import express from "express";
import multer from "multer";
import * as path from "path";
import { pdfToImages, scanPageImage, extractJsonBlock } from "./lib/ocr";
import { fillTimesheet, MONTH_ABBR, type TimeEntry, type FillWarning } from "./lib/xlsx";
import { inferMissingDays, type RestDay } from "./lib/gapfill";
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
const SCAN_ATTEMPTS_PER_PAGE = SCAN_TEMPERATURES.length;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});

// Fanning out SCAN_ATTEMPTS_PER_PAGE parallel calls per page means far more surface area for a
// flaky upstream response. Our own try/catch around each scanPageImage call assumes SDK failures
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
function buildPrompt(context: string, year: number): string {
    return `This is one page of a handwritten daily timesheet, used to fill a wage-claim spreadsheet for the year ${year}.

For each calendar date row on this page, your job is simply to list EVERY clock time value written on that row, left to right, in the order they appear — do NOT try to decide how many shifts they represent or group them into clock-in/clock-out pairs yourself. That grouping happens automatically downstream from the count and order of values you report, so your only job is accurate, complete enumeration.

- A normal day with one shift has 2 values: [clock_in, clock_out].
- A split day with a morning shift and an evening shift has 4 values: [in1, out1, in2, out2].
- A day with three shifts has 6 values, and so on.
Report the values as bare 24-hour numbers, no colon, e.g. 800 means 8:00am, 1330 means 1:30pm, 2200 means 10:00pm.

CRITICAL — always scan the FULL WIDTH of a row before deciding it only has 2 values. It is a common and serious error to read only the first clock-in/clock-out pair and stop, when the row actually has 4 (or more) values further right representing a second shift. If you see more than 2 time values anywhere on a row, report ALL of them — never silently drop the later ones.

Watch out for the 12am/12pm ambiguity — it's a common mistake. 12pm = noon = 1200. 12am = midnight = 0 (or 2400 if it's the last value of the day, ending a shift that started earlier). These are NOT the same time, even though both are written as "12". Do not convert 12am the same way you'd convert 12pm.

Note: an overnight-spanning value (a time that's numerically smaller than the one before it, e.g. a shift running from 2200 to 0600) is expected and handled correctly downstream — do not try to "fix" it or reorder the values, just report them in the order they appear on the page.

Hard constraint — no human can work 24 hours or more in a single calendar day. The span from the first time to the last time you report for a row must always be strictly less than 24 hours. If your reading would imply 24 hours or more, you have misread the image — look again. If you still cannot resolve it, output null for times on that row and explain the conflict in notes.

Total hours worked must tally strictly. If the page shows both raw clock times AND a separately written total/duration for the same day, what you report must be consistent with that written total (accounting for any marked meal break). If they don't agree, do not silently pick one — explain the discrepancy in notes so a human can review it.

This page may contain many rows (up to 31, one per day of the month). Transcribe EVERY row visible on the page, top to bottom — do not skip, merge, or summarize any row, even if the page is dense or some rows look repetitive.

CRITICAL — many rows on a timesheet look nearly identical at a glance (e.g. the same clock-in time and same mid-day break time repeated every day), but that does NOT mean every row is identical. Do not let an earlier row you already read confidently influence how you read a later row that merely looks similar. You must independently re-examine and read the actual handwritten digits on EVERY row, especially any values later in the row — it is extremely common for only a later time value to differ between otherwise similar-looking rows, and copying a previous row's values here instead of reading this row's own digits is a serious, easy-to-make error. Treat each row as a completely separate read, as if you had never seen any other row on the page.

By right, every calendar date that falls within this page's date range should end up with an entry. If a date's row is blank, smudged, or its times aren't clearly legible, but OTHER rows on this same page show a clear, consistent pattern (e.g. the same values repeated on most other workdays), use that pattern to make your best guess for the missing date instead of leaving it null. When you output a best-guess estimate rather than values read directly off the page, set guessed to true and explain the basis for the guess in notes (e.g. "no entry visible, inferred from the 8am-5pm pattern seen on surrounding weekdays").

If a date is explicitly marked as a rest day, day off, public holiday, or similar, still output a row for it — set rest_day to true and times to null. Do NOT guess times for a confirmed rest day. This lets a downstream system tell "confirmed day off" apart from "data missing entirely", so only genuinely missing days get inferred later, never real rest days.

For every date row visible on this page, output:
- day: day of month, integer 1-31
- month: month, integer 1-12 (this page is for the year ${year} — ignore any year written on the page, it is not needed)
- times: array of every clock time value on this row as described above, in left-to-right order, or null if illegible/not determinable/rest day. Length should normally be even (2, 4, 6...) since shifts come in in/out pairs.
- guessed: true if times is your best-guess estimate rather than values read directly off the page, false otherwise
- rest_day: true if this date is explicitly marked as a rest day/off/holiday on the page, false otherwise
- notes: null normally. If times is null, OR guessed is true, OR anything about this row doesn't make sense (e.g. an odd number of values, unclear handwriting, unusual format, implied 24h+ span), explain briefly here so a human can review — do not guess wildly.

Additional context from the person submitting this form: ${context || "None provided."}

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

    const context = (req.body.context as string) ?? "";
    const prompt = buildPrompt(context, year);

    const timeEntries: TimeEntry[] = [];
    const restDays: RestDay[] = [];
    const warnings: FillWarning[] = [];

    for (const file of files) {
        let images: string[];
        try {
            images = await pdfToImages(file.buffer);
        } catch (e: any) {
            warnings.push({ source: file.originalname, reason: `could not read PDF: ${e.message}` });
            continue;
        }

        for (let i = 0; i < images.length; i++) {
            const source = `${file.originalname} p${i + 1}`;

            const results = await Promise.allSettled(
                SCAN_TEMPERATURES.map(({ temperature, seed }) => scanPageImage(images[i], prompt, temperature, seed))
            );

            const attempts: ParsedEntry[][] = [];
            let truncatedCount = 0;
            let failedCount = 0;
            for (const result of results) {
                if (result.status === "rejected") {
                    failedCount++;
                    continue;
                }
                const { content, truncated } = result.value;
                if (truncated) truncatedCount++;
                try {
                    const parsed = JSON.parse(extractJsonBlock(content));
                    if (!Array.isArray(parsed)) throw new Error("not a JSON array");
                    attempts.push(parsed);
                } catch {
                    failedCount++;
                }
            }

            if (truncatedCount > 0) {
                warnings.push({
                    source,
                    reason: `${truncatedCount}/${SCAN_ATTEMPTS_PER_PAGE} scan attempts were truncated (hit token limit) — this page may still be missing rows, please review carefully`,
                });
            }
            if (failedCount > 0) {
                warnings.push({
                    source,
                    reason: `${failedCount}/${SCAN_ATTEMPTS_PER_PAGE} scan attempts failed or returned unparseable output${attempts.length > 0 ? " (used the remaining attempts)" : ""}`,
                });
            }
            if (attempts.length === 0) {
                warnings.push({ source, reason: "all scan attempts for this page failed — page was skipped entirely" });
                continue;
            }

            const { entries: parsed, warnings: reconcileWarnings } = reconcileAttempts(attempts, source);
            warnings.push(...reconcileWarnings);

            for (const entry of parsed) {
                if (entry.day === null || entry.month === null) {
                    warnings.push({
                        source,
                        reason: `skipped a row with no determinable date (times=${entry.times ? entry.times.join(",") : entry.times})${entry.notes ? `: ${entry.notes}` : ""}`,
                    });
                    continue;
                }
                if (entry.month < 1 || entry.month > 12 || entry.day < 1 || entry.day > 31) {
                    warnings.push({ source, reason: `implausible date day=${entry.day} month=${entry.month}, skipped` });
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
                    });
                    continue;
                }
                if (entry.rest_day === true) {
                    restDays.push({ year, month: entry.month, day: entry.day });
                    continue;
                }
                if (!entry.times || entry.times.length === 0) {
                    warnings.push({
                        source,
                        reason: `skipped day=${entry.day} month=${entry.month} (no times detected)${entry.notes ? `: ${entry.notes}` : " — please provide more context and re-upload"}`,
                    });
                    continue;
                }
                if (entry.times.length % 2 !== 0) {
                    warnings.push({
                        source,
                        reason: `day=${entry.day} month=${entry.month}: odd number of time values (${entry.times.join(", ")}) — cannot pair into clock-in/out shifts, skipped, please verify against the original page`,
                    });
                    continue;
                }
                if (entry.guessed === true) {
                    warnings.push({
                        source,
                        reason: `day=${entry.day} month=${entry.month} is a model-derived guess (${entry.times.join(", ")})${entry.notes ? `: ${entry.notes}` : ""} — please double check`,
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

    // Each page above was scanned independently (no cross-page memory during OCR), so a day that
    // no page covered at all is a true gap, not necessarily a rest day. Now that every page's
    // results are aggregated, look for a recurring pattern on that weekday elsewhere in the month
    // and infer the gap from it — same guessed/highlighted treatment as a per-page guess.
    const { inferred, warnings: gapWarnings } = inferMissingDays(timeEntries, restDays, year);
    timeEntries.push(...inferred);
    warnings.push(...gapWarnings);

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

    // Final coverage check: every skip path above (reconcile, gap-fill, fillTimesheet) is
    // supposed to leave a warning behind — but a page whose model output is a successfully
    // parsed, genuinely empty array isn't a "failure" by any check above, so if that happens on
    // every attempt for a page, a day can vanish with zero trail. Walk every calendar day of
    // every month actually touched by this upload and loudly flag anything still uncovered,
    // regardless of which step (or bug) caused it, so a day is never silently missing again.
    const monthSummary: { label: string; filled: number; total: number }[] = [];
    for (const [key, daysCovered] of [...coveredByMonth].sort()) {
        const [y, monthIndex0] = key.split("-").map(Number);
        const daysInMonth = new Date(y, monthIndex0 + 1, 0).getDate();
        for (let day = 1; day <= daysInMonth; day++) {
            if (daysCovered.has(day)) continue;
            const date = new Date(y, monthIndex0, day);
            warnings.push({
                source: "coverage check",
                reason: `${date.toDateString()} has no entry anywhere — not read by any scan attempt on any page, not a confirmed rest day, and gap-fill could not infer it. Please check the source PDF for this date directly.`,
            });
        }
        monthSummary.push({ label: `${MONTH_ABBR[monthIndex0]} ${y}`, filled: daysCovered.size, total: daysInMonth });
    }

    res.json({
        success: true,
        filename: `calculation-filled-${Date.now()}.xlsx`,
        file: buffer.toString("base64"),
        warnings: [...warnings, ...fillWarnings],
        entriesWritten: writtenDates.length,
        monthSummary,
        durationMs: Date.now() - startedAt,
    });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
