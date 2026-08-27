import { describe, expect, it, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { PagedImages, ensurePagedImagesDir } from "../../lib/ocr/pagedImages";

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paged-images-test-"));
    tmpDirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("PagedImages", () => {
    it("get() returns exactly the bytes written for that page", async () => {
        const dir = await makeTmpDir();
        await ensurePagedImagesDir(dir);
        const page0 = Buffer.from("fake png bytes for page 0");
        const page1 = Buffer.from("different bytes for page 1");
        await fs.writeFile(PagedImages.pagePath(dir, 0), page0);
        await fs.writeFile(PagedImages.pagePath(dir, 1), page1);

        const images = new PagedImages(dir, 2);
        expect(images.length).toBe(2);
        expect(await images.get(0)).toBe(page0.toString("base64"));
        expect(await images.get(1)).toBe(page1.toString("base64"));
    });

    it("set() persists a replacement image (e.g. after rotation) that a later get() sees", async () => {
        const dir = await makeTmpDir();
        await ensurePagedImagesDir(dir);
        const original = Buffer.from("original page bytes");
        await fs.writeFile(PagedImages.pagePath(dir, 0), original);

        const images = new PagedImages(dir, 1);
        const rotated = Buffer.from("rotated page bytes").toString("base64");
        await images.set(0, rotated);

        expect(await images.get(0)).toBe(rotated);
    });

    it("cleanup() removes every page file and the directory itself", async () => {
        const dir = await makeTmpDir();
        await ensurePagedImagesDir(dir);
        await fs.writeFile(PagedImages.pagePath(dir, 0), Buffer.from("page 0"));
        await fs.writeFile(PagedImages.pagePath(dir, 1), Buffer.from("page 1"));

        const images = new PagedImages(dir, 2);
        await images.cleanup();

        await expect(fs.access(dir)).rejects.toThrow();
        tmpDirs.splice(tmpDirs.indexOf(dir), 1); // already removed, nothing left for afterEach to clean up
    });
});
