import * as path from "path";
import { resizeForDisplay, rotateImage, type PagedImages } from "../ocr";
import { extractMedicalCertificateEntries, mergeMedicalCertificateEntries, type MedicalCertificateEntry } from "../medicalCertificates";
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

// Same standalone-job shape as the medical bills job (see ./medicalBillsJob) — a medical
// certificate scan checks for proof of MC leave and is its own independent cross-check, not part
// of the timesheet/IPA pipeline or the medical bills (billed-amount) one.
export type MedicalCertificatesPageResult = { source: string; image: string; entries: MedicalCertificateEntry[] };
export type MedicalCertificateJob = {
    status: "running" | "done" | "error";
    pages: MedicalCertificatesPageResult[];
    result: { entries: (MedicalCertificateEntry & { source: string })[]; costUsd: number; durationMs: number } | null;
    error: string | null;
};
export const medicalCertJobs = new Map<string, MedicalCertificateJob>();
/** Schedules a medical-certificate job's entry to be evicted from {@link medicalCertJobs} after {@link JOB_TTL_MS}, and reclaims its temp page dir immediately. */
export function scheduleMedicalCertJobCleanup(jobId: string) {
    cleanupJobDir(jobPagesDir(jobId));
    setTimeout(() => medicalCertJobs.delete(jobId), JOB_TTL_MS);
}

/**
 * Runs the full medical-certificate scan pipeline for one `/api/medical-certificates` job: scans
 * every page for granted-leave-period entries with {@link SCAN_TEMPERATURES}'s multi-attempt
 * pattern, and writes the final result into `medicalCertJobs.get(jobId)`.
 *
 * @param jobId - The job's id in {@link medicalCertJobs} (already set to `"running"` by the caller).
 * @param files - The uploaded medical certificate files.
 * @param rotations - Human-confirmed page rotations, keyed `"<fileIndex>-<pageIndex>"`.
 * @param excludedPages - Pages dropped by the caseworker in staging, same keying as `rotations`.
 */
export async function runMedicalCertificateJob(
    jobId: string,
    files: Express.Multer.File[],
    rotations: Record<string, number>,
    excludedPages: Set<string>
) {
    const job = medicalCertJobs.get(jobId);
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

    const pageTasks: { fi: number; pi: number }[] = [];
    for (let fi = 0; fi < files.length; fi++) {
        const pageCount = imagesByFile[fi]?.length ?? 0;
        for (let pi = 0; pi < pageCount; pi++) {
            if (excludedPages.has(`${fi}-${pi}`)) continue;
            pageTasks.push({ fi, pi });
        }
    }
    // Capped at MAX_PAGE_CONCURRENCY pages in flight at once (see shared.ts), ratcheting down
    // (never back up) if a page's scan fails — same adaptive-concurrency pattern as the timesheet,
    // bank-statement, and medical-bills job runners.
    let pageConcurrencyLimit = Math.min(MAX_PAGE_CONCURRENCY, Math.max(1, pageTasks.length));
    const pages: (MedicalCertificatesPageResult | undefined)[] = new Array(pageTasks.length);
    job.pages.length = pageTasks.length;

    async function processMedicalCertPage(fi: number, pi: number, orderIndex: number): Promise<void> {
        const file = files[fi];
        const images = imagesByFile[fi]!;
        const key = `${fi}-${pi}`;
        const rotation = rotations[key] || 0;
        if (rotation) await images.set(pi, await rotateImage(await images.get(pi), rotation));
        const pageImage = await images.get(pi);

        const source = `${file.originalname} p${pi + 1}`;
        const page: MedicalCertificatesPageResult = { source, image: await resizeForDisplay(pageImage, 500), entries: [] };
        const results = await Promise.allSettled(
            SCAN_TEMPERATURES.map(({ temperature, seed }) => extractMedicalCertificateEntries(pageImage, temperature, seed))
        );
        const attempts: MedicalCertificateEntry[][] = [];
        let failedCount = 0;
        for (const result of results) {
            if (result.status === "fulfilled") {
                attempts.push(result.value.entries);
                totalCostUsd += result.value.cost;
            } else {
                failedCount++;
                console.error(`medical certificate scan failed for ${source}:`, result.reason);
            }
        }
        if (failedCount > 0) {
            const reduced = Math.max(1, Math.floor(pageConcurrencyLimit / 2));
            if (reduced < pageConcurrencyLimit) {
                console.warn(`${source}: ${failedCount}/${SCAN_TEMPERATURES.length} scan attempts failed — reducing page concurrency ${pageConcurrencyLimit} -> ${reduced} for the rest of this job`);
                pageConcurrencyLimit = reduced;
            }
        }
        page.entries = mergeMedicalCertificateEntries(attempts);
        pages[orderIndex] = page;
        if (job!.status === "running") job!.pages[orderIndex] = page;
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
                    processMedicalCertPage(fi, pi, orderIndex).finally(() => {
                        active--;
                        if (nextIdx >= pageTasks.length && active === 0) resolve();
                        else pump();
                    });
                }
            }
            pump();
        });
    }

    const orderedPages = pages.filter((p): p is MedicalCertificatesPageResult => p !== undefined);
    const entries = orderedPages
        .flatMap(p => p.entries.map(e => ({ ...e, source: p.source })))
        .sort((a, b) => a.leaveFrom.localeCompare(b.leaveFrom));

    job.pages = orderedPages;
    job.result = { entries, costUsd: totalCostUsd, durationMs: Date.now() - startedAt };
    job.status = "done";
}
