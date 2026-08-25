import { sendVisionRequest, extractJsonBlock } from "./ocr";

export type BankTransaction = {
    date: string; // YYYY-MM-DD
    description: string; // verbatim from the statement
    amount: number;
    direction: "credit" | "debit" | null;
    // Set only by mergeTransactionAttempts below — how many of the independent scan attempts on
    // this page actually reported this transaction. null for anything not produced by the
    // multi-attempt path (e.g. a manually-added row in public/index.html, which was never "seen"
    // by a scan at all).
    confirmedByAttempts: { seen: number; total: number } | null;
};

// No keyword filtering — every credit (money IN) transaction on the page is extracted, full stop.
// Trying to guess which credits are "the employer's payment" up front (via a caseworker-supplied
// keyword list) meant a real payment worded unexpectedly could get silently excluded before the
// caseworker ever saw it. Extracting everything and letting the caseworker delete the irrelevant
// rows themselves in the editable review trades that silent-miss risk for a longer list to skim,
// which is the safer failure mode for a wage claim.
const PROMPT = `This image is one page of a bank statement belonging to a migrant/Work-Permit-holder worker. A caseworker is checking what money actually came into this account, to cross-check against a separate wage claim calculation.

Scan every transaction line on this page. Report every transaction where money came INTO this account (a credit/incoming transaction) — do NOT report debits/withdrawals/outgoing transfers, and do NOT try to judge which credits look employer-related or not; report every single incoming credit transaction on the page, regardless of who it's from or what it's for.

For each incoming transaction, report:
- date: YYYY-MM-DD (infer the year from the statement's own header/period if the row itself only shows day/month)
- description: the transaction description exactly as printed/written on the statement
- amount: the dollar amount as a plain number (no currency symbol, no commas)
- direction: always "credit" (this list is credits only, per the instructions above)

Output ONLY a valid JSON array of transactions, no markdown fences, no other text. If this page has no incoming transactions, output exactly [].`;

// Despite the prompt asking for "a plain number", the model sometimes returns amount as a
// quoted string instead (e.g. "7400.00") — coerce rather than reject, stripping any currency
// symbol/commas it might still include, so a real match doesn't silently collapse to $0.
/** Coerces a value to a finite number, stripping currency symbols/commas from strings; `null` if unparseable. */
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

/** Coerces a value to a trimmed string, or `""` if it isn't a string at all. */
function str(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
}

// One independent scan attempt at a given temperature/seed — called several times per page (see
// server.ts's SCAN_TEMPERATURES) since a single deterministic pass can genuinely miss a line the
// model would have caught on a second, differently-seeded look, even on a clean printed/digital-
// export statement, not just a dense handwritten table.
/**
 * Scans one bank statement page image for incoming (credit) transactions.
 *
 * @param base64Image - The page image, base64-encoded (no data URL prefix).
 * @param temperature - Model sampling temperature for this attempt.
 * @param seed - Model sampling seed for this attempt.
 * @returns The credit transactions found on the page, and this call's cost in USD.
 * @throws If the model's reply can't be parsed as a JSON array.
 */
export async function extractMatchingTransactions(base64Image: string, temperature = 0, seed = 42): Promise<{ transactions: BankTransaction[]; cost: number }> {
    const { content, cost } = await sendVisionRequest(base64Image, PROMPT, temperature, seed, 3000);
    let parsed: unknown;
    try {
        parsed = JSON.parse(extractJsonBlock(content));
    } catch (e: any) {
        console.error("extractMatchingTransactions: failed to parse model output as JSON. Raw content:\n", content);
        throw new Error(`${e.message} — raw reply started with: ${content.slice(0, 200)}`);
    }
    if (!Array.isArray(parsed)) return { transactions: [], cost };

    const transactions: BankTransaction[] = parsed
        .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
        .map(t => ({
            date: str(t.date),
            description: str(t.description),
            amount: num(t.amount) ?? 0,
            direction: "credit" as const,
            confirmedByAttempts: null,
        }))
        .filter(t => t.date); // a match with no date at all isn't usable downstream

    return { transactions, cost };
}

// Unions transactions across N independent scan attempts of the SAME page (same "a real one
// missed by one attempt but caught by another still makes it in" philosophy as reconcile.ts's
// cross-band merge for timesheets) — this is the actual fix for the failure mode that motivated
// multi-attempt scanning here: a single pass missing a page's transaction entirely, silently
// understating what the worker was actually paid.
//
// Two transactions from different attempts are treated as the same real transaction if they agree
// on date+amount+direction — description wording can vary slightly between attempts (extra
// whitespace, a truncated reference number) even when they're clearly the same line, so it isn't
// part of the identity key. The most common description among the attempts that reported it wins
// (ties broken by whichever appeared first).
/**
 * Merges multiple independent scan attempts of the same page into one deduplicated transaction list.
 *
 * @param attempts - One transaction array per scan attempt (see {@link extractMatchingTransactions}).
 * @returns The unioned transactions, each tagged with how many attempts reported it (`confirmedByAttempts`).
 */
export function mergeTransactionAttempts(attempts: BankTransaction[][]): BankTransaction[] {
    const total = attempts.length;
    const groups = new Map<string, { descriptionCounts: Map<string, number>; sample: BankTransaction; seenIn: Set<number> }>();

    attempts.forEach((attempt, attemptIdx) => {
        for (const t of attempt) {
            const key = `${t.date}|${t.amount}|${t.direction ?? ""}`;
            let group = groups.get(key);
            if (!group) {
                group = { descriptionCounts: new Map(), sample: t, seenIn: new Set() };
                groups.set(key, group);
            }
            group.seenIn.add(attemptIdx);
            group.descriptionCounts.set(t.description, (group.descriptionCounts.get(t.description) ?? 0) + 1);
        }
    });

    return [...groups.values()].map(group => {
        let bestDescription = group.sample.description;
        let bestCount = 0;
        for (const [description, count] of group.descriptionCounts) {
            if (count > bestCount) {
                bestDescription = description;
                bestCount = count;
            }
        }
        return {
            ...group.sample,
            description: bestDescription,
            confirmedByAttempts: { seen: group.seenIn.size, total },
        };
    });
}
