import * as fs from "fs";
import * as path from "path";
import { pdfToImages, scanPageImage } from "./lib/ocr";

const PROMPT = `This is a handwritten timesheet. Transcribe every entry exactly as written,
then output a JSON array with fields: date, clock_in, clock_out, notes.
If a field is illegible, use null and flag it in notes. Output ONLY valid JSON, no other text.`;

async function main() {
    const pdfPath = path.join(__dirname, "test.pdf"); // adjust to your file
    const images = await pdfToImages(pdfPath);

    const results = [];
    for (let i = 0; i < images.length; i++) {
        const { content, truncated } = await scanPageImage(images[i], PROMPT);
        console.log(`--- Page ${i + 1}${truncated ? " (TRUNCATED)" : ""} ---`);
        console.log(content);
        results.push(content);
    }

    fs.writeFileSync("output.json", JSON.stringify(results, null, 2));
    console.log("Done. Saved to output.json");
}

main().catch(console.error);
