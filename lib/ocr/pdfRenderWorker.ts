import { pdf } from "pdf-to-img";
import sharp from "sharp";
import { writeFile } from "fs/promises";
import { PagedImages, ensurePagedImagesDir } from "./pagedImages";
import { boostFaintContrast, MAX_RENDERED_PAGE_DIMENSION } from "./pageImageHelpers";

// Runs inside a piscina worker thread (see lib/ocr/images.ts's renderPool) — this is the ENTIRE
// body of what used to be pdfToImages itself, before rendering moved off the main thread. Takes a
// plain data object (not live references — worker_threads can't share JS objects across the thread
// boundary) and does the same pdf.js render -> dimension-cap -> contrast-boost -> write-to-disk
// sequence per page, one page at a time (page.render() is CPU-bound synchronous JS; running several
// concurrently within one worker would just move the same oversized-buffer memory problem this was
// built to avoid into the worker instead of the main thread).
export type RenderPdfPagesTask = {
    input: string | Buffer;
    destDir: string;
    maxPages?: number;
    scale: number;
};

export type RenderPdfPagesResult = { pageCount: number };

/**
 * Renders every page of a PDF to a PNG file on disk (worker-thread task). See
 * lib/ocr/images.ts's `pdfToImages` for the public-facing API this backs.
 *
 * @param task - The PDF input, destination directory, optional page-count cap, and render scale.
 * @returns The number of pages rendered.
 * @throws If `maxPages` is given and the PDF's own page count exceeds it.
 */
export default async function renderPdfPages({ input, destDir, maxPages, scale }: RenderPdfPagesTask): Promise<RenderPdfPagesResult> {
    await ensurePagedImagesDir(destDir);
    const document = await pdf(input, { scale });
    if (maxPages !== undefined && document.length > maxPages) {
        await document.destroy();
        throw new Error(`this file has ${document.length} pages, over the ${maxPages}-page limit per scan — please split it into smaller uploads`);
    }
    const total = document.length;
    // document.getPage is 1-indexed; this function's own page indices (and PagedImages') stay
    // 0-indexed throughout, same convention as the pre-worker-thread version had.
    for (let i = 0; i < total; i++) {
        const pageBuffer = await document.getPage(i + 1);
        const capped = await sharp(pageBuffer)
            .resize({ width: MAX_RENDERED_PAGE_DIMENSION, height: MAX_RENDERED_PAGE_DIMENSION, fit: "inside", withoutEnlargement: true })
            .png()
            .toBuffer();
        const boosted = await boostFaintContrast(capped);
        await writeFile(PagedImages.pagePath(destDir, i), boosted);
    }
    return { pageCount: total };
}
