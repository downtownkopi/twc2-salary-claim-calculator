import type { FillWarning } from "./xlsx";

export type ParsedEntry = {
    day: number | null;
    month: number | null;
    // ALL raw clock values seen on this row, left-to-right (chronological) — NOT pre-grouped into
    // shifts. A normal day is [clock_in, clock_out] (length 2); a split day/night shift is
    // [in1, out1, in2, out2] (length 4); asking the model to enumerate every value it sees rather
    // than decide up front "this is N shifts" turned out far more reliable — it kept collapsing
    // 4-value rows down to 2 when asked to pre-group them into shift objects. Shift-pairing
    // happens downstream in server.ts once the value count is known.
    times: number[] | null;
    guessed: boolean | null;
    rest_day: boolean | null;
    notes: string | null;
};

// Even at temperature 0 with a fixed seed, a single scan of a dense handwritten page isn't
// reliably complete — the model can genuinely miss/skip rows differently between identical
// requests (seed isn't strictly honored by every backend, and long dense generations can drift).
// So a page gets scanned multiple times independently (with varied temperature — see
// server.ts's SCAN_TEMPERATURES), and this unions their coverage: a day missed by one attempt
// but caught by another still makes it in.
//
// Reconciliation happens at the whole-day level: each attempt reports at most one times[] array
// per day, and if every attempt consistently reports the SAME array, it's used as-is. Only a
// genuine disagreement (different arrays for the same day) gets flagged and majority-voted,
// since a wrong guess is worse than a visible flag on a wage claim.
export function reconcileAttempts(
    attempts: ParsedEntry[][],
    source: string
): { entries: ParsedEntry[]; warnings: FillWarning[] } {
    const warnings: FillWarning[] = [];
    const dayKeys = new Set<string>();
    for (const attempt of attempts) {
        for (const e of attempt) {
            if (e.day !== null && e.month !== null) dayKeys.add(`${e.month}-${e.day}`);
        }
    }

    const entries: ParsedEntry[] = [];

    for (const key of dayKeys) {
        const [month, day] = key.split("-").map(Number);

        const attemptTimes: number[][] = [];
        const attemptNotes: (string | null)[] = [];
        const attemptGuessed: boolean[] = [];
        let restVotes = 0;
        let attemptsThatMentionedDay = 0;

        for (const attempt of attempts) {
            const rowForDay = attempt.find(e => e.day === day && e.month === month);
            if (!rowForDay) continue;
            attemptsThatMentionedDay++;

            if (rowForDay.times && rowForDay.times.length > 0) {
                attemptTimes.push(rowForDay.times);
                attemptNotes.push(rowForDay.notes);
                attemptGuessed.push(rowForDay.guessed === true);
            } else if (rowForDay.rest_day === true) {
                restVotes++;
            }
        }

        if (attemptTimes.length > 0) {
            const signatureCounts = new Map<string, number>();
            const signatureTimes = new Map<string, number[]>();
            const signatureNotes = new Map<string, string | null>();
            const signatureGuessed = new Map<string, boolean>();
            attemptTimes.forEach((times, i) => {
                const sig = times.join(",");
                signatureCounts.set(sig, (signatureCounts.get(sig) ?? 0) + 1);
                if (!signatureTimes.has(sig)) {
                    signatureTimes.set(sig, times);
                    signatureNotes.set(sig, attemptNotes[i]);
                    signatureGuessed.set(sig, attemptGuessed[i]);
                }
            });

            // Prefer the MOST COMPLETE reading (longest times array) first, falling back to vote
            // count only to break ties among equally-long candidates. This is deliberately NOT a
            // pure majority vote: the observed failure mode is attempts lazily collapsing a
            // 4-value split shift down to 2 (undercounting), which can easily outvote the one
            // attempt that read the row correctly and completely (2 wrong-but-short attempts
            // beating 1 correct-but-long one). Undercounting is far more common for this model on
            // this task than hallucinating a shift that isn't there, so biasing toward
            // completeness is the right tradeoff — and any disagreement still gets guessed=true
            // and flagged for review either way, so a wrong pick from either direction stays
            // visible rather than silently shipping.
            let bestSig = "";
            let bestLength = -1;
            let bestCount = 0;
            for (const [sig, count] of signatureCounts) {
                const length = signatureTimes.get(sig)!.length;
                const better = length > bestLength || (length === bestLength && count > bestCount);
                if (better) { bestSig = sig; bestLength = length; bestCount = count; }
            }

            const winningTimes = signatureTimes.get(bestSig)!;
            const unanimous = signatureCounts.size === 1 && attemptsThatMentionedDay === attempts.length;
            const guessed = !unanimous || signatureGuessed.get(bestSig) === true;

            if (signatureCounts.size > 1) {
                const breakdown = [...signatureCounts.entries()]
                    .map(([sig, count]) => `[${sig || "none"}] (x${count})`)
                    .join(", ");
                warnings.push({
                    source,
                    reason: `day=${day} month=${month}: repeated scans disagreed on that day's times (${breakdown}) — used the most complete/common version, please verify`,
                });
            }

            entries.push({
                day, month,
                times: winningTimes,
                guessed,
                rest_day: false,
                notes: unanimous
                    ? signatureNotes.get(bestSig) ?? null
                    : attemptsThatMentionedDay < attempts.length
                        ? `only detected in ${attemptsThatMentionedDay}/${attempts.length} scan attempts of this page`
                        : `repeated scans disagreed on this day's times, used the most complete/common version`,
            });
        } else if (restVotes > 0) {
            entries.push({ day, month, times: null, guessed: false, rest_day: true, notes: null });
        }
        // else: no attempt produced usable data for this day — left out; cross-page gap-fill
        // (lib/gapfill.ts) may still infer it from the same weekday elsewhere in the month.
    }

    return { entries, warnings };
}
