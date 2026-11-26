import * as path from "path";
import { resizeForDisplay } from "../ocr";
import { loadPagesForFile, JOB_TTL_MS, MAX_PAGES_PER_JOB, cleanupJobDir, jobPagesDir } from "./shared";

// Rendered at a much cheaper scale than the real scan — every page here gets downscaled again to
// 800px wide for display (resizeForDisplay) and thrown away once rendered, so rendering at the
// real scan's OCR-legibility scale (3.0) here would spend most of its time producing pixels nobody
// ever sees, then render the exact same pages a second time at 3.0 for real once the caseworker
// confirms rotations and /api/process runs.
export const PREVIEW_RENDER_SCALE = 1.2;

type FilePreviewEntry = { fileIndex: number; pageIndex: number; fileName: string; image: string };
type FilePreviewError = { fileName: string; error: string };

// A background job (like every real scan type), not a single blocking request — a large/slow
// source PDF (e.g. a 50MB+ file with big embedded images, independent of its page count) can take
// well over a minute just to rasterize even at this reduced scale, and a single long-lived
// request/response risks the hosting proxy's own timeout killing the connection before the
// response is ever sent (seen in production as a Cloudflare 524 — "origin took too long" — on a
// 52MB/20-page upload that took ~70s to render locally). A job id returned instantly, polled to
// completion, means no single HTTP request is ever open longer than one poll interval, regardless
// of how long the actual rendering takes.
export type PreviewJob = {
    status: "running" | "done" | "error";
    error: string | null;
    pdfsPreview: FilePreviewEntry[];
    pdfsErrors: FilePreviewError[];
    ipaPreview: { pageIndex: number; image: string }[];
    ipaError: string | null;
    bankStatementPreview: FilePreviewEntry[];
    bankStatementErrors: FilePreviewError[];
    medicalBillsPreview: FilePreviewEntry[];
    medicalBillsErrors: FilePreviewError[];
    medicalCertificatesPreview: FilePreviewEntry[];
    medicalCertificatesErrors: FilePreviewError[];
    payslipsPreview: FilePreviewEntry[];
    payslipsErrors: FilePreviewError[];
};

export const previewJobs = new Map<string, PreviewJob>();

/** Builds a fresh, all-empty {@link PreviewJob} in the `"running"` state. */
export function blankPreviewJob(): PreviewJob {
    return {
        status: "running",
        error: null,
        pdfsPreview: [],
        pdfsErrors: [],
        ipaPreview: [],
        ipaError: null,
        bankStatementPreview: [],
        bankStatementErrors: [],
        medicalBillsPreview: [],
        medicalBillsErrors: [],
        medicalCertificatesPreview: [],
        medicalCertificatesErrors: [],
        payslipsPreview: [],
        payslipsErrors: [],
    };
}

/** Schedules a preview job's entry to be evicted from {@link previewJobs} after {@link JOB_TTL_MS}. */
export function schedulePreviewJobCleanup(jobId: string) {
    setTimeout(() => previewJobs.delete(jobId), JOB_TTL_MS);
}

/**
 * Renders a thumbnail of every page of every attached file (no OCR/model calls at all — just
 * pdf-to-image/image-normalize + downscale, same functions /api/process itself uses to load pages)
 * into `previewJobs.get(jobId)`, section by section, so a caseworker can confirm/rotate/exclude a
 * page up front before the real (expensive, multi-pass) scan runs.
 *
 * @param jobId - The job's id in {@link previewJobs} (already set to a blank running job by the caller).
 * @param filesByField - Every attached field's files, by the same field names `/api/preview` accepts.
 */
export async function runPreviewJob(
    jobId: string,
    filesByField: {
        pdfs: Express.Multer.File[];
        ipa?: Express.Multer.File;
        bankStatement: Express.Multer.File[];
        medicalBills: Express.Multer.File[];
        medicalCertificates: Express.Multer.File[];
        payslips: Express.Multer.File[];
    }
): Promise<void> {
    const job = previewJobs.get(jobId);
    if (!job) return;
    const previewDir = jobPagesDir(jobId);

    async function renderFileGroup(
        files: Express.Multer.File[],
        fieldLabel: string,
        preview: FilePreviewEntry[],
        errors: FilePreviewError[]
    ): Promise<void> {
        for (let fi = 0; fi < files.length; fi++) {
            const file = files[fi];
            try {
                const images = await loadPagesForFile(file, path.join(previewDir, `${fieldLabel}-${fi}`), MAX_PAGES_PER_JOB, PREVIEW_RENDER_SCALE);
                for (let pi = 0; pi < images.length; pi++) {
                    preview.push({ fileIndex: fi, pageIndex: pi, fileName: file.originalname, image: await resizeForDisplay(await images.get(pi), 800) });
                }
            } catch (e: any) {
                errors.push({ fileName: file.originalname, error: e.message });
            }
        }
    }

    try {
        await renderFileGroup(filesByField.pdfs, "pdfs", job.pdfsPreview, job.pdfsErrors);

        // Same staging idea as pdfsPreview above — the IPA upload can itself be multi-page (a cover
        // sheet, the actual approval page, maybe an annex), and extractIpaFields (lib/ipa.ts) only
        // ever reads ONE of them, so every page is shown here with its own delete button, the same
        // "attach, then drop the pages you don't need" flow pdfs already has — rather than silently
        // assuming page 0 is always the right one.
        if (filesByField.ipa) {
            try {
                const images = await loadPagesForFile(filesByField.ipa, path.join(previewDir, "ipa"), MAX_PAGES_PER_JOB, PREVIEW_RENDER_SCALE);
                for (let pi = 0; pi < images.length; pi++) {
                    job.ipaPreview.push({ pageIndex: pi, image: await resizeForDisplay(await images.get(pi), 800) });
                }
            } catch (e: any) {
                job.ipaError = e.message;
            }
        }

        // Same staging idea as pdfs above — a bank statement is just as likely to be a phone photo
        // as a clean digital export, so it gets the same rotate/exclude-before-scan step.
        await renderFileGroup(filesByField.bankStatement, "bankStatement", job.bankStatementPreview, job.bankStatementErrors);

        // Same staging idea as bankStatement above — an MC/hospital bill is just as likely to be a
        // phone photo as a clean printout.
        await renderFileGroup(filesByField.medicalBills, "medicalBills", job.medicalBillsPreview, job.medicalBillsErrors);

        // Same staging idea as medicalBills above — a medical certificate (MC) is a distinct
        // document from a bill/invoice (no billed amount involved), but still just as likely to be
        // a phone photo as a clean printout, so it gets the same rotate/exclude-before-scan step.
        await renderFileGroup(filesByField.medicalCertificates, "medicalCertificates", job.medicalCertificatesPreview, job.medicalCertificatesErrors);

        // Same staging idea as medicalCertificates above — a payslip is just as likely to be a
        // phone photo as a clean printout.
        await renderFileGroup(filesByField.payslips, "payslips", job.payslipsPreview, job.payslipsErrors);

        job.status = "done";
    } catch (e: any) {
        job.status = "error";
        job.error = e.message;
    } finally {
        // Results are already embedded as base64 in the job object above (polled from there for
        // the rest of this job's TTL, same as every other job type's `pages`/`entries` arrays) —
        // the rendered files on disk are never read again once this function returns, so it's safe
        // to reclaim them immediately rather than waiting on the job's own TTL eviction.
        await cleanupJobDir(previewDir);
    }
}
