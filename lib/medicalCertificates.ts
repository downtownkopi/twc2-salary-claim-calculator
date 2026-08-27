import { sendVisionRequest, extractJsonBlock } from "./ocr";

export type MedicalCertificateEntry = {
    leaveFrom: string; // YYYY-MM-DD — first day of medical leave granted
    leaveTo: string; // YYYY-MM-DD — last day of medical leave granted (inclusive); same as leaveFrom for a single-day MC
    description: string; // diagnosis/reason given on the certificate, verbatim if given
    // Set only by mergeMedicalCertificateEntries below — same "how many independent scan attempts
    // on this page actually reported this" pattern as lib/bankstatement.ts's BankTransaction.
    confirmedByAttempts: { seen: number; total: number } | null;
};

// A medical certificate (MC) states a period of leave a doctor granted — a distinct document and
// a distinct check from a medical bill/invoice (lib/medicalbills.ts, which tracks billed amounts
// for reimbursement). An MC often has no dollar amount printed on it at all, so it's its own
// separate upload rather than folded into the bills one. This extraction is what
// public/index.html's mc-cert-note guardrail checks a timesheet's MC-marked days against.
const PROMPT = `This image is a medical certificate (MC) belonging to a migrant/Work-Permit-holder worker — a document a doctor issues granting a period of medical leave. A caseworker is checking whether a timesheet day marked "MC" has a real certificate backing it.

Find every period of medical leave stated on this document (usually one, but scan the whole page in case there's more than one).

For each period of leave, report:
- leaveFrom: YYYY-MM-DD, the first day of leave granted (infer the year from the document's own date header if it only shows day/month)
- leaveTo: YYYY-MM-DD, the last day of leave granted (inclusive) — same as leaveFrom if only one day of leave was given
- description: the diagnosis or reason given, verbatim if stated, otherwise an empty string

Look for phrasing like "is granted leave from ... to ...", "unfit for work from/to", "hospitalisation leave", or a single date.

Output ONLY a valid JSON array, no markdown fences, no other text. If this page has no period of medical leave stated on it at all, output exactly [].`;

/** Coerces a value to a trimmed string, or `""` if it isn't a string at all. */
function str(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
}

// One independent scan attempt at a given temperature/seed — called several times per page (see
// server.ts's SCAN_TEMPERATURES), same "a single deterministic pass can genuinely miss/misread a
// figure" reasoning as extractMedicalBillEntries in lib/medicalbills.ts.
/**
 * Scans one medical certificate page image for granted leave periods.
 *
 * @param base64Image - The page image, base64-encoded (no data URL prefix).
 * @param temperature - Model sampling temperature for this attempt.
 * @param seed - Model sampling seed for this attempt.
 * @returns The leave periods found on the page, and this call's cost in USD.
 * @throws If the model's reply can't be parsed as a JSON array.
 */
export async function extractMedicalCertificateEntries(base64Image: string, temperature = 0, seed = 42): Promise<{ entries: MedicalCertificateEntry[]; cost: number }> {
    const { content, cost } = await sendVisionRequest(base64Image, PROMPT, temperature, seed, 2000);
    let parsed: unknown;
    try {
        parsed = JSON.parse(extractJsonBlock(content));
    } catch (e: any) {
        console.error("extractMedicalCertificateEntries: failed to parse model output as JSON. Raw content:\n", content);
        throw new Error(`${e.message} — raw reply started with: ${content.slice(0, 200)}`);
    }
    if (!Array.isArray(parsed)) return { entries: [], cost };

    const entries: MedicalCertificateEntry[] = parsed
        .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
        .map(t => ({
            leaveFrom: str(t.leaveFrom),
            leaveTo: str(t.leaveTo) || str(t.leaveFrom), // a single-day MC may only state one date
            description: str(t.description),
            confirmedByAttempts: null,
        }))
        .filter(t => t.leaveFrom); // an entry with no leave-start date at all isn't usable downstream

    return { entries, cost };
}

// Unions entries across N independent scan attempts of the SAME page — same union-merge philosophy
// as mergeMedicalBillEntries in lib/medicalbills.ts. Two entries from different attempts are
// treated as the same real certificate if they agree on the leave date range; description wording
// can vary between attempts, so it isn't part of the identity key — the most common description
// among the attempts that reported it wins.
/**
 * Merges multiple independent scan attempts of the same page into one deduplicated entry list.
 *
 * @param attempts - One entry array per scan attempt (see {@link extractMedicalCertificateEntries}).
 * @returns The unioned entries, each tagged with how many attempts reported it (`confirmedByAttempts`).
 */
export function mergeMedicalCertificateEntries(attempts: MedicalCertificateEntry[][]): MedicalCertificateEntry[] {
    const total = attempts.length;
    const groups = new Map<string, { descriptionCounts: Map<string, number>; sample: MedicalCertificateEntry; seenIn: Set<number> }>();

    attempts.forEach((attempt, attemptIdx) => {
        for (const t of attempt) {
            const key = `${t.leaveFrom}|${t.leaveTo}`;
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
