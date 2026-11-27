import sharp from "sharp";
import { writeFile } from "fs/promises";
import * as path from "path";
import Piscina from "piscina";
import { PagedImages, ensurePagedImagesDir } from "./pagedImages";
import { boostFaintContrast } from "./pageImageHelpers";
import type { RenderPdfPagesTask, RenderPdfPagesResult } from "./pdfRenderWorker";

export { PagedImages } from "./pagedImages";
// Re-exported for existing callers/imports of boostFaintContrast from this module — the
// implementation itself moved to lib/ocr/pageImageHelpers.ts (shared with pdfRenderWorker.ts
// without that worker needing to import this module, which constructs the Piscina pool below —
// see renderPool's own comment for why that matters).
export { boostFaintContrast } from "./pageImageHelpers";

// The actual per-page rendering (pdfRenderWorker.ts's renderPdfPages) runs in a pool of worker
// threads, not here on the main thread. Why: pdf.js's page.render() (via node-canvas) does its
// decode/draw work as synchronous JS, not offloaded to libuv's threadpool the way e.g. sharp's
// operations are — a single large/high-resolution page can tie up the main thread for 10+ seconds
// of pure CPU work, during which this one Node process can't service ANY other request (a
// different caseworker's page load, /api/me, anything), since Node's main thread is single. A
// worker pool means the HTTP-serving thread stays free the whole time a render is in progress,
// regardless of how large or slow that render is. maxThreads deliberately conservative (not CPU
// count) — this VPS has already crash-looped once from a rendering-driven memory spike, and more
// concurrent render threads directly multiplies how many of those oversized intermediate buffers
// (see lib/ocr/pageImageHelpers.ts's MAX_RENDERED_PAGE_DIMENSION comment) can exist in memory at once.
// execArgv explicitly registers tsx's require hook in the spawned worker, rather than relying on
// worker_threads' default execArgv inheritance from the parent process — that inheritance only
// carries tsx/cjs through when the PARENT itself was launched with `node --require tsx/cjs` (true
// for `npm run server`, confirmed working), but not when the parent is vitest's own test runtime
// (vite-node, not plain node+tsx) — a worker spawned there had no TS loader at all and failed to
// load pdfRenderWorker.ts with ERR_UNKNOWN_FILE_EXTENSION. Explicit beats inherited here.
const renderPool = new Piscina({
    filename: path.join(__dirname, "pdfRenderWorker.ts"),
    maxThreads: Number(process.env.PDF_RENDER_MAX_THREADS) || 2,
    execArgv: ["--require", "tsx/cjs"],
});

// Convert a PDF (path or in-memory buffer) into per-page PNG files on disk, one per page. Pages
// used to be collected into one in-memory base64 array — for a large multi-page upload (e.g.
// ~159 pages), that held every rendered page's bytes in RAM at once for the whole job. Writing
// each page to disk as it's rendered, and returning a PagedImages that reads a page's bytes back
// only when a caller actually needs them, bounds peak RAM to however many pages are in flight
// rather than the total page count.
/**
 * Renders every page of a PDF to a PNG file on disk, via a worker-thread pool (see
 * {@link renderPool}'s own comment — keeps this off the main thread entirely).
 *
 * @param input - The PDF, as a file path or an in-memory buffer.
 * @param destDir - Directory to write each page's PNG into; created if missing.
 * @param maxPages - If given, rejects (before rendering any page) a PDF whose own page count
 * already exceeds this, instead of spending time/disk rendering pages that would just be discarded
 * once the job-wide page cap is hit anyway.
 * @param scale - Render resolution multiplier; defaults to 3.0 (the legibility floor needed for
 * actual OCR — bumped from 2.0 after a systematic, unanimous-across-reconciliation-attempts misread
 * of dense, small handwritten digits at the lower scale). Callers that only need these pages for a
 * human-facing preview (downscaled further for display anyway, e.g. /api/preview) should pass a
 * cheaper value — rendering at 3.0 just to immediately throw away most of those pixels wastes the
 * bulk of the time this function spends.
 * @returns A {@link PagedImages} over the rendered pages, in page order.
 */
export async function pdfToImages(input: string | Buffer, destDir: string, maxPages?: number, scale = 3.0): Promise<PagedImages> {
    const task: RenderPdfPagesTask = { input, destDir, maxPages, scale };
    const { pageCount }: RenderPdfPagesResult = await renderPool.run(task);
    return new PagedImages(destDir, pageCount);
}

// A single photographed/scanned timesheet (jpg/png/etc, common in real-world uploads — phone
// photos of a physical card) is already "one page" — normalize it into the same
// array-of-base64-PNG shape pdfToImages returns so callers don't need to branch downstream.
// `.rotate()` with no args applies the image's own EXIF orientation tag before stripping it —
// phone cameras commonly save landscape-held shots as portrait pixels + an EXIF rotation flag,
// and without this the page (and any handwriting on it) would be scanned sideways.
//
// A modern phone photo is commonly 3000-4000px on its long side — converted to PNG (no lossy
// compression, unlike the source JPEG) that balloons to 15MB+, which the model provider outright
// rejects ("Multimodal file size is too large"), failing every scan attempt for the page. Capped
// to roughly the same resolution pdfToImages produces for a rendered PDF page (~1800-2500px) —
// already proven legible for OCR there, and comfortably under the provider's limit.
/**
 * Normalizes a single photographed/scanned image (jpg/png/etc.) into the same one-page-per-file
 * shape {@link pdfToImages} writes.
 *
 * @param input - The raw image bytes.
 * @param destDir - Directory to write the normalized page's PNG into; created if missing.
 * @returns A single-page {@link PagedImages} over the normalized page.
 */
export async function imageToPages(input: string | Buffer, destDir: string): Promise<PagedImages> {
    await ensurePagedImagesDir(destDir);
    const png = await sharp(input)
        .rotate()
        .resize({ width: 2500, height: 2500, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
    const boosted = await boostFaintContrast(png);
    await writeFile(PagedImages.pagePath(destDir, 0), boosted);
    return new PagedImages(destDir, 1);
}

// Splits one page image into vertically overlapping bands (top/bottom by default). A single
// generation transcribing many visually-similar handwritten rows in one shot is prone to
// degenerate repetition — the model anchors on an earlier confidently-read row and starts
// pattern-completing later ones instead of independently re-reading them, and this reproduces
// identically across reconciliation attempts (same model, same failure) so majority-vote alone
// can't catch it. Cropping to fewer rows per generation directly reduces the dense visual
// stimulus that triggers this. Bands overlap generously (default 20% of each band's height) so
// no row sits exactly on a cut boundary — every row should land fully within at least one band.
// Callers reconcile each band independently, then reconcile again against bands (same function,
// same logic) to merge the (deliberately duplicate, boundary-safe) coverage back into one result.
//
// Page-level context (e.g. a header naming the month) can live ANYWHERE on the page depending on
// the source template's layout — there's no reliable pixel region to assume and stitch onto every
// band (tried assuming "near the top", wrong in general). Instead, extractPageContext (see
// ./pageScan) reads the FULL uncropped page once and that's carried forward as explicit text into
// every band's prompt, which works regardless of where on the page the context actually sits.
/**
 * Splits one page image into vertically overlapping bands, to reduce the dense-table
 * pattern-completion failure mode a single large transcription is prone to.
 *
 * @param base64Image - The page image, base64-encoded.
 * @param bandCount - How many bands to split into; `1` (or less) returns the page unchanged.
 * @param overlapFraction - Fraction of each band's height that overlaps its neighbors, so no row
 * sits exactly on a cut boundary.
 * @returns One base64 PNG string per band.
 */
export async function cropIntoBands(
    base64Image: string,
    bandCount = 2,
    overlapFraction = 0.2
): Promise<string[]> {
    if (bandCount <= 1) return [base64Image];

    const buffer = Buffer.from(base64Image, "base64");
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width!;
    const height = metadata.height!;

    const bandHeight = Math.round((height / bandCount) * (1 + overlapFraction));
    const step = bandCount > 1 ? (height - bandHeight) / (bandCount - 1) : 0;

    const bands: string[] = [];
    for (let i = 0; i < bandCount; i++) {
        const top = Math.max(0, Math.min(height - bandHeight, Math.round(i * step)));
        const cropHeight = Math.min(bandHeight, height - top);
        const cropped = await sharp(buffer)
            .extract({ left: 0, top, width, height: cropHeight })
            .png()
            .toBuffer();
        bands.push(cropped.toString("base64"));
    }
    return bands;
}

// Used by the agent loop's cropRegion tool (lib/ocr/agentLoop.ts) so a model that's unsure about
// one area of a page can zoom in rather than re-reading the whole image. Coordinates are
// fractions of the page (0-1), not pixels — the model is only ever shown the rendered image, never
// told its pixel dimensions, so asking it to reason in pixel space would be guesswork; fractions
// map directly onto what it can actually see.
/**
 * Crops a rectangular region of a page image, specified as fractions (0-1) of the page's width
 * and height.
 *
 * @param base64Image - The page image, base64-encoded.
 * @param bbox - The region to crop, as fractions of the page's width/height.
 * @returns The cropped region, base64-encoded PNG.
 */
export async function cropRegion(
    base64Image: string,
    bbox: { left: number; top: number; width: number; height: number }
): Promise<string> {
    const buffer = Buffer.from(base64Image, "base64");
    const metadata = await sharp(buffer).metadata();
    const imgWidth = metadata.width!;
    const imgHeight = metadata.height!;

    const left = Math.max(0, Math.min(imgWidth - 1, Math.round(bbox.left * imgWidth)));
    const top = Math.max(0, Math.min(imgHeight - 1, Math.round(bbox.top * imgHeight)));
    const width = Math.max(1, Math.min(imgWidth - left, Math.round(bbox.width * imgWidth)));
    const height = Math.max(1, Math.min(imgHeight - top, Math.round(bbox.height * imgHeight)));

    const cropped = await sharp(buffer).extract({ left, top, width, height }).png().toBuffer();
    return cropped.toString("base64");
}

// The OCR pipeline needs the page rendered at scale 3.0 for legible digits, but shipping that
// same full-resolution image back to the browser for every page (for the side-by-side review UI)
// would bloat the JSON response — a single page can be 1-1.5MB at that scale. Downscaled
// separately, display-only, so the OCR-quality image never leaves the server.
/**
 * Downscales a page image for display in the browser's review UI, without touching the
 * full-resolution copy used for OCR.
 *
 * @param base64Image - The page image, base64-encoded.
 * @param maxWidth - Maximum width in pixels; the image is never upscaled.
 * @returns The downscaled image, base64-encoded.
 */
export async function resizeForDisplay(base64Image: string, maxWidth = 1400): Promise<string> {
    const buffer = Buffer.from(base64Image, "base64");
    const resized = await sharp(buffer)
        .resize({ width: maxWidth, withoutEnlargement: true })
        .png()
        .toBuffer();
    return resized.toString("base64");
}

// Applies a user-confirmed rotation from the pre-scan staging step (public/index.html) — chosen
// by a human looking at a thumbnail, not detected automatically. A cheap VLM self-report of "how
// many degrees to rotate this" was tested and found unreliable (confidently wrong on a real
// sideways page), so orientation correction here is deliberately human-confirmed rather than
// inferred. `degrees` follows the same clockwise convention as CSS's `transform: rotate()`, so the
// staging UI's live thumbnail preview and this server-side correction always agree on which way is
// which.
/**
 * Rotates a page image by a human-confirmed angle (from the pre-scan staging step).
 *
 * @param base64Image - The page image, base64-encoded.
 * @param degrees - Clockwise rotation in degrees, same convention as CSS `transform: rotate()`.
 * @returns The rotated image, base64-encoded; the input unchanged if `degrees` normalizes to 0.
 */
export async function rotateImage(base64Image: string, degrees: number): Promise<string> {
    const normalized = ((degrees % 360) + 360) % 360;
    if (normalized === 0) return base64Image;
    const buffer = Buffer.from(base64Image, "base64");
    const rotated = await sharp(buffer).rotate(normalized).png().toBuffer();
    return rotated.toString("base64");
}
