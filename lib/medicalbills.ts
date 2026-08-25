import { sendVisionRequest, extractJsonBlock } from "./ocr";

export type MedicalBillEntry = {
    date: string; // YYYY-MM-DD — invoice/service date
    amount: number; // amount billed/due, as a plain number
    description: string; // what the bill was for, verbatim if given
    // Set only by mergeMedicalBillEntries below — same "how many independent scan attempts on this
    // page actually reported this" pattern as lib/bankstatement.ts's BankTransaction.
    confirmedByAttempts: { seen: number; total: number } | null;
};

// This is a reimbursement check, not a leave-day count — an employer of a Work Permit holder is
// generally obliged to bear the worker's medical costs, so a caseworker cross-checks each bill's
// billed amount against whether the worker was actually reimbursed (see "reimbursed" flag set by
// the caseworker in public/index.html's review, not extracted here).
const PROMPT = `This image is a medical bill or invoice belonging to a migrant/Work-Permit-holder worker. A caseworker is checking whether the worker was reimbursed by their employer for medical costs they paid out of pocket.

Find every billed amount stated on this document (usually one per document, but scan the whole page in case there's more than one — e.g. a subtotal per item and a grand total should only be reported once, as the total amount actually due/billed).

For each billed amount, report:
- date: YYYY-MM-DD, the invoice date or date of service (infer the year from the document's own date header if it only shows day/month)
- amount: the total amount due/billed, as a plain number (no currency symbol, no commas)
- description: what the bill/invoice was for (e.g. "consultation", "medication", diagnosis), verbatim if given, otherwise an empty string

Output ONLY a valid JSON array, no markdown fences, no other text. If this page has no billed amount stated on it at all, output exactly [].`;

/** Coerces a value to a trimmed string, or `""` if it isn't a string at all. */
function str(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
}

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

// One independent scan attempt at a given temperature/seed — called several times per page (see
// server.ts's SCAN_TEMPERATURES), same "a single deterministic pass can genuinely miss/misread a
// figure" reasoning as extractMatchingTransactions in lib/bankstatement.ts.
/**
 * Scans one medical bill/invoice page image for billed amounts.
 *
 * @param base64Image - The page image, base64-encoded (no data URL prefix).
 * @param temperature - Model sampling temperature for this attempt.
 * @param seed - Model sampling seed for this attempt.
 * @returns The billed entries found on the page, and this call's cost in USD.
 * @throws If the model's reply can't be parsed as a JSON array.
 */
export async function extractMedicalBillEntries(base64Image: string, temperature = 0, seed = 42): Promise<{ entries: MedicalBillEntry[]; cost: number }> {
    const { content, cost } = await sendVisionRequest(base64Image, PROMPT, temperature, seed, 2000);
    let parsed: unknown;
    try {
        parsed = JSON.parse(extractJsonBlock(content));
    } catch (e: any) {
        console.error("extractMedicalBillEntries: failed to parse model output as JSON. Raw content:\n", content);
        throw new Error(`${e.message} — raw reply started with: ${content.slice(0, 200)}`);
    }
    if (!Array.isArray(parsed)) return { entries: [], cost };

    const entries: MedicalBillEntry[] = parsed
        .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
        .map(t => ({
            date: str(t.date),
            amount: num(t.amount) ?? 0,
            description: str(t.description),
            confirmedByAttempts: null,
        }))
        .filter(t => t.date); // an entry with no date at all isn't usable downstream

    return { entries, cost };
}

// Unions entries across N independent scan attempts of the SAME page — same union-merge philosophy
// as mergeTransactionAttempts in lib/bankstatement.ts. Two entries from different attempts are
// treated as the same real bill if they agree on date+amount; description wording can vary between
// attempts, so it isn't part of the identity key — the most common description among the attempts
// that reported it wins.
/**
 * Merges multiple independent scan attempts of the same page into one deduplicated entry list.
 *
 * @param attempts - One entry array per scan attempt (see {@link extractMedicalBillEntries}).
 * @returns The unioned entries, each tagged with how many attempts reported it (`confirmedByAttempts`).
 */
export function mergeMedicalBillEntries(attempts: MedicalBillEntry[][]): MedicalBillEntry[] {
    const total = attempts.length;
    const groups = new Map<string, { descriptionCounts: Map<string, number>; sample: MedicalBillEntry; seenIn: Set<number> }>();

    attempts.forEach((attempt, attemptIdx) => {
        for (const t of attempt) {
            const key = `${t.date}|${t.amount}`;
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
