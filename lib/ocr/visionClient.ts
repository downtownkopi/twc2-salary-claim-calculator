import { OpenRouter } from "@openrouter/sdk";
import { traceable } from "langsmith/traceable";

// The default model every call uses unless a caller explicitly overrides it (see the `model`
// param on sendVisionRequest/scanPageImage/extractPageContext/verifyDatesOnPage). IPA extraction
// (lib/ipa.ts) and bank statement extraction (lib/bankstatement.ts) never override, so they always
// use this; server.ts's timesheet pipeline also uses this directly now (see timesheetModel there).
// Currently both set to xiaomi/mimo-v2.5 per user testing — beat qwen3-vl-32b-instruct AND
// gemini-2.5-flash on the two hardest real cases found this session (dash+holiday-label combo, "no
// lunch" attribution), at roughly half gemini-2.5-flash's cost. FALLBACK_VISION_MODEL is currently
// identical to PRIMARY_VISION_MODEL, so server.ts's hybrid escalation step (re-asking a disputed
// date with the fallback model) is a no-op while they match — repoint FALLBACK_VISION_MODEL to a
// genuinely different model to restore that escalation's value.
export const PRIMARY_VISION_MODEL = "xiaomi/mimo-v2.5";
export const FALLBACK_VISION_MODEL = "xiaomi/mimo-v2.5";

let client: OpenRouter | null = null;

/**
 * Lazily creates (and caches) the shared OpenRouter client.
 *
 * @returns The OpenRouter client.
 * @throws If `OPENROUTER_API_KEY` isn't set.
 */
function getClient(): OpenRouter {
    if (!client) {
        if (!process.env.OPENROUTER_API_KEY) {
            throw new Error("OPENROUTER_API_KEY is not set. Add it to .env.");
        }
        client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
    }
    return client;
}

/** Checks whether a caught error represents an HTTP 429 (rate limited) response. */
function isRateLimited(err: any): boolean {
    const code = err?.error?.code ?? err?.statusCode ?? err?.status;
    return code === 429;
}

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// A malformed/truncated upstream response can make the OpenRouter SDK throw from deep inside its
// own internals (confirmed live: a JSON.parse failure inside the SDK's matchFunc/chatSend),
// detached from the promise this function returns — that promise then never resolves or rejects
// on its own, hanging forever. Racing it against a plain timeout doesn't cancel the underlying
// request (the SDK's own unhandled rejection, already logged and swallowed by server.ts's
// process-level handler, still fires later) but it stops THIS call from blocking whatever awaited
// it — e.g. one hung attempt no longer blocks an entire page's Promise.allSettled batch forever.
//
// A timeout here is retried (bounded, see MAX_ATTEMPTS below), unlike the original no-retry
// design. Reasoning: a pending request can be in one of two states we can't tell apart while
// waiting — genuinely slow (big image, long prompt, provider under load; would eventually
// succeed) or the SDK bug above (would NEVER resolve, confirmed live via an unhandled-rejection
// that fired minutes after we'd already given up). Since a real, confirmed-possible permanent
// hang exists, removing the timeout entirely isn't safe — but since a slow-but-good response is
// also plausible, treating every timeout as a final failure with zero retry throws away exactly
// the case where trying again would have worked. A fresh attempt (no backoff delay — unlike the
// 429 case, there's no rate limit to wait out) gives that case a real second chance while still
// bounding total wait to MAX_ATTEMPTS x REQUEST_TIMEOUT_MS in the worst case.
class TimeoutError extends Error {}

const REQUEST_TIMEOUT_MS = 90_000;

/** Rejects with a {@link TimeoutError} after `ms` milliseconds. */
function requestTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) => setTimeout(() => reject(new TimeoutError(`OpenRouter request timed out after ${ms}ms`)), ms));
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
// Wrapped in LangSmith's traceable() so every vision-model call in the app — page context reads,
// per-attempt scans, date verification, IPA extraction, bank statement extraction — shows up as a
// traced run (prompt/response/latency/cost) without each call site needing its own tracing code,
// since they all funnel through this one function. No-ops with zero behavior change if
// LANGSMITH_API_KEY/LANGSMITH_TRACING aren't set (see LangSmith SDK docs) — safe to leave wrapped
// even when tracing isn't configured, e.g. in this repo's default local dev setup.
/**
 * Sends one page image + prompt to the vision model via OpenRouter and returns its raw text reply.
 * Retries on rate limiting (with backoff) and on a hung/timed-out request (no backoff).
 *
 * @param base64Image - The page image, base64-encoded (no data URL prefix).
 * @param prompt - The text prompt to send alongside the image.
 * @param temperature - Model sampling temperature.
 * @param seed - Model sampling seed.
 * @param maxTokens - Max output tokens; a response that hits this cap comes back `truncated: true`.
 * @param model - Which model to call; defaults to {@link PRIMARY_VISION_MODEL}.
 * @returns The model's raw reply text, whether it was truncated, and this call's cost in USD.
 */
export const sendVisionRequest = traceable(
    async function sendVisionRequest(
        base64Image: string,
        prompt: string,
        temperature: number,
        seed: number,
        maxTokens: number,
        model: string = PRIMARY_VISION_MODEL
    ): Promise<{ content: string; truncated: boolean; cost: number }> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const response = await Promise.race([
                getClient().chat.send({
                    chatRequest: {
                        // Asks OpenRouter to report the actual USD cost of this specific call back in
                        // the response (response.usage.cost) rather than us estimating it from
                        // published per-token pricing — exact and correct even if a request happens to
                        // route to a different-priced provider/quantization tier than expected.
                        usage: { include: true },
                        // reasoning: effort "none" is kept as a harmless no-op for non-reasoning
                        // models (confirmed via a live call on qwen3-vl-32b-instruct — response comes
                        // back with reasoning: null, doesn't error) so callers don't need to
                        // special-case it per model, including FALLBACK_VISION_MODEL.
                        reasoning: { effort: "none" },
                        model,
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
                }),
                requestTimeout(REQUEST_TIMEOUT_MS),
            ]);

            const choice = (response as any).choices[0];
            return {
                // Some models/providers (seen with xiaomi/mimo-v2.5, not with the earlier
                // qwen/gemini setup) can return message.content as null — e.g. a moderation/
                // content-filter response, or an empty completion — despite this function's return
                // type promising a plain string. Every caller downstream (extractJsonBlock, JSON.parse,
                // .trim() in extractPageContext's fallback path) assumes a real string; coercing null
                // to "" here means those calls fail through their EXISTING "couldn't parse" handling
                // instead of throwing a raw TypeError that skips a page with a confusing crash message.
                content: choice.message.content ?? "",
                truncated: choice.finishReason === "length",
                cost: (response as any).usage?.cost ?? 0,
            };
        } catch (err) {
            if (isRateLimited(err) && attempt < MAX_ATTEMPTS) {
                await sleep(1000 * 2 ** (attempt - 1)); // 1s, 2s backoff
                continue;
            }
            if (err instanceof TimeoutError && attempt < MAX_ATTEMPTS) {
                continue; // no backoff — a hung/slow request just needs a fresh attempt, not a wait
            }
            throw err;
        }
    }
    throw new Error("unreachable"); // satisfies TS control-flow analysis
    },
    {
        name: "sendVisionRequest",
        run_type: "llm",
        // The raw base64 PNG is often 1-3MB of text — logging it in full would bloat every trace
        // and isn't readable in the LangSmith UI anyway. Swap it for its length so a trace still
        // shows "an image was sent" and roughly how large, without the actual payload. Multiple
        // positional args (not a single object) means the traced shape is { args: [...] }, per
        // langsmith's ProcessInputs typing — index 0 is base64Image.
        processInputs: ({ args }) => {
            const [base64Image, prompt, temperature, seed, maxTokens, model] = args;
            return {
                args: [`<image, ${base64Image?.length ?? 0} base64 chars>`, prompt, temperature, seed, maxTokens, model],
            };
        },
    }
);

// Model replies are usually markdown-fenced (```json ... ```) but sometimes prefix/suffix the
// JSON with stray characters or prose (e.g. a leading ">"). Strip fences if present, otherwise
// fall back to slicing from the first "[" to the last "]" (array responses) or "{" to "}" (object
// responses, e.g. extractPageContext's classification reply) so junk around the JSON is dropped.
/**
 * Extracts the JSON payload from a model's raw reply text, stripping markdown fences or
 * surrounding prose if present.
 *
 * @param text - The model's raw reply.
 * @returns The extracted JSON substring (still needs `JSON.parse`), or `text` unchanged if no
 * JSON-like bracket could be found at all.
 */
export function extractJsonBlock(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced) return fenced[1];

    const arrStart = text.indexOf("[");
    const objStart = text.indexOf("{");
    // Whichever bracket the reply's JSON actually opens with FIRST tells us its true top-level
    // shape — an object reply (e.g. lib/ipa.ts's IpaFields) can itself contain array-valued
    // fields (fixedMonthlyAllowances/fixedMonthlyDeductions), so unconditionally preferring
    // "first [ ... last ]" here would slice out just one of those nested arrays (e.g. an empty
    // "[]") instead of the whole object — JSON.parse happily parses that short valid array on
    // its own, then errors on every character of the real object that follows it.
    const useArray = arrStart !== -1 && (objStart === -1 || arrStart < objStart);
    if (useArray) {
        const arrEnd = text.lastIndexOf("]");
        if (arrEnd > arrStart) return text.slice(arrStart, arrEnd + 1);
    }
    const objEnd = text.lastIndexOf("}");
    if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
        return text.slice(objStart, objEnd + 1);
    }
    return text;
}
