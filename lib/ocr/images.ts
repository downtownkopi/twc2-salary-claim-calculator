import { pdf } from "pdf-to-img";
import sharp from "sharp";

// Contrast boost for genuinely low-contrast pages (faint pen, washed-out photocopies) — centered
// on the page's own measured brightness (mean) rather than a hard min/max stretch. Tested against
// real faint samples before adopting this: a full min/max stretch (sharp's .normalize()) thins
// faint pen strokes enough to flip digit reads (9 misread as 6, repeatedly, on an otherwise
// perfectly-read page); this mean-centered version left that same page's accuracy unchanged, and
// surfaced at least one previously "illegible" cell on a genuinely hard low-contrast sample. Only
// applied below a stdev threshold so a normal, already-decent-contrast scan is never touched —
// the risk demonstrated above is specifically from applying this where it isn't needed.
const LOW_CONTRAST_STDEV_THRESHOLD = 30;
const CONTRAST_BOOST_FACTOR = 1.6;

/**
 * Boosts contrast on a genuinely low-contrast page image (faint pen, washed-out photocopy),
 * centered on the page's own measured brightness. A no-op for already-decent-contrast pages.
 *
 * @param png - The page image as a PNG buffer.
 * @returns The (possibly contrast-boosted) PNG buffer.
 */
async function boostFaintContrast(png: Buffer): Promise<Buffer> {
    const stats = await sharp(png).grayscale().stats();
    const stdev = stats.channels[0].stdev;
    if (stdev >= LOW_CONTRAST_STDEV_THRESHOLD) return png;
    const mean = stats.channels[0].mean;
    const offset = mean * (1 - CONTRAST_BOOST_FACTOR);
    return sharp(png).linear(CONTRAST_BOOST_FACTOR, offset).png().toBuffer();
}

// Convert a PDF (path or in-memory buffer) into an array of base64 PNG images, one per page
/**
 * Renders every page of a PDF to a base64 PNG image.
 *
 * @param input - The PDF, as a file path or an in-memory buffer.
 * @returns One base64 PNG string per page, in page order.
 */
export async function pdfToImages(input: string | Buffer): Promise<string[]> {
    const images: string[] = [];
    // Bumped from 2.0 after a systematic (unanimous-across-attempts) misread of dense, small
    // handwritten digits — the failure wasn't inconsistency between attempts (which the
    // multi-attempt reconciliation in lib/reconcile.ts is designed to catch), it was the same
    // legibility limit hit every time. Higher scale trades more tokens/latency per page for
    // clearer source pixels.
    const document = await pdf(input, { scale: 3.0 });
    for await (const pageBuffer of document) {
        const boosted = await boostFaintContrast(pageBuffer);
        images.push(boosted.toString("base64"));
    }
    return images;
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
 * Normalizes a single photographed/scanned image (jpg/png/etc.) into the same
 * one-page-per-array-entry shape {@link pdfToImages} returns.
 *
 * @param input - The raw image bytes.
 * @returns A single-element array containing the normalized page as a base64 PNG.
 */
export async function imageToPages(input: Buffer): Promise<string[]> {
    const png = await sharp(input)
        .rotate()
        .resize({ width: 2500, height: 2500, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
    const boosted = await boostFaintContrast(png);
    return [boosted.toString("base64")];
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
