import express from "express";
import multer from "multer";
import * as path from "path";
import { randomUUID } from "crypto";
import { pdfToImages, imageToPages, scanPageImage, extractJsonBlock, cropIntoBands, extractPageContext, verifyDatesOnPage, resizeForDisplay, rotateImage, PRIMARY_VISION_MODEL, FALLBACK_VISION_MODEL, type PageDataModel } from "./lib/ocr";
import { buildReviewRows, fillTimesheetFromRows, MONTH_ABBR, type TimeEntry, type FillWarning, type RestDay, type ReviewRow } from "./lib/xlsx";
import { reconcileAttempts, type ParsedEntry } from "./lib/reconcile";
import { uploadFlaggedPage, type FlaggedPageEntry } from "./lib/feedback";
import { extractIpaFields, type IpaFields } from "./lib/ipa";
import { extractMatchingTransactions, type BankTransaction } from "./lib/bankstatement";

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

// memoryStorage() means every uploaded byte sits in process RAM (times ~10-20x again once
// pdf-to-img/sharp rasterize each page) until the job finishes — a file large enough to blow past
// the container's memory limit gets the whole process OOM-killed by the OS, silently taking down
// every other in-flight scan's job too (see JOB_TTL_MS above). Rejecting oversized uploads up
// front with a clear 400 is far better than that.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 40 * 1024 * 1024, files: 10 },
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
    entries: { date: string; type: string;[k: string]: unknown }[];
    warnings: FillWarning[];
    dataModel: PageDataModel;
    pageContext: string;
    modelsUsed: string[]; // every model that touched this page — always PRIMARY_VISION_MODEL, plus FALLBACK_VISION_MODEL if that page's escalation step ran
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

// Separate job type/store from ProcessJob above — a bank-statement scan is a standalone
// cross-check against a worker's own claimed payments, not part of the timesheet/IPA pipeline
// (different files, no year, no spreadsheet output), so it gets its own background-job track
// rather than being bolted onto processJobs' shape.
type BankStatementPageResult = { source: string; image: string; transactions: BankTransaction[] };
type BankStatementJob = {
    status: "running" | "done" | "error";
    pages: BankStatementPageResult[];
    result: { transactions: (BankTransaction & { source: string })[]; totalCredits: number; costUsd: number; durationMs: number } | null;
    error: string | null;
};
const bankJobs = new Map<string, BankStatementJob>();
function scheduleBankJobCleanup(jobId: string) {
    setTimeout(() => bankJobs.delete(jobId), JOB_TTL_MS);
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

// Handwritten years are frequently misread by OCR (e.g. "2023" instead of "2026") — this per-row
// scan still never asks the model for a year, only day/month/clock times, same as before. The
// year used below is resolved ONCE per job (runProcessJob's prescan, before this function is ever
// called) from page-level PRINTED/TYPED headers via extractPageContext (lib/ocr.ts) — a much safer
// read than trusting handwritten digits in the row data itself — validated against SUPPORTED_YEARS
// before any scanning starts, since this template only has sheets for SUPPORTED_YEARS.
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
export function buildPrompt(
    year: number,
    pageContext: string,
    dataModelHint: PageDataModel,
): string {
    const hintLine =
        dataModelHint === "hours_total"
            ? "An earlier pass guessed that this page records total hours worked (and possibly overtime) rather than clock in/out times. Treat this only as a hint and verify the actual image. If clock times are visibly present, extract those instead."
            : dataModelHint === "clock_times"
                ? "An earlier pass guessed that this page records actual clock in/out times. Treat this only as a hint and verify the actual image."
                : dataModelHint === "punch_log"
                    ? "An earlier pass guessed that this page is a phone application's punch-log screen containing individual timestamped events. Treat this only as a hint and verify the actual image."
                    : "An earlier pass could not confidently determine the page's data model. Determine it from the actual image.";

    return `You are extracting attendance and work-time information from a single page of a worker's time or attendance record.

        The page is used to fill a wage-claim spreadsheet for the year ${year}.

        The page may be:
        - handwritten or typed/computer-generated
        - in English, Chinese, Bengali, or a mixture of languages
        - a traditional row-per-day table
        - two half-month tables side by side
        - a weekly/monthly calendar grid
        - a free-form handwritten list
        - a punch card
        - a phone application's punch-log screen
        - another unfamiliar attendance/time layout

        Your primary responsibility is ACCURATE VISUAL TRANSCRIPTION.

        Read what is actually visible in the image.

        Do NOT invent, reconstruct, or "repair" information that is not clearly supported by the image.

        Do NOT use patterns from other dates to fill in missing information.

        Do NOT change a visually read value merely because another value would make more logical sense.

        Downstream code will perform business-rule validation and calculations.

        PAGE-LEVEL CONTEXT:
        ${pageContext || "none found"}

        FORMAT HINT:
        ${hintLine}

        IMPORTANT: The page-level context and format hint are supporting information only. Always verify them against the actual image.

        --------------------------------------------------
        1. IDENTIFY EVERY POPULATED DATE ENTRY
        --------------------------------------------------

        Identify every actual date entry visible on this page.

        A date entry may be represented by:
        - a table row
        - a calendar-grid cell
        - a free-form dated entry
        - one or more punch-log records belonging to the same date

        Do NOT assume that every day of the month appears.

        Do NOT output completely blank rows or cells.

        However, ANY visible mark means the date entry is populated and must be output, including:
        - clock times
        - total hours
        - overtime
        - checkmarks
        - tally marks
        - dashes
        - X marks
        - leave codes
        - handwritten notes
        - other visible notation

        The only reason to omit a date entirely is that its corresponding region is genuinely completely blank.

        --------------------------------------------------
        2. READ EACH DATE INDEPENDENTLY
        --------------------------------------------------

        Every date must be read independently from its own visual region.

        Never copy or infer information from:
        - previous rows
        - following rows
        - neighboring calendar cells
        - neighboring columns
        - other dates
        - repeated weekdays
        - repeated weekly patterns
        - visually similar handwriting
        - dominant values appearing elsewhere on the page

        A repeated pattern is NOT evidence that another date contains the same value.

        For example, if dates 9 and 11 both contain "09:00 - 19:00", but date 10 contains only a checkmark, do NOT give date 10 the times from dates 9 or 11.

        Only report clock times that are actually visible inside that date's own region.

        --------------------------------------------------
        3. EXTRACT CLOCK TIMES
        --------------------------------------------------

        When actual clock times are visible for a date, extract EVERY clock-time value belonging to that date.

        Do not decide how many shifts the worker worked.

        Do not pair or group the times into shifts.

        Simply transcribe every visible clock-time value belonging to that date.

        For a normal table row:
        - read times from left to right

        For a calendar cell:
        - read times in the natural top-to-bottom/reading order inside that cell

        For a free-form entry:
        - use the natural reading order of that entry

        Return clock times as bare 24-hour integers with no colon.

        Examples:
        - 8:00am -> 800
        - 8:30am -> 830
        - 1:30pm -> 1330
        - 10:00pm -> 2200

        Do not include seconds.

        A normal day with one shift might therefore produce:

        [800, 1700]

        A split day might produce:

        [800, 1200, 1300, 1700]

        A day with three shifts might produce six values.

        Report every visible time. Do not stop after finding the first pair.

        --------------------------------------------------
        4. SCAN THE ENTIRE LOGICAL DATE REGION
        --------------------------------------------------

        Before finalizing a date, inspect the entire region belonging to that date.

        For a table:
        - inspect the full width of the row

        For a calendar:
        - inspect the entire cell

        For a free-form entry:
        - inspect the complete logical entry

        Do not stop after finding the first clock-in/clock-out pair.

        A row may contain 2, 4, 6, or more clock-time values.

        If more than two time values are visible, report ALL of them.

        --------------------------------------------------
        5. 12AM AND 12PM
        --------------------------------------------------

        Distinguish noon and midnight carefully.

        - 12pm = 1200
        - 12am = midnight

        When midnight is the endpoint of a shift that began earlier on that calendar date, represent it as 2400 where appropriate.

        For example:

        6am - 12pm, 6pm - 12am

        becomes:

        [600, 1200, 1800, 2400]

        Do not convert both occurrences of "12" to the same value when the visual context distinguishes noon from midnight.

        If the distinction genuinely cannot be determined from the image, do not guess. Return null for the times and explain the ambiguity in notes.

        --------------------------------------------------
        6. OVERNIGHT SHIFTS
        --------------------------------------------------

        An overnight shift may contain a time that is numerically smaller than the preceding time.

        For example:

        2200 - 0600

        is valid visual information.

        Do NOT reorder the times.

        Do NOT change 0600 to another value.

        Report the values in the order they are visually written.

        If the sequence appears unusual, preserve the visual transcription. Do not alter it merely to make the numbers increase.

        --------------------------------------------------
        7. HOUR-ONLY CLOCK-TIME SHORTHAND
        --------------------------------------------------

        Some workers write clock-in/out times using shorthand such as:

        08/20

        or:

        08-20

        even when the printed column label does not indicate that the field is for time.

        When the actual row/context clearly shows that such a value represents clock hours, interpret it as:

        [800, 2000]

        Do NOT automatically interpret every NN/NN or NN-NN value as a date.

        A real calendar date normally belongs to the date/day portion of the record. A second date-like value elsewhere may instead be a clock-time shorthand.

        Use the actual contents and visual structure of the row.

        If the meaning genuinely remains ambiguous, do not guess. Return the affected time information as null and explain the ambiguity in notes.

        --------------------------------------------------
        8. HOURS-ONLY RECORDS
        --------------------------------------------------

        Some pages record only total hours worked per day, without clock in/out times.

        Examples:

        8

        8 + 2 OT

        8.5 hours

        If a date genuinely has NO clock times and instead provides only a total-hours figure:

        - times = null
        - hoursWorked = the visible total
        - otHours = the visible overtime, if any

        For example:

        8 + 2 OT

        means:

        hoursWorked = 8
        otHours = 2

        Do NOT invent clock times from total hours.

        If actual clock times ARE visible for that date, report those in times.

        When times is populated:
        - hoursWorked should be null
        - otHours should be null

        Do not calculate missing clock times from a total-hours value.

        --------------------------------------------------
        9. BARE PRESENCE MARKS
        --------------------------------------------------

        A checkmark, tally mark, X, or similar presence mark does not itself provide a clock time or duration.

        If a date contains only a presence mark:

        - times = null
        - hoursWorked = null
        - otHours = null
        - rest_day = false

        Describe the mark briefly in notes.

        Do NOT infer a duration from the mark.

        Do NOT copy times from surrounding dates.

        --------------------------------------------------
        10. REST DAYS, LEAVE, AND NON-WORKED MARKINGS
        --------------------------------------------------

        If a date is explicitly marked as not worked, still output that date.

        Examples include:
        - OFF
        - REST
        - rest day
        - holiday
        - public holiday
        - MC
        - medical leave
        - AL
        - annual leave
        - EL
        - emergency leave
        - unpaid leave
        - X
        - a deliberate dash indicating a non-worked day
        - another explicit leave/non-work notation

        For an explicitly non-worked date:

        - rest_day = true
        - times = null

        Put the literal visible notation in notes when useful.

        Do NOT infer clock times for a leave/rest entry.

        If an unfamiliar notation is visible but its meaning cannot be determined, transcribe it in notes rather than inventing an interpretation.

        A named public holiday (e.g. a printed "New Year's Day" label on a calendar template) combined with a dash drawn in the SAME box is not a special or ambiguous case — it is simply two signals agreeing with each other that this date was not worked. Do not let the presence of BOTH a printed holiday name AND a dash confuse you into treating the box as needing extra scrutiny or a different rule; it still gets rest_day = true, times = null, exactly like any other box with a dash. A box with a named holiday label is not automatically exempt from also being read for a dash — check every box the same way regardless of what else is printed in it.

        --------------------------------------------------
        11. Dashes AND CHECKMARKS IN CALENDAR GRIDS
        --------------------------------------------------

        A dash or checkmark inside a calendar date cell belongs only to that date.

        Never use neighboring dates to determine what it means.

        For example:

        Date 9:
        09:00 - 19:00

        Date 10:
        -

        Date 11:
        09:00 - 19:00

        Date 10 must NOT receive 09:00 - 19:00.

        A bare dash "-" or short horizontal line drawn in a date's box ALWAYS means that date was not worked — treat it exactly the same as an explicit "OFF"/"rest day" notation from section 10 above, with no exceptions:
        - rest_day = true
        - times = null
        - notes = "-"

        Do not second-guess this by asking "is this dash CLEARLY non-worked, or just a presence mark?" — a dash by itself, with no time text next to it, is never merely a presence mark. It is common for a page to show the SAME repeated time (e.g. "09:00-19:00") in most boxes for a given weekday, with only one or two boxes on that weekday instead containing a bare dash — that repetition elsewhere does NOT make the dash on this date ambiguous; still set rest_day = true, times = null for it. If you find yourself writing "dash mark" or similar into notes for a date, rest_day for that SAME date must be true — never write a dash into notes and then leave rest_day false, that is a direct contradiction.

        A CHECKMARK or tally mark (a tick, a small check symbol — visually distinct from a dash/line) with no time text is a different case: a bare presence mark, not a claim about whether the day was worked.
        - rest_day = false
        - times = null
        - describe it in notes

        --------------------------------------------------
        12. NO-BREAK INFORMATION
        --------------------------------------------------

        Set:

        noBreak = true

        ONLY when the current date explicitly indicates that no meal break was taken.

        Examples include:
        - no lunch
        - no break
        - no meal break
        - straight shift
        - continuous
        - an explicit zero/no-break notation in a clearly identifiable break/lunch field

        The absence of a break entry does NOT mean no break.

        Do NOT infer noBreak from:
        - shift duration
        - number of time values
        - missing lunch information
        - the page template

        If there is no explicit evidence that no break was taken:

        noBreak = false

        --------------------------------------------------
        13. PRINTED COLUMN LABELS MAY BE WRONG
        --------------------------------------------------

        Do not blindly trust printed column labels.

        A worker may write information in a different column from what the printed template intended.

        Interpret the actual content and surrounding visual structure.

        For example, a column printed "Amount" may contain a handwritten clock-time shorthand.

        The actual written content is more important than blindly trusting the printed label.

        However, do not reinterpret genuinely ambiguous information merely because another interpretation is convenient.

        --------------------------------------------------
        14. PUNCH-LOG SCREENSHOTS
        --------------------------------------------------

        Some pages are screenshots of phone clock-in applications.

        These may contain a chronological list of individual timestamped events rather than one row per day.

        Example:

        12-06-2026 06:29:54
        12-06-2026 19:50:07

        For punch-log layouts:

        1. Read every visible timestamp.
        2. Remove seconds completely.
        3. Group all timestamps belonging to the same calendar date into ONE output object.
        4. Sort that date's times chronologically from earliest to latest.
        5. Do not preserve newest-first display order.
        6. Do not output multiple objects for the same date.

        For example:

        20:07:32
        06:26:15

        on the same date becomes:

        [626, 2007]

        Seconds must NOT be included.

        If the date or time cannot be read reliably, do not guess.

        --------------------------------------------------
        15. HANDWRITING AND VISUAL AMBIGUITY
        --------------------------------------------------

        Handwritten digits may be difficult to distinguish.

        If a value could visually be either one digit or another, do not resolve the ambiguity using surrounding patterns.

        For example, if a handwritten value could be 3 or 8:

        Do NOT choose 8 merely because other rows contain 8.

        Do NOT choose the value that makes the work duration look more reasonable.

        If the value cannot be determined reliably from the image:
        - do not guess
        - set times = null for the affected date if the ambiguity prevents reliable extraction
        - explain the ambiguity briefly in notes

        Visual accuracy is more important than producing a complete-looking answer.

        --------------------------------------------------
        16. CLOCK TIMES AND WRITTEN TOTALS
        --------------------------------------------------

        A row may contain both raw clock times and a written total/duration.

        Transcribe both independently.

        Do NOT change the clock times to make them agree with the total.

        Do NOT change the total to make it agree with the clock times.

        If they conflict, preserve the visible information and explain the discrepancy in notes.

        Downstream code will perform arithmetic and business-rule validation.

        --------------------------------------------------
        17. DO NOT APPLY BUSINESS RULES DURING TRANSCRIPTION
        --------------------------------------------------

        Do not modify visually extracted values merely because they violate an expected business rule.

        For example, if the extracted times appear to imply:
        - an unusually long shift
        - an overnight shift
        - a mismatch with total hours
        - an unusual number of clock times

        preserve the actual visual transcription if it can be read.

        If necessary, mention the unusual condition in notes.

        Do NOT "fix" the visual reading to make it conform to a business rule.

        --------------------------------------------------
        18. FINAL VISUAL VERIFICATION
        --------------------------------------------------

        Before returning the result, perform a final independent visual check.

        Verify:

        1. Every populated date visible on the page is represented.
        2. Completely blank dates were not added.
        3. Each date was read from its own visual region.
        4. No value was copied from another date.
        5. No missing clock time was invented.
        6. Every visible clock time belonging to each date was included.
        7. Times are in the correct reading order for that layout.
        8. Punch-log events for the same date were merged.
        9. Punch-log times were sorted chronologically.
        10. Seconds were removed.
        11. 12am and 12pm were distinguished where visually determinable.
        12. Hours-only records did not receive invented clock times.
        13. Leave/rest markings have times = null.
        14. noBreak is true only when explicitly supported by that date's own content.
        15. Printed column labels were not blindly trusted.
        16. Ambiguous handwriting was not silently guessed.
        17. Conflicts between clock times and written totals are described in notes rather than "fixed".

        This verification is a visual verification only.

        Do not change a visually supported value merely to satisfy arithmetic or business rules.

        --------------------------------------------------
        19. OUTPUT SCHEMA
        --------------------------------------------------

        For every populated date entry, output an object containing EXACTLY these fields:

        - day: integer 1-31
        - month: integer 1-12
        - times: array of clock-time integers, or null
        - hoursWorked: number, or null
        - otHours: number, or null
        - noBreak: boolean
        - rest_day: boolean
        - notes: string or null

        Rules:

        times should be null when:
        - no clock times exist
        - the date is explicitly not worked
        - only total hours are present
        - the clock times cannot be read reliably
        - the visible notation does not provide a determinable clock time

        hoursWorked should be populated ONLY when:
        - times is null
        - and a genuine total-hours value is visibly shown

        otHours should be populated ONLY when:
        - an overtime value is explicitly shown
        - alongside an hours-only record

        noBreak:
        - true only when explicitly stated for that date
        - false otherwise

        rest_day:
        - true only when the date is explicitly marked as not worked
        - false otherwise

        notes:
        - normally null
        - use a short explanation when information is ambiguous, missing, unusual, contradictory, or otherwise requires human review
        - for leave/rest markings, include the literal visible notation when useful

        --------------------------------------------------
        20. OUTPUT FORMAT
        --------------------------------------------------

        Return ONLY a valid JSON array.

        Do NOT return:
        - markdown
        - code fences
        - explanations
        - commentary
        - headings
        - text before or after the JSON

        Each object must contain exactly:

        day
        month
        times
        hoursWorked
        otHours
        noBreak
        rest_day
        notes

        Example structure:

        [
        {
            "day": 1,
            "month": 6,
            "times": [800, 1200, 1300, 1700],
            "hoursWorked": null,
            "otHours": null,
            "noBreak": false,
            "rest_day": false,
            "notes": null
        }
        ]`;
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
        { name: "bankStatement", maxCount: 10 },
    ]),
    async (req, res) => {
        const uploadedFields = req.files as { [field: string]: Express.Multer.File[] } | undefined;
        const files = uploadedFields?.pdfs ?? [];
        const ipaFile = uploadedFields?.ipa?.[0];
        const bankStatementFiles = uploadedFields?.bankStatement ?? [];

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

        // Same staging idea as pdfs above — a bank statement is just as likely to be a phone
        // photo as a clean digital export, so it gets the same rotate/exclude-before-scan step.
        const bankStatementPreview: { fileIndex: number; pageIndex: number; fileName: string; image: string }[] = [];
        const bankStatementErrors: { fileName: string; error: string }[] = [];
        for (let fi = 0; fi < bankStatementFiles.length; fi++) {
            const file = bankStatementFiles[fi];
            try {
                const images = await loadPagesForFile(file);
                for (let pi = 0; pi < images.length; pi++) {
                    bankStatementPreview.push({ fileIndex: fi, pageIndex: pi, fileName: file.originalname, image: await resizeForDisplay(images[pi], 400) });
                }
            } catch (e: any) {
                bankStatementErrors.push({ fileName: file.originalname, error: e.message });
            }
        }

        res.json({ pdfsPreview, pdfsErrors, ipaPreview, ipaError, bankStatementPreview, bankStatementErrors });
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

        // The caseworker's declared standard break (public/index.html's radio group) — used as
        // the assumed break for single-shift days (nothing is actually observed to contradict it
        // there) and as the value a multi-shift day's genuinely observed gap gets compared against
        // client-side (checkBreakMismatch). Falls back to 1h on anything unparseable/out of range,
        // matching the form's own default.
        const parsedBreakHours = Number(req.body.standardBreakHours);
        const standardBreakHours = Number.isFinite(parsedBreakHours) && parsedBreakHours >= 0 ? parsedBreakHours : 1;

        // A real scan (many pages, sequential) can run 15-20+ minutes — long enough that holding this
        // HTTP request open the whole time is fragile (proxies/networks can drop a connection that
        // long) and gives the browser zero visibility into progress until the very end. Instead: kick
        // the scan off as a background job and return its id immediately; public/index.html polls
        // GET /api/process/:jobId, which renders each page's card as soon as that page finishes rather
        // than waiting for the entire batch.
        const jobId = randomUUID();
        processJobs.set(jobId, { status: "running", pages: [], result: null, error: null });
        runProcessJob(jobId, files, ipaFile, rotations, excludedPages, standardBreakHours)
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
    rotations: RotationMap,
    excludedPages: Set<string>,
    standardBreakHours: number
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
    // The model every timesheet-scanning call (page-context reads, scan attempts, date
    // verification) uses — now just PRIMARY_VISION_MODEL directly, same as IPA/bank-statement
    // extraction, now that all three document types are on the same model (see lib/ocr.ts). Kept as
    // its own named binding (rather than inlining PRIMARY_VISION_MODEL at each call site) so a
    // future model split between document types is a one-line change here again, not a hunt through
    // every call site.
    const timesheetModel = PRIMARY_VISION_MODEL;
    let totalCostUsd = 0; // sums OpenRouter's own reported usage.cost across every call this request makes
    // Split out by model id (e.g. PRIMARY_VISION_MODEL vs FALLBACK_VISION_MODEL) so a caseworker can
    // see how much of a job's cost came from the cheap default pass vs the fallback-model escalation
    // — the hybrid setup only pays fallback-model rates on the specific pages that needed it.
    const costByModel: Record<string, number> = {};
    function addCost(model: string, cost: number) {
        totalCostUsd += cost;
        costByModel[model] = (costByModel[model] ?? 0) + cost;
    }
    // Every page always uses PRIMARY_VISION_MODEL at least once (page-context read, if nothing
    // else); FALLBACK_VISION_MODEL is added to a page's set only if that page's escalation step
    // actually ran. Surfaced per-page in pageReviews so a caseworker can see which pages needed the
    // more expensive model, not just the job-wide total.
    const pageModelsUsed = new Map<string, Set<string>>();
    function markModelUsed(source: string, model: string) {
        const set = pageModelsUsed.get(source) ?? new Set<string>();
        set.add(model);
        pageModelsUsed.set(source, set);
    }
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
    // Resized display copy of the IPA's own page, alongside its extracted fields — public/index.html
    // shows this next to the editable salary/allowance inputs in the page-by-page review, the same
    // "verify against the source scan" pattern every timesheet page already gets.
    let ipaImage: string | null = null;
    const ipaPromise: Promise<IpaFields | null> = ipaFile
        ? (async () => {
            try {
                const images = await loadPagesForFile(ipaFile);
                if (images.length === 0) {
                    ipaWarning = "IPA file had no readable pages";
                    return null;
                }
                const image = rotations.ipa ? await rotateImage(images[0], rotations.ipa) : images[0];
                ipaImage = await resizeForDisplay(image, 500);
                const { fields, cost } = await extractIpaFields(image);
                addCost(PRIMARY_VISION_MODEL, cost);
                return fields;
            } catch (e: any) {
                ipaWarning = `could not process IPA document: ${e.message}`;
                return null;
            }
        })()
        : Promise.resolve(null);

    // ---- Resolve each page's own claim year before any per-row scanning starts ---------------
    // buildPrompt (below) bakes a resolved year into a page's prompt text, so it has to be known
    // before the main loop's first buildPrompt call, not discovered partway through it. Loads
    // every file's pages once here (rotated to their confirmed orientation) and the main loop
    // below reuses this same in-memory array — this isn't a second, wasted image-load pass. Only
    // extractPageContext (a cheap page-level read, the same one month-header detection already
    // relies on) runs an extra time here, once per non-excluded page, looking for a printed/typed
    // year label. See lib/ocr.ts's extractPageContext and the updated comment above buildPrompt.
    //
    // Deliberately PER-PAGE, not one job-wide majority vote — a real multi-month upload can
    // genuinely span a year boundary (e.g. Sep 2025 - Jul 2026, one sheet per month, each with its
    // own correct "Month Year" header), and a single job-wide vote would let the more numerous
    // year silently overwrite the genuinely different year on the minority pages, mislabeling
    // real, correctly-scanned data. Each page keeps its own resolved year instead.
    const imagesByFile: string[][] = [];
    const fileLoadErrors = new Map<number, string>();
    const pageContextCache = new Map<string, { context: string; isTimesheet: boolean; dataModel: PageDataModel; year: number | null }>();
    for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        try {
            imagesByFile[fi] = await loadPagesForFile(file);
        } catch (e: any) {
            const isImage = file.mimetype.startsWith("image/");
            fileLoadErrors.set(fi, `could not read ${isImage ? "image" : "PDF"}: ${e.message}`);
            imagesByFile[fi] = [];
            continue;
        }
        for (let i = 0; i < imagesByFile[fi].length; i++) {
            if (excludedPages.has(`${fi}-${i}`)) continue;
            const pageRotation = rotations.pdfs?.[`${fi}-${i}`];
            if (pageRotation) imagesByFile[fi][i] = await rotateImage(imagesByFile[fi][i], pageRotation);
            const source = `${file.originalname} p${i + 1}`;
            try {
                const result = await extractPageContext(imagesByFile[fi][i], timesheetModel);
                const validYear = result.year !== null && SUPPORTED_YEARS.includes(result.year) ? result.year : null;
                pageContextCache.set(source, { context: result.context, isTimesheet: result.isTimesheet, dataModel: result.dataModel, year: validYear });
                addCost(timesheetModel, result.cost);
                markModelUsed(source, timesheetModel);
            } catch {
                // Leave uncached — the main loop below re-attempts extractPageContext itself and
                // reports the failure there, same as it always has.
            }
        }
    }

    // Fill in pages that had no year label of their own (common — a header is often only printed
    // once per month/section, not on every page) from the NEAREST page in the SAME FILE that did
    // have one — forward first (a header usually precedes the pages it covers), then backward for
    // any still-unresolved leading pages. Scoped to one file at a time: two separately uploaded
    // files have no guaranteed relationship to each other, so a year detected in file A must never
    // leak into file B's undated pages.
    const resolvedYearBySource = new Map<string, number>();
    for (let fi = 0; fi < files.length; fi++) {
        const images = imagesByFile[fi];
        if (!images) continue;
        const sources = images.map((_, i) => `${files[fi].originalname} p${i + 1}`).filter(s => pageContextCache.has(s));
        let lastKnown: number | null = null;
        for (const source of sources) {
            const y = pageContextCache.get(source)!.year;
            if (y !== null) lastKnown = y;
            else if (lastKnown !== null) resolvedYearBySource.set(source, lastKnown);
            if (y !== null) resolvedYearBySource.set(source, y);
        }
        lastKnown = null;
        for (let idx = sources.length - 1; idx >= 0; idx--) {
            const source = sources[idx];
            const y = pageContextCache.get(source)!.year;
            if (y !== null) lastKnown = y;
            else if (!resolvedYearBySource.has(source) && lastKnown !== null) resolvedYearBySource.set(source, lastKnown);
        }
    }

    if (resolvedYearBySource.size === 0) {
        const job = processJobs.get(jobId);
        if (job) {
            job.status = "error";
            job.error = "Could not detect a claim year from any uploaded page — none had a printed/typed date header (a title, filename, or form field naming the month/year), and none fell in the supported range (" + SUPPORTED_YEARS.join(", ") + ").";
        }
        return;
    }

    for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        const loadError = fileLoadErrors.get(fi);
        if (loadError) {
            warnings.push({ source: file.originalname, reason: loadError, category: "system" });
            continue;
        }
        const images = imagesByFile[fi];

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
                // Rotation was already applied in the prescan pass above (images[i] here is the same
                // mutated array), so this is just building the display copy — everything downstream
                // sees the human-confirmed upright orientation from the /api/preview staging step,
                // not the raw (possibly sideways) render.
                displayImage = await resizeForDisplay(images[i]);
                pageImages.push({ source, image: displayImage });

                // Page-level context (e.g. a month header) + timesheet/data-model classification —
                // normally already computed by the prescan pass above; only re-run here on a prescan
                // cache miss (that page's extractPageContext call itself failed up there).
                let cached = pageContextCache.get(source);
                if (!cached) {
                    try {
                        const result = await extractPageContext(images[i], timesheetModel);
                        const validYear = result.year !== null && SUPPORTED_YEARS.includes(result.year) ? result.year : null;
                        cached = { context: result.context, isTimesheet: result.isTimesheet, dataModel: result.dataModel, year: validYear };
                        addCost(timesheetModel, result.cost);
                        markModelUsed(source, timesheetModel);
                        // Same forward/backward-fill this page missed out on during the prescan pass
                        // (its own extractPageContext call failed there) — fall back to whichever
                        // neighboring page in this SAME file already has a resolved year, preferring
                        // the previous page (a header usually precedes the pages it covers).
                        if (validYear !== null) {
                            resolvedYearBySource.set(source, validYear);
                        } else if (!resolvedYearBySource.has(source)) {
                            const prevYear = i > 0 ? resolvedYearBySource.get(`${file.originalname} p${i}`) : undefined;
                            const nextYear = resolvedYearBySource.get(`${file.originalname} p${i + 2}`);
                            const fallbackYear = prevYear ?? nextYear;
                            if (fallbackYear !== undefined) resolvedYearBySource.set(source, fallbackYear);
                        }
                    } catch (e: any) {
                        warnings.push({ source, reason: `could not extract page-level context (e.g. month header): ${e.message} — bands will rely on per-row reading only`, category: "scan_quality" });
                    }
                }
                if (cached) {
                    pageContext = cached.context;
                    dataModel = cached.dataModel;
                    pageMeta.set(source, { dataModel, pageContext });
                    if (!cached.isTimesheet) {
                        warnings.push({
                            source,
                            reason: `page does not appear to be a work time/attendance record${pageContext ? ` (${pageContext})` : ""} — skipped, no scan attempts made`,
                            category: "system",
                        });
                        continue;
                    }
                }
                const pageYear = resolvedYearBySource.get(source);
                if (pageYear === undefined) {
                    warnings.push({
                        source,
                        reason: "could not determine which year this page's dates belong to (no printed/typed year header on this page, and no nearby page in the same file to infer it from) — skipped, no scan attempts made",
                        category: "system",
                    });
                    continue;
                }
                const prompt = buildPrompt(pageYear, pageContext, dataModel);

                const bands = await cropIntoBands(images[i], BANDS_PER_PAGE);

                // flatten band x temperature into one parallel batch for max concurrency — all
                // bands' attempts fire together rather than band-by-band, so wall-clock time stays
                // close to a single batch's latency despite more total calls.
                const scanJobs = bands.flatMap((bandImage, b) =>
                    SCAN_TEMPERATURES.map(({ temperature, seed }) => ({ bandImage, b, temperature, seed }))
                );
                const results = await Promise.allSettled(
                    scanJobs.map(({ bandImage, temperature, seed }) => scanPageImage(bandImage, prompt, temperature, seed, timesheetModel))
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
                    addCost(timesheetModel, cost);
                    markModelUsed(source, timesheetModel);
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
                    const { entries: bandEntries, warnings: bandWarnings } = reconcileAttempts(attemptsByBand[b], bandSource, true, pageYear, orderMatters);
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
                const { entries: reconciled, warnings: crossBandWarnings } = reconcileAttempts(bandResults, source, false, pageYear, orderMatters);
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
                        const { confirmed, cost } = await verifyDatesOnPage(images[i], candidates, timesheetModel);
                        addCost(timesheetModel, cost);
                        markModelUsed(source, timesheetModel);
                        parsed = reconciled.filter(e => {
                            if (e.day === null || e.month === null) return true; // let existing validation handle it
                            const isConfirmed = confirmed.has(`${e.month}-${e.day}`);
                            if (!isConfirmed) {
                                warnings.push({
                                    source,
                                    reason: `day=${e.day} month=${e.month}: failed page-level verification (no genuine row found for this date on a full-page recheck) — dropped, please check the source PDF for this date directly`,
                                    category: "dropped_disagreement",
                                    date: `${pageYear}-${String(e.month).padStart(2, "0")}-${String(e.day).padStart(2, "0")}`,
                                });
                            }
                            return isConfirmed;
                        });
                    } catch (e: any) {
                        warnings.push({ source, reason: `date verification pass failed (${e.message}) — entries for this page were NOT independently verified, please review carefully`, category: "scan_quality" });
                    }
                }

                // Hybrid escalation: timesheetModel is normally the cheap PRIMARY_VISION_MODEL, which
                // occasionally can't reach agreement on a date — those show up as "dropped_disagreement"
                // warnings just above, from either band-level reconciliation or the verification pass.
                // Rather than re-scanning the whole page with the far more expensive
                // FALLBACK_VISION_MODEL (real side-by-side testing found it meaningfully more accurate
                // on hard cases, but ~5x the cost), ONE extra full-page call resolves just the disputed
                // dates. Most pages never trigger this at all — the added cost only lands on pages that
                // actually needed it. NOTE: currently redundant while timesheetModel is itself pointed
                // at FALLBACK_VISION_MODEL (see its declaration above) — escalating to the same model
                // that already produced the disagreement won't recover anything new.
                const disputedDates = new Set(
                    warnings
                        .filter(w => w.source === source && w.category === "dropped_disagreement" && w.date)
                        .map(w => {
                            const [, m, d] = w.date!.split("-").map(Number);
                            return `${m}-${d}`;
                        })
                );
                if (disputedDates.size > 0) {
                    try {
                        const { content: fallbackContent, cost: fallbackCost } = await scanPageImage(images[i], prompt, 0, 42, FALLBACK_VISION_MODEL);
                        addCost(FALLBACK_VISION_MODEL, fallbackCost);
                        markModelUsed(source, FALLBACK_VISION_MODEL);
                        const fallbackParsed = JSON.parse(extractJsonBlock(fallbackContent)) as ParsedEntry[];
                        for (const fbEntry of fallbackParsed) {
                            if (fbEntry.day === null || fbEntry.month === null) continue;
                            const key = `${fbEntry.month}-${fbEntry.day}`;
                            if (!disputedDates.has(key)) continue;
                            // Only trust a confident fallback reading — same "genuine reading, not a
                            // guess" bar as the primary pipeline. A fallback attempt that ALSO
                            // couldn't read the date (times/rest_day/hoursWorked all empty) leaves the
                            // original drop in place rather than adding noise.
                            const hasRealReading =
                                (fbEntry.times && fbEntry.times.length > 0) ||
                                fbEntry.rest_day === true ||
                                (fbEntry.hoursWorked !== null && fbEntry.hoursWorked !== undefined);
                            if (!hasRealReading) continue;
                            parsed = [
                                ...parsed.filter(e => !(e.day === fbEntry.day && e.month === fbEntry.month)),
                                {
                                    ...fbEntry,
                                    guessed: true,
                                    notes: `resolved via fallback model (${FALLBACK_VISION_MODEL}) after primary model's attempts disagreed — please verify${fbEntry.notes ? `: ${fbEntry.notes}` : ""}`,
                                },
                            ];
                            disputedDates.delete(key);
                            warnings.push({
                                source,
                                reason: `day=${fbEntry.day} month=${fbEntry.month}: primary model's attempts disagreed (see above), but ${FALLBACK_VISION_MODEL} resolved it confidently — used its reading instead of dropping the day, please verify against the source PDF`,
                                category: "flagged_review",
                                date: `${pageYear}-${String(fbEntry.month).padStart(2, "0")}-${String(fbEntry.day).padStart(2, "0")}`,
                            });
                        }
                    } catch (e: any) {
                        warnings.push({
                            source,
                            reason: `fallback-model escalation for ${disputedDates.size} disputed date(s) failed (${e.message}) — those dates remain dropped`,
                            category: "scan_quality",
                        });
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
                    const daysInThisMonth = new Date(pageYear, entry.month, 0).getDate();
                    if (entry.day > daysInThisMonth) {
                        warnings.push({
                            source,
                            reason: `day=${entry.day} does not exist in month=${entry.month}/${pageYear} (only has ${daysInThisMonth} days), skipped`,
                            category: "skipped_invalid",
                        });
                        continue;
                    }
                    if (entry.rest_day === true) {
                        restDays.push({ year: pageYear, month: entry.month, day: entry.day, source, notes: entry.notes });
                        continue;
                    }
                    const entryDate = `${pageYear}-${String(entry.month).padStart(2, "0")}-${String(entry.day).padStart(2, "0")}`;
                    if ((!entry.times || entry.times.length === 0) && entry.hoursWorked !== null) {
                        // hours_total data model: no clock times exist for this date, only a total
                        // hours(+OT) figure — can't feed fillTimesheet's clock-time columns, so this
                        // is captured for the review UI/JSON but explicitly flagged as not written to
                        // the spreadsheet, rather than either fabricating clock times or silently
                        // dropping genuinely-read data.
                        hoursEntries.push({
                            date: new Date(pageYear, entry.month - 1, entry.day),
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
                        // The model DID report a row for this date (buildPrompt above only omits a
                        // date entirely when its row is genuinely blank) — it just couldn't map it to
                        // clock times, an hours figure, or a recognized rest_day/leave mark (e.g. a
                        // bare presence tick, or something illegible). Still counts as "this date was
                        // purposefully accounted for on the source document", same as an explicit
                        // rest_day — recorded here (not dropped) so the review UI shows a row for it
                        // instead of the missing-day auto-insert fabricating a default-shift workday
                        // over a day that plainly has SOMETHING written on it.
                        restDays.push({ year: pageYear, month: entry.month, day: entry.day, source, notes: entry.notes ? `unclear mark: ${entry.notes} — please verify` : "unclear mark — please verify" });
                        warnings.push({
                            source,
                            reason: `day=${entry.day} month=${entry.month}: has a mark but no clock times/hours/leave-code could be determined${entry.notes ? ` (${entry.notes})` : ""} — recorded as unworked so it isn't auto-filled as a missing day, please verify against the source PDF`,
                            category: "flagged_review",
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
                            date: new Date(pageYear, entry.month - 1, entry.day),
                            clockIn: entry.times[ti],
                            clockOut: entry.times[ti + 1],
                            source,
                            guessed: entry.guessed === true,
                            noBreak: entry.noBreak === true,
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
                        modelsUsed: [...(pageModelsUsed.get(source) ?? new Set<string>())],
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
    const reviewRows = buildReviewRows(timeEntries, restDays, standardBreakHours);

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
        const modelsUsed = [...(pageModelsUsed.get(source) ?? new Set<string>())];
        return { source, image, entries, warnings: pageWarnings, dataModel: meta?.dataModel ?? "unclear", pageContext: meta?.pageContext ?? "", modelsUsed };
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
    // Every distinct year actually resolved across the upload's pages, not a single job-wide
    // value — a real upload can genuinely span a year boundary (see the prescan comment above).
    // public/index.html surfaces this as-is so a caseworker can sanity-check what got detected.
    const years = [...new Set(resolvedYearBySource.values())].sort((a, b) => a - b);
    job.result = {
        success: true,
        years,
        warnings: generalWarnings,
        monthSummary,
        scanOutput,
        pageReviews,
        reviewRows,
        ipa,
        ipaImage,
        ipaWarning,
        costUsd: totalCostUsd,
        costByModel,
        durationMs: Date.now() - startedAt,
    };
    job.status = "done";
}

// Standalone cross-check tool: caseworker uploads the worker's own bank statement(s) and a list
// of keywords/phrases to look for (e.g. "SALARY", the employer's name), and every page is scanned
// for transactions the model judges related to those keywords — surfaced as a plain list for the
// caseworker to compare against the claim total by eye. Not wired into /api/generate or the
// spreadsheet at all (v1 scope is "surface matches", not automated gap calculation).
app.post(
    "/api/bank-statement",
    upload.fields([{ name: "statements", maxCount: 10 }]),
    (req, res) => {
        const uploadedFields = req.files as { [field: string]: Express.Multer.File[] } | undefined;
        const files = uploadedFields?.statements;
        if (!files || files.length === 0) {
            return res.status(400).json({ error: "No bank statement files uploaded." });
        }

        let keywords: string[] = [];
        try {
            const parsed = JSON.parse(req.body.keywords ?? "[]");
            if (Array.isArray(parsed)) keywords = parsed.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map(k => k.trim());
        } catch {
            // ignore — falls through to the empty-keywords check below
        }
        if (keywords.length === 0) {
            return res.status(400).json({ error: "At least one keyword/line item to look for is required." });
        }

        // Same staging-confirmed rotation/exclusion pattern as /api/process — keyed
        // "<fileIndex>-<pageIndex>", from the /api/preview-backed staging step in public/index.html.
        let rotations: Record<string, number> = {};
        try {
            const parsed = JSON.parse(req.body.rotations ?? "{}");
            if (parsed && typeof parsed === "object") rotations = parsed;
        } catch {
            // ignore — fall through with no rotations applied
        }
        let excludedPages = new Set<string>();
        try {
            const parsed = JSON.parse(req.body.excludedPages ?? "[]");
            if (Array.isArray(parsed)) excludedPages = new Set(parsed);
        } catch {
            // ignore — fall through with no exclusions applied
        }

        const jobId = randomUUID();
        bankJobs.set(jobId, { status: "running", pages: [], result: null, error: null });
        runBankStatementJob(jobId, files, keywords, rotations, excludedPages)
            .catch(e => {
                const job = bankJobs.get(jobId);
                if (job) { job.status = "error"; job.error = e.message; }
            })
            .finally(() => scheduleBankJobCleanup(jobId));

        res.json({ jobId });
    }
);

app.get("/api/bank-statement/:jobId", (req, res) => {
    const job = bankJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "job not found or expired" });
    res.json(job);
});

async function runBankStatementJob(
    jobId: string,
    files: Express.Multer.File[],
    keywords: string[],
    rotations: Record<string, number>,
    excludedPages: Set<string>
) {
    const job = bankJobs.get(jobId);
    if (!job) return;
    const startedAt = Date.now();
    let totalCostUsd = 0;
    const pages: BankStatementPageResult[] = [];

    for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        let images: string[];
        try {
            images = await loadPagesForFile(file);
        } catch (e: any) {
            console.error(`failed to load pages for ${file.originalname}:`, e);
            continue;
        }
        for (let pi = 0; pi < images.length; pi++) {
            const key = `${fi}-${pi}`;
            if (excludedPages.has(key)) continue;
            const rotation = rotations[key] || 0;
            if (rotation) images[pi] = await rotateImage(images[pi], rotation);

            const source = `${file.originalname} p${pi + 1}`;
            const page: BankStatementPageResult = { source, image: await resizeForDisplay(images[pi], 500), transactions: [] };
            try {
                const { transactions, cost } = await extractMatchingTransactions(images[pi], keywords);
                page.transactions = transactions;
                totalCostUsd += cost;
            } catch (e: any) {
                console.error(`bank statement scan failed for ${source}:`, e);
            }
            pages.push(page);
            job.pages = [...pages]; // live snapshot for polling clients
        }
    }

    const transactions = pages
        .flatMap(p => p.transactions.map(t => ({ ...t, source: p.source })))
        .sort((a, b) => a.date.localeCompare(b.date));
    const totalCredits = transactions.filter(t => t.direction !== "debit").reduce((sum, t) => sum + t.amount, 0);

    job.pages = pages;
    job.result = { transactions, totalCredits, costUsd: totalCostUsd, durationMs: Date.now() - startedAt };
    job.status = "done";
}

// Takes the human-reviewed (possibly hand-corrected) rows from the browser's edit step and writes
// them straight to the spreadsheet — no OCR here, this is pure "given these final numbers, fill
// the template" work, so it's fast and synchronous compared to /api/process.
app.post("/api/generate", express.json({ limit: "5mb" }), async (req, res) => {
    // No year gate here — fillTimesheetFromRows below picks each row's sheet straight off its own
    // r.date (already a full YYYY-MM-DD), and silently skips (with a warning) any date outside the
    // template's supported range. The claim-wide year itself was already resolved and validated
    // against SUPPORTED_YEARS back at /api/process (runProcessJob's prescan) before these rows ever
    // reached the browser for review.
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
                : err.code === "LIMIT_FILE_SIZE"
                    ? "file too large — each attachment must be under 40MB"
                    : err.message;
        return res.status(400).json({ error: message });
    }
    // Any other upload-time error (e.g. a malformed multipart body) still needs to come back as
    // JSON — Express's default HTML error page makes the frontend's res.json() throw a useless
    // "did not match the expected pattern" error instead of showing what actually broke.
    console.error("upload error:", err);
    res.status(500).json({ error: err?.message || "upload failed" });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
