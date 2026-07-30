import express from "express";
import multer from "multer";
import * as path from "path";
import { randomUUID } from "crypto";
import { pdfToImages, imageToPages, scanPageImage, extractJsonBlock, cropIntoBands, extractPageContext, verifyDatesOnPage, resizeForDisplay, rotateImage, type PageDataModel } from "./lib/ocr";
import { buildReviewRows, fillTimesheetFromRows, MONTH_ABBR, type TimeEntry, type FillWarning, type RestDay, type ReviewRow } from "./lib/xlsx";
import { reconcileAttempts, type ParsedEntry } from "./lib/reconcile";
import { uploadFlaggedPage, type FlaggedPageEntry } from "./lib/feedback";
import { extractIpaFields, type IpaFields } from "./lib/ipa";

const TEMPLATE_PATH = path.join(__dirname, "calculation.xltx");
const PORT = process.env.PORT || 3000;
const SUPPORTED_YEARS = [2025, 2026];
// A single scan of a dense page can genuinely miss/misread rows. Scanning each page this many
// times independently and reconciling (lib/reconcile.ts) trades latency/cost for much more
// reliable coverage — one deterministic (temperature=0) pass for consistency, plus two
// higher-temperature passes. Identical settings on every attempt would mean a systematic model
// bias (e.g. lazily repeating a previous row's value on a dense, visually-repetitive table)
// reproduces identically every time, leaving reconciliation's disagreement-detection nothing to
// catch since all attempts agree with each other. Varied temperature/seed gives each pass a
// real chance to diverge when the model's reading is actually uncertain, instead of just being
// confidently wrong every time.
const SCAN_TEMPERATURES: { temperature: number; seed: number }[] = [
    { temperature: 0, seed: 42 },
    { temperature: 0.3, seed: 43 },
    { temperature: 0.5, seed: 44 },
];
// Band-cropping (splitting a page into smaller vertical strips before OCR, each scanned
// independently) was an attempt at reducing dense-table repetition/row-merging failures. Tried 2
// bands, then 3 — neither reliably fixed the specific failure it was meant to address, so it's
// off for now (1 = cropIntoBands short-circuits and returns the page uncropped, see lib/ocr.ts).
// The two-level (within-band, then cross-band) reconciliation structure in the loop below still
// runs either way — with 1 band it's just reconciling a single "band" against nothing else,
// which is a no-op pass-through, so no separate code path was needed to disable it cleanly.
const BANDS_PER_PAGE = 1;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});

// Shared by /api/preview (staging thumbnails) and /api/process (the real scan) — real-world
// timesheets are frequently a phone photo (jpg/png), not a PDF, so branch on the upload's
// mimetype rather than assuming every file is a PDF.
async function loadPagesForFile(file: Express.Multer.File): Promise<string[]> {
    const isImage = file.mimetype.startsWith("image/");
    return isImage ? await imageToPages(file.buffer) : await pdfToImages(file.buffer);
}

// Rotation degrees a human confirmed in the pre-scan staging step (public/index.html), keyed so
// /api/process can look up which page they apply to. pdfs are keyed "<fileIndex>-<pageIndex>"
// since there can be several multi-page files; ipa is a single number since only its first page is
// ever used downstream (lib/ipa.ts).
type RotationMap = { pdfs?: Record<string, number>; ipa?: number };

// A page's own image + everything read from it so far, in the exact shape public/index.html
// already knows how to render — used both as a live in-progress snapshot (pushed as each page
// finishes scanning) and as the authoritative final version (once the whole job is done, which
// additionally has coverage-check warnings attached — see the end of runProcessJob).
type PageReview = {
    source: string;
    image: string;
    entries: { date: string; type: string; [k: string]: unknown }[];
    warnings: FillWarning[];
    dataModel: PageDataModel;
    pageContext: string;
};

// /api/process kicks off a scan as a background job (12 real-world pages can take 15-20+ minutes
// sequentially) and returns a jobId immediately rather than holding the HTTP request open the
// whole time — a connection held open that long is fragile (proxies/networks can drop it), and it
// gave the browser zero visibility into per-page progress. public/index.html polls
// GET /api/process/:jobId to render each page's card as soon as that page finishes, instead of
// waiting for the entire batch before showing anything.
type ProcessJob = {
    status: "running" | "done" | "error";
    pages: PageReview[]; // grows live while running; replaced with the authoritative final list once done
    result: Record<string, unknown> | null; // set once status is "done" — same shape /api/process used to return directly
    error: string | null;
};
// Named processJobs, not jobs — the per-page scan loop below already uses a local variable
// called `jobs` for its band x temperature attempt list, and shadowing that would be a landmine.
const processJobs = new Map<string, ProcessJob>();
// Jobs are only needed long enough for the client to poll the final "done" state once — not
// pruning them at all would leak memory on a long-running server across many scans.
const JOB_TTL_MS = 30 * 60 * 1000;
function scheduleJobCleanup(jobId: string) {
    setTimeout(() => processJobs.delete(jobId), JOB_TTL_MS);
}

// Fanning out many parallel scan calls per page (bands x temperatures) means far more surface
// area for a flaky upstream response. Our own try/catch around each scanPageImage call assumes SDK failures
// always surface as a rejected promise we're awaiting — but a malformed/truncated network
// response can throw inside the SDK's internals detached from that chain (an unhandled rejection
// or uncaught exception), which by default kills the entire Node process and drops every
// in-flight request, not just the one that hit the flaky response. Requests here are stateless
// (memory-storage uploads, no shared mutable state or open transactions), so logging and staying
// up is safe and far better than a total outage over one bad upstream response.
process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection (server staying up):", reason);
});
process.on("uncaughtException", (err) => {
    console.error("Uncaught exception (server staying up):", err);
});

// Handwritten years are frequently misread by OCR (e.g. "2023" instead of "2026"), and since
// this template only has sheets for SUPPORTED_YEARS, we don't trust the model's year at all —
// the caller picks it explicitly, and we only ask the model for day/month/clock times.
//
// A real-world upload batch turned out to span far more variety than "one row per day, clock
// in/out times, handwritten" — see the format survey behind this revision: two-half-month
// side-by-side tables, weekly calendar grids, free-form diagonal lists, punch cards, typed
// (non-handwritten) sheets, mixed English/Chinese/Bengali, and — critically — pages that record
// only a total hours-worked(+OT) figure per day with NO clock times anywhere. The prompt below no
// longer assumes handwriting or a single table shape, and adds hoursWorked/otHours as the
// alternative to `times` for that last case. dataModelHint comes from extractPageContext's cheap
// full-page classification pass — a hint to lean on, not a hard rule, since a single page can
// occasionally mix both models.
function buildPrompt(year: number, pageContext: string, dataModelHint: PageDataModel): string {
    const hintLine =
        dataModelHint === "hours_total"
            ? "An earlier pass guessed this page records only total hours worked (and maybe separate overtime hours) per day, with no clock in/out times — but verify against what you actually see; if clock times ARE visible on this image, report those instead (see below)."
            : dataModelHint === "clock_times"
                ? "An earlier pass guessed this page records actual clock in/out times per day — but verify against what you actually see."
                : dataModelHint === "punch_log"
                    ? "An earlier pass guessed this page is a phone app's punch-log screen (a chronological list of individual timestamped events, not a table) — see the specific guidance for that layout below, and verify against what you actually see."
                    : "An earlier pass could not tell what this page records per day — judge purely from what you see on this image.";

    return `This is one page of a worker's daily time/attendance record, used to fill a wage-claim spreadsheet for the year ${year}. It may be handwritten OR typed/computer-generated, in English, Chinese, Bengali, or a mix, and may use any layout — a simple row-per-day table, two half-months side by side on one page, a weekly calendar grid (day-of-week columns), a free-form list, a punch card, a phone app's punch-log screenshot, etc. Read whatever is actually in front of you rather than assuming one fixed shape.

Some pages are a punch-log screenshot from a phone clock-in app instead of a table — a chronological LIST of individual timestamped events (e.g. a "History" screen with rows like "12-06-2026 06:29:54"), most-recent-first, with each clock in and each clock out as its own separate list entry rather than grouped by day. For this layout specifically:
- The timestamp includes seconds (HH:MM:SS) — DROP the seconds entirely, do not fold them into the reported time. "19:50:07" is 1950 (7:50pm), NOT 195007. "06:29:54" is 629 (6:29am), NOT 62954.
- Multiple separate list entries can share the same calendar date (e.g. one entry at 06:50 and another at 19:50 both dated 11-06-2026 — a clock-in and a clock-out on the same day, shown as two unrelated-looking rows because the app lists individual events, not days). Merge every entry for the same date into ONE output object for that date, with a single times array containing all of that date's events together — do not output multiple separate objects for the same day.
- Order the merged times array in TRUE chronological order (earliest time of day first), not the order the entries happen to appear on the page (which is newest-date-first, and within a date, not guaranteed to be in a fixed order either) — you can see which of a date's timestamps is actually earlier, use that.

Worked example of a common mistake with merged punch-log entries: two events dated 04-06-2026 are shown on the page as "20:07:32" then "06:26:15" (in that page order, newest-first). The correct times array is [626, 2007] — 626 (6:26am) is chronologically earlier than 2007 (8:07pm), so it goes first, even though it appeared SECOND on the page. If you find yourself reasoning through which value is chronologically earlier and concluding e.g. "[626, 2007]", your times array MUST be exactly that — [626, 2007], not [2007, 626]. Do not reason your way to the correct order in your notes and then write the values in the original page order anyway; that is the exact mistake this example exists to prevent.

The printed column labels on a page's template may NOT match what's actually written in that column — the same printed template is often reused inconsistently by different workers (e.g. a column printed "Amount"/support-in-currency might actually contain a clock-out time, not money; a column printed "Site" might contain a month name instead). Always interpret each cell by what is ACTUALLY WRITTEN there, never by trusting the printed label alone.

Page-level context (extracted separately from the full page before this image was cropped, since this image you're looking at now may be only part of the page and might not show a header/title that exists elsewhere on the page): ${pageContext || "none found"}. If this names a specific month, treat it as authoritative for every date row you report below — use that month even if this particular cropped image doesn't show the header itself, UNLESS a row on THIS image explicitly and clearly indicates a different month.

${hintLine}

For each calendar date row on this page, if actual clock in/out times are shown, your job is simply to list EVERY clock time value written on that row, left to right, in the order they appear — do NOT try to decide how many shifts they represent or group them into clock-in/clock-out pairs yourself. That grouping happens automatically downstream from the count and order of values you report, so your only job is accurate, complete enumeration.

- A normal day with one shift has 2 values: [clock_in, clock_out].
- A split day with a morning shift and an evening shift has 4 values: [in1, out1, in2, out2].
- A day with three shifts has 6 values, and so on.
Report the values as bare 24-hour numbers, no colon, e.g. 800 means 8:00am, 1330 means 1:30pm, 2200 means 10:00pm.

CRITICAL — always scan the FULL WIDTH of a row before deciding it only has 2 values. It is a common and serious error to read only the first clock-in/clock-out pair and stop, when the row actually has 4 (or more) values further right representing a second shift. If you see more than 2 time values anywhere on a row, report ALL of them — never silently drop the later ones.

Watch out for the 12am/12pm ambiguity — it's a common mistake. 12pm = noon = 1200. 12am = midnight = 0 (or 2400 if it's the last value of the day, ending a shift that started earlier). These are NOT the same time, even though both are written as "12". Do not convert 12am the same way you'd convert 12pm.

Worked example of this exact mistake: a row reading "6am to 12pm, 6pm to 12am" (two shifts, a morning block and an evening block) must be reported as [600, 1200, 1800, 2400] — NOT [600, 1200, 1800, 1200]. The second "12" is 12am (midnight), ending the evening shift, and is a completely different time from the first "12" (12pm/noon) even though both look like "12" at a glance. If your final value for a row matches an earlier value in that same row only because you converted both "12"s the same way, you have made this exact mistake — re-examine whether the later one is actually 12am.

Watch out for a bare "NN/NN" or "NN-NN" shorthand (e.g. "08/20") written in a non-Date column (e.g. one printed "Amount" or "Qty") on a work-hours page — this is a common way workers write clock-in/clock-out as just the HOUR, no minutes, no am/pm marker. It is NOT a calendar date, even though it superficially looks like MM/DD — a real date belongs in the Date column, which this page already has separately, so a second date-like value elsewhere on the same row would be redundant and wrong.

Worked example of this exact case: a row shows "08/20" in a column printed "Amount", and this page is a time/wage record (not a payment ledger). The correct output for that row is times: [800, 2000] — 8:00am to 8:00pm — filled into the times array exactly like any other clock time, per the schema below. Do NOT second-guess this into times: null because the column's printed label says "Amount" rather than "time" — you already know from the instruction above that printed labels on this page's template can be wrong, and this is that exact situation. If you find yourself reasoning through this shorthand and concluding it represents clock hours, your times array for that row MUST reflect that conclusion — do not talk yourself back into null afterward.

Note: an overnight-spanning value (a time that's numerically smaller than the one before it, e.g. a shift running from 2200 to 0600) is expected and handled correctly downstream — do not try to "fix" it or reorder the values, just report them in the order they appear on the page.

Hard constraint — no human can work 24 hours or more in a single calendar day. The span from the first time to the last time you report for a row must always be strictly less than 24 hours. If your reading would imply 24 hours or more, you have misread the image — look again. If you still cannot resolve it, output null for times on that row and explain the conflict in notes.

Total hours worked must tally strictly. If the page shows both raw clock times AND a separately written total/duration for the same day, what you report must be consistent with that written total (accounting for any marked meal break). If they don't agree, do not silently pick one — explain the discrepancy in notes so a human can review it.

This page may contain many rows (up to 31, one per day of the month) — but do NOT assume every day of the month must appear. Only report a date if that date's row genuinely exists on the page with some kind of mark, entry, or handwriting in it. Transcribe EVERY row that is actually present, top to bottom — do not skip, merge, or summarize any row, even if the page is dense or some rows look repetitive.

CRITICAL — pay special attention to the LAST row that has any handwritten content on it, especially when it's followed by several blank/empty rows before the page ends. It is a common mistake to see a run of blank rows coming up and treat that as a signal that the data has "ended" a row early, causing the last real row to get skipped even though it clearly has content. The last populated row is exactly as real as every row before it — verify you have included it.

CRITICAL — many rows on a timesheet look nearly identical at a glance (e.g. the same clock-in time and same mid-day break time repeated every day), but that does NOT mean every row is identical. Do not let an earlier row you already read confidently influence how you read a later row that merely looks similar. You must independently re-examine and read the actual handwritten digits on EVERY row, especially any values later in the row — it is extremely common for only a later time value to differ between otherwise similar-looking rows, and copying a previous row's values here instead of reading this row's own digits is a serious, easy-to-make error. Treat each row as a completely separate read, as if you had never seen any other row on the page.

CRITICAL — this same rule applies just as strictly to a weekly CALENDAR GRID layout (day-of-week columns, each date in its own box), where the "neighbors" that can wrongly bleed into each other are the boxes next to, above, or below the one you're reading, not rows in a table. A date's own box is read purely on its own — never copy, infer, or "complete the pattern" from a neighboring date's box, even when several neighboring dates in a row all show the identical time (e.g. a run of workdays all reading "8:00 to 19:00"). Worked example of this exact mistake: dates 9 and 11 both show "8:00 to 19:00" in their boxes, and date 10 (directly between them) shows only a bare checkmark or tally mark in its box with NO time text written inside it at all. The correct output for date 10 is times: null (per the bare-presence-mark rule above) — NOT "8:00 to 19:00" borrowed from either neighbor. A checkmark is not a time value, no matter how consistent the surrounding dates look; only report a time for a date when that date's OWN box actually contains written time text.

NEVER guess or invent time values, for any reason. If a row's clock times are smudged, blurry, or otherwise too unclear to read with confidence, output times as null for that row and briefly explain why in notes — do not use a pattern from other rows on the page to fill it in, even if the pattern looks obvious or consistent. And if a date simply has no row on the page at all (no marks, nothing written for it), do not output an entry for it at all. Every value you report must be something you actually read directly off the page, never inferred, pattern-matched, or guessed.

If a date is explicitly marked as a rest day, day off, public holiday, or similar, still output a row for it — set rest_day to true and times to null. Do NOT guess times for a confirmed rest day.

Some pages record only a TOTAL number of hours worked per day (and sometimes a separate overtime figure), with NO clock in/out time anywhere on that row — e.g. a row just saying "8" or "8 + 2 OT" instead of "8:00-17:00". When this is genuinely what's on the page for a date (no clock times present at all for it), do NOT invent clock times to fill the times field — instead leave times null and report hoursWorked (a number, e.g. 8 or 10.5) and otHours (a number, or null if no overtime shown/not applicable) for that date. Only use hoursWorked/otHours when clock times are genuinely absent for that date — if actual clock times ARE present on the row, always report them via times as instructed above instead, even if a total-hours figure also happens to sit alongside them (times take priority whenever both exist). If a date's row shows only a bare presence mark (e.g. a checkmark or tally mark) with nothing that tells you a duration or a clock time, leave times, hoursWorked, and otHours all null and say so briefly in notes — do not invent a duration from a presence mark alone.

For every date row visible on this page, output:
- day: day of month, integer 1-31
- month: month, integer 1-12. Use the page-level context above if it names a month, unless this specific row clearly indicates otherwise (this page is for the year ${year} — ignore any year written on the page, it is not needed)
- times: array of every clock time value on this row as described above, in left-to-right order, or null if illegible/not determinable/rest day/hours-only. Length should normally be even (2, 4, 6...) since shifts come in in/out pairs.
- hoursWorked: total hours worked that day as a number (e.g. 8, 10.5), ONLY when times is null because no clock times exist for this date and a total-hours figure is genuinely shown instead. null otherwise (including whenever times is populated).
- otHours: overtime hours as a number, alongside hoursWorked when shown. null if not applicable/not shown, or whenever hoursWorked itself is null.
- guessed: always false. You must never guess or invent values (see above) — this field exists only for schema consistency.
- rest_day: true if this date is explicitly marked as a rest day/off/holiday on the page, false otherwise
- notes: null normally. If times/hoursWorked are null, OR anything about this row doesn't make sense (e.g. an odd number of values, unclear handwriting, unusual format, implied 24h+ span), explain briefly here so a human can review.

Output ONLY a valid JSON array of {day, month, times, hoursWorked, otHours, guessed, rest_day, notes} objects for this page. No other text, no markdown fences.`;
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));

// Renders a thumbnail of every page of every attached file (no OCR/model calls at all — just
// pdf-to-image/image-normalize + downscale, same functions /api/process itself uses to load
// pages) so the browser can show a staging grid right after attaching, before the real (expensive,
// multi-pass) scan runs. Lets a human confirm/rotate a sideways page up front — auto-detecting
// this from the model was tried and found unreliable (see lib/ocr.ts's rotateImage comment).
app.post(
    "/api/preview",
    upload.fields([
        { name: "pdfs", maxCount: 10 },
        { name: "ipa", maxCount: 1 },
    ]),
    async (req, res) => {
        const uploadedFields = req.files as { [field: string]: Express.Multer.File[] } | undefined;
        const files = uploadedFields?.pdfs ?? [];
        const ipaFile = uploadedFields?.ipa?.[0];

        const pdfsPreview: { fileIndex: number; pageIndex: number; fileName: string; image: string }[] = [];
        const pdfsErrors: { fileName: string; error: string }[] = [];
        for (let fi = 0; fi < files.length; fi++) {
            const file = files[fi];
            try {
                const images = await loadPagesForFile(file);
                for (let pi = 0; pi < images.length; pi++) {
                    pdfsPreview.push({ fileIndex: fi, pageIndex: pi, fileName: file.originalname, image: await resizeForDisplay(images[pi], 400) });
                }
            } catch (e: any) {
                pdfsErrors.push({ fileName: file.originalname, error: e.message });
            }
        }

        let ipaPreview: string | null = null;
        let ipaError: string | null = null;
        if (ipaFile) {
            try {
                const images = await loadPagesForFile(ipaFile);
                // Only the first page is ever sent to extractIpaFields (lib/ipa.ts) — previewing
                // later pages would invite rotating a page that isn't actually used.
                if (images.length > 0) ipaPreview = await resizeForDisplay(images[0], 400);
            } catch (e: any) {
                ipaError = e.message;
            }
        }

        res.json({ pdfsPreview, pdfsErrors, ipaPreview, ipaError });
    }
);

app.post(
    "/api/process",
    upload.fields([
        { name: "pdfs", maxCount: 10 },
        { name: "ipa", maxCount: 1 }, // optional — the IPA letter, a single separate document from the timesheets
    ]),
    (req, res) => {
    const uploadedFields = req.files as { [field: string]: Express.Multer.File[] } | undefined;
    const files = uploadedFields?.pdfs;
    const ipaFile = uploadedFields?.ipa?.[0];
    if (!files || files.length === 0) {
        return res.status(400).json({ error: "No PDF files uploaded." });
    }

    const year = Number(req.body.year);
    if (!SUPPORTED_YEARS.includes(year)) {
        return res.status(400).json({ error: `year must be one of: ${SUPPORTED_YEARS.join(", ")}` });
    }

    // Rotation degrees a human confirmed against the /api/preview thumbnails (public/index.html's
    // staging step) — applied below via rotateImage before anything else ever looks at a page's
    // image, so every downstream step (context extraction, scanning, IPA extraction) sees the
    // corrected orientation. Absent/malformed is treated as "no rotations chosen" rather than an
    // error — the staging step is a UX improvement, not a required step, so a request without it
    // (e.g. an older client) should still scan normally, just without the correction.
    let rotations: RotationMap = {};
    try {
        if (typeof req.body.rotations === "string") rotations = JSON.parse(req.body.rotations);
    } catch {
        // ignore — fall through with no rotations applied
    }

    // Pages a human dropped in the staging preview ("<fileIndex>-<pageIndex>" keys, same as
    // rotations.pdfs) — the underlying file is still uploaded whole (a PDF's pages can't be
    // stripped client-side), so exclusion is enforced here: skip these pages entirely, before any
    // context extraction or scan attempt, as if that page were never on the page count at all.
    let excludedPages = new Set<string>();
    try {
        if (typeof req.body.excludedPages === "string") {
            const parsed = JSON.parse(req.body.excludedPages);
            if (Array.isArray(parsed)) excludedPages = new Set(parsed);
        }
    } catch {
        // ignore — fall through with no exclusions applied
    }

    // A real scan (many pages, sequential) can run 15-20+ minutes — long enough that holding this
    // HTTP request open the whole time is fragile (proxies/networks can drop a connection that
    // long) and gives the browser zero visibility into progress until the very end. Instead: kick
    // the scan off as a background job and return its id immediately; public/index.html polls
    // GET /api/process/:jobId, which renders each page's card as soon as that page finishes rather
    // than waiting for the entire batch.
    const jobId = randomUUID();
    processJobs.set(jobId, { status: "running", pages: [], result: null, error: null });
    runProcessJob(jobId, files, ipaFile, year, rotations, excludedPages)
        .catch(e => {
            const job = processJobs.get(jobId);
            if (job) { job.status = "error"; job.error = e.message; }
        })
        .finally(() => scheduleJobCleanup(jobId));

    res.json({ jobId });
    }
);

// Polled by public/index.html every few seconds while a scan runs. `pages` grows live as each
// page finishes scanning; `result`/`error` land once `status` moves away from "running".
app.get("/api/process/:jobId", (req, res) => {
    const job = processJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "job not found or expired" });
    res.json(job);
});

// The actual scan/reconcile/fill-prep pipeline — everything /api/process's handler used to do
// inline before returning res.json() directly. Now runs detached from the request that started
// it (see the handler above), mutating the processJobs entry in place as it goes so
// GET /api/process/:jobId always reflects current progress.
async function runProcessJob(
    jobId: string,
    files: Express.Multer.File[],
    ipaFile: Express.Multer.File | undefined,
    year: number,
    rotations: RotationMap,
    excludedPages: Set<string>
): Promise<void> {
    const startedAt = Date.now();

    const timeEntries: TimeEntry[] = [];
    const restDays: RestDay[] = [];
    // Days where the source page recorded only a total hours-worked(+OT) figure, no clock times
    // (lib/ocr.ts's PageDataModel "hours_total") — fillTimesheet's N/O columns need actual clock
    // times, so these can't be written to the spreadsheet yet. Kept here purely so the raw scan
    // output / side-by-side review UI can show what was extracted, instead of silently vanishing.
    const hoursEntries: { date: Date; hoursWorked: number; otHours: number | null; source: string; guessed: boolean }[] = [];
    const warnings: FillWarning[] = [];
    let totalCostUsd = 0; // sums OpenRouter's own reported usage.cost across every call this request makes
    // Display-only (downscaled) copy of every page, for the side-by-side review UI — keyed by the
    // same `source` string ("file.pdf p2") already used to tag every entry/warning from that page.
    const pageImages: { source: string; image: string }[] = [];
    // dataModel/pageContext per page, keyed by source — populated once extractPageContext runs
    // below. Carried into pageReviews purely so a later "flag this page" action (public/index.html)
    // can send this classification along with the flag, without the client having to re-derive it.
    const pageMeta = new Map<string, { dataModel: PageDataModel; pageContext: string }>();

    // toLocalDateString, not toISOString: .toISOString() converts to UTC, which silently shifts
    // the calendar date by a day in timezones ahead of UTC (e.g. a local-midnight Sept 11 becomes
    // "2025-09-10") — exactly the class of date bug this debug output exists to help catch, so
    // shipping that here would be self-defeating. Every date elsewhere in this codebase is
    // constructed and read in local time (new Date(year, month, day)), so this matches that.
    // Declared up here (rather than down by scanOutput, where it used to live) since the live
    // per-page progress push inside the loop below needs it too.
    const toLocalDateString = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    // Builds the same {date, type, ...} shape /api/process has always returned per page, filtered
    // to one page's own source — shared by the live in-progress snapshot pushed inside the loop
    // below and the authoritative final pageReviews built after the whole loop completes.
    function entriesForSource(source: string) {
        return [
            ...timeEntries
                .filter(e => e.source === source)
                .map(e => ({
                    date: toLocalDateString(e.date),
                    type: "worked" as const,
                    clockIn: e.clockIn,
                    clockOut: e.clockOut,
                    guessed: e.guessed,
                })),
            ...restDays
                .filter(r => r.source === source)
                .map(r => ({
                    date: `${r.year}-${String(r.month).padStart(2, "0")}-${String(r.day).padStart(2, "0")}`,
                    type: "rest_day" as const,
                })),
            ...hoursEntries
                .filter(h => h.source === source)
                .map(h => ({
                    date: toLocalDateString(h.date),
                    type: "hours_worked" as const,
                    hoursWorked: h.hoursWorked,
                    otHours: h.otHours,
                    guessed: h.guessed,
                })),
        ].sort((a, b) => a.date.localeCompare(b.date));
    }

    // Kicked off before the timesheet-page loop below (not awaited yet) so it runs concurrently
    // with that loop's sequential per-file/per-page work instead of adding its own latency on top.
    // An IPA is one MOM-issued document (unlike timesheets, never multiple files) — single page,
    // single deterministic extraction pass (see lib/ipa.ts), so no per-page/band/temperature
    // fan-out is needed here the way the timesheet loop needs it.
    let ipaWarning: string | null = null;
    const ipaPromise: Promise<IpaFields | null> = ipaFile
        ? (async () => {
            try {
                const images = await loadPagesForFile(ipaFile);
                if (images.length === 0) {
                    ipaWarning = "IPA file had no readable pages";
                    return null;
                }
                const image = rotations.ipa ? await rotateImage(images[0], rotations.ipa) : images[0];
                const { fields, cost } = await extractIpaFields(image);
                totalCostUsd += cost;
                return fields;
            } catch (e: any) {
                ipaWarning = `could not process IPA document: ${e.message}`;
                return null;
            }
        })()
        : Promise.resolve(null);

    for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        let images: string[];
        try {
            images = await loadPagesForFile(file);
        } catch (e: any) {
            const isImage = file.mimetype.startsWith("image/");
            warnings.push({ source: file.originalname, reason: `could not read ${isImage ? "image" : "PDF"}: ${e.message}`, category: "system" });
            continue;
        }

        for (let i = 0; i < images.length; i++) {
            if (excludedPages.has(`${fi}-${i}`)) continue; // dropped by a human in the staging preview — not a failure, nothing to warn about

            const source = `${file.originalname} p${i + 1}`;
            let displayImage = "";
            let pageContext = "";
            let dataModel: PageDataModel = "unclear";
            // Wrapped in try/finally (rather than checking success at every one of this block's
            // several early `continue`s) so the live progress push below always fires exactly once
            // per page — whether it fully scanned, got skipped as a non-timesheet, or every scan
            // attempt failed. A page the user is watching "process" should never just disappear
            // without ever being accounted for in the live view.
            try {
                // Applied before anything else looks at this page (context extraction, band-cropping,
                // scanning) — everything downstream sees the human-confirmed upright orientation from
                // the /api/preview staging step, not the raw (possibly sideways) render.
                const pageRotation = rotations.pdfs?.[`${fi}-${i}`];
                if (pageRotation) images[i] = await rotateImage(images[i], pageRotation);
                displayImage = await resizeForDisplay(images[i]);
                pageImages.push({ source, image: displayImage });

                // Read the full, uncropped page once for page-level context (e.g. a month header)
                // before cropping into bands — a header can sit anywhere on the page depending on
                // the source layout, and once cropped into bands, whichever band doesn't happen to
                // include it would otherwise have no way to know what month its rows belong to. Also
                // does two cheap classifications on the same call (lib/ocr.ts): whether this page is
                // a timesheet at all, and which data model it seems to use.
                try {
                    const result = await extractPageContext(images[i]);
                    pageContext = result.context;
                    dataModel = result.dataModel;
                    pageMeta.set(source, { dataModel, pageContext });
                    totalCostUsd += result.cost;
                    if (!result.isTimesheet) {
                        warnings.push({
                            source,
                            reason: `page does not appear to be a work time/attendance record${pageContext ? ` (${pageContext})` : ""} — skipped, no scan attempts made`,
                            category: "system",
                        });
                        continue;
                    }
                } catch (e: any) {
                    warnings.push({ source, reason: `could not extract page-level context (e.g. month header): ${e.message} — bands will rely on per-row reading only`, category: "scan_quality" });
                }
                const prompt = buildPrompt(year, pageContext, dataModel);

                const bands = await cropIntoBands(images[i], BANDS_PER_PAGE);

                // flatten band x temperature into one parallel batch for max concurrency — all
                // bands' attempts fire together rather than band-by-band, so wall-clock time stays
                // close to a single batch's latency despite more total calls.
                const scanJobs = bands.flatMap((bandImage, b) =>
                    SCAN_TEMPERATURES.map(({ temperature, seed }) => ({ bandImage, b, temperature, seed }))
                );
                const results = await Promise.allSettled(
                    scanJobs.map(({ bandImage, temperature, seed }) => scanPageImage(bandImage, prompt, temperature, seed))
                );

                const attemptsByBand: ParsedEntry[][][] = bands.map(() => []);
                let truncatedCount = 0;
                let failedCount = 0;
                results.forEach((result, idx) => {
                    const { b, temperature, seed } = scanJobs[idx];
                    if (result.status === "rejected") {
                        failedCount++;
                        // Previously silent — a rejected scan attempt (network error, the OpenRouter
                        // SDK's internal parse bug, our own 90s timeout) gave zero trace of what
                        // actually happened, making failure patterns like "most attempts on most
                        // pages failed" undiagnosable after the fact.
                        console.error(`${source} band ${b} temp=${temperature} seed=${seed}: scan attempt rejected —`, result.reason);
                        return;
                    }
                    const { content, truncated, cost } = result.value;
                    totalCostUsd += cost;
                    if (truncated) truncatedCount++;
                    try {
                        const parsed = JSON.parse(extractJsonBlock(content));
                        if (!Array.isArray(parsed)) throw new Error("not a JSON array");
                        attemptsByBand[b].push(parsed);
                    } catch (e: any) {
                        failedCount++;
                        // Same visibility gap as above, but for a response that came back at all yet
                        // failed to parse as the expected JSON array — logging the raw text (not just
                        // "failedCount++") is the only way to tell a truncation cutoff apart from a
                        // genuinely malformed reply apart from extractJsonBlock picking the wrong
                        // bracket pair.
                        console.error(`${source} band ${b} temp=${temperature} seed=${seed} truncated=${truncated}: failed to parse scan output (${e.message}). Raw content:\n`, content);
                    }
                });

                const totalAttempts = scanJobs.length;
                if (truncatedCount > 0) {
                    warnings.push({
                        source,
                        reason: `${truncatedCount}/${totalAttempts} scan attempts were truncated (hit token limit) — this page may still be missing rows, please review carefully`,
                        category: "scan_quality",
                    });
                }
                if (failedCount > 0) {
                    warnings.push({
                        source,
                        reason: `${failedCount}/${totalAttempts} scan attempts failed or returned unparseable output`,
                        category: "scan_quality",
                    });
                }

                // Reconcile WITHIN each band first (its own SCAN_TEMPERATURES attempts, all looking
                // at the exact same cropped image — full participation required here, since a lone
                // attempt hallucinating something the other attempts of the SAME image never mention
                // is a genuine disagreement about the same source material). A band that fully
                // failed contributes nothing (skipped, not pushed as an empty attempt) so it doesn't
                // dilute the "X/N attempts agreed" bookkeeping for bands that did report.
                // A punch-log page (lib/ocr.ts's PageDataModel) has no meaningful left-to-right/
                // row order to preserve — each entry is independently timestamped by the app itself,
                // unlike a table row where order distinguishes e.g. a real overnight shift from its
                // reverse. Only relax reconcileAttempts's order-sensitivity for pages classified as
                // such (see lib/reconcile.ts for why this can't safely be the default everywhere).
                const orderMatters = dataModel !== "punch_log";

                const bandResults: ParsedEntry[][] = [];
                for (let b = 0; b < bands.length; b++) {
                    if (attemptsByBand[b].length === 0) continue;
                    const bandSource = bands.length > 1 ? `${source} (band ${b + 1}/${bands.length})` : source;
                    const { entries: bandEntries, warnings: bandWarnings } = reconcileAttempts(attemptsByBand[b], bandSource, true, year, orderMatters);
                    bandResults.push(bandEntries);
                    warnings.push(...bandWarnings);
                }

                if (bandResults.length === 0) {
                    warnings.push({ source, reason: "all scan attempts for this page failed — page was skipped entirely", category: "scan_quality" });
                    continue;
                }

                // Reconcile ACROSS bands leniently (requireFullParticipation=false): bands see
                // genuinely different, only partially overlapping crops by design, so a day sitting
                // in one band's region and outside another's isn't disagreement, it's expected
                // non-coverage. Only reject when multiple bands DO report the same day with
                // conflicting values — that's a real disagreement, not a coverage gap.
                const { entries: reconciled, warnings: crossBandWarnings } = reconcileAttempts(bandResults, source, false, year, orderMatters);
                warnings.push(...crossBandWarnings);

                // Strict cross-attempt unanimity (lib/reconcile.ts) only catches disagreement — it
                // can't catch the model confidently, consistently hallucinating the same fabricated
                // date on every attempt, since there's nothing for reconciliation to disagree about.
                // One extra focused call per page (not per date) asks specifically "does this date's
                // row actually exist on the page", against the full uncropped image, and drops
                // anything not confirmed rather than trusting transcription alone.
                let parsed = reconciled;
                const candidates = reconciled
                    .filter((e): e is ParsedEntry & { day: number; month: number } => e.day !== null && e.month !== null)
                    .map(e => ({ day: e.day, month: e.month }));
                if (candidates.length > 0) {
                    try {
                        const { confirmed, cost } = await verifyDatesOnPage(images[i], candidates);
                        totalCostUsd += cost;
                        parsed = reconciled.filter(e => {
                            if (e.day === null || e.month === null) return true; // let existing validation handle it
                            const isConfirmed = confirmed.has(`${e.month}-${e.day}`);
                            if (!isConfirmed) {
                                warnings.push({
                                    source,
                                    reason: `day=${e.day} month=${e.month}: failed page-level verification (no genuine row found for this date on a full-page recheck) — dropped, please check the source PDF for this date directly`,
                                    category: "dropped_disagreement",
                                    date: `${year}-${String(e.month).padStart(2, "0")}-${String(e.day).padStart(2, "0")}`,
                                });
                            }
                            return isConfirmed;
                        });
                    } catch (e: any) {
                        warnings.push({ source, reason: `date verification pass failed (${e.message}) — entries for this page were NOT independently verified, please review carefully`, category: "scan_quality" });
                    }
                }

                for (const entry of parsed) {
                    if (entry.day === null || entry.month === null) {
                        warnings.push({
                            source,
                            reason: `skipped a row with no determinable date (times=${entry.times ? entry.times.join(",") : entry.times})${entry.notes ? `: ${entry.notes}` : ""}`,
                            category: "skipped_invalid",
                        });
                        continue;
                    }
                    if (entry.month < 1 || entry.month > 12 || entry.day < 1 || entry.day > 31) {
                        warnings.push({ source, reason: `implausible date day=${entry.day} month=${entry.month}, skipped`, category: "skipped_invalid" });
                        continue;
                    }
                    // Generic 1-31 above isn't month-aware (e.g. April 31 doesn't exist). Entries
                    // that build a real Date (timeEntries) get this correction for free via JS's own
                    // rollover — but restDays are stored as raw numbers with no Date construction at
                    // all, so an invalid day here would silently inflate that month's day count with
                    // no bounds check downstream. Catch it here for every entry type uniformly.
                    const daysInThisMonth = new Date(year, entry.month, 0).getDate();
                    if (entry.day > daysInThisMonth) {
                        warnings.push({
                            source,
                            reason: `day=${entry.day} does not exist in month=${entry.month}/${year} (only has ${daysInThisMonth} days), skipped`,
                            category: "skipped_invalid",
                        });
                        continue;
                    }
                    if (entry.rest_day === true) {
                        restDays.push({ year, month: entry.month, day: entry.day, source });
                        continue;
                    }
                    const entryDate = `${year}-${String(entry.month).padStart(2, "0")}-${String(entry.day).padStart(2, "0")}`;
                    if ((!entry.times || entry.times.length === 0) && entry.hoursWorked !== null) {
                        // hours_total data model: no clock times exist for this date, only a total
                        // hours(+OT) figure — can't feed fillTimesheet's clock-time columns, so this
                        // is captured for the review UI/JSON but explicitly flagged as not written to
                        // the spreadsheet, rather than either fabricating clock times or silently
                        // dropping genuinely-read data.
                        hoursEntries.push({
                            date: new Date(year, entry.month - 1, entry.day),
                            hoursWorked: entry.hoursWorked,
                            otHours: entry.otHours,
                            source,
                            guessed: entry.guessed === true,
                        });
                        warnings.push({
                            source,
                            reason: `day=${entry.day} month=${entry.month}: only a total-hours figure was found (${entry.hoursWorked}h${entry.otHours ? ` + ${entry.otHours}h OT` : ""}), no clock in/out times — NOT written to the spreadsheet (needs clock times), please enter this day manually`,
                            category: "flagged_review",
                            date: entryDate,
                        });
                        continue;
                    }
                    if (!entry.times || entry.times.length === 0) {
                        warnings.push({
                            source,
                            reason: `skipped day=${entry.day} month=${entry.month} (no times detected)${entry.notes ? `: ${entry.notes}` : " — please check the source PDF for this date directly"}`,
                            category: "skipped_invalid",
                            date: entryDate,
                        });
                        continue;
                    }
                    if (entry.times.length % 2 !== 0) {
                        warnings.push({
                            source,
                            reason: `day=${entry.day} month=${entry.month}: odd number of time values (${entry.times.join(", ")}) — cannot pair into clock-in/out shifts, skipped, please verify against the original page`,
                            category: "skipped_invalid",
                            date: entryDate,
                        });
                        continue;
                    }
                    if (entry.guessed === true) {
                        warnings.push({
                            source,
                            reason: `day=${entry.day} month=${entry.month} is a model-derived guess (${entry.times.join(", ")})${entry.notes ? `: ${entry.notes}` : ""} — please double check`,
                            category: "flagged_review",
                            date: entryDate,
                        });
                    }
                    // Pair consecutive values into shifts: [in1,out1,in2,out2,...] -> shift per pair.
                    // Multiple TimeEntry objects sharing the same date is exactly how lib/xlsx.ts
                    // already recognizes and handles a multi-shift day (see byCell grouping there).
                    for (let ti = 0; ti < entry.times.length; ti += 2) {
                        timeEntries.push({
                            date: new Date(year, entry.month - 1, entry.day),
                            clockIn: entry.times[ti],
                            clockOut: entry.times[ti + 1],
                            source,
                            guessed: entry.guessed === true,
                        });
                    }
                }
            } finally {
                // Live progress — pushed into the polled job as soon as this page's own processing
                // reaches any exit point (success, non-timesheet skip, or total scan failure), so
                // public/index.html can render "page N done" without waiting for the whole batch.
                // Overwritten with the authoritative final pageReviews (including coverage-check-
                // attached warnings) once the whole job finishes below.
                const job = processJobs.get(jobId);
                if (job && job.status === "running") {
                    job.pages.push({
                        source,
                        image: displayImage,
                        entries: entriesForSource(source),
                        warnings: warnings.filter(w => w.source.split(", ").includes(source)),
                        dataModel,
                        pageContext,
                    });
                }
            }
        }
    }

    // No cross-page/weekday-pattern inference of missing days — a day with no entry anywhere
    // stays uncovered and gets flagged below (coverage check), rather than having hours
    // fabricated from a same-weekday pattern elsewhere in the month. Previously this inferred
    // gaps from weekday patterns, but that produced entries for days the source PDF never
    // actually showed (e.g. a day before the earliest page any file covered) — a wrong entry on
    // a wage claim is worse than a visible, honest gap.

    // One row per calendar date (multi-shift days already collapsed into a single span+break) —
    // this is the editable seed for the human-review step in the browser. Nothing gets written to
    // the spreadsheet until the reviewer submits their (possibly corrected) rows to /api/generate.
    const reviewRows = buildReviewRows(timeEntries, restDays);

    // A day is "covered" once it has a review row at all (worked or rest day) — this is a
    // pre-generate PREVIEW of coverage, not the final word (fillTimesheetFromRows does its own
    // 24h-sanity check later and can still reject a row the human never fixed).
    const coveredByMonth = new Map<string, Set<number>>(); // key `${year}-${monthIndex0}`
    for (const r of reviewRows) {
        const [y, m, d] = r.date.split("-").map(Number);
        const k = `${y}-${m - 1}`;
        (coveredByMonth.get(k) ?? coveredByMonth.set(k, new Set()).get(k)!).add(d);
    }

    // A day that reconciliation already explained with a specific warning (e.g. "dropped due to
    // conflicting reads") doesn't need this generic catch-all repeating "no entry anywhere" for
    // the exact same date — that's the duplication that made the warnings list feel long-winded.
    // Only dates with zero explanation anywhere get the generic message.
    const explainedDates = new Set(warnings.map(w => w.date).filter((d): d is string => d !== undefined));

    // Final coverage check: every skip path above (reconcile, fillTimesheet) is supposed to
    // leave a warning behind — but a page whose model output is a successfully parsed, genuinely
    // empty array isn't a "failure" by any check above, so if that happens on every attempt for
    // a page, a day can vanish with zero trail. Walk every calendar day of every month actually
    // touched by this upload and loudly flag anything still uncovered, regardless of which step
    // (or bug) caused it, so a day is never silently missing again. No inference happens here —
    // an uncovered day just stays uncovered and gets flagged for the user to check manually.
    const monthSummary: { label: string; filled: number; total: number }[] = [];
    for (const [key, daysCovered] of [...coveredByMonth].sort()) {
        const [y, monthIndex0] = key.split("-").map(Number);
        const daysInMonth = new Date(y, monthIndex0 + 1, 0).getDate();
        for (let day = 1; day <= daysInMonth; day++) {
            if (daysCovered.has(day)) continue;
            const dateStr = `${y}-${String(monthIndex0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            if (explainedDates.has(dateStr)) continue;
            const date = new Date(y, monthIndex0, day);
            warnings.push({
                source: "coverage check",
                reason: `${date.toDateString()} has no entry anywhere — not read by any scan attempt on any page, and not a confirmed rest day. Please check the source PDF for this date directly.`,
                category: "missing_data",
                date: dateStr,
            });
        }
        monthSummary.push({ label: `${MONTH_ABBR[monthIndex0]} ${y}`, filled: daysCovered.size, total: daysInMonth });
    }

    // Every entry that was attempted, with its exact origin (a specific page/band scan), so a
    // wrong result (e.g. dates appearing that the source PDF never showed) can be traced back
    // without needing to reproduce the run to find out.
    const scanOutput = [
        ...timeEntries.map(e => ({
            date: toLocalDateString(e.date),
            type: "worked" as const,
            clockIn: e.clockIn,
            clockOut: e.clockOut,
            guessed: e.guessed,
            source: e.source,
        })),
        ...restDays.map(r => ({
            date: `${r.year}-${String(r.month).padStart(2, "0")}-${String(r.day).padStart(2, "0")}`,
            type: "rest_day" as const,
            source: r.source,
        })),
        ...hoursEntries.map(h => ({
            date: toLocalDateString(h.date),
            type: "hours_worked" as const,
            hoursWorked: h.hoursWorked,
            otHours: h.otHours,
            guessed: h.guessed,
            source: h.source,
        })),
    ].sort((a, b) => a.date.localeCompare(b.date));

    // Side-by-side review data: each page's (downscaled) image next to everything relevant to
    // it — every entry attempted from that page (written, flagged, or guessed) plus every warning
    // about it, so a user can visually compare the source handwriting against what the pipeline
    // produced without needing the separate scan-output JSON download. This is the authoritative
    // version — supersedes the live in-progress snapshots pushed into processJobs during the loop
    // above, since only here do coverage-check warnings get attached to their nearest page (below).
    //
    // Every warning attached to a page here is tracked in `assignedWarnings` and excluded from the
    // top-level `warnings` field below — a warning about a specific page belongs next to that page,
    // not duplicated in a separate general list. Only warnings with no page to attach to (e.g. the
    // coverage check for a day nothing ever read, or a file-level "could not read PDF" error) stay
    // in the general list.
    const allWarnings = warnings;
    const assignedWarnings = new Set<FillWarning>();
    const pageReviews: PageReview[] = pageImages.map(({ source, image }) => {
        const entries = entriesForSource(source);

        // Some warnings combine multiple sources into one comma-joined string (e.g. a multi-shift
        // day's shifts collapsing into one row) — split-and-match avoids a prefix false-positive
        // like "file.pdf p1" wrongly matching a warning actually about "file.pdf p10".
        const pageWarnings = allWarnings.filter(w => w.source.split(", ").includes(source));
        pageWarnings.forEach(w => assignedWarnings.add(w));

        const meta = pageMeta.get(source);
        return { source, image, entries, warnings: pageWarnings, dataModel: meta?.dataModel ?? "unclear", pageContext: meta?.pageContext ?? "" };
    });

    // A warning with no specific page source (e.g. the coverage check for a day nothing read at
    // all) still carries a date — matched to whichever page's actual entries sit closest to that
    // day, so it lands next to the page it would have appeared on if the data existed, rather
    // than a generic top-level list. Matched by nearest day-of-month, not just "any page sharing
    // that month" — matters when a month spans multiple pages (e.g. Dec 1-18 on page 1, Dec 19-29
    // on page 2), where a missing day near the end of the month belongs with the page covering
    // that range, not whichever page happens to come first.
    const pageMonthRanges = pageReviews.map(pr => {
        const ranges = new Map<string, { minDay: number; maxDay: number }>(); // "YYYY-MM" -> day range
        for (const e of pr.entries) {
            const ym = e.date.slice(0, 7);
            const day = Number(e.date.slice(8, 10));
            const existing = ranges.get(ym);
            if (!existing) ranges.set(ym, { minDay: day, maxDay: day });
            else {
                existing.minDay = Math.min(existing.minDay, day);
                existing.maxDay = Math.max(existing.maxDay, day);
            }
        }
        return ranges;
    });
    for (const w of allWarnings) {
        if (assignedWarnings.has(w) || !w.date) continue;
        const ym = w.date.slice(0, 7);
        const day = Number(w.date.slice(8, 10));
        let bestIdx = -1;
        let bestDistance = Infinity;
        pageMonthRanges.forEach((ranges, idx) => {
            const range = ranges.get(ym);
            if (!range) return;
            const distance = day < range.minDay ? range.minDay - day : day > range.maxDay ? day - range.maxDay : 0;
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIdx = idx;
            }
        });
        if (bestIdx !== -1) {
            pageReviews[bestIdx].warnings.push(w);
            assignedWarnings.add(w);
        }
    }

    const generalWarnings = allWarnings.filter(w => !assignedWarnings.has(w));

    // Awaited last (not right after being kicked off) so its work overlapped with the timesheet
    // loop above rather than blocking ahead of it.
    const ipa = await ipaPromise;

    const job = processJobs.get(jobId);
    if (!job) return; // expired/evicted before the scan finished — nothing left to report to
    job.pages = pageReviews;
    job.result = {
        success: true,
        year,
        warnings: generalWarnings,
        monthSummary,
        scanOutput,
        pageReviews,
        reviewRows,
        ipa,
        ipaWarning,
        costUsd: totalCostUsd,
        durationMs: Date.now() - startedAt,
    };
    job.status = "done";
}

// Takes the human-reviewed (possibly hand-corrected) rows from the browser's edit step and writes
// them straight to the spreadsheet — no OCR here, this is pure "given these final numbers, fill
// the template" work, so it's fast and synchronous compared to /api/process.
app.post("/api/generate", express.json({ limit: "5mb" }), async (req, res) => {
    const year = Number(req.body?.year);
    if (!SUPPORTED_YEARS.includes(year)) {
        return res.status(400).json({ error: `year must be one of: ${SUPPORTED_YEARS.join(", ")}` });
    }
    const rows = req.body?.rows;
    if (!Array.isArray(rows)) {
        return res.status(400).json({ error: "rows must be an array" });
    }

    let buffer: Buffer;
    let warnings: FillWarning[];
    let writtenDates: Date[];
    try {
        ({ buffer, warnings, writtenDates } = await fillTimesheetFromRows(TEMPLATE_PATH, rows as ReviewRow[]));
    } catch (e: any) {
        return res.status(500).json({ error: `failed to fill template: ${e.message}` });
    }

    // Same "every day of every touched month, flag anything uncovered" coverage check as the scan
    // step's preview, but authoritative now — based on what fillTimesheetFromRows actually wrote
    // (post 24h-sanity-check) plus confirmed rest days, rather than the pre-write preview.
    const coveredByMonth = new Map<string, Set<number>>();
    for (const d of writtenDates) {
        const k = `${d.getFullYear()}-${d.getMonth()}`;
        (coveredByMonth.get(k) ?? coveredByMonth.set(k, new Set()).get(k)!).add(d.getDate());
    }
    for (const r of rows as ReviewRow[]) {
        if (!r.restDay) continue;
        const [y, m, d] = r.date.split("-").map(Number);
        const k = `${y}-${m - 1}`;
        (coveredByMonth.get(k) ?? coveredByMonth.set(k, new Set()).get(k)!).add(d);
    }
    const explainedDates = new Set(warnings.map(w => w.date).filter((d): d is string => d !== undefined));

    const monthSummary: { label: string; filled: number; total: number }[] = [];
    for (const [key, daysCovered] of [...coveredByMonth].sort()) {
        const [y, monthIndex0] = key.split("-").map(Number);
        const daysInMonth = new Date(y, monthIndex0 + 1, 0).getDate();
        for (let day = 1; day <= daysInMonth; day++) {
            if (daysCovered.has(day)) continue;
            const dateStr = `${y}-${String(monthIndex0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            if (explainedDates.has(dateStr)) continue;
            const date = new Date(y, monthIndex0, day);
            warnings.push({
                source: "coverage check",
                reason: `${date.toDateString()} has no row submitted — please check this date directly.`,
                category: "missing_data",
                date: dateStr,
            });
        }
        monthSummary.push({ label: `${MONTH_ABBR[monthIndex0]} ${y}`, filled: daysCovered.size, total: daysInMonth });
    }

    res.json({
        success: true,
        filename: `calculation-filled-${Date.now()}.xlsx`,
        file: buffer.toString("base64"),
        warnings,
        entriesWritten: writtenDates.length,
        monthSummary,
    });
});

// Ground-truth corpus builder, not part of the scan/generate critical path — a user marks a page
// as misread, we store the source image next to what the pipeline produced (rawEntries, the
// pre-edit reconciled output already sent to the browser in /api/process's pageReviews) and what
// the user actually corrected it to (correctedEntries, read back from their edited review rows).
// Used later for prompt fixes/regression tests, not live inference, so a storage hiccup here
// shouldn't look like a failure of the actual scan/generate the user cares about.
app.post("/api/flag-page", express.json({ limit: "5mb" }), async (req, res) => {
    const { source, image, rawEntries, correctedEntries, note, dataModel, pageContext } = req.body ?? {};
    if (typeof source !== "string" || typeof image !== "string" || !Array.isArray(rawEntries) || !Array.isArray(correctedEntries)) {
        return res.status(400).json({ error: "source, image, rawEntries, correctedEntries are required" });
    }
    try {
        const { docId } = await uploadFlaggedPage({
            source,
            image,
            rawEntries: rawEntries as FlaggedPageEntry[],
            correctedEntries: correctedEntries as FlaggedPageEntry[],
            note: typeof note === "string" && note.trim() ? note.trim() : null,
            dataModel: typeof dataModel === "string" ? dataModel : "unclear",
            pageContext: typeof pageContext === "string" ? pageContext : "",
        });
        res.json({ success: true, docId });
    } catch (e: any) {
        console.error("failed to store flagged page:", e);
        res.status(500).json({ error: `failed to store flagged page: ${e.message}` });
    }
});

// Catches multer's upload errors (e.g. a second file sent under the "ipa" field, which
// maxCount: 1 above rejects) so they come back as the same clean JSON shape every other error on
// these routes uses, instead of Express's default HTML 500 page — the frontend only ever expects
// to res.json() a response body, never HTML.
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof multer.MulterError) {
        const message =
            err.code === "LIMIT_UNEXPECTED_FILE" && err.field === "ipa"
                ? "only 1 IPA file is accepted"
                : err.message;
        return res.status(400).json({ error: message });
    }
    next(err);
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
