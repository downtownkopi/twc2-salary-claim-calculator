import { OpenRouter } from "@openrouter/sdk";
import { pdf } from "pdf-to-img";
import sharp from "sharp";
import { traceable } from "langsmith/traceable";

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

async function boostFaintContrast(png: Buffer): Promise<Buffer> {
    const stats = await sharp(png).grayscale().stats();
    const stdev = stats.channels[0].stdev;
    if (stdev >= LOW_CONTRAST_STDEV_THRESHOLD) return png;
    const mean = stats.channels[0].mean;
    const offset = mean * (1 - CONTRAST_BOOST_FACTOR);
    return sharp(png).linear(CONTRAST_BOOST_FACTOR, offset).png().toBuffer();
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
        const boosted = await boostFaintContrast(pageBuffer);
        images.push(boosted.toString("base64"));
    }
    return images;
}

// A single photographed/scanned timesheet (jpg/png/etc, common in real-world uploads — phone
// photos of a physical card) is already "one page" — normalize it into the same
// array-of-base64-PNG shape pdfToImages returns so callers don't need to branch downstream.
// `.rotate()` with no args applies the image's own EXIF orientation tag before stripping it —
// phone cameras commonly save landscape-held shots as portrait pixels + an EXIF rotation flag,
// and without this the page (and any handwriting on it) would be scanned sideways.
//
// A modern phone photo is commonly 3000-4000px on its long side — converted to PNG (no lossy
// compression, unlike the source JPEG) that balloons to 15MB+, which the model provider outright
// rejects ("Multimodal file size is too large"), failing every scan attempt for the page. Capped
// to roughly the same resolution pdfToImages produces for a rendered PDF page (~1800-2500px) —
// already proven legible for OCR there, and comfortably under the provider's limit.
export async function imageToPages(input: Buffer): Promise<string[]> {
    const png = await sharp(input)
        .rotate()
        .resize({ width: 2500, height: 2500, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
    const boosted = await boostFaintContrast(png);
    return [boosted.toString("base64")];
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

// The OCR pipeline needs the page rendered at scale 3.0 for legible digits, but shipping that
// same full-resolution image back to the browser for every page (for the side-by-side review UI)
// would bloat the JSON response — a single page can be 1-1.5MB at that scale. Downscaled
// separately, display-only, so the OCR-quality image never leaves the server.
export async function resizeForDisplay(base64Image: string, maxWidth = 1400): Promise<string> {
    const buffer = Buffer.from(base64Image, "base64");
    const resized = await sharp(buffer)
        .resize({ width: maxWidth, withoutEnlargement: true })
        .png()
        .toBuffer();
    return resized.toString("base64");
}

// Applies a user-confirmed rotation from the pre-scan staging step (public/index.html) — chosen
// by a human looking at a thumbnail, not detected automatically. A cheap VLM self-report of "how
// many degrees to rotate this" was tested and found unreliable (confidently wrong on a real
// sideways page), so orientation correction here is deliberately human-confirmed rather than
// inferred. `degrees` follows the same clockwise convention as CSS's `transform: rotate()`, so the
// staging UI's live thumbnail preview and this server-side correction always agree on which way is
// which.
export async function rotateImage(base64Image: string, degrees: number): Promise<string> {
    const normalized = ((degrees % 360) + 360) % 360;
    if (normalized === 0) return base64Image;
    const buffer = Buffer.from(base64Image, "base64");
    const rotated = await sharp(buffer).rotate(normalized).png().toBuffer();
    return rotated.toString("base64");
}

function isRateLimited(err: any): boolean {
    const code = err?.error?.code ?? err?.statusCode ?? err?.status;
    return code === 429;
}

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
export const sendVisionRequest = traceable(
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
            const response = await Promise.race([
                getClient().chat.send({
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
                }),
                requestTimeout(REQUEST_TIMEOUT_MS),
            ]);

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
            const [base64Image, prompt, temperature, seed, maxTokens] = args;
            return {
                args: [`<image, ${base64Image?.length ?? 0} base64 chars>`, prompt, temperature, seed, maxTokens],
            };
        },
    }
);

export async function scanPageImage(
    base64Image: string,
    prompt: string,
    temperature = 0,
    seed = 42
): Promise<{ content: string; truncated: boolean; cost: number }> {
    return sendVisionRequest(base64Image, prompt, temperature, seed, 8000);
}

export type PageDataModel = "clock_times" | "hours_total" | "punch_log" | "unclear";

// Reads the FULL, uncropped page once to find any page-level context (most importantly, a
// header/title naming the month all rows on the page belong to) before it gets cropped into
// bands for the actual row-by-row transcription. A month header can sit anywhere on the page
// depending on the source template's layout, so there's no reliable pixel region to always
// preserve in every band — reading the whole page once and carrying the answer forward as text
// works regardless of where it actually is. Deterministic (temperature 0) and single-shot: this
// is a much simpler read (one label, not dozens of ambiguous handwritten digits) than the
// per-row transcription, so it doesn't need the multi-attempt reconciliation the row-by-row
// scan gets — one confident read is enough for a single label.
//
// Also does three cheap classification jobs on the same call (avoids a separate model round-trip
// per page): whether this page is a work time/attendance record at all (a real-world upload batch
// mixes in ID-card cover pages with no date rows, and even entirely unrelated documents), which of
// the observed data models it uses — plain clock in/out times, or only a total-hours(+OT) figure
// per day with no clock times anywhere — and, separately, which calendar YEAR the page's rows
// belong to. The per-row scan prompt (server.ts) uses dataModel as a hint, not a hard rule, since a
// single page can occasionally mix both.
//
// Year detection here is a deliberately different, much safer read than trusting the model's
// per-ROW handwritten year (which server.ts's buildPrompt explicitly tells the model to ignore —
// see the comment there): this asks for a single clean PRINTED/TYPED page header/title/filename
// once per page, the same kind of one-shot page-level read month detection above already relies
// on, not dozens of ambiguous handwritten digits repeated down a column. server.ts resolves one
// claim-wide year from the page headers it can find (majority vote across pages) instead of asking
// the caller to pick it.
export async function extractPageContext(
    base64Image: string
): Promise<{ context: string; isTimesheet: boolean; dataModel: PageDataModel; year: number | null; cost: number }> {
    const prompt = `Look at this ENTIRE page of a worker's daily time/attendance record. It may be handwritten or typed, in any language, and in any layout — a row-per-day table, a calendar grid, a free-form list, a punch card, etc.

Answer four things:
1. context: Somewhere on the page — top, bottom, a corner, a margin, anywhere — there may be a title, header, label, or filename-like text indicating which calendar month (and possibly year) the date rows on this page belong to. There may also be other useful page-level context, like a worker's name. Reply with ONE short plain-text sentence stating what you found, e.g. "Header indicates December" or "No month header found, but page appears to be for a worker named Ahmad" or "No page-level context found."
2. isTimesheet: true if this page genuinely contains a work time/attendance record for one or more calendar dates, in any format. false if this page is something else entirely — e.g. a blank ID-card cover with no date rows, a driving-school log, a signature-only page, or an unrelated document.
3. dataModel: what's actually recorded per date on THIS page — "clock_times" if actual clock in/out times are shown in a day-per-row table/list (e.g. "8:00", "8am-5pm"), "hours_total" if only a total number of hours worked (and/or separate overtime hours) is shown per day with NO clock in/out times anywhere, "punch_log" if this is a phone app's chronological event-log screen instead of a table — individual timestamped clock in/out entries (often with seconds, e.g. "12-06-2026 06:29:54"), most-recent-first, one entry per punch rather than one row per day — or "unclear" if you can't tell, it's mixed, or no rows are populated yet.
4. year: the 4-digit calendar year this page's date rows belong to, ONLY if it's stated as part of the DOCUMENT'S OWN content — a title naming the claim/pay period (e.g. "Timesheet - Jan 2026"), a filename like "2026_01_timesheet.pdf", or a printed form field for the period being recorded. Do NOT use a scanner, fax, photocopier, or "received/printed on" transmission timestamp/date-stamp banner (these usually sit right at the very top or bottom edge of the page, often with a time down to the second, e.g. "12/08/2026 17:41:57") — that is when the PAGE WAS SCANNED, not the period the timesheet covers, and using it is a common, serious mistake. Do NOT infer it from handwritten day/month digits in the row data itself either, and do NOT guess — if no genuine document-content year label exists anywhere on the page, reply null.

Output ONLY a JSON object: {"context": string, "isTimesheet": boolean, "dataModel": "clock_times" | "hours_total" | "punch_log" | "unclear", "year": number | null}. No markdown fences, no other text.`;
    const { content, cost } = await sendVisionRequest(base64Image, prompt, 0, 42, 300);
    try {
        const parsed = JSON.parse(extractJsonBlock(content));
        const dataModel: PageDataModel =
            parsed.dataModel === "clock_times" || parsed.dataModel === "hours_total" || parsed.dataModel === "punch_log"
                ? parsed.dataModel
                : "unclear";
        const year = Number.isInteger(parsed.year) && parsed.year >= 2000 && parsed.year <= 2100 ? parsed.year : null;
        return {
            context: typeof parsed.context === "string" ? parsed.context : "",
            isTimesheet: parsed.isTimesheet !== false,
            dataModel,
            year,
            cost,
        };
    } catch {
        // A malformed classification response shouldn't block the page from being scanned at all
        // — fall back permissively (assume it IS a timesheet, data model unclear, year unknown)
        // rather than silently dropping a page over a JSON parsing hiccup in this classification.
        return { context: content.trim(), isTimesheet: true, dataModel: "unclear", year: null, cost };
    }
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
    // Forcing bare JSON with zero reasoning space (an earlier version of this prompt) turned out to
    // make the model rush a long date list and misjudge boundary items specifically — reproduced
    // directly: asked about a single date in isolation, it read a clearly-filled box correctly, but
    // asked to verify the SAME date as item 1 of a 7-date batch with JSON-only output required, it
    // confidently said not confirmed. Explicitly allowing brief per-date notes before the JSON verdict
    // (still parsed via extractJsonBlock, which already handles trailing prose after fenced JSON)
    // fixed it in that same reproduction. Don't remove this reasoning step to "simplify" the prompt.
    const prompt = `This is the full page of a handwritten timesheet. A previous pass claimed to find a row with actual handwritten content (times, marks, something written) for each of these dates on this page: ${dateList} (format is day/month).

Your job is to verify, for EACH date in that list, whether that date's row genuinely exists on the page with real handwritten content in it — not to re-transcribe any times. Go through the dates ONE AT A TIME, in the order given: for each one, first locate that exact date's box on the calendar/table, look carefully at what is actually inside it, and briefly note what you see, before moving to the next date. Do not rush through the list or judge several boxes at a glance.

Genuine content includes not just clock times, but ANY deliberate mark — a dash/line, a leave code (MC/AL/EL/off), a checkmark, an hours figure, or anything else a human clearly drew or wrote on purpose. Only mark a date NOT confirmed if its box is truly empty (no ink at all) or that date genuinely doesn't appear on the page anywhere.

After going through every date individually, end your reply with a JSON array with exactly one object per date in the list, in the same order, as {day, month, confirmed}, where confirmed is true only if you found genuine handwritten content for that date's row. You may write your brief per-date notes first; put the JSON array last, in a \`\`\`json code fence.`;

    const { content, cost } = await sendVisionRequest(base64Image, prompt, 0, 42, 4000);
    const parsed = JSON.parse(extractJsonBlock(content)) as { day: number; month: number; confirmed: boolean }[];

    const confirmed = new Set<string>();
    for (const r of parsed) {
        if (r.confirmed === true) confirmed.add(`${r.month}-${r.day}`);
    }
    return { confirmed, cost };
}

// Model replies are usually markdown-fenced (```json ... ```) but sometimes prefix/suffix the
// JSON with stray characters or prose (e.g. a leading ">"). Strip fences if present, otherwise
// fall back to slicing from the first "[" to the last "]" (array responses) or "{" to "}" (object
// responses, e.g. extractPageContext's classification reply) so junk around the JSON is dropped.
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
