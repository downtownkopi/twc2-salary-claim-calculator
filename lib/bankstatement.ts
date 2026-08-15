import { sendVisionRequest, extractJsonBlock } from "./ocr";

export type BankTransaction = {
    date: string; // YYYY-MM-DD
    description: string; // verbatim from the statement
    amount: number;
    direction: "credit" | "debit" | null;
    // Cross-check against the caseworker's own keywords, independent of the model's judgement —
    // false means the description doesn't literally contain any of them (the model matched it on
    // meaning alone: an abbreviated name, a GIRO/PayNow reference, etc). For a SCANNED transaction
    // this is now a hard filter, not just advisory — extractMatchingTransactions below drops any
    // non-literal match rather than surfacing it with a warning, per caseworker request. The field
    // stays on the type because it's still used live for manually-added/edited rows in
    // public/index.html, which get their own warning as the caseworker types (those aren't
    // filtered — a human explicitly typed it in, unlike a model's fuzzy judgement call).
    keywordVerified: boolean;
};

// The caseworker's keyword(s) are a hint, not an exact-match filter — a worker's own bank
// statement often shows the employer's payment under wording that doesn't literally contain the
// keyword (an abbreviated company name, a GIRO/PayNow reference, "PAYROLL", "SAL", part of a
// director's name used as the payer). The model is asked to judge relevance per line rather than
// have the app do a plain substring match, since a strict match would miss most real cases.
function buildPrompt(keywords: string[]): string {
    return `This image is one page of a bank statement belonging to a migrant/Work-Permit-holder worker. A caseworker is trying to find payments this worker received from their employer, to cross-check against a separate wage claim calculation — the worker may say they were paid "some" but not all of what they're owed, and this statement is being checked to see what actually came in.

The caseworker is looking for transactions related to any of these: ${keywords.join(", ")}.

The exact wording on the statement will often NOT match these keywords literally — use judgement. A payment could show up as an abbreviated/partial company name, a GIRO or PayNow reference, "PAYROLL", "SAL", "SALARY", a director's or manager's personal name (if that's how the employer actually pays), or similar. Payments may recur on a fixed schedule (e.g. monthly on a similar date) OR be irregular/ad hoc (occasional top-ups, partial payments) — do not assume a fixed frequency, and do not exclude a transaction just because it doesn't repeat elsewhere on the statement.

Scan every transaction line on this page. For each one that plausibly relates to one of the given keywords, report it. Do NOT include transactions that are clearly unrelated (groceries, utilities, ATM withdrawals, transfers to other individuals, other merchants) even if you're scanning past them — only report the ones you believe are a genuine match.

For each matching transaction, report:
- date: YYYY-MM-DD (infer the year from the statement's own header/period if the row itself only shows day/month)
- description: the transaction description exactly as printed/written on the statement
- amount: the dollar amount as a plain number (no currency symbol, no commas)
- direction: "credit" if money came IN to this account, "debit" if it went out (a wage payment should normally be a credit — but report what you see; occasionally a caseworker is checking a repayment/deduction, which would be a debit)

Output ONLY a valid JSON array of matching transactions, no markdown fences, no other text. If this page has no matching transactions, output exactly [].`;
}

// Despite the prompt asking for "a plain number", the model sometimes returns amount as a
// quoted string instead (e.g. "7400.00") — coerce rather than reject, stripping any currency
// symbol/commas it might still include, so a real match doesn't silently collapse to $0.
function num(v: unknown): number | null {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") {
        const cleaned = v.replace(/[^0-9.\-]/g, "");
        if (cleaned === "") return null;
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function str(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
}

function direction(v: unknown): "credit" | "debit" | null {
    return v === "credit" || v === "debit" ? v : null;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Case-insensitive "does this description literally contain any of the caseworker's keywords" —
// deliberately dumb/literal, as a sanity check ON TOP OF the model's fuzzier judgement, not a
// replacement for it.
function buildKeywordRegex(keywords: string[]): RegExp {
    return new RegExp(keywords.map(escapeRegExp).join("|"), "i");
}

// Single deterministic pass, same reasoning as lib/ipa.ts — a bank statement is typically a clean
// printed/digital-export document, not a dense handwritten table, so the multi-attempt
// reconciliation server.ts uses for timesheets isn't needed here.
export async function extractMatchingTransactions(base64Image: string, keywords: string[]): Promise<{ transactions: BankTransaction[]; cost: number }> {
    if (keywords.length === 0) return { transactions: [], cost: 0 };
    const { content, cost } = await sendVisionRequest(base64Image, buildPrompt(keywords), 0, 42, 3000);
    let parsed: unknown;
    try {
        parsed = JSON.parse(extractJsonBlock(content));
    } catch (e: any) {
        console.error("extractMatchingTransactions: failed to parse model output as JSON. Raw content:\n", content);
        throw new Error(`${e.message} — raw reply started with: ${content.slice(0, 200)}`);
    }
    if (!Array.isArray(parsed)) return { transactions: [], cost };

    const keywordRegex = buildKeywordRegex(keywords);
    const transactions: BankTransaction[] = parsed
        .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
        .map(t => {
            const description = str(t.description);
            return {
                date: str(t.date),
                description,
                amount: num(t.amount) ?? 0,
                direction: direction(t.direction),
                keywordVerified: keywordRegex.test(description),
            };
        })
        .filter(t => t.date) // a match with no date at all isn't usable downstream
        // Strictly literal keyword matches only — per caseworker request, a transaction the model
        // matched on meaning alone (no keyword actually appearing in the description) is dropped
        // rather than surfaced with a warning. keywordVerified stays on the type (still used for
        // manually-added/edited rows in public/index.html, which get their own live warning as the
        // caseworker types), but a scanned transaction that fails this check never reaches the list.
        .filter(t => t.keywordVerified);

    return { transactions, cost };
}
