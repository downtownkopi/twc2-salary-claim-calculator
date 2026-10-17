import { OpenRouter } from "@openrouter/sdk";
import { traceable } from "langsmith/traceable";
import { logVisionEvent } from "../visionDebugLog";

// The default model every call uses unless a caller explicitly overrides it (see the `model`
// param on sendVisionRequest/scanPageImage/extractPageContext/verifyDatesOnPage). IPA extraction
// (lib/ipa.ts) and bank statement extraction (lib/bankstatement.ts) never override, so they always
// use this; server.ts's timesheet pipeline also uses this directly now (see timesheetModel there).
// Briefly tried xiaomi/mimo-v2.6-flash (identical OpenRouter pricing and context window, newer
// release) — reverted back to xiaomi/mimo-v2.5. A small 3-call sample looked like a wash, but real
// full-document usage on sample-data/338M/338M_Timecards.pdf (the hardest sample on hand — a
// passbook-style sheet with genuinely ambiguous Qty/Amount columns) showed v2.6-flash returning
// empty/wrong rows across most of the document, consistent with an empty-array failure mode
// (shapeFamily correct, rows: [] on a page with 28 real dates) already caught in isolated testing
// before the switch. v2.5 remains the validated default until v2.6-flash (or another candidate) is
// tested more rigorously at full-document scale, not just a handful of isolated calls, before
// switching again. FALLBACK_VISION_MODEL is currently identical to PRIMARY_VISION_MODEL, so
// server.ts's hybrid escalation step (re-asking a disputed date with the fallback model) is a no-op
// while they match — repoint FALLBACK_VISION_MODEL to a genuinely different model to restore that
// escalation's value.
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
// on its own, hanging forever. Previously this raced the send() call against a plain timeout
// promise — but racing doesn't cancel the underlying HTTP request, it just stops THIS call from
// blocking whatever awaited it. The abandoned request kept running on OpenRouter's side (the SDK's
// own unhandled rejection, already logged and swallowed by server.ts's process-level handler,
// still fires later) and — critically — can still complete and get billed there, even though we
// retried with a brand-new request and never read the abandoned one's usage.cost. That silently
// dropped real spend out of every job's reported cost total (confirmed: a scan whose on-screen
// total was $0.0626 actually billed ~$0.25 on OpenRouter — the gap tracks with timeout/retry
// volume). Aborting the request via AbortController instead actually tears down the in-flight
// fetch on timeout, so it can't keep running (and billing) after we've given up on it.
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

// Shared by sendVisionRequest and sendVisionRequestWithTools — same rate-limit/timeout retry
// behavior (see the comment above TimeoutError for why timeouts are retried, not just rate
// limits), extracted so the agent loop's tool-calling path doesn't duplicate this logic. Takes an
// already-fully-built chatRequest body and just owns the retry/timeout/signal mechanics around the
// network call.
/**
 * Sends one already-built chat request to OpenRouter, retrying on rate limiting (with backoff)
 * and on a hung/timed-out request (no backoff).
 *
 * @param chatRequest - The fully-built OpenRouter chat request body.
 * @param signal - Optional abort signal; an in-flight request is cancelled if this fires.
 * @returns The raw OpenRouter response.
 */
async function sendChatRequestWithRetry(chatRequest: any, signal?: AbortSignal): Promise<any> {
    const MAX_ATTEMPTS = 3;
    const model: string = chatRequest.model ?? "unknown";
    // Cheap proxy for request size (dominated by the base64 image) — avoids walking the message
    // array just to measure it on every single attempt.
    const requestBytes = JSON.stringify(chatRequest).length;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // One AbortController per attempt, wired to BOTH the caller's own cancellation signal
        // (e.g. a job stop) and our own timeout — either reason actually aborts the in-flight
        // fetch now, instead of just abandoning a promise and letting the request run to
        // completion (and get billed) unseen.
        const controller = new AbortController();
        const onExternalAbort = () => controller.abort(signal!.reason);
        if (signal) {
            if (signal.aborted) controller.abort(signal.reason);
            else signal.addEventListener("abort", onExternalAbort);
        }
        const timeoutId = setTimeout(
            () => controller.abort(new TimeoutError(`OpenRouter request timed out after ${REQUEST_TIMEOUT_MS}ms`)),
            REQUEST_TIMEOUT_MS
        );
        const startedAt = Date.now();
        logVisionEvent({ type: "attempt_start", model, attempt, requestBytes });
        try {
            const response = await getClient().chat.send({ chatRequest }, { signal: controller.signal });
            logVisionEvent({
                type: "attempt_success",
                model,
                attempt,
                elapsedMs: Date.now() - startedAt,
                cost: (response as any)?.usage?.cost ?? 0,
                truncated: (response as any)?.choices?.[0]?.finishReason === "length",
            });
            return response;
        } catch (err) {
            const elapsedMs = Date.now() - startedAt;
            if (isRateLimited(err) && attempt < MAX_ATTEMPTS) {
                logVisionEvent({ type: "attempt_rate_limited", model, attempt, elapsedMs, willRetry: true });
                await sleep(1000 * 2 ** (attempt - 1)); // 1s, 2s backoff
                continue;
            }
            // Only our own timeout abort gets retried — an externally-aborted request (job
            // stopped by the caller) falls through to the throw below instead, same as before.
            if (controller.signal.aborted && controller.signal.reason instanceof TimeoutError) {
                const willRetry = attempt < MAX_ATTEMPTS;
                logVisionEvent({ type: "attempt_timeout", model, attempt, elapsedMs, willRetry });
                if (willRetry) continue; // no backoff — a hung/slow request just needs a fresh attempt, not a wait
            } else if (controller.signal.aborted) {
                logVisionEvent({ type: "attempt_aborted_external", model, attempt, elapsedMs });
            } else {
                logVisionEvent({ type: "attempt_error", model, attempt, elapsedMs, message: err instanceof Error ? err.message : String(err) });
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
            signal?.removeEventListener("abort", onExternalAbort);
        }
    }
    throw new Error("unreachable"); // satisfies TS control-flow analysis
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
 * @param signal - Optional abort signal (e.g. a job cancellation); cuts off an in-flight call.
 * @returns The model's raw reply text, whether it was truncated, and this call's cost in USD.
 */
export const sendVisionRequest = traceable(
    async function sendVisionRequest(
        base64Image: string,
        prompt: string,
        temperature: number,
        seed: number,
        maxTokens: number,
        model: string = PRIMARY_VISION_MODEL,
        signal?: AbortSignal
    ): Promise<{ content: string; truncated: boolean; cost: number }> {
        const response = await sendChatRequestWithRetry(
            {
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
            },
            signal
        );

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

// Multi-turn, tool-calling sibling to sendVisionRequest — used by the agent loop
// (lib/ocr/agentLoop.ts) for page-shape discovery, where the model drives its own exploration
// (crop closer, ask who the target worker is, describe what it found) across several turns before
// settling on an answer, instead of answering a single fixed prompt in one shot. Deliberately a
// separate function rather than an overload on sendVisionRequest: every existing caller
// (extractIpaFields, scanPageImage, extractPageContext, verifyDatesOnPage, bank/medical
// extraction) keeps using the single-shot path completely unchanged.
export type VisionTool = {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
};

export type VisionToolCall = { id: string; name: string; arguments: unknown }; // arguments already JSON-parsed

export type VisionMessage =
    | { role: "user"; content: Array<{ type: "text"; text: string } | { type: "image_url"; imageUrl: { url: string } }> }
    | { role: "assistant"; content: string | null; toolCalls?: VisionToolCall[] }
    | { role: "tool"; toolCallId: string; content: Array<{ type: "text"; text: string } | { type: "image_url"; imageUrl: { url: string } }> };

/**
 * Sends one turn of a multi-turn, tool-calling conversation to the vision model via OpenRouter.
 * Same retry/timeout behavior as {@link sendVisionRequest} (shared via `sendChatRequestWithRetry`).
 *
 * @param messages - The full conversation so far (the agent loop's own accumulated state).
 * @param tools - The tool catalog available to the model this turn.
 * @param temperature - Model sampling temperature.
 * @param seed - Model sampling seed.
 * @param maxTokens - Max output tokens; a response that hits this cap comes back `truncated: true`.
 * @param model - Which model to call; defaults to {@link PRIMARY_VISION_MODEL}.
 * @param signal - Optional abort signal (e.g. a job cancellation); cuts off an in-flight call.
 * @param toolChoice - `"auto"` (default) lets the model also answer in prose; `"required"` forces
 * a tool call every turn — useful if a particular model tends to narrate instead of calling tools.
 * @returns The model's raw reply text (if any), any tool calls it made, whether it was truncated,
 * and this call's cost in USD.
 */
// VisionMessage keeps a friendly shape for agentLoop.ts (toolCalls as flat {id,name,arguments},
// content nullable) — this converts to the wire format the SDK's request schema actually validates
// against: an assistant message's content must be a string (never null — an empty string, not
// null, for a tool-calls-only turn) or array, and each toolCall must be the full
// {id, type:"function", function:{name, arguments: <JSON string>}} shape, not the flattened form
// this app parses responses INTO. Confirmed live: sending the flattened/nullable shape straight
// through fails the SDK's own zod validation on the second turn of any tool-calling conversation
// (every role alternative in the union rejects it, surfacing as a wall of "invalid_union" errors).
function toWireMessage(m: VisionMessage): any {
    if (m.role === "assistant") {
        return {
            role: "assistant",
            content: m.content ?? "",
            ...(m.toolCalls && m.toolCalls.length > 0
                ? { toolCalls: m.toolCalls.map(tc => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) }
                : {}),
        };
    }
    if (m.role === "tool") {
        return { role: "tool", toolCallId: m.toolCallId, content: m.content };
    }
    return { role: "user", content: m.content };
}

export async function sendVisionRequestWithTools(
    messages: VisionMessage[],
    tools: VisionTool[],
    temperature: number,
    seed: number,
    maxTokens: number,
    model: string = PRIMARY_VISION_MODEL,
    signal?: AbortSignal,
    toolChoice: "auto" | "required" = "auto"
): Promise<{ content: string; toolCalls: VisionToolCall[]; truncated: boolean; cost: number }> {
    const response = await sendChatRequestWithRetry(
        {
            usage: { include: true },
            reasoning: { effort: "none" },
            model,
            maxTokens,
            temperature,
            seed,
            messages: messages.map(toWireMessage),
            tools: tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
            toolChoice,
        },
        signal
    );

    const choice = (response as any).choices[0];
    const rawToolCalls: any[] = choice.message.toolCalls ?? [];
    const toolCalls: VisionToolCall[] = rawToolCalls.map(tc => {
        let args: unknown = {};
        try {
            args = JSON.parse(tc.function.arguments);
        } catch {
            // Malformed tool-call arguments are surfaced as an empty object rather than thrown —
            // the agent loop's own per-tool validation (e.g. emitRows's shapeFamily check) is
            // better positioned to turn "arguments didn't parse" into a retry-prompting tool-result
            // than this low-level function guessing at recovery.
        }
        return { id: tc.id, name: tc.function.name, arguments: args };
    });

    return {
        content: choice.message.content ?? "",
        toolCalls,
        truncated: choice.finishReason === "length",
        cost: (response as any).usage?.cost ?? 0,
    };
}

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
