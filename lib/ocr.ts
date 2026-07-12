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
): Promise<{ content: string; truncated: boolean; cost: number }> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const response = await getClient().chat.send({
                chatRequest: {
                    // Asks OpenRouter to report the actual USD cost of this specific call back in
                    // the response (response.usage.cost) rather than us estimating it from
                    // published per-token pricing — exact and correct even if a request happens to
                    // route to a different-priced provider/quantization tier than expected.
                    usage: { include: true },
                    // Switched from google/gemini-2.5-flash after user side-by-side testing found
                    // it underperformed on dense handwritten timesheets. nex-agi/nex-n2-pro is a
                    // MoE model (17B active / 397B total, Qwen3.5 arch) with two OpenRouter
                    // endpoints: Nex AGI (fp8) and SiliconFlow (unknown quantization). Filtering to
                    // known, higher-precision quant tiers only (same reasoning as the earlier Qwen
                    // setup) to avoid the lower-confidence unknown-quant provider.
                    // Switched from nex-n2-pro per user request to try qwen3-vl-32b-instruct.
                    // reasoning: effort "none" is kept as a harmless no-op for non-reasoning
                    // models (confirmed via a live call — response comes back with
                    // reasoning: null, doesn't error) so we don't need to special-case it per
                    // model. qwen3-vl-32b-instruct has only one OpenRouter endpoint (Alibaba,
                    // quantization "unknown") — the fp8/fp16/bf16/fp32 filter used for Qwen's
                    // larger models would exclude that one endpoint entirely and leave nothing to
                    // route to, so it's dropped here (same reasoning as the earlier Gemini swap).
                    reasoning: { effort: "none" },
                    model: "qwen/qwen3-vl-32b-instruct",
                    maxTokens,
                    temperature,
                    seed,
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
                    // `usage` isn't in the SDK's TS type for ChatRequest, but OpenRouter's API
                    // accepts and honors it (confirmed via a live call) — cast to bypass the
                    // stale type, matching the `response as any` cast already used below for the
                    // same reason on the response side.
                } as any,
            });

            const choice = (response as any).choices[0];
            return {
                content: choice.message.content,
                truncated: choice.finishReason === "length",
                cost: (response as any).usage?.cost ?? 0,
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
): Promise<{ content: string; truncated: boolean; cost: number }> {
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
export async function extractPageContext(base64Image: string): Promise<{ context: string; cost: number }> {
    const prompt = `Look at this ENTIRE page of a handwritten timesheet. Somewhere on the page — top, bottom, a corner, a margin, anywhere — there may be a title, header, label, or filename-like text indicating which calendar month (and possibly year) the date rows on this page belong to. There may also be other useful page-level context, like a worker's name.

Reply with ONE short plain-text sentence stating what you found, e.g. "Header indicates December" or "No month header found, but page appears to be for a worker named Ahmad" or "No page-level context found." Do not transcribe any individual rows or times — this is only about page-level context, not row data. Keep it brief.`;
    const { content, cost } = await sendVisionRequest(base64Image, prompt, 0, 42, 200);
    return { context: content.trim(), cost };
}

// Even with strict cross-attempt unanimity (lib/reconcile.ts), the underlying model can still
// consistently, confidently report a date that simply isn't on the page at all — e.g. it
// hallucinates the same fabricated entry on every one of the 3 temperature-varied attempts, so
// there's no disagreement for reconciliation to catch. This is a genuinely different, narrower
// question than "transcribe every row correctly" (the task that's been failing): for each date
// the main pass already agreed on, does that date's row actually exist on the page at all? A
// single batch call handles every candidate date at once rather than one call per date, keeping
// the cost to one extra call per page regardless of how many dates were reported.
export async function verifyDatesOnPage(
    base64Image: string,
    candidates: { day: number; month: number }[]
): Promise<{ confirmed: Set<string>; cost: number }> {
    if (candidates.length === 0) return { confirmed: new Set(), cost: 0 };

    const dateList = candidates.map(c => `${c.day}/${c.month}`).join(", ");
    const prompt = `This is the full page of a handwritten timesheet. A previous pass claimed to find a row with actual handwritten content (times, marks, something written) for each of these dates on this page: ${dateList} (format is day/month).

Your ONLY job is to verify, for EACH date in that list, whether that date's row genuinely exists on the page with real handwritten content in it — not to re-transcribe any times. Look carefully: is there an actual row for this date, with something written in it? If a date's row is blank, or that date doesn't appear on the page at all, that date should be marked NOT confirmed.

Output ONLY a JSON array with exactly one object per date in the list, in the same order, as {day, month, confirmed}, where confirmed is true only if you can see genuine handwritten content for that date's row. No other text, no markdown fences.`;

    const { content, cost } = await sendVisionRequest(base64Image, prompt, 0, 42, 2000);
    const parsed = JSON.parse(extractJsonBlock(content)) as { day: number; month: number; confirmed: boolean }[];

    const confirmed = new Set<string>();
    for (const r of parsed) {
        if (r.confirmed === true) confirmed.add(`${r.month}-${r.day}`);
    }
    return { confirmed, cost };
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
