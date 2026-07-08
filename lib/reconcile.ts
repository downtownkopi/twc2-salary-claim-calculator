import type { FillWarning } from "./xlsx";

export type ParsedEntry = {
    day: number | null;
    month: number | null;
    clock_in: number | null;
    clock_out: number | null;
    guessed: boolean | null;
    rest_day: boolean | null;
    notes: string | null;
};

type Shift = { clock_in: number; clock_out: number };

function shiftKey(s: Shift): string {
    return `${s.clock_in}-${s.clock_out}`;
}

// Dedupe + sort a single attempt's shifts for one day into a canonical signature, so the SAME
// day with the SAME set of shifts (e.g. a split day/night shift, both found consistently) reads
// as one signature rather than N competing individual readings.
function signatureOf(shifts: Shift[]): string {
    const distinct = [...new Map(shifts.map(s => [shiftKey(s), s])).values()];
    return distinct.map(shiftKey).sort().join("|");
}

// Even at temperature 0 with a fixed seed, a single scan of a dense handwritten page isn't
// reliably complete — the model can genuinely miss/skip rows differently between identical
// requests (seed isn't strictly honored by every backend, and long dense generations can drift).
// So a page gets scanned multiple times independently, and this unions their coverage: a day
// missed by one attempt but caught by another still makes it in.
//
// Reconciliation happens at the whole-day level, not per individual shift reading — a day can
// legitimately have more than one shift (split day/night shift), and if every attempt
// consistently reports the SAME set of shifts for that day, all of them are kept, not just one.
// Only a genuine disagreement between attempts (different sets of shifts for the same day) gets
// flagged and majority-voted, since a wrong guess is worse than a visible flag on a wage claim.
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

        // per attempt: this day's shifts (deduped) + rest-day vote + any raw entry for notes/guessed
        const attemptShifts: Shift[][] = [];
        const attemptNotes: (string | null)[] = [];
        const attemptGuessed: boolean[] = [];
        let restVotes = 0;
        let attemptsThatMentionedDay = 0;

        for (const attempt of attempts) {
            const rowsForDay = attempt.filter(e => e.day === day && e.month === month);
            if (rowsForDay.length === 0) continue;
            attemptsThatMentionedDay++;

            const shifts = rowsForDay.filter(
                (e): e is ParsedEntry & { clock_in: number; clock_out: number } =>
                    e.clock_in !== null && e.clock_out !== null
            );
            if (shifts.length > 0) {
                attemptShifts.push(shifts.map(s => ({ clock_in: s.clock_in, clock_out: s.clock_out })));
                attemptNotes.push(shifts.map(s => s.notes).find(n => n) ?? null);
                attemptGuessed.push(shifts.some(s => s.guessed === true));
            } else if (rowsForDay.some(e => e.rest_day === true)) {
                restVotes++;
            }
        }

        if (attemptShifts.length > 0) {
            const signatureCounts = new Map<string, number>();
            const signatureShifts = new Map<string, Shift[]>();
            const signatureNotes = new Map<string, string | null>();
            const signatureGuessed = new Map<string, boolean>();
            attemptShifts.forEach((shifts, i) => {
                const sig = signatureOf(shifts);
                signatureCounts.set(sig, (signatureCounts.get(sig) ?? 0) + 1);
                if (!signatureShifts.has(sig)) {
                    signatureShifts.set(sig, [...new Map(shifts.map(s => [shiftKey(s), s])).values()]);
                    signatureNotes.set(sig, attemptNotes[i]);
                    signatureGuessed.set(sig, attemptGuessed[i]);
                }
            });

            let bestSig = "";
            let bestCount = 0;
            for (const [sig, count] of signatureCounts) {
                const better =
                    count > bestCount ||
                    (count === bestCount && signatureShifts.get(sig)!.length > (signatureShifts.get(bestSig)?.length ?? 0));
                if (better) { bestSig = sig; bestCount = count; }
            }

            const winningShifts = signatureShifts.get(bestSig)!;
            const unanimous = signatureCounts.size === 1 && attemptsThatMentionedDay === attempts.length;
            const guessed = !unanimous || signatureGuessed.get(bestSig) === true;

            if (signatureCounts.size > 1) {
                const breakdown = [...signatureCounts.entries()]
                    .map(([sig, count]) => `[${sig || "none"}] (x${count})`)
                    .join(", ");
                warnings.push({
                    source,
                    reason: `day=${day} month=${month}: repeated scans disagreed on that day's shifts (${breakdown}) — used the most common version, please verify`,
                });
            }

            for (const shift of winningShifts) {
                entries.push({
                    day, month,
                    clock_in: shift.clock_in,
                    clock_out: shift.clock_out,
                    guessed,
                    rest_day: false,
                    notes: unanimous
                        ? signatureNotes.get(bestSig) ?? null
                        : attemptsThatMentionedDay < attempts.length
                            ? `only detected in ${attemptsThatMentionedDay}/${attempts.length} scan attempts of this page`
                            : `repeated scans disagreed on this day's shifts, used the most common version`,
                });
            }
        } else if (restVotes > 0) {
            entries.push({ day, month, clock_in: null, clock_out: null, guessed: false, rest_day: true, notes: null });
        }
        // else: no attempt produced usable data for this day — left out; cross-page gap-fill
        // (lib/gapfill.ts) may still infer it from the same weekday elsewhere in the month.
    }

    return { entries, warnings };
}
