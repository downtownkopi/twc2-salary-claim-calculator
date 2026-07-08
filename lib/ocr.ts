import { OpenRouter } from "@openrouter/sdk";
import { pdf } from "pdf-to-img";

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
    const document = await pdf(input, { scale: 2.0 }); // scale up for better OCR
    for await (const pageBuffer of document) {
        images.push(pageBuffer.toString("base64"));
    }
    return images;
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
export async function scanPageImage(
    base64Image: string,
    prompt: string
): Promise<{ content: string; truncated: boolean }> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const response = await getClient().chat.send({
                chatRequest: {
                    model: "qwen/qwen2.5-vl-72b-instruct",
                    maxTokens: 8000,
                    // This is transcription, not creative writing — the same page should read the
                    // same way every time. Without this the provider's default (non-zero)
                    // temperature makes row-count and legibility calls vary run to run.
                    temperature: 0,
                    seed: 42,
                    // OpenRouter auto-routes this model across multiple backend providers, which
                    // can silently serve different quantizations of "the same" model. No fp16+
                    // endpoint is currently available for this model at all (every provider
                    // quantizes it), so we exclude only the most degraded tiers (int4/int8/fp4/fp6)
                    // that most hurt fine-detail reading like dense handwriting, while still
                    // allowing fp8 since that's what's actually served.
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
