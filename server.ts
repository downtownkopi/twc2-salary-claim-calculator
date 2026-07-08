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
// Even at temperature 0, a single scan of a dense page can genuinely miss rows differently
// between identical requests. Scanning each page this many times independently and reconciling
// (lib/reconcile.ts) trades latency/cost for much more reliable full-month coverage.
const SCAN_ATTEMPTS_PER_PAGE = 3;

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

The spreadsheet this feeds has one row per calendar day with these relevant columns:
- "Start Time w/o :" — the clock-in time as a bare number, e.g. 800 means 8:00am, 1330 means 1:30pm, 2200 means 10:00pm. Always 24-hour, no colon.
- "End Time w/o :" — the clock-out time, same numeric format.
These two numbers are later converted into real times by the spreadsheet — so give the actual clock times shown on the page (when the worker started and stopped), NOT a duration or total hours worked.
Note: an overnight shift (e.g. start 2200, end 0600) is expected and handled correctly downstream — do not try to "fix" an end time that is numerically smaller than the start time.

Hard constraint — no human can work 24 hours or more in a single calendar day. A shift's duration, and the sum of all shifts on the same day if there is more than one, must always be strictly less than 24 hours. If your reading of the clock-in/clock-out times would imply 24 hours or more (e.g. clock_in and clock_out being the same time, or shifts that overlap), you have misread the image — look again. If you still cannot resolve it to something under 24 hours, output null for that row's clock_in/clock_out and explain the conflict in notes. Never output times that imply a 24-hour-or-longer shift.

Total hours worked must tally strictly. If the page shows both raw clock-in/clock-out times AND a separately written total/duration for the same day, the clock times you output must be consistent with that written total (accounting for any marked meal break). If they don't agree, do not silently pick one — explain the discrepancy in notes so a human can review it.

This page may contain many rows (up to 31, one per day of the month). Transcribe EVERY row visible on the page, top to bottom — do not skip, merge, or summarize any row, even if the page is dense or some rows look repetitive.

By right, every calendar date that falls within this page's date range should end up with an entry. If a date's row is blank, smudged, or its times aren't clearly legible, but OTHER rows on this same page show a clear, consistent pattern (e.g. the same start/end time repeated on most other workdays), use that pattern to make your best guess for the missing date instead of leaving it null. When you output a best-guess estimate rather than a time read directly off the page, set guessed to true and explain the basis for the guess in notes (e.g. "no entry visible, inferred from the 8am-5pm pattern seen on surrounding weekdays").

If a date is explicitly marked as a rest day, day off, public holiday, or similar, still output a row for it — set rest_day to true and clock_in/clock_out to null. Do NOT guess a clock-in/out for a confirmed rest day. This lets a downstream system tell "confirmed day off" apart from "data missing entirely", so only genuinely missing days get inferred later, never real rest days.

For every date row visible on this page, output:
- day: day of month, integer 1-31
- month: month, integer 1-12 (this page is for the year ${year} — ignore any year written on the page, it is not needed)
- clock_in: start time as described above, integer, or null if illegible/not determinable/rest day
- clock_out: end time as described above, integer, or null if illegible/not determinable/rest day
- guessed: true if clock_in/clock_out is your best-guess estimate rather than a value read directly off the page, false otherwise
- rest_day: true if this date is explicitly marked as a rest day/off/holiday on the page, false otherwise
- notes: null normally. If clock_in or clock_out is null, OR guessed is true, OR anything about this row doesn't make sense (e.g. conflicting times, unclear handwriting, unusual format, implied 24h+ shift), explain briefly here so a human can review — do not guess wildly.

Additional context from the person submitting this form: ${context || "None provided."}

Output ONLY a valid JSON array of {day, month, clock_in, clock_out, guessed, rest_day, notes} objects for this page. No other text, no markdown fences.`;
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
                Array.from({ length: SCAN_ATTEMPTS_PER_PAGE }, () => scanPageImage(images[i], prompt))
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
                        reason: `skipped a row with no determinable date (clock_in=${entry.clock_in}, clock_out=${entry.clock_out})${entry.notes ? `: ${entry.notes}` : ""}`,
                    });
                    continue;
                }
                if (entry.month < 1 || entry.month > 12 || entry.day < 1 || entry.day > 31) {
                    warnings.push({ source, reason: `implausible date day=${entry.day} month=${entry.month}, skipped` });
                    continue;
                }
                if (entry.rest_day === true) {
                    restDays.push({ year, month: entry.month, day: entry.day });
                    continue;
                }
                if (entry.clock_in === null || entry.clock_out === null) {
                    warnings.push({
                        source,
                        reason: `skipped day=${entry.day} month=${entry.month} (clock_in=${entry.clock_in}, clock_out=${entry.clock_out})${entry.notes ? `: ${entry.notes}` : " — please provide more context and re-upload"}`,
                    });
                    continue;
                }
                if (entry.guessed === true) {
                    warnings.push({
                        source,
                        reason: `day=${entry.day} month=${entry.month} is a model-derived guess (${entry.clock_in}-${entry.clock_out})${entry.notes ? `: ${entry.notes}` : ""} — please double check`,
                    });
                }
                timeEntries.push({
                    date: new Date(year, entry.month - 1, entry.day),
                    clockIn: entry.clock_in,
                    clockOut: entry.clock_out,
                    source,
                    guessed: entry.guessed === true,
                });
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
