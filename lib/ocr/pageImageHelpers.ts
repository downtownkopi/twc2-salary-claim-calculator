import sharp from "sharp";

// Shared by lib/ocr/images.ts (imageToPages, the main-thread path for a plain photo upload) and
// lib/ocr/pdfRenderWorker.ts (the worker-thread path for a rendered PDF page) — kept in their own
// module, importing neither of those two, specifically so pdfRenderWorker.ts doesn't need to import
// images.ts: images.ts is where the Piscina pool itself is constructed, and a worker thread
// requiring that module would instantiate its own nested pool (spawning yet more worker threads)
// every time a task file loads it.

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
export async function boostFaintContrast(png: Buffer): Promise<Buffer> {
    const stats = await sharp(png).grayscale().stats();
    const stdev = stats.channels[0].stdev;
    if (stdev >= LOW_CONTRAST_STDEV_THRESHOLD) return png;
    const mean = stats.channels[0].mean;
    const offset = mean * (1 - CONTRAST_BOOST_FACTOR);
    return sharp(png).linear(CONTRAST_BOOST_FACTOR, offset).png().toBuffer();
}

// Caps how large a single rendered page is allowed to come out, regardless of what `scale ×
// the PDF's own native page size` would otherwise produce. scale is a FIXED multiplier with zero
// awareness of how large a page's native resolution already is — fine for a normal low-res scanned
// page (the case scale 3.0 was tuned for), but a real-world timesheet is just as likely to be a PDF
// built from full-resolution phone-camera photos (one per page), where the native page size is
// already huge. Observed live: a 20-page upload like this rendered its first page at 6804×12096px
// at scale 3.0 — a 314MB raw buffer for ONE page, a major contributor to a production memory spike
// severe enough to crash-loop the process. Same ceiling imageToPages uses for a raw photo upload
// (already proven legible for OCR there) — downscaled immediately after render, before
// boostFaintContrast or anything else touches the oversized buffer, so it never propagates further
// into the pipeline (base64 encoding, the agentic loop's conversation history, MAX_PAGE_CONCURRENCY
// pages processing at once).
export const MAX_RENDERED_PAGE_DIMENSION = 2500;
