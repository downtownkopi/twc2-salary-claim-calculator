import { sendVisionRequest, extractJsonBlock, PRIMARY_VISION_MODEL } from "./visionClient";

/**
 * Scans one timesheet page image with a per-row transcription prompt.
 *
 * @param base64Image - The page image, base64-encoded.
 * @param prompt - The per-row transcription prompt (built by server.ts's buildPrompt).
 * @param temperature - Model sampling temperature for this attempt.
 * @param seed - Model sampling seed for this attempt.
 * @param model - Which model to call; defaults to {@link PRIMARY_VISION_MODEL}.
 * @returns The model's raw reply text, whether it was truncated, and this call's cost in USD.
 */
export async function scanPageImage(
    base64Image: string,
    prompt: string,
    temperature = 0,
    seed = 42,
    model: string = PRIMARY_VISION_MODEL
): Promise<{ content: string; truncated: boolean; cost: number }> {
    // Was 8000 — a dense page (e.g. a full-month calendar grid, or one with lots of per-day notes)
    // can still burn through that on reasoning alone before the JSON array is even done, truncating
    // mid-response. Since reconcileAttempts requires all 3 scan attempts to agree per day, even one
    // truncated attempt silently missing a trailing row is enough to drop a genuinely-covered date
    // as "not unanimous". Same reasoning-overhead-eats-the-budget failure mode extractIpaFields and
    // extractPageContext were already bumped for, just landing here too.
    return sendVisionRequest(base64Image, prompt, temperature, seed, 16000, model);
}

export type PageDataModel = "clock_times" | "hours_total" | "punch_log" | "worker_roster" | "unclear";

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
/**
 * Reads a timesheet page's full-page context in one deterministic pass: any month/year header,
 * whether the page is a genuine time/attendance record at all, and which data model it uses.
 *
 * @param base64Image - The full, uncropped page image, base64-encoded.
 * @param model - Which model to call; defaults to {@link PRIMARY_VISION_MODEL}.
 * @returns `context` (a one-sentence summary of any page-level header/label found), `isTimesheet`,
 * `dataModel`, `year` (only if genuinely printed/typed on the document — never inferred from
 * handwritten row data), and this call's cost in USD.
 */
export async function extractPageContext(
    base64Image: string,
    model: string = PRIMARY_VISION_MODEL
): Promise<{ context: string; isTimesheet: boolean; dataModel: PageDataModel; year: number | null; cost: number }> {
    const prompt = `Look at this ENTIRE page of a worker's daily time/attendance record. It may be handwritten or typed, in any language, and in any layout — a row-per-day table, a calendar grid, a free-form list, a punch card, etc.

Answer four things:
1. context: Somewhere on the page — top, bottom, a corner, a margin, anywhere — there may be a title, header, label, or filename-like text indicating which calendar month (and possibly year) the date rows on this page belong to. There may also be other useful page-level context, like a worker's name. Reply with ONE short plain-text sentence stating what you found, e.g. "Header indicates December" or "No month header found, but page appears to be for a worker named Ahmad" or "No page-level context found."
2. isTimesheet: true if this page genuinely contains a work time/attendance record for one or more calendar dates, in any format. false if this page is something else entirely — e.g. a blank ID-card cover with no date rows, a driving-school log, a signature-only page, or an unrelated document.
3. dataModel: what's actually recorded per date on THIS page — "clock_times" if actual clock in/out times are shown in a day-per-row table/list (e.g. "8:00", "8am-5pm"), "hours_total" if only a total number of hours worked (and/or separate overtime hours) is shown per day with NO clock in/out times anywhere, "punch_log" if this is a phone app's chronological event-log screen instead of a table — individual timestamped clock in/out entries (often with seconds, e.g. "12-06-2026 06:29:54"), most-recent-first, one entry per punch rather than one row per day — "worker_roster" if this page is an attendance register/muster sheet covering ONE shared date, with MULTIPLE DIFFERENT NAMED WORKERS listed as separate rows (each their own scheduled shift, actual time in/out, signature) — the inverse layout of the other three, which are all one worker's own record across many dates — or "unclear" if you can't tell, it's mixed, or no rows are populated yet.
4. year: the 4-digit calendar year this page's date rows belong to, ONLY if it's stated as part of the DOCUMENT'S OWN content — a title naming the claim/pay period (e.g. "Timesheet - Jan 2026"), a filename like "2026_01_timesheet.pdf", or a printed form field for the period being recorded. Do NOT use a scanner, fax, photocopier, or "received/printed on" transmission timestamp/date-stamp banner (these usually sit right at the very top or bottom edge of the page, often with a time down to the second, e.g. "12/08/2026 17:41:57") — that is when the PAGE WAS SCANNED, not the period the timesheet covers, and using it is a common, serious mistake. Do NOT infer it from handwritten day/month digits in the row data itself either, and do NOT guess — if no genuine document-content year label exists anywhere on the page, reply null.

Output ONLY a JSON object: {"context": string, "isTimesheet": boolean, "dataModel": "clock_times" | "hours_total" | "punch_log" | "worker_roster" | "unclear", "year": number | null}. No markdown fences, no other text.`;
    // 300 was enough for qwen/gemini (a real answer here is normally one short sentence + a few
    // fields) but xiaomi/mimo-v2.5 was observed spending its token budget on internal reasoning
    // before emitting any visible answer for this specific longer, multi-part prompt — even with
    // reasoning effort set to "none" — truncating with EMPTY content and no error, which cascaded
    // into every page on a job failing year detection with zero diagnostic trail. Matches the same
    // failure class verifyDatesOnPage was bumped 2000->4000 for earlier; same fix here.
    const { content, cost } = await sendVisionRequest(base64Image, prompt, 0, 42, 1200, model);
    try {
        const parsed = JSON.parse(extractJsonBlock(content));
        const dataModel: PageDataModel =
            parsed.dataModel === "clock_times" ||
            parsed.dataModel === "hours_total" ||
            parsed.dataModel === "punch_log" ||
            parsed.dataModel === "worker_roster"
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
/**
 * Re-verifies, in one batch call, whether each candidate date's row genuinely exists on the page
 * with real handwritten content — a narrower question than "transcribe correctly", meant to catch
 * a date the model hallucinated identically across every reconciliation attempt.
 *
 * @param base64Image - The full page image, base64-encoded.
 * @param candidates - The `{day, month}` dates to verify (already agreed upon by reconciliation).
 * @param model - Which model to call; defaults to {@link PRIMARY_VISION_MODEL}.
 * @returns The confirmed dates as a `Set` of `"month-day"` strings, and this call's cost in USD.
 */
export async function verifyDatesOnPage(
    base64Image: string,
    candidates: { day: number; month: number }[],
    model: string = PRIMARY_VISION_MODEL
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

    const { content, cost } = await sendVisionRequest(base64Image, prompt, 0, 42, 4000, model);
    const parsed = JSON.parse(extractJsonBlock(content)) as { day: number; month: number; confirmed: boolean }[];

    const confirmed = new Set<string>();
    for (const r of parsed) {
        if (r.confirmed === true) confirmed.add(`${r.month}-${r.day}`);
    }
    return { confirmed, cost };
}
