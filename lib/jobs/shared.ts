import multer from "multer";
import type { Request, Response, NextFunction } from "express";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { rm, unlink } from "fs/promises";
import { mkdirSync } from "fs";
import { imageToPages, pdfToImages, type PagedImages } from "../ocr";

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

// Caps how many pages one job scans at once. Previously uncapped (every page started
// simultaneously, on the theory that most real uploads were small) — fine on Cloud Run's elastic
// instances, but on a fixed-RAM VPS a large upload (e.g. ~159 pages) firing all at once means up to
// that many pages' rendered bytes are resident in RAM at the same moment (each read from disk via
// PagedImages.get, held only until that page's own scan finishes), plus a burst of concurrent
// vision-API requests that risks the provider's own rate limits. A fixed cap bounds the peak to a
// known size regardless of how large the upload is.
export const MAX_PAGE_CONCURRENCY = 10;

// Jobs are only needed long enough for the client to poll the final "done" state once — not
// pruning them at all would leak memory on a long-running server across many scans.
export const JOB_TTL_MS = 30 * 60 * 1000;

// Uploaded files stream straight to disk (see `upload` below) instead of RAM, so a large upload
// costs disk, not process memory. Overridable via env var in case the platform's default temp dir
// isn't disk-backed (some VPS images mount /tmp as tmpfs, which would defeat the point).
export const UPLOAD_TMP_DIR = process.env.UPLOAD_TMP_DIR || path.join(os.tmpdir(), "cuba-uploads");
mkdirSync(UPLOAD_TMP_DIR, { recursive: true });

// Generous enough for a real large scan (e.g. ~500MB / ~159 pages) with headroom, while still
// being a real ceiling rather than effectively unbounded — a request over this is rejected
// up front with a clear 400 rather than left to fail unpredictably later.
export const MAX_TOTAL_UPLOAD_BYTES = 1024 * 1024 * 1024;

// Separate from the byte cap above — this bounds vision-model cost/latency (3 scan attempts per
// page, plus a context-extraction pass), not memory. A page-heavy but small-in-bytes upload (e.g.
// many sparse text pages) wouldn't be caught by MAX_TOTAL_UPLOAD_BYTES at all otherwise. ~200 pages
// gives headroom over the known real case (~159 pages, itself already a 15-20+ minute scan)
// without letting a job's cost/runtime balloon unbounded.
export const MAX_PAGES_PER_JOB = 200;

/** Throws a descriptive error if `totalPages` (summed across every file in one job) exceeds {@link MAX_PAGES_PER_JOB}. */
export function checkPageCount(totalPages: number): void {
    if (totalPages > MAX_PAGES_PER_JOB) {
        throw new Error(
            `too many pages — ${totalPages} pages across all files, but the limit is ${MAX_PAGES_PER_JOB} pages per scan. Please split this into multiple smaller uploads.`
        );
    }
}

export const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOAD_TMP_DIR),
        // Original filename isn't trusted as-is (path separators, collisions between concurrent
        // uploads) — prefixed with a random id so two files named the same thing, uploaded at the
        // same time, never collide on disk.
        filename: (req, file, cb) => cb(null, `${randomUUID()}-${path.basename(file.originalname)}`),
    }),
    limits: { fileSize: MAX_TOTAL_UPLOAD_BYTES, files: 10 },
});

// multer's own `limits` only cap one file or one field at a time — nothing built in checks the
// combined size of every file across every field in a single request. Runs after upload.fields()
// so req.files is already populated; sits well within Node's default req timeout since the files
// are already fully written to disk by this point (the check itself is instant).
/**
 * Rejects the request with a 400 if the combined size of every uploaded file exceeds
 * {@link MAX_TOTAL_UPLOAD_BYTES}.
 */
export async function enforceTotalUploadSize(req: Request, res: Response, next: NextFunction) {
    const filesByField = (req.files as Record<string, Express.Multer.File[]> | undefined) || {};
    const allFiles = Object.values(filesByField).flat();
    const totalBytes = allFiles.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
        // The oversized files are already sitting on disk (diskStorage writes as bytes arrive,
        // before this check can run) — clean them up rather than leaking them.
        await Promise.all(allFiles.map(f => unlink(f.path).catch(() => {})));
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
 * Renders every page of an uploaded file to disk, branching on mimetype (a real-world
 * timesheet/bank statement/medical bill is as likely to be a phone photo as a PDF).
 *
 * @param file - The uploaded file (from multer's disk storage).
 * @param destDir - Directory to write this file's rendered pages into.
 * @param maxPages - Passed through to {@link pdfToImages} to reject an over-limit PDF early.
 * @returns A {@link PagedImages} over the file's rendered pages.
 */
export async function loadPagesForFile(file: Express.Multer.File, destDir: string, maxPages?: number): Promise<PagedImages> {
    const isImage = file.mimetype.startsWith("image/");
    const pages = isImage ? await imageToPages(file.path, destDir) : await pdfToImages(file.path, destDir, maxPages);
    // The uploaded source file is never read again after this — every downstream step works off
    // the rendered per-page files instead — so it's safe (and worth doing promptly, not waiting
    // for a TTL) to reclaim its disk space right away.
    await unlink(file.path).catch(() => {});
    return pages;
}

// Job queue concurrency — Cloud Run would just add instances under load; a fixed VPS can't. Caps
// how many scans run at once so peak memory/CPU stays predictable instead of scaling with however
// many caseworkers happen to upload at the same moment. Deliberately simple (counter + waiter
// queue) — no new dependency needed for this.
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || 1;
let runningJobs = 0;
const jobSlotQueue: (() => void)[] = [];

/** Resolves once a job slot is free (immediately if under {@link MAX_CONCURRENT_JOBS}, otherwise queued FIFO). */
export function acquireJobSlot(): Promise<void> {
    if (runningJobs < MAX_CONCURRENT_JOBS) {
        runningJobs++;
        return Promise.resolve();
    }
    return new Promise(resolve => {
        jobSlotQueue.push(() => {
            runningJobs++;
            resolve();
        });
    });
}

/** Releases a job slot acquired via {@link acquireJobSlot}, starting the next queued job (if any). */
export function releaseJobSlot(): void {
    runningJobs--;
    const next = jobSlotQueue.shift();
    if (next) next();
}

/** Deletes a job's temp page directory, ignoring errors (e.g. already removed). */
export async function cleanupJobDir(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
}

// One deterministic root per job, computed from jobId alone — every rendered-page temp dir a job
// creates lives under here, so cleaning up a finished job is always a single recursive delete of
// this one path, regardless of how many files/pages it had.
/** The root temp directory for a job's rendered pages (deterministic from `jobId` alone). */
export function jobPagesDir(jobId: string): string {
    return path.join(UPLOAD_TMP_DIR, jobId);
}
