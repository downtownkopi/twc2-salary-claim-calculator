import { sendTextRequest, CHEAP_TEXT_MODEL } from "./ocr/visionClient";

// Mirrors public/index.html's TIER_EXPR_VARS exactly — if a field is ever added/renamed on the
// client's expression grammar, update it here too, or the model will confidently translate into a
// field name the client-side parser then rejects as unknown.
const GRAMMAR_PROMPT = `Translate ONE plain-English non-fixed-allowance condition into a single expression using exactly this grammar. Output ONLY the expression — no prose, no markdown fences, no explanation.

Allowed fields (use these names exactly, nothing else):
- date: a "YYYY-MM-DD" string
- weekday: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
- clockIn / clockOut: 24-hour clock times as bare integers, e.g. 1700 for 5pm, 900 for 9am, 0 for midnight
- netHours: hours actually worked that day (a number)
- isRestDay: true if the day is the worker's declared weekly rest day
- isHalfDay: true if the day is the worker's declared half-day
- isPublicHoliday: true if the day is a gazetted public holiday

Allowed operators: == != >= <= > < for comparisons, && || ! for combining, ( ) for grouping. String literals (dates) must be double-quoted.

Examples:
"time beyond 5pm" -> clockOut > 1700
"worked past 9pm" -> clockOut > 2100
"on Sundays" -> weekday == 0
"weekends" -> weekday == 0 || weekday == 6
"public holidays that aren't also a rest day" -> isPublicHoliday && !isRestDay
"the whole month of September 2025" -> date >= "2025-09-01" && date <= "2025-09-30"
"worked more than 10 hours" -> netHours > 10
"always", "every day", or blank/no real condition -> output nothing at all (an empty response)

If the English genuinely cannot be expressed with these fields, output exactly: UNSUPPORTED

Translate this: `;

/**
 * Translates one plain-English tier condition into the client-side expression grammar via a
 * cheap text-only LLM call. The caller (public/index.html) always re-validates/compiles the
 * result itself before using it — this function only produces a candidate string, it never
 * becomes the thing that actually runs on every recompute.
 *
 * @param englishText - The caseworker's plain-English description, e.g. "time beyond 5pm".
 * @returns The translated expression string (empty string means "always applies", matching the
 * client's own blank-condition convention), and this call's cost in USD.
 * @throws If the model reports the English can't be expressed in this grammar at all.
 */
export async function translateTierCondition(englishText: string): Promise<{ expression: string; cost: number }> {
    const { content, cost } = await sendTextRequest(GRAMMAR_PROMPT + englishText, 0, 200, CHEAP_TEXT_MODEL);
    const expression = content.trim();
    if (expression === "UNSUPPORTED") {
        throw new Error("couldn't translate that into a usable condition — try rephrasing, or write the expression directly");
    }
    return { expression, cost };
}

// `once`/`anchorMonth` distinguish a one-time lump sum (e.g. "$250 one-time for housing over
// Sep 1-10") from a recurring per-day tier (e.g. "$5 per day past 5pm"). Without this distinction,
// a one-time payment tied to a date RANGE would otherwise compile into a recurring condition like
// `date >= "..." && date <= "..."` and get paid on EVERY matching day — $250 x 10 days instead of
// $250 once. `anchorMonth` is only meaningful when `once` is true: which month to record the lump
// sum against (the client has no per-row condition to evaluate for a one-time payment, so there's
// nothing else to attribute it to).
export type ParsedTier = { expression: string; amount: number; once: boolean; anchorMonth: string | null };

// Same field grammar as GRAMMAR_PROMPT above, but extracting a whole LIST of rules out of one
// freely-written paragraph (the caseworker's "non-fixed allowance rules" box) in a single call,
// rather than translating one condition at a time. Run once, at "Extract details" time — not live
// per-keystroke the way translateTierCondition is — so the model only ever sees the caseworker's
// finished text, not a half-typed draft.
const BATCH_GRAMMAR_PROMPT = `Read the following free-written text describing one or more contract-based pay allowance rules. Extract EVERY distinct rule as a {condition, amount, once, anchorMonth} object. Output ONLY a JSON array of these objects — no prose, no markdown fences.

Each rule is either:
- RECURRING (the default): applies on every day whose condition is true — the amount is paid for EACH matching day. Use this for anything phrased as a per-day/ongoing rate (e.g. "$5 daily if...", "every time the worker...").
- ONE-TIME: a single lump sum tied to one event or period, paid exactly once, never repeated per day — e.g. "one-time", "a single payment of", "lump sum", "provided $X once for...". Set "once": true, "condition": "" (a one-time payment has no per-day condition to check), and "anchorMonth" to the "YYYY-MM" month to record it against (use the start of whatever period/date is mentioned).

"condition" (for a recurring rule) must be an expression using exactly this grammar:

Allowed fields (use these names exactly, nothing else):
- date: a "YYYY-MM-DD" string
- weekday: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
- clockIn / clockOut: 24-hour clock times as bare integers, e.g. 1700 for 5pm, 900 for 9am, 0 for midnight
- netHours: hours actually worked that day (a number)
- isRestDay: true if the day is the worker's declared weekly rest day
- isHalfDay: true if the day is the worker's declared half-day
- isPublicHoliday: true if the day is a gazetted public holiday

Allowed operators: == != >= <= > < for comparisons, && || ! for combining, ( ) for grouping. String literals (dates) must be double-quoted.

If a recurring rule applies unconditionally (no real condition, e.g. "always add $5 per day"), use an empty string "" for that condition too — same as a one-time rule, but with "once": false.

Each dollar amount is whatever the text states for THAT rule — never invent, assume, or reuse a number from a different rule or a worked example elsewhere in the text.

If a sentence describes a rule but genuinely cannot be expressed with these fields, omit that one object rather than guessing — don't fail the whole response over one unclear sentence.

Example input: "Add $5 daily if the worker clocked out past 5pm. Add $3 daily if past 9pm. Between September 1 2026 and September 10 2026, the company provided $250 one-time for housing for the entire period."
Example output: [{"condition": "clockOut > 1700", "amount": 5, "once": false, "anchorMonth": null}, {"condition": "clockOut > 2100", "amount": 3, "once": false, "anchorMonth": null}, {"condition": "", "amount": 250, "once": true, "anchorMonth": "2026-09"}]

Text to extract from:
`;

/**
 * Extracts every distinct {condition, amount, once, anchorMonth} allowance rule out of one
 * freely-written block of text, via a single cheap text-only LLM call. The caller
 * (public/index.html) compiles/validates every returned condition itself before using it, same as
 * {@link translateTierCondition} — this function only produces candidates.
 *
 * @param englishText - The caseworker's free-form description of one or more allowance rules.
 * @returns Every extracted tier (amounts that aren't finite positive numbers are dropped, and a
 * `once: true` tier with no usable `anchorMonth` is dropped too — there'd be nothing to attribute
 * it to), and this call's cost in USD.
 * @throws If the model's reply can't be parsed as a JSON array at all.
 */
export async function parseTierConditionsBatch(englishText: string): Promise<{ tiers: ParsedTier[]; cost: number }> {
    const { content, cost } = await sendTextRequest(BATCH_GRAMMAR_PROMPT + englishText, 0, 800, CHEAP_TEXT_MODEL);
    let parsed: any;
    try {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    } catch (e: any) {
        throw new Error(`couldn't parse the model's reply as a list of rules: ${e.message}`);
    }
    if (!Array.isArray(parsed)) throw new Error("model reply wasn't a list of rules");
    const MONTH_KEY = /^\d{4}-\d{2}$/;
    const tiers: ParsedTier[] = parsed
        .filter((x): x is { condition: unknown; amount: unknown; once: unknown; anchorMonth: unknown } => typeof x === "object" && x !== null)
        .map(x => ({
            expression: typeof x.condition === "string" ? x.condition : "",
            amount: typeof x.amount === "number" ? x.amount : Number(x.amount),
            once: x.once === true,
            anchorMonth: typeof x.anchorMonth === "string" && MONTH_KEY.test(x.anchorMonth) ? x.anchorMonth : null,
        }))
        .filter(t => Number.isFinite(t.amount) && t.amount > 0)
        .filter(t => !t.once || t.anchorMonth !== null);
    return { tiers, cost };
}
