import { OpenRouter } from "@openrouter/sdk";
import { pdf } from "pdf-to-img";
import sharp from "sharp";

let client: OpenRouter | null = null;

function getClient(): OpenRouter {
    if (!client) {
        if (!process.env.OPENROUTER_API_KEY) {
            throw new Error("OPENROUTER_API_KEY is not set. Add it to .env.");
        }
        client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
    }
    return client;
}

// Convert a PDF (path or in-memory buffer) into an array of base64 PNG images, one per page
export async function pdfToImages(input: string | Buffer): Promise<string[]> {
    const images: string[] = [];
    // Bumped from 2.0 after a systematic (unanimous-across-attempts) misread of dense, small
    // handwritten digits — the failure wasn't inconsistency between attempts (which the
    // multi-attempt reconciliation in lib/reconcile.ts is designed to catch), it was the same
    // legibility limit hit every time. Higher scale trades more tokens/latency per page for
    // clearer source pixels.
    const document = await pdf(input, { scale: 3.0 });
    for await (const pageBuffer of document) {
        images.push(pageBuffer.toString("base64"));
    }
    return images;
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
// band (tried assuming "near the top", wrong in general). Instead, extractPageContext below reads
// the FULL uncropped page once and that's carried forward as explicit text into every band's
// prompt, which works regardless of where on the page the context actually sits.
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

function isRateLimited(err: any): boolean {
    const code = err?.error?.code ?? err?.statusCode ?? err?.status;
    return code === 429;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Send a single page image + prompt to Qwen2.5-VL via OpenRouter, return raw model text.
// A dense timesheet page (e.g. 24+ rows) can produce a long JSON response — without an
// explicit maxTokens the provider default can cut it off mid-array, silently dropping the
// tail rows. We set a generous cap and flag it if the model still hit that limit.
//
// temperature/seed are caller-supplied rather than hardcoded: transcription is mostly
// deterministic work, but temperature=0 across every reconciliation attempt (lib/reconcile.ts)
// means a systematic model bias — e.g. lazily repeating a previous row's value on a dense,
// visually-repetitive table instead of re-reading each row — gets reproduced identically on
// every attempt, giving reconciliation's disagreement-detection nothing to catch. Varying
// temperature/seed across attempts (server.ts) gives each pass a real chance to diverge when
// the model's reading is actually uncertain.
async function sendVisionRequest(
    base64Image: string,
    prompt: string,
    temperature: number,
    seed: number,
    maxTokens: number
): Promise<{ content: string; truncated: boolean }> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const response = await getClient().chat.send({
                chatRequest: {
                    model: "qwen/qwen3-vl-235b-a22b-instruct",
                    maxTokens,
                    temperature,
                    seed,
                    // OpenRouter auto-routes this model across multiple backend providers, which
                    // can silently serve different quantizations of "the same" model. Unlike the
                    // old qwen2.5-vl-72b (no fp16+ endpoint existed at all), this model has a
                    // bf16 provider available — exclude only the most degraded tiers
                    // (int4/int8/fp4/fp6) that most hurt fine-detail reading like dense
                    // handwriting, keep fp8/bf16/fp32 in play.
                    provider: { quantizations: ["fp8", "fp16", "bf16", "fp32"] },
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: prompt },
                                {
                                    type: "image_url",
                                    imageUrl: {
                                        url: `data:image/png;base64,${base64Image}`,
                                    },
                                },
                            ],
                        },
                    ],
                },
            });

            const choice = (response as any).choices[0];
            return {
                content: choice.message.content,
                truncated: choice.finishReason === "length",
            };
        } catch (err) {
            if (isRateLimited(err) && attempt < MAX_ATTEMPTS) {
                await sleep(1000 * 2 ** (attempt - 1)); // 1s, 2s backoff
                continue;
            }
            throw err;
        }
    }
    throw new Error("unreachable"); // satisfies TS control-flow analysis
}

export async function scanPageImage(
    base64Image: string,
    prompt: string,
    temperature = 0,
    seed = 42
): Promise<{ content: string; truncated: boolean }> {
    return sendVisionRequest(base64Image, prompt, temperature, seed, 8000);
}

// Reads the FULL, uncropped page once to find any page-level context (most importantly, a
// header/title naming the month all rows on the page belong to) before it gets cropped into
// bands for the actual row-by-row transcription. A month header can sit anywhere on the page
// depending on the source template's layout, so there's no reliable pixel region to always
// preserve in every band — reading the whole page once and carrying the answer forward as text
// works regardless of where it actually is. Deterministic (temperature 0) and single-shot: this
// is a much simpler read (one label, not dozens of ambiguous handwritten digits) than the
// per-row transcription, so it doesn't need the multi-attempt reconciliation the row-by-row
// scan gets — one confident read is enough for a single label.
export async function extractPageContext(base64Image: string): Promise<string> {
    const prompt = `Look at this ENTIRE page of a handwritten timesheet. Somewhere on the page — top, bottom, a corner, a margin, anywhere — there may be a title, header, label, or filename-like text indicating which calendar month (and possibly year) the date rows on this page belong to. There may also be other useful page-level context, like a worker's name.

Reply with ONE short plain-text sentence stating what you found, e.g. "Header indicates December" or "No month header found, but page appears to be for a worker named Ahmad" or "No page-level context found." Do not transcribe any individual rows or times — this is only about page-level context, not row data. Keep it brief.`;
    const { content } = await sendVisionRequest(base64Image, prompt, 0, 42, 200);
    return content.trim();
}

// Model replies are usually markdown-fenced (```json ... ```) but sometimes prefix/suffix the
// JSON with stray characters or prose (e.g. a leading ">"). Strip fences if present, otherwise
// fall back to slicing from the first "[" to the last "]" so junk around the array is dropped.
export function extractJsonBlock(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced) return fenced[1];

    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) {
        return text.slice(start, end + 1);
    }
    return text;
}
