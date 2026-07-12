import express from "express";
import multer from "multer";
import * as path from "path";
import { pdfToImages, scanPageImage, extractJsonBlock, cropIntoBands, extractPageContext, verifyDatesOnPage } from "./lib/ocr";
import { fillTimesheet, MONTH_ABBR, type TimeEntry, type FillWarning, type RestDay } from "./lib/xlsx";
import { reconcileAttempts, type ParsedEntry } from "./lib/reconcile";

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
function buildPrompt(year: number, pageContext: string): string {
    return `This is one page of a handwritten daily timesheet, used to fill a wage-claim spreadsheet for the year ${year}.

Page-level context (extracted separately from the full page before this image was cropped, since this image you're looking at now may be only part of the page and might not show a header/title that exists elsewhere on the page): ${pageContext || "none found"}. If this names a specific month, treat it as authoritative for every date row you report below — use that month even if this particular cropped image doesn't show the header itself, UNLESS a row on THIS image explicitly and clearly indicates a different month.

For each calendar date row on this page, your job is simply to list EVERY clock time value written on that row, left to right, in the order they appear — do NOT try to decide how many shifts they represent or group them into clock-in/clock-out pairs yourself. That grouping happens automatically downstream from the count and order of values you report, so your only job is accurate, complete enumeration.

- A normal day with one shift has 2 values: [clock_in, clock_out].
- A split day with a morning shift and an evening shift has 4 values: [in1, out1, in2, out2].
- A day with three shifts has 6 values, and so on.
Report the values as bare 24-hour numbers, no colon, e.g. 800 means 8:00am, 1330 means 1:30pm, 2200 means 10:00pm.

CRITICAL — always scan the FULL WIDTH of a row before deciding it only has 2 values. It is a common and serious error to read only the first clock-in/clock-out pair and stop, when the row actually has 4 (or more) values further right representing a second shift. If you see more than 2 time values anywhere on a row, report ALL of them — never silently drop the later ones.

Watch out for the 12am/12pm ambiguity — it's a common mistake. 12pm = noon = 1200. 12am = midnight = 0 (or 2400 if it's the last value of the day, ending a shift that started earlier). These are NOT the same time, even though both are written as "12". Do not convert 12am the same way you'd convert 12pm.

Worked example of this exact mistake: a row reading "6am to 12pm, 6pm to 12am" (two shifts, a morning block and an evening block) must be reported as [600, 1200, 1800, 2400] — NOT [600, 1200, 1800, 1200]. The second "12" is 12am (midnight), ending the evening shift, and is a completely different time from the first "12" (12pm/noon) even though both look like "12" at a glance. If your final value for a row matches an earlier value in that same row only because you converted both "12"s the same way, you have made this exact mistake — re-examine whether the later one is actually 12am.

Note: an overnight-spanning value (a time that's numerically smaller than the one before it, e.g. a shift running from 2200 to 0600) is expected and handled correctly downstream — do not try to "fix" it or reorder the values, just report them in the order they appear on the page.

Hard constraint — no human can work 24 hours or more in a single calendar day. The span from the first time to the last time you report for a row must always be strictly less than 24 hours. If your reading would imply 24 hours or more, you have misread the image — look again. If you still cannot resolve it, output null for times on that row and explain the conflict in notes.

Total hours worked must tally strictly. If the page shows both raw clock times AND a separately written total/duration for the same day, what you report must be consistent with that written total (accounting for any marked meal break). If they don't agree, do not silently pick one — explain the discrepancy in notes so a human can review it.

This page may contain many rows (up to 31, one per day of the month) — but do NOT assume every day of the month must appear. Only report a date if that date's row genuinely exists on the page with some kind of mark, entry, or handwriting in it. Transcribe EVERY row that is actually present, top to bottom — do not skip, merge, or summarize any row, even if the page is dense or some rows look repetitive.

CRITICAL — pay special attention to the LAST row that has any handwritten content on it, especially when it's followed by several blank/empty rows before the page ends. It is a common mistake to see a run of blank rows coming up and treat that as a signal that the data has "ended" a row early, causing the last real row to get skipped even though it clearly has content. The last populated row is exactly as real as every row before it — verify you have included it.

CRITICAL — many rows on a timesheet look nearly identical at a glance (e.g. the same clock-in time and same mid-day break time repeated every day), but that does NOT mean every row is identical. Do not let an earlier row you already read confidently influence how you read a later row that merely looks similar. You must independently re-examine and read the actual handwritten digits on EVERY row, especially any values later in the row — it is extremely common for only a later time value to differ between otherwise similar-looking rows, and copying a previous row's values here instead of reading this row's own digits is a serious, easy-to-make error. Treat each row as a completely separate read, as if you had never seen any other row on the page.

NEVER guess or invent time values, for any reason. If a row's clock times are smudged, blurry, or otherwise too unclear to read with confidence, output times as null for that row and briefly explain why in notes — do not use a pattern from other rows on the page to fill it in, even if the pattern looks obvious or consistent. And if a date simply has no row on the page at all (no marks, nothing written for it), do not output an entry for it at all. Every value you report must be something you actually read directly off the page, never inferred, pattern-matched, or guessed.

If a date is explicitly marked as a rest day, day off, public holiday, or similar, still output a row for it — set rest_day to true and times to null. Do NOT guess times for a confirmed rest day.

For every date row visible on this page, output:
- day: day of month, integer 1-31
- month: month, integer 1-12. Use the page-level context above if it names a month, unless this specific row clearly indicates otherwise (this page is for the year ${year} — ignore any year written on the page, it is not needed)
- times: array of every clock time value on this row as described above, in left-to-right order, or null if illegible/not determinable/rest day. Length should normally be even (2, 4, 6...) since shifts come in in/out pairs.
- guessed: always false. You must never guess or invent values (see above) — this field exists only for schema consistency.
- rest_day: true if this date is explicitly marked as a rest day/off/holiday on the page, false otherwise
- notes: null normally. If times is null, OR anything about this row doesn't make sense (e.g. an odd number of values, unclear handwriting, unusual format, implied 24h+ span), explain briefly here so a human can review.

Output ONLY a valid JSON array of {day, month, times, guessed, rest_day, notes} objects for this page. No other text, no markdown fences.`;
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/process", upload.array("pdfs", 10), async (req, res) => {
    const startedAt = Date.now();
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
        return res.status(400).json({ error: "No PDF files uploaded." });
    }

    const year = Number(req.body.year);
    if (!SUPPORTED_YEARS.includes(year)) {
        return res.status(400).json({ error: `year must be one of: ${SUPPORTED_YEARS.join(", ")}` });
    }

    const timeEntries: TimeEntry[] = [];
    const restDays: RestDay[] = [];
    const warnings: FillWarning[] = [];
    let totalCostUsd = 0; // sums OpenRouter's own reported usage.cost across every call this request makes

    for (const file of files) {
        let images: string[];
        try {
            images = await pdfToImages(file.buffer);
        } catch (e: any) {
            warnings.push({ source: file.originalname, reason: `could not read PDF: ${e.message}`, category: "system" });
            continue;
        }

        for (let i = 0; i < images.length; i++) {
            const source = `${file.originalname} p${i + 1}`;

            // Read the full, uncropped page once for page-level context (e.g. a month header)
            // before cropping into bands — a header can sit anywhere on the page depending on
            // the source layout, and once cropped into bands, whichever band doesn't happen to
            // include it would otherwise have no way to know what month its rows belong to.
            let pageContext = "";
            try {
                const result = await extractPageContext(images[i]);
                pageContext = result.context;
                totalCostUsd += result.cost;
            } catch (e: any) {
                warnings.push({ source, reason: `could not extract page-level context (e.g. month header): ${e.message} — bands will rely on per-row reading only`, category: "scan_quality" });
            }
            const prompt = buildPrompt(year, pageContext);

            const bands = await cropIntoBands(images[i], BANDS_PER_PAGE);

            // flatten band x temperature into one parallel batch for max concurrency — all
            // bands' attempts fire together rather than band-by-band, so wall-clock time stays
            // close to a single batch's latency despite more total calls.
            const jobs = bands.flatMap((bandImage, b) =>
                SCAN_TEMPERATURES.map(({ temperature, seed }) => ({ bandImage, b, temperature, seed }))
            );
            const results = await Promise.allSettled(
                jobs.map(({ bandImage, temperature, seed }) => scanPageImage(bandImage, prompt, temperature, seed))
            );

            const attemptsByBand: ParsedEntry[][][] = bands.map(() => []);
            let truncatedCount = 0;
            let failedCount = 0;
            results.forEach((result, idx) => {
                const { b } = jobs[idx];
                if (result.status === "rejected") {
                    failedCount++;
                    return;
                }
                const { content, truncated, cost } = result.value;
                totalCostUsd += cost;
                if (truncated) truncatedCount++;
                try {
                    const parsed = JSON.parse(extractJsonBlock(content));
                    if (!Array.isArray(parsed)) throw new Error("not a JSON array");
                    attemptsByBand[b].push(parsed);
                } catch {
                    failedCount++;
                }
            });

            const totalAttempts = jobs.length;
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
            const bandResults: ParsedEntry[][] = [];
            for (let b = 0; b < bands.length; b++) {
                if (attemptsByBand[b].length === 0) continue;
                const bandSource = bands.length > 1 ? `${source} (band ${b + 1}/${bands.length})` : source;
                const { entries: bandEntries, warnings: bandWarnings } = reconcileAttempts(attemptsByBand[b], bandSource, true, year);
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
            const { entries: reconciled, warnings: crossBandWarnings } = reconcileAttempts(bandResults, source, false, year);
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
                for (let i = 0; i < entry.times.length; i += 2) {
                    timeEntries.push({
                        date: new Date(year, entry.month - 1, entry.day),
                        clockIn: entry.times[i],
                        clockOut: entry.times[i + 1],
                        source,
                        guessed: entry.guessed === true,
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

    let buffer: Buffer;
    let fillWarnings: FillWarning[];
    let writtenDates: Date[];
    try {
        ({ buffer, warnings: fillWarnings, writtenDates } = await fillTimesheet(TEMPLATE_PATH, timeEntries));
    } catch (e: any) {
        return res.status(500).json({ error: `failed to fill template: ${e.message}` });
    }

    // A day is "covered" once it's either actually written to the sheet (writtenDates, i.e. it
    // survived fillTimesheet's own validation like the 24h check) or a confirmed rest day —
    // both are correct, complete outcomes, not gaps. Built from writtenDates rather than the
    // pre-validation timeEntries so a day that fillTimesheet rejected doesn't get wrongly
    // counted as covered here.
    const coveredByMonth = new Map<string, Set<number>>(); // key `${year}-${monthIndex0}`
    for (const d of writtenDates) {
        const k = `${d.getFullYear()}-${d.getMonth()}`;
        (coveredByMonth.get(k) ?? coveredByMonth.set(k, new Set()).get(k)!).add(d.getDate());
    }
    for (const r of restDays) {
        const k = `${r.year}-${r.month - 1}`;
        (coveredByMonth.get(k) ?? coveredByMonth.set(k, new Set()).get(k)!).add(r.day);
    }

    // A day that reconciliation/fillTimesheet already explained with a specific warning (e.g.
    // "dropped due to conflicting reads") doesn't need this generic catch-all repeating "no entry
    // anywhere" for the exact same date — that's the duplication that made the warnings list feel
    // long-winded. Only dates with zero explanation anywhere get the generic message.
    const explainedDates = new Set(
        [...warnings, ...fillWarnings].map(w => w.date).filter((d): d is string => d !== undefined)
    );

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
    //
    // toLocalDateString, not toISOString: .toISOString() converts to UTC, which silently shifts
    // the calendar date by a day in timezones ahead of UTC (e.g. a local-midnight Sept 11 becomes
    // "2025-09-10") — exactly the class of date bug this debug output exists to help catch, so
    // shipping that here would be self-defeating. Every date elsewhere in this codebase is
    // constructed and read in local time (new Date(year, month, day)), so this matches that.
    const toLocalDateString = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
    ].sort((a, b) => a.date.localeCompare(b.date));

    res.json({
        success: true,
        filename: `calculation-filled-${Date.now()}.xlsx`,
        file: buffer.toString("base64"),
        warnings: [...warnings, ...fillWarnings],
        entriesWritten: writtenDates.length,
        monthSummary,
        scanOutput,
        costUsd: totalCostUsd,
        durationMs: Date.now() - startedAt,
    });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
