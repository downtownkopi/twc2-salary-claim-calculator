import { resizeForDisplay, rotateImage } from "../ocr";
import { extractMatchingTransactions, mergeTransactionAttempts, type BankTransaction } from "../bankstatement";
import { loadPagesForFile, SCAN_TEMPERATURES, JOB_TTL_MS } from "./shared";

// Separate job type/store from the timesheet job (see ./timesheetJob) — a bank-statement scan is a
// standalone cross-check against a worker's own claimed payments, not part of the timesheet/IPA
// pipeline (different files, no year, no spreadsheet output), so it gets its own background-job
// track rather than being bolted onto ProcessJob's shape.
export type BankStatementPageResult = { source: string; image: string; transactions: BankTransaction[] };
export type BankStatementJob = {
    status: "running" | "done" | "error";
    pages: BankStatementPageResult[];
    result: { transactions: (BankTransaction & { source: string })[]; totalCredits: number; costUsd: number; durationMs: number } | null;
    error: string | null;
};
export const bankJobs = new Map<string, BankStatementJob>();
/** Schedules a bank-statement job's entry to be evicted from {@link bankJobs} after {@link JOB_TTL_MS}. */
export function scheduleBankJobCleanup(jobId: string) {
    setTimeout(() => bankJobs.delete(jobId), JOB_TTL_MS);
}

/**
 * Runs the full bank-statement scan pipeline for one `/api/bank-statement` job: scans every page
 * for incoming (credit) transactions with {@link SCAN_TEMPERATURES}'s multi-attempt pattern, and
 * writes the final result into `bankJobs.get(jobId)`.
 *
 * @param jobId - The job's id in {@link bankJobs} (already set to `"running"` by the caller).
 * @param files - The uploaded bank statement files.
 * @param rotations - Human-confirmed page rotations, keyed `"<fileIndex>-<pageIndex>"`.
 * @param excludedPages - Pages dropped by the caseworker in staging, same keying as `rotations`.
 */
export async function runBankStatementJob(
    jobId: string,
    files: Express.Multer.File[],
    rotations: Record<string, number>,
    excludedPages: Set<string>
) {
    const job = bankJobs.get(jobId);
    if (!job) return;
    const startedAt = Date.now();
    let totalCostUsd = 0;

    const imagesByFile: string[][] = [];
    for (let fi = 0; fi < files.length; fi++) {
        try {
            imagesByFile[fi] = await loadPagesForFile(files[fi]);
        } catch (e: any) {
            console.error(`failed to load pages for ${files[fi].originalname}:`, e);
            imagesByFile[fi] = [];
        }
    }

    // Same adaptive-concurrency pattern as the timesheet pipeline (runProcessJob) — every page
    // starts at once by default, pageConcurrencyLimit only ever ratchets down (never back up) if a
    // page's scan comes back failed, treating that as a signal of provider distress. pages/job.pages
    // are pre-sized and written by index (upload-order position) rather than pushed, since pages now
    // finish in whatever order they complete, not the order they were uploaded in.
    const pageTasks: { fi: number; pi: number }[] = [];
    for (let fi = 0; fi < files.length; fi++) {
        for (let pi = 0; pi < imagesByFile[fi].length; pi++) {
            if (excludedPages.has(`${fi}-${pi}`)) continue;
            pageTasks.push({ fi, pi });
        }
    }
    let pageConcurrencyLimit = Math.max(1, pageTasks.length);
    const pages: (BankStatementPageResult | undefined)[] = new Array(pageTasks.length);
    job.pages.length = pageTasks.length;

    async function processBankPage(fi: number, pi: number, orderIndex: number): Promise<void> {
        const file = files[fi];
        const images = imagesByFile[fi];
        const key = `${fi}-${pi}`;
        const rotation = rotations[key] || 0;
        if (rotation) images[pi] = await rotateImage(images[pi], rotation);

        const source = `${file.originalname} p${pi + 1}`;
        const page: BankStatementPageResult = { source, image: await resizeForDisplay(images[pi], 500), transactions: [] };
        // Same SCAN_TEMPERATURES multi-attempt pattern as timesheet scanning — a single pass here
        // can genuinely miss a page's transaction entirely (the bug this was added to fix: one
        // deterministic attempt skipped 2 of 3 real payments on a page, understating what the
        // worker was actually paid). mergeTransactionAttempts unions whatever each attempt caught.
        const results = await Promise.allSettled(
            SCAN_TEMPERATURES.map(({ temperature, seed }) => extractMatchingTransactions(images[pi], temperature, seed))
        );
        const attempts: BankTransaction[][] = [];
        let failedCount = 0;
        for (const result of results) {
            if (result.status === "fulfilled") {
                attempts.push(result.value.transactions);
                totalCostUsd += result.value.cost;
            } else {
                failedCount++;
                console.error(`bank statement scan failed for ${source}:`, result.reason);
            }
        }
        if (failedCount > 0) {
            const reduced = Math.max(1, Math.floor(pageConcurrencyLimit / 2));
            if (reduced < pageConcurrencyLimit) {
                console.warn(`${source}: ${failedCount}/${SCAN_TEMPERATURES.length} scan attempts failed — reducing page concurrency ${pageConcurrencyLimit} -> ${reduced} for the rest of this job`);
                pageConcurrencyLimit = reduced;
            }
        }
        page.transactions = mergeTransactionAttempts(attempts);
        pages[orderIndex] = page;
        // Non-null: job was checked right after the bankJobs.get() above (this closure captures
        // that same guaranteed-non-null reference, which TS's narrowing doesn't see through).
        if (job!.status === "running") job!.pages[orderIndex] = page; // live snapshot for polling clients
    }

    if (pageTasks.length > 0) {
        await new Promise<void>(resolve => {
            let nextIdx = 0;
            let active = 0;
            function pump() {
                while (active < pageConcurrencyLimit && nextIdx < pageTasks.length) {
                    const orderIndex = nextIdx;
                    const { fi, pi } = pageTasks[nextIdx++];
                    active++;
                    processBankPage(fi, pi, orderIndex).finally(() => {
                        active--;
                        if (nextIdx >= pageTasks.length && active === 0) resolve();
                        else pump();
                    });
                }
            }
            pump();
        });
    }

    const orderedPages = pages.filter((p): p is BankStatementPageResult => p !== undefined);
    const transactions = orderedPages
        .flatMap(p => p.transactions.map(t => ({ ...t, source: p.source })))
        .sort((a, b) => a.date.localeCompare(b.date));
    const totalCredits = transactions.filter(t => t.direction !== "debit").reduce((sum, t) => sum + t.amount, 0);

    job.pages = orderedPages;
    job.result = { transactions, totalCredits, costUsd: totalCostUsd, durationMs: Date.now() - startedAt };
    job.status = "done";
}
