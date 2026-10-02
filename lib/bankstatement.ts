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

DETERMINE DIRECTION FROM THE COLUMN THE AMOUNT IS PRINTED IN (a "Deposit"/"Credit"/money-in column vs a "Withdrawal"/"Debit"/money-out column), NOT from the transaction type label. A label like "FAST Payment / Receipt" or "Payment / Collection" can describe BOTH an incoming and an outgoing transfer on the same statement — the word "Receipt" does NOT mean money came in, it's just the bank's name for that transaction type. If an amount sits in the withdrawal/debit column, it is NOT a credit, no matter what the row's label says — skip it entirely, even if the label sounds like money-in.

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

// mergeTransactionAttempts below dedups transactions by an exact `${date}|${amount}|${direction}`
// string key — a model occasionally drops the day (e.g. "2025-07" instead of "2025-07-01") despite
// the prompt asking for YYYY-MM-DD, which doesn't fail to parse, it just forms a DIFFERENT dedup key
// from every other attempt's correctly-formatted reading of the exact same transaction. The result
// is the same real transaction showing up twice in the final list — once correctly dated, once
// under its malformed date — rather than merging into one row. Same treatment as a transaction with
// no date at all (already filtered below): drop it from THIS attempt's output rather than letting a
// malformed reading silently fork into its own phantom entry; a properly-dated reading of the same
// line from another attempt still comes through normally.
const FULL_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

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
    // Was 3000 — a dense statement page (20+ transaction lines) needing a JSON object per line can
    // burn through that on reasoning alone before any output is emitted, truncating to a completely
    // EMPTY response rather than a partial one (same "reasoning eats the budget" failure mode
    // scanPageImage/extractPageContext were already bumped for — see lib/ocr/pageScan.ts). Observed
    // live: 2 of 3 independent attempts on a real page returning empty content under the old budget,
    // leaving only 1 attempt's reading with zero redundancy to catch a misclassified transaction —
    // mergeTransactionAttempts unions attempts rather than voting, so a lone bad attempt with no
    // competing reads to disagree with survives straight into the final result.
    const { content, cost } = await sendVisionRequest(base64Image, PROMPT, temperature, seed, 10000);
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
        .filter(t => FULL_DATE_FORMAT.test(t.date)); // no date, or a malformed one, isn't usable downstream — see FULL_DATE_FORMAT comment

    return { transactions, cost };
}

// Unions transactions across N independent scan attempts of the SAME page (same "a real one
// missed by one attempt but caught by another still makes it in" philosophy as reconcile.ts's
// cross-band merge for timesheets) — this is the actual fix for the failure mode that motivated
// multi-attempt scanning here: a single pass missing a page's transaction entirely, silently
// understating what the worker was actually paid.
//
// Grouped primarily by amount+direction, NOT by an exact date match. Observed live, twice, on real
// statements: one attempt reads "28-06-2025", another reads "30-06-2025", for the SAME real
// transaction — a single-digit date misread, not a disagreement about which day it happened. Keying
// on exact date (the original design) treated these as two different transactions instead of one
// correctly-voted one, duplicating every date-misread transaction in the final list. Amount is a
// far more reliable identity signal than a handwritten/printed date digit — within one amount+
// direction group, candidates are further clustered by date PROXIMITY (±3 days) before being
// treated as the same transaction, so a genuinely different transaction that happens to share an
// amount (e.g. the same dollar figure paid in two different months) doesn't incorrectly merge just
// because the number matches. The most common date/description among a cluster's attempts wins
// (ties broken by whichever appeared first) — description wording can vary slightly between
// attempts (extra whitespace, a truncated reference number) even when it's clearly the same line.
const DATE_CLUSTER_TOLERANCE_MS = 3 * 24 * 60 * 60 * 1000;

// Compares only the transaction-TYPE line (e.g. "Cash Deposit Machine"), not the full multi-line
// description — a trailing reference/site code line ("63493333.TO PAGAR DL2" vs "63493333,TG PAGAR
// DL2") is exactly the kind of noisy OCR detail that varies between attempts even when it's clearly
// the same real transaction, so comparing the full string would still miss the match this is meant
// to catch.
/** Normalizes a transaction description's first line for same-transaction comparison. */
function normalizeDescription(description: string): string {
    return description.split("\n")[0].trim().toLowerCase().replace(/\s+/g, " ");
}

/** Returns the most frequent value in a `Map<value, count>`, falling back to `fallback` if empty. */
function pickMostCommon(counts: Map<string, number>, fallback: string): string {
    let best = fallback;
    let bestCount = 0;
    for (const [value, count] of counts) {
        if (count > bestCount) {
            best = value;
            bestCount = count;
        }
    }
    return best;
}

/**
 * Merges multiple independent scan attempts of the same page into one deduplicated transaction list.
 *
 * @param attempts - One transaction array per scan attempt (see {@link extractMatchingTransactions}).
 * @returns The unioned transactions, each tagged with how many attempts reported it (`confirmedByAttempts`).
 */
export function mergeTransactionAttempts(attempts: BankTransaction[][]): BankTransaction[] {
    const total = attempts.length;

    type Candidate = { t: BankTransaction; attemptIdx: number };
    const byAmountDirection = new Map<string, Candidate[]>();
    attempts.forEach((attempt, attemptIdx) => {
        for (const t of attempt) {
            const key = `${t.amount}|${t.direction ?? ""}`;
            const list = byAmountDirection.get(key) ?? [];
            list.push({ t, attemptIdx });
            byAmountDirection.set(key, list);
        }
    });

    const results: BankTransaction[] = [];
    for (const candidates of byAmountDirection.values()) {
        const clusters: Candidate[][] = [];
        for (const cand of candidates) {
            const candDate = Date.parse(cand.t.date);
            const candDesc = normalizeDescription(cand.t.description);
            const cluster = clusters.find(c => {
                // Two signals, either is enough: close dates (handles a misread DIGIT — "28" vs
                // "30"), or an identical description (handles a date that's genuinely illegible in
                // the source scan, not just misread — observed live: a statement's date column
                // literally cropped off at the page's left edge for one row, so two attempts each
                // guessed a different day number up to 6 days apart for what the matching
                // description ("Cash Deposit Machine" at the same site code) confirms is the same
                // single real transaction. Amount+direction already match (that's the group key);
                // requiring EITHER signal rather than date alone catches this without needing an
                // unboundedly wide date tolerance that would risk merging genuinely different
                // same-amount transactions weeks apart.
                const clusterDate = Date.parse(c[0].t.date);
                const closeDates = Number.isFinite(candDate) && Number.isFinite(clusterDate) && Math.abs(candDate - clusterDate) <= DATE_CLUSTER_TOLERANCE_MS;
                const sameDescription = candDesc !== "" && candDesc === normalizeDescription(c[0].t.description);
                return closeDates || sameDescription;
            });
            if (cluster) cluster.push(cand);
            else clusters.push([cand]);
        }

        for (const cluster of clusters) {
            const dateCounts = new Map<string, number>();
            const descriptionCounts = new Map<string, number>();
            const seenIn = new Set<number>();
            for (const { t, attemptIdx } of cluster) {
                dateCounts.set(t.date, (dateCounts.get(t.date) ?? 0) + 1);
                descriptionCounts.set(t.description, (descriptionCounts.get(t.description) ?? 0) + 1);
                seenIn.add(attemptIdx);
            }
            results.push({
                ...cluster[0].t,
                date: pickMostCommon(dateCounts, cluster[0].t.date),
                description: pickMostCommon(descriptionCounts, cluster[0].t.description),
                confirmedByAttempts: { seen: seenIn.size, total },
            });
        }
    }

    return results;
}
