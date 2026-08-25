import {
    scanPageImage,
    extractJsonBlock,
    cropIntoBands,
    extractPageContext,
    verifyDatesOnPage,
    resizeForDisplay,
    rotateImage,
    PRIMARY_VISION_MODEL,
    FALLBACK_VISION_MODEL,
    type PageDataModel,
} from "../ocr";
import { buildReviewRows, MONTH_ABBR, type TimeEntry, type FillWarning, type RestDay } from "../xlsx";
import { reconcileAttempts, reconcileRosterAttempts, type ParsedEntry, type RosterPageAttempt, type RosterRow } from "../reconcile";
import { extractIpaFields, type IpaFields } from "../ipa";
import { buildPrompt } from "../timesheetPrompt";
import { buildRosterPrompt } from "../rosterPrompt";
import type { WorkerMatchConfidence } from "../workerMatch";
import { loadPagesForFile, SUPPORTED_YEARS, SCAN_TEMPERATURES, BANDS_PER_PAGE, JOB_TTL_MS } from "./shared";

// Rotation degrees a human confirmed in the pre-scan staging step (public/index.html), keyed so
// /api/process can look up which page they apply to. pdfs are keyed "<fileIndex>-<pageIndex>"
// since there can be several multi-page files; ipa is a single number since only its first page is
// ever used downstream (../ipa.ts).
export type RotationMap = { pdfs?: Record<string, number>; ipa?: number };

// A page's own image + everything read from it so far, in the exact shape public/index.html
// already knows how to render — used both as a live in-progress snapshot (pushed as each page
// finishes scanning) and as the authoritative final version (once the whole job is done, which
// additionally has coverage-check warnings attached — see the end of runProcessJob).
export type PageReview = {
    source: string;
    image: string;
    entries: { date: string; type: string;[k: string]: unknown }[];
    warnings: FillWarning[];
    dataModel: PageDataModel;
    pageContext: string;
    modelsUsed: string[]; // every model that touched this page — always PRIMARY_VISION_MODEL, plus FALLBACK_VISION_MODEL if that page's escalation step ran
    // Only set when dataModel is "worker_roster" — every non-struck-through worker row seen across
    // scan attempts (deduped by name), how confidently the target worker was auto-matched, and the
    // page's own resolved date (kept even when no worker was confidently matched, so a manually
    // picked row can still be built into a full YYYY-MM-DD entry) — lets public/index.html render a
    // picker to override the match if it's wrong or missing.
    rosterMatch?: { confidence: WorkerMatchConfidence; allRows: RosterRow[]; date: string | null; matchedRowIndex: number | null };
};

// /api/process kicks off a scan as a background job (12 real-world pages can take 15-20+ minutes
// sequentially) and returns a jobId immediately rather than holding the HTTP request open the
// whole time — a connection held open that long is fragile (proxies/networks can drop it), and it
// gave the browser zero visibility into per-page progress. public/index.html polls
// GET /api/process/:jobId to render each page's card as soon as that page finishes, instead of
// waiting for the entire batch.
export type ProcessJob = {
    status: "running" | "done" | "error";
    pages: PageReview[]; // grows live while running; replaced with the authoritative final list once done
    result: Record<string, unknown> | null; // set once status is "done" — same shape /api/process used to return directly
    error: string | null;
};
// Named processJobs, not jobs — the per-page scan loop below already uses a local variable
// called `jobs` for its band x temperature attempt list, and shadowing that would be a landmine.
export const processJobs = new Map<string, ProcessJob>();
/** Schedules a process job's entry to be evicted from {@link processJobs} after {@link JOB_TTL_MS}. */
export function scheduleJobCleanup(jobId: string) {
    setTimeout(() => processJobs.delete(jobId), JOB_TTL_MS);
}

// The actual scan/reconcile/fill-prep pipeline — everything /api/process's handler used to do
// inline before returning res.json() directly. Now runs detached from the request that started
// it (see server.ts's /api/process handler), mutating the processJobs entry in place as it goes so
// GET /api/process/:jobId always reflects current progress.
/**
 * Runs the full timesheet scan/reconcile pipeline for one `/api/process` job: resolves each page's
 * claim year, scans every page (band x temperature fan-out, cross-attempt reconciliation, date
 * verification, fallback-model escalation on disputed dates), and writes the final result into
 * `processJobs.get(jobId)`.
 *
 * @param jobId - The job's id in {@link processJobs} (already set to `"running"` by the caller).
 * @param files - The uploaded timesheet files.
 * @param ipaFile - The uploaded IPA letter, if any.
 * @param rotations - Human-confirmed page rotations from the pre-scan staging step.
 * @param excludedPages - Pages dropped by the caseworker in staging, keyed `"<fileIndex>-<pageIndex>"`.
 * @param standardBreakHours - The caseworker's declared standard meal break.
 * @param fallbackYear - Only set by the single-page "Rotate + Rescan" flow (public/index.html) —
 * that request deliberately excludes every OTHER page of the file (to avoid re-scanning/re-billing
 * pages that were already fine), which means the neighbor-page year-inference below has nothing to
 * borrow from. The client already knows what year that page's rows used the first time around, so
 * it resends it here as a last-resort fallback, used only if this page still can't resolve a year
 * on its own even after being rescanned (e.g. the rotation fix was needed for the date header
 * itself). A normal full-batch job never passes this — every page there can still borrow from a
 * real neighbor.
 */
export async function runProcessJob(
    jobId: string,
    files: Express.Multer.File[],
    ipaFile: Express.Multer.File | undefined,
    rotations: RotationMap,
    excludedPages: Set<string>,
    standardBreakHours: number,
    fallbackYear?: number
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
    // Pre-sized to pageTasks.length and written by INDEX (each page's position in upload order),
    // not push()'d, because pages now run concurrently and can finish in any order — pushing would
    // scramble page order in the final review UI to "whichever finished first" instead of the
    // order the files/pages were actually uploaded in. A page that fails before reaching its first
    // write leaves a hole, filtered out below once every page has settled.
    const pageImages: ({ source: string; image: string } | undefined)[] = [];
    // dataModel/pageContext per page, keyed by source — populated once extractPageContext runs
    // below. Carried into pageReviews purely so a later "flag this page" action (public/index.html)
    // can send this classification along with the flag, without the client having to re-derive it.
    const pageMeta = new Map<string, { dataModel: PageDataModel; pageContext: string }>();
    // Roster-match info per page, keyed by source — populated only for dataModel "worker_roster"
    // pages, carried into pageReviews so the client can render the worker-picker fallback UI.
    const pageRosterMeta = new Map<string, { confidence: WorkerMatchConfidence; allRows: RosterRow[]; date: string | null; matchedRowIndex: number | null }>();

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

    if (resolvedYearBySource.size === 0 && fallbackYear === undefined) {
        const job = processJobs.get(jobId);
        if (job) {
            job.status = "error";
            job.error = "Could not detect a claim year from any uploaded page — none had a printed/typed date header (a title, filename, or form field naming the month/year), and none fell in the supported range (" + SUPPORTED_YEARS.join(", ") + ").";
        }
        return;
    }

    for (let fi = 0; fi < files.length; fi++) {
        const loadError = fileLoadErrors.get(fi);
        if (loadError) warnings.push({ source: files[fi].originalname, reason: loadError, category: "system" });
    }

    // Adaptive page concurrency: every page in this upload is queued to run at once (uncapped —
    // the theory being most real uploads are small enough that "try everything simultaneously" is
    // strictly faster with no downside), and pageConcurrencyLimit only ever ratchets DOWN, never
    // back up. A page's scan attempts failing (sendVisionRequest already retried 429s internally
    // before giving up on any single attempt, so a failure surfacing here means the provider was
    // already pushed hard) halves the limit for every page that hasn't started yet. Never scales
    // back up mid-job — we can't distinguish "the provider recovered" from "we just got lucky this
    // batch" from in here, and erring toward the safer, more sequential side for the rest of THIS
    // job costs little; a fresh job starts optimistic again regardless.
    const pageTasks: { fi: number; i: number }[] = [];
    for (let fi = 0; fi < files.length; fi++) {
        if (fileLoadErrors.has(fi)) continue;
        const images = imagesByFile[fi];
        for (let i = 0; i < images.length; i++) {
            if (excludedPages.has(`${fi}-${i}`)) continue; // dropped by a human in the staging preview — not a failure, nothing to warn about
            pageTasks.push({ fi, i });
        }
    }
    let pageConcurrencyLimit = Math.max(1, pageTasks.length);
    // Index into this array (rather than push) is each task's position here — i.e. upload order.
    pageImages.length = pageTasks.length;
    // Same fix applied to the LIVE progress array clients poll mid-job (see the GET handler, which
    // filters out not-yet-filled holes before sending) — otherwise the in-progress view would also
    // show pages in "whichever finished first" order instead of upload order while the job runs.
    const liveJob = processJobs.get(jobId);
    if (liveJob) liveJob.pages.length = pageTasks.length;

    async function processPage(fi: number, i: number, orderIndex: number): Promise<void> {
            const file = files[fi];
            const images = imagesByFile[fi];
            const source = `${file.originalname} p${i + 1}`;
            let displayImage = "";
            let pageContext = "";
            let dataModel: PageDataModel = "unclear";
            // Wrapped in try/finally (rather than checking success at every one of this block's
            // several early `return`s) so the live progress push below always fires exactly once
            // per page — whether it fully scanned, got skipped as a non-timesheet, or every scan
            // attempt failed. A page the user is watching "process" should never just disappear
            // without ever being accounted for in the live view.
            try {
                // Rotation was already applied in the prescan pass above (images[i] here is the same
                // mutated array), so this is just building the display copy — everything downstream
                // sees the human-confirmed upright orientation from the /api/preview staging step,
                // not the raw (possibly sideways) render.
                displayImage = await resizeForDisplay(images[i]);
                pageImages[orderIndex] = { source, image: displayImage };

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
                        return;
                    }
                }
                const pageYear = resolvedYearBySource.get(source) ?? fallbackYear;
                if (pageYear === undefined) {
                    warnings.push({
                        source,
                        reason: "could not determine which year this page's dates belong to (no printed/typed year header on this page, and no nearby page in the same file to infer it from) — skipped, no scan attempts made",
                        category: "system",
                    });
                    return;
                }

                // A worker-roster page (one shared date, many named workers as rows) is the inverse
                // shape of every other dataModel — extracted and reconciled via a completely
                // different path (lib/rosterPrompt.ts + lib/reconcile.ts's reconcileRosterAttempts,
                // keyed by worker identity rather than day/month) that ends by producing a normal
                // TimeEntry/RestDay for the target worker, so nothing downstream of this branch
                // (buildReviewRows, fillTimesheetFromRows) needs to know this page was a roster at
                // all. No band-cropping (irrelevant for a short worker list) and no fallback-model
                // escalation in this first version — matches the simpler shape of
                // bankStatementJob.ts/medicalBillsJob.ts, neither of which have escalation either.
                if (dataModel === "worker_roster") {
                    const ipa = await ipaPromise;
                    const targetName = ipa?.workerName ?? null;
                    const targetFin = ipa?.workerFin ?? null;

                    const rosterPrompt = buildRosterPrompt();
                    const rosterResults = await Promise.allSettled(
                        SCAN_TEMPERATURES.map(({ temperature, seed }) => scanPageImage(images[i], rosterPrompt, temperature, seed, timesheetModel))
                    );

                    const rosterAttempts: RosterPageAttempt[] = [];
                    let rosterTruncatedCount = 0;
                    let rosterFailedCount = 0;
                    rosterResults.forEach((result, idx) => {
                        const { temperature, seed } = SCAN_TEMPERATURES[idx];
                        if (result.status === "rejected") {
                            rosterFailedCount++;
                            console.error(`${source} temp=${temperature} seed=${seed}: roster scan attempt rejected —`, result.reason);
                            return;
                        }
                        const { content, truncated, cost } = result.value;
                        addCost(timesheetModel, cost);
                        markModelUsed(source, timesheetModel);
                        if (truncated) rosterTruncatedCount++;
                        try {
                            const parsed = JSON.parse(extractJsonBlock(content));
                            if (!Array.isArray(parsed.workers)) throw new Error("workers is not an array");
                            rosterAttempts.push({
                                day: typeof parsed.day === "number" ? parsed.day : null,
                                month: typeof parsed.month === "number" ? parsed.month : null,
                                workers: parsed.workers.map((w: any) => ({
                                    workerName: typeof w.workerName === "string" ? w.workerName : null,
                                    workerIc: typeof w.workerIc === "string" ? w.workerIc : null,
                                    actualTimeIn: typeof w.actualTimeIn === "number" ? w.actualTimeIn : null,
                                    actualTimeOut: typeof w.actualTimeOut === "number" ? w.actualTimeOut : null,
                                    mealBreakHours: typeof w.mealBreakHours === "number" ? w.mealBreakHours : null,
                                    struckThrough: w.struckThrough === true,
                                    notes: typeof w.notes === "string" ? w.notes : null,
                                })),
                            });
                        } catch (e: any) {
                            rosterFailedCount++;
                            console.error(`${source} temp=${temperature} seed=${seed} truncated=${truncated}: failed to parse roster scan output (${e.message}). Raw content:\n`, content);
                        }
                    });

                    const rosterTotalAttempts = SCAN_TEMPERATURES.length;
                    if (rosterTruncatedCount > 0) {
                        warnings.push({ source, reason: `${rosterTruncatedCount}/${rosterTotalAttempts} roster scan attempts were truncated (hit token limit) — this page may be missing worker rows`, category: "scan_quality" });
                    }
                    if (rosterFailedCount > 0) {
                        warnings.push({ source, reason: `${rosterFailedCount}/${rosterTotalAttempts} roster scan attempts failed or returned unparseable output`, category: "scan_quality" });
                    }
                    if (rosterAttempts.length === 0) {
                        warnings.push({ source, reason: "all scan attempts for this worker-roster page failed — page was skipped entirely", category: "scan_quality" });
                        return;
                    }

                    const { date: rosterDate, entry, allRows, warnings: rosterWarnings } = reconcileRosterAttempts(rosterAttempts, source, targetName, targetFin, pageYear);
                    warnings.push(...rosterWarnings);
                    const rosterDateStr = rosterDate ? `${pageYear}-${String(rosterDate.month).padStart(2, "0")}-${String(rosterDate.day).padStart(2, "0")}` : null;
                    pageRosterMeta.set(source, {
                        confidence: entry?.matchConfidence ?? "none",
                        allRows,
                        date: rosterDateStr,
                        matchedRowIndex: entry?.matchedRowIndex ?? null,
                    });

                    if (entry) {
                        const entryDate = `${pageYear}-${String(entry.month).padStart(2, "0")}-${String(entry.day).padStart(2, "0")}`;
                        if (entry.actualTimeIn !== null && entry.actualTimeOut !== null) {
                            timeEntries.push({
                                date: new Date(pageYear, entry.month - 1, entry.day),
                                clockIn: entry.actualTimeIn,
                                clockOut: entry.actualTimeOut,
                                source,
                                guessed: entry.guessed,
                                noBreak: entry.mealBreakHours === 0,
                            });
                            if (entry.guessed) {
                                warnings.push({
                                    source,
                                    reason: `day=${entry.day} month=${entry.month}: roster match for the target worker is a model-derived guess${entry.notes ? `: ${entry.notes}` : ""} — please double check`,
                                    category: "flagged_review",
                                    date: entryDate,
                                });
                            }
                        } else {
                            // Matched the worker, but couldn't resolve a usable actual time in/out —
                            // recorded as unworked (same convention as an "unclear mark" in the normal
                            // path, lib/jobs/timesheetJob.ts's restDays.push below) so the date isn't
                            // silently missing, rather than vanishing with no trace.
                            restDays.push({
                                year: pageYear,
                                month: entry.month,
                                day: entry.day,
                                source,
                                notes: entry.notes ? `roster match, unclear time: ${entry.notes}` : "roster match, unclear actual time in/out — please verify",
                            });
                            warnings.push({
                                source,
                                reason: `day=${entry.day} month=${entry.month}: target worker matched on the roster, but actual time in/out could not be determined — recorded as unworked so it isn't auto-filled as a missing day, please verify against the source PDF`,
                                category: "flagged_review",
                                date: entryDate,
                            });
                        }
                    }
                    return;
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
                    const reduced = Math.max(1, Math.floor(pageConcurrencyLimit / 2));
                    if (reduced < pageConcurrencyLimit) {
                        console.warn(`${source}: ${failedCount}/${totalAttempts} scan attempts failed — reducing page concurrency ${pageConcurrencyLimit} -> ${reduced} for the rest of this job`);
                        pageConcurrencyLimit = reduced;
                    }
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
                    return;
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
                        // entry.notes can itself already end in its own "please verify"-style call
                        // to action (e.g. the fallback-model resolution note above) — appending
                        // "please double check" unconditionally produced a visibly redundant
                        // "please verify — please double check" tail in that case.
                        const alreadyHasCta = entry.notes ? /verify|double check/i.test(entry.notes) : false;
                        warnings.push({
                            source,
                            reason: `day=${entry.day} month=${entry.month} is a model-derived guess (${entry.times.join(", ")})${entry.notes ? `: ${entry.notes}` : ""}${alreadyHasCta ? "" : " — please double check"}`,
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
                    job.pages[orderIndex] = {
                        source,
                        image: displayImage,
                        entries: entriesForSource(source),
                        warnings: warnings.filter(w => w.source.split(", ").includes(source)),
                        dataModel,
                        pageContext,
                        modelsUsed: [...(pageModelsUsed.get(source) ?? new Set<string>())],
                        rosterMatch: pageRosterMeta.get(source),
                    };
                }
            }
    }

    // Concurrency-limited pool: starts every page's own task, up to pageConcurrencyLimit at once,
    // and starts the next queued page the moment any in-flight page finishes — so a fast page
    // frees its slot for the next one immediately rather than waiting for the whole current batch
    // to settle. pageConcurrencyLimit can shrink mid-run (see processPage's failedCount check
    // above), which this checks fresh every time a slot opens, so a mid-job reduction throttles
    // every page queued after that point without needing to touch pages already in flight.
    if (pageTasks.length > 0) {
        await new Promise<void>(resolve => {
            let nextIdx = 0;
            let active = 0;
            function pump() {
                while (active < pageConcurrencyLimit && nextIdx < pageTasks.length) {
                    const orderIndex = nextIdx;
                    const { fi, i } = pageTasks[nextIdx++];
                    active++;
                    processPage(fi, i, orderIndex).finally(() => {
                        active--;
                        if (nextIdx >= pageTasks.length && active === 0) resolve();
                        else pump();
                    });
                }
            }
            pump();
        });
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
    // Holes (pages that threw before ever writing their pageImages slot — see processPage) are
    // dropped here; every slot that DID get written keeps its original upload-order position
    // relative to the others, since pageImages was written by index, not push().
    const orderedPageImages = pageImages.filter((p): p is { source: string; image: string } => p !== undefined);
    const pageReviews: PageReview[] = orderedPageImages.map(({ source, image }) => {
        const entries = entriesForSource(source);

        // Some warnings combine multiple sources into one comma-joined string (e.g. a multi-shift
        // day's shifts collapsing into one row) — split-and-match avoids a prefix false-positive
        // like "file.pdf p1" wrongly matching a warning actually about "file.pdf p10".
        const pageWarnings = allWarnings.filter(w => w.source.split(", ").includes(source));
        pageWarnings.forEach(w => assignedWarnings.add(w));

        const meta = pageMeta.get(source);
        const modelsUsed = [...(pageModelsUsed.get(source) ?? new Set<string>())];
        return {
            source,
            image,
            entries,
            warnings: pageWarnings,
            dataModel: meta?.dataModel ?? "unclear",
            pageContext: meta?.pageContext ?? "",
            modelsUsed,
            rosterMatch: pageRosterMeta.get(source),
        };
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
