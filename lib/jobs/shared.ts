import multer from "multer";
import type { Request, Response, NextFunction } from "express";
import { imageToPages, pdfToImages } from "../ocr";

// SUPPORTED_YEARS: the calculation template only has sheets for these years — any page whose
// resolved claim year falls outside this range is treated the same as "no year found at all".
export const SUPPORTED_YEARS = [2025, 2026];

// A single scan of a dense page can genuinely miss/misread rows. Scanning each page this many
// times independently and reconciling (../reconcile.ts) trades latency/cost for much more
// reliable coverage — one deterministic (temperature=0) pass for consistency, plus two
// higher-temperature passes. Identical settings on every attempt would mean a systematic model
// bias (e.g. lazily repeating a previous row's value on a dense, visually-repetitive table)
// reproduces identically every time, leaving reconciliation's disagreement-detection nothing to
// catch since all attempts agree with each other. Varied temperature/seed gives each pass a
// real chance to diverge when the model's reading is actually uncertain, instead of just being
// confidently wrong every time.
export const SCAN_TEMPERATURES: { temperature: number; seed: number }[] = [
    { temperature: 0, seed: 42 },
    { temperature: 0.3, seed: 43 },
    { temperature: 0.5, seed: 44 },
];

// Band-cropping (splitting a page into smaller vertical strips before OCR, each scanned
// independently) was an attempt at reducing dense-table repetition/row-merging failures. Tried 2
// bands, then 3 — neither reliably fixed the specific failure it was meant to address, so it's
// off for now (1 = cropIntoBands short-circuits and returns the page uncropped, see ../ocr.ts).
// The two-level (within-band, then cross-band) reconciliation structure in the timesheet job
// runner still runs either way — with 1 band it's just reconciling a single "band" against
// nothing else, which is a no-op pass-through, so no separate code path was needed to disable it
// cleanly.
export const BANDS_PER_PAGE = 1;

// Jobs are only needed long enough for the client to poll the final "done" state once — not
// pruning them at all would leak memory on a long-running server across many scans.
export const JOB_TTL_MS = 30 * 60 * 1000;

// memoryStorage() means every uploaded byte sits in process RAM (times ~10-20x again once
// pdf-to-img/sharp rasterize each page) until the job finishes — a file large enough to blow past
// the container's memory limit gets the whole process OOM-killed by the OS, silently taking down
// every other in-flight scan's job too (see JOB_TTL_MS above). Rejecting oversized uploads up
// front with a clear 400 is far better than that.
//
// 10MB per file (and MAX_TOTAL_UPLOAD_BYTES below) is generous for what this app actually
// receives — a real 53-page bank statement PDF runs about 1.1MB, since it's a text-based export,
// not a stack of full-res photos. No single file can exceed the combined total anyway, so the
// per-file limit is set to match it (also lets multer reject an oversized file mid-stream,
// instead of buffering most of the way to a much higher limit before the total-size check below
// even runs).
export const MAX_TOTAL_UPLOAD_BYTES = 10 * 1024 * 1024;

export const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_TOTAL_UPLOAD_BYTES, files: 10 },
});

// multer's own `limits` only cap one file or one field at a time — nothing built in checks the
// combined size of every file across every field in a single request. Runs after upload.fields()
// so req.files is already populated; sits well within Node's default req timeout since the files
// are already fully buffered in memory by this point (the check itself is instant).
/**
 * Rejects the request with a 400 if the combined size of every uploaded file exceeds
 * {@link MAX_TOTAL_UPLOAD_BYTES}. Must run after `upload.fields(...)` so `req.files` is populated.
 */
export function enforceTotalUploadSize(req: Request, res: Response, next: NextFunction) {
    const filesByField = (req.files as Record<string, Express.Multer.File[]> | undefined) || {};
    const totalBytes = Object.values(filesByField)
        .flat()
        .reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
        const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
        return res.status(400).json({
            error: `attachments too large — ${totalMb}MB total, but the combined limit is ${MAX_TOTAL_UPLOAD_BYTES / (1024 * 1024)}MB`,
        });
    }
    next();
}

// Shared by /api/preview (staging thumbnails) and /api/process (the real scan) — real-world
// timesheets are frequently a phone photo (jpg/png), not a PDF, so branch on the upload's
// mimetype rather than assuming every file is a PDF.
/**
 * Loads every page of an uploaded file as base64 PNG images, branching on mimetype (a real-world
 * timesheet/bank statement/medical bill is as likely to be a phone photo as a PDF).
 *
 * @param file - The uploaded file (from multer).
 * @returns One base64 PNG string per page.
 */
export async function loadPagesForFile(file: Express.Multer.File): Promise<string[]> {
    const isImage = file.mimetype.startsWith("image/");
    return isImage ? await imageToPages(file.buffer) : await pdfToImages(file.buffer);
}
