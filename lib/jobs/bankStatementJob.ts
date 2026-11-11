import * as path from "path";
import { resizeForDisplay, rotateImage, type PagedImages } from "../ocr";
import { extractMatchingTransactions, mergeTransactionAttempts, type BankTransaction } from "../bankstatement";
import { persistScan } from "../history";
import {
    loadPagesForFile,
    SCAN_TEMPERATURES,
    JOB_TTL_MS,
    MAX_PAGES_PER_JOB,
    MAX_PAGE_CONCURRENCY,
    checkPageCount,
    cleanupJobDir,
    jobPagesDir,
} from "./shared";

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
    // Set by server.ts at job-creation time (from the SSO JWT) — not serialized to the client
    // (excluded the same way `controller` is on the timesheet job), read back here purely to
    // persist a finished scan to history. See lib/history.ts.
    userId: number;
    userFullname: string;
    userEmail: string;
};
export const bankJobs = new Map<string, BankStatementJob>();
/** Schedules a bank-statement job's entry to be evicted from {@link bankJobs} after {@link JOB_TTL_MS}, and reclaims its temp page dir immediately. */
export function scheduleBankJobCleanup(jobId: string) {
    cleanupJobDir(jobPagesDir(jobId));
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
 * @param interpretationHint - Free text typed into the single-page "Rescan" popup
 * (public/index.html) — forwarded into every page this request scans. See
 * lib/ocr/visionClient.ts's `withRescanHint`.
 */
export async function runBankStatementJob(
    jobId: string,
    files: Express.Multer.File[],
    rotations: Record<string, number>,
    excludedPages: Set<string>,
    interpretationHint?: string
) {
    const job = bankJobs.get(jobId);
    if (!job) return;
    const startedAt = Date.now();
    let totalCostUsd = 0;

    const imagesByFile: (PagedImages | undefined)[] = [];
    for (let fi = 0; fi < files.length; fi++) {
        try {
            imagesByFile[fi] = await loadPagesForFile(files[fi], path.join(jobPagesDir(jobId), `file-${fi}`), MAX_PAGES_PER_JOB);
        } catch (e: any) {
            console.error(`failed to load pages for ${files[fi].originalname}:`, e);
        }
    }

    try {
        checkPageCount(imagesByFile.reduce((sum, p) => sum + (p?.length ?? 0), 0));
    } catch (e: any) {
        job.status = "error";
        job.error = e.message;
        return;
    }

    // Same adaptive-concurrency pattern as the timesheet pipeline (runProcessJob) — capped at
    // MAX_PAGE_CONCURRENCY pages in flight at once (see shared.ts), and pageConcurrencyLimit only
    // ever ratchets down from there (never back up) if a page's scan comes back failed, treating
    // that as a signal of provider distress. pages/job.pages
    // are pre-sized and written by index (upload-order position) rather than pushed, since pages now
    // finish in whatever order they complete, not the order they were uploaded in.
    const pageTasks: { fi: number; pi: number }[] = [];
    for (let fi = 0; fi < files.length; fi++) {
        const pageCount = imagesByFile[fi]?.length ?? 0;
        for (let pi = 0; pi < pageCount; pi++) {
            if (excludedPages.has(`${fi}-${pi}`)) continue;
            pageTasks.push({ fi, pi });
        }
    }
    let pageConcurrencyLimit = Math.min(MAX_PAGE_CONCURRENCY, Math.max(1, pageTasks.length));
    const pages: (BankStatementPageResult | undefined)[] = new Array(pageTasks.length);
    job.pages.length = pageTasks.length;

    async function processBankPage(fi: number, pi: number, orderIndex: number): Promise<void> {
        const file = files[fi];
        const images = imagesByFile[fi]!;
        const key = `${fi}-${pi}`;
        const rotation = rotations[key] || 0;
        if (rotation) await images.set(pi, await rotateImage(await images.get(pi), rotation));
        const pageImage = await images.get(pi);

        const source = `${file.originalname} p${pi + 1}`;
        const page: BankStatementPageResult = { source, image: await resizeForDisplay(pageImage, 1400), transactions: [] };
        // Same SCAN_TEMPERATURES multi-attempt pattern as timesheet scanning — a single pass here
        // can genuinely miss a page's transaction entirely (the bug this was added to fix: one
        // deterministic attempt skipped 2 of 3 real payments on a page, understating what the
        // worker was actually paid). mergeTransactionAttempts unions whatever each attempt caught.
        const results = await Promise.allSettled(
            SCAN_TEMPERATURES.map(({ temperature, seed }) => extractMatchingTransactions(pageImage, temperature, seed, interpretationHint))
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
    persistScan({
        id: jobId,
        scanType: "bank_statement",
        userId: job.userId,
        userFullname: job.userFullname,
        userEmail: job.userEmail,
        title: null,
        costUsd: job.result.costUsd,
        durationMs: job.result.durationMs,
        result: job.result,
        pages: job.pages,
    });
}
