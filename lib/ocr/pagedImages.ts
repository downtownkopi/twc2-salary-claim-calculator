import { mkdir, readFile, rm, writeFile } from "fs/promises";
import * as path from "path";

// A file's rendered pages, one PNG per page, written to `dir` by pdfToImages/imageToPages instead
// of an in-memory array — a 159-page job would otherwise hold every page's base64 PNG in RAM
// simultaneously for the whole ~15-20 minute job (see lib/ocr/images.ts). get()/set() touch one
// page's bytes at a time, so peak RAM is bounded by however many pages are actually in flight, not
// the total page count.
export class PagedImages {
    readonly dir: string;
    readonly length: number;

    constructor(dir: string, length: number) {
        this.dir = dir;
        this.length = length;
    }

    static pagePath(dir: string, i: number): string {
        return path.join(dir, `page-${i}.png`);
    }

    /** Reads page `i`'s PNG off disk and returns it base64-encoded. */
    async get(i: number): Promise<string> {
        const buf = await readFile(PagedImages.pagePath(this.dir, i));
        return buf.toString("base64");
    }

    // Callers (e.g. the staging-confirmed rotation step) currently mutate a page's image in place
    // before re-reading it later — set() persists that same "replace this page's image" write to
    // disk instead of a RAM array slot.
    /** Overwrites page `i`'s PNG on disk with a new base64-encoded image (e.g. after rotation). */
    async set(i: number, base64: string): Promise<void> {
        await writeFile(PagedImages.pagePath(this.dir, i), Buffer.from(base64, "base64"));
    }

    /** Deletes every page file and this instance's directory. */
    async cleanup(): Promise<void> {
        await rm(this.dir, { recursive: true, force: true });
    }
}

/** Ensures `dir` exists, creating it (and any missing parents) if needed. */
export async function ensurePagedImagesDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
}
