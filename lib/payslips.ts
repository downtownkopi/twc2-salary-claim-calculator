import { sendVisionRequest, extractJsonBlock } from "./ocr";

export type PayslipGranularity = "day" | "week" | "month";

export type PayslipEntry = {
    granularity: PayslipGranularity;
    date: string | null; // YYYY-MM-DD — set when granularity === "day"
    weekStart: string | null; // YYYY-MM-DD — set when granularity === "week"
    weekEnd: string | null; // YYYY-MM-DD — set when granularity === "week"
    yearMonth: string | null; // YYYY-MM — set when granularity === "month"
    overtimeHours: number;
    // The per-hour OT rate printed alongside the hours (e.g. "68 hrs x $5.63"), or null if the slip
    // doesn't show one. This is what the EMPLOYER says they paid — not necessarily the correct
    // statutory rate (that's computed from the IPA's basic salary via the Fourth Schedule formula
    // elsewhere in this app). Display/reference only: never substituted into the actual claim math,
    // since a wrong (too-low) rate here could well be the very thing the claim is about.
    hourlyRate: number | null;
    // Set only by mergePayslipEntries below — same "how many independent scan attempts on this
    // page actually reported this" pattern as lib/bankstatement.ts's BankTransaction.
    confirmedByAttempts: { seen: number; total: number } | null;
};

// A payslip states overtime hours already worked out by the employer for some period — unlike a
// timesheet, it's not a day-by-day punch log. The period it's stated at varies slip to slip: some
// give one figure per calendar month, some break it down per week, some even per day. This
// extraction reports whichever granularity is actually printed rather than forcing one shape, and
// deliberately does NOT ask the model to compute date ranges (e.g. "last day of February") — that
// math happens deterministically in periodRange() below instead.
const PROMPT = `This image is a payslip belonging to a migrant/Work-Permit-holder worker. A caseworker needs the overtime (OT) hours stated on it.

Find every overtime-hours figure stated on this document. Payslips vary in how they break this down — some state one OT-hours figure for a whole calendar month, some break it down per week, some per day. Report whichever granularity this specific slip actually uses.

For each OT-hours figure found, report:
- granularity: one of "day", "week", or "month" — whichever this line item is actually stated at
- date: YYYY-MM-DD, ONLY if granularity is "day" (infer the year from the document's own date header if it only shows day/month), otherwise null
- weekStart: YYYY-MM-DD, ONLY if granularity is "week" — the first day of that week as printed, otherwise null
- weekEnd: YYYY-MM-DD, ONLY if granularity is "week" — the last day of that week as printed, otherwise null
- yearMonth: YYYY-MM, ONLY if granularity is "month", otherwise null
- overtimeHours: the number of overtime hours stated for that period (a plain number, not a dollar amount)
- hourlyRate: the per-hour overtime RATE, if one is printed alongside the hours (e.g. "68 hrs x $5.63" -> hourlyRate 5.63, or a column/field literally labeled "OT rate" or "hourly rate"). A plain number, no dollar sign. null if no such rate is printed anywhere near the overtime hours figure — do not compute it yourself by dividing a total by the hours.

Do not compute or infer any date math yourself (e.g. don't work out which date a month starts or ends on) — just report the dates/month exactly as printed.

Output ONLY a valid JSON array, no markdown fences, no other text. If this page has no overtime-hours figure stated on it at all, output exactly [].`;

/** Coerces a value to a trimmed string, or `null` if it isn't a non-empty string. */
function strOrNull(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    return trimmed ? trimmed : null;
}

/** Coerces a value to a finite number, or `null` if it can't be. */
function numOrNull(v: unknown): number | null {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
}

// One independent scan attempt at a given temperature/seed — called several times per page (see
// server.ts's SCAN_TEMPERATURES), same "a single deterministic pass can genuinely miss/misread a
// figure" reasoning as extractMedicalCertificateEntries in lib/medicalCertificates.ts.
/**
 * Scans one payslip page image for overtime-hours entries, at whatever granularity the slip states them.
 *
 * @param base64Image - The page image, base64-encoded (no data URL prefix).
 * @param temperature - Model sampling temperature for this attempt.
 * @param seed - Model sampling seed for this attempt.
 * @returns The OT entries found on the page, and this call's cost in USD.
 * @throws If the model's reply can't be parsed as a JSON array.
 */
export async function extractPayslipEntries(base64Image: string, temperature = 0, seed = 42): Promise<{ entries: PayslipEntry[]; cost: number }> {
    const { content, cost } = await sendVisionRequest(base64Image, PROMPT, temperature, seed, 2000);
    let parsed: unknown;
    try {
        parsed = JSON.parse(extractJsonBlock(content));
    } catch (e: any) {
        console.error("extractPayslipEntries: failed to parse model output as JSON. Raw content:\n", content);
        throw new Error(`${e.message} — raw reply started with: ${content.slice(0, 200)}`);
    }
    if (!Array.isArray(parsed)) return { entries: [], cost };

    const entries: PayslipEntry[] = parsed
        .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
        .map(t => ({
            granularity: (t.granularity === "day" || t.granularity === "week" || t.granularity === "month" ? t.granularity : null) as PayslipGranularity,
            date: strOrNull(t.date),
            weekStart: strOrNull(t.weekStart),
            weekEnd: strOrNull(t.weekEnd),
            yearMonth: strOrNull(t.yearMonth),
            overtimeHours: numOrNull(t.overtimeHours) ?? 0,
            hourlyRate: numOrNull(t.hourlyRate),
            confirmedByAttempts: null,
        }))
        // An entry with no valid granularity, or missing the field(s) that granularity requires,
        // isn't usable downstream (periodRange() has nothing to compute a date range from).
        .filter(t => {
            if (!t.granularity) return false;
            if (t.granularity === "day") return !!t.date;
            if (t.granularity === "week") return !!t.weekStart && !!t.weekEnd;
            return !!t.yearMonth;
        });

    return { entries, cost };
}

/** Builds the identity key mergePayslipEntries groups entries by — whichever date field(s) this entry's granularity uses. */
function entryKey(t: PayslipEntry): string {
    if (t.granularity === "day") return `day|${t.date}`;
    if (t.granularity === "week") return `week|${t.weekStart}|${t.weekEnd}`;
    return `month|${t.yearMonth}`;
}

// Unions entries across N independent scan attempts of the SAME page — same union-merge philosophy
// as mergeMedicalCertificateEntries in lib/medicalCertificates.ts. Two entries from different
// attempts are treated as the same real line item if they agree on granularity and period; the
// overtime-hours figure can vary between attempts, so the most common one among attempts that
// reported this period wins.
/**
 * Merges multiple independent scan attempts of the same page into one deduplicated entry list.
 *
 * @param attempts - One entry array per scan attempt (see {@link extractPayslipEntries}).
 * @returns The unioned entries, each tagged with how many attempts reported it (`confirmedByAttempts`).
 */
export function mergePayslipEntries(attempts: PayslipEntry[][]): PayslipEntry[] {
    const total = attempts.length;
    const groups = new Map<string, { hoursCounts: Map<number, number>; rateCounts: Map<number | null, number>; sample: PayslipEntry; seenIn: Set<number> }>();

    attempts.forEach((attempt, attemptIdx) => {
        for (const t of attempt) {
            const key = entryKey(t);
            let group = groups.get(key);
            if (!group) {
                group = { hoursCounts: new Map(), rateCounts: new Map(), sample: t, seenIn: new Set() };
                groups.set(key, group);
            }
            group.seenIn.add(attemptIdx);
            group.hoursCounts.set(t.overtimeHours, (group.hoursCounts.get(t.overtimeHours) ?? 0) + 1);
            group.rateCounts.set(t.hourlyRate, (group.rateCounts.get(t.hourlyRate) ?? 0) + 1);
        }
    });

    /** Picks the highest-count key from a Map, breaking ties toward `sample`. */
    function majority<T>(counts: Map<T, number>, sample: T): T {
        let best = sample;
        let bestCount = 0;
        for (const [value, count] of counts) {
            if (count > bestCount) {
                best = value;
                bestCount = count;
            }
        }
        return best;
    }

    return [...groups.values()].map(group => ({
        ...group.sample,
        overtimeHours: majority(group.hoursCounts, group.sample.overtimeHours),
        hourlyRate: majority(group.rateCounts, group.sample.hourlyRate),
        confirmedByAttempts: { seen: group.seenIn.size, total },
    }));
}

/** Formats a Date as YYYY-MM-DD in local time (no timezone shifting via toISOString). */
function formatDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Deliberately not asking the model to do this date math (leap years, month lengths) — computed
// here instead so it's always correct regardless of what the model reports.
/**
 * Computes the actual YYYY-MM-DD start/end date range an entry's overtime hours cover, regardless
 * of which granularity it was stated at.
 *
 * @param entry - A payslip entry (see {@link PayslipEntry}).
 * @returns The inclusive start/end date range, or `null` if the entry has no usable period.
 */
export function periodRange(entry: PayslipEntry): { start: string; end: string } | null {
    if (entry.granularity === "day" && entry.date) {
        return { start: entry.date, end: entry.date };
    }
    if (entry.granularity === "week" && entry.weekStart && entry.weekEnd) {
        return { start: entry.weekStart, end: entry.weekEnd };
    }
    if (entry.granularity === "month" && entry.yearMonth) {
        const [y, m] = entry.yearMonth.split("-").map(Number);
        if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
        const start = formatDate(new Date(y, m - 1, 1));
        const end = formatDate(new Date(y, m, 0)); // day 0 of next month = last day of this month
        return { start, end };
    }
    return null;
}
