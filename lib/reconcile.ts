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

// A clock time is stored as a bare HHMM integer (e.g. 800 = 8:00am). The minutes component
// (the value mod 100) must be 00-59 — anything else (e.g. 1074, which would mean "10:74") is not
// a different opinion about what the digits say, it's a value that cannot represent any real
// clock time at all. Treating it as a normal vote lets it "disagree" with a genuinely correct
// reading from another attempt and drop an otherwise-recoverable day. 2400 is allowed as the
// documented sentinel for a shift ending exactly at midnight.
function isPlausibleTime(t: number): boolean {
    if (t < 0) return false;
    if (t === 2400) return true;
    const minutes = t % 100;
    return minutes < 60;
}

// Even at temperature 0 with a fixed seed, a single scan of a dense handwritten page isn't
// reliably complete — the model can genuinely miss/skip rows differently between identical
// requests (seed isn't strictly honored by every backend, and long dense generations can drift).
// So a page gets scanned multiple times independently (with varied temperature — see
// server.ts's SCAN_TEMPERATURES), and this unions their coverage: a day missed by one attempt
// but caught by another still makes it in.
//
// Reconciliation is strict, not best-effort: a day only makes it into the result if the
// attempts that mentioned it agree on the exact same reading — no majority-vote or "most
// complete reading wins" fallback. A wrong entry the user has to notice and manually remove on a
// wage claim is worse than a gap they're explicitly warned about and can fill in themselves.
//
// requireFullParticipation controls what "agree" means:
// - true (default): every attempt passed in must mention the day, and all of them must agree.
//   Used within a single band's own temperature-varied attempts, which all look at the exact
//   same image — if even one attempt hallucinates a day the others never mention at all, that's
//   a real disagreement about the same source material, and the day is dropped.
// - false: a day is fine to accept from a SUBSET of attempts (e.g. only one band mentioning it),
//   as long as none of the attempts that DID mention it conflict with each other. Used when
//   merging multiple bands' already-reconciled results — bands see genuinely different (only
//   partially overlapping) crops by design, so one band having no opinion on a day the other
//   band's row sits entirely outside its crop for isn't disagreement, it's expected non-coverage.
export function reconcileAttempts(
    attempts: ParsedEntry[][],
    source: string,
    requireFullParticipation = true
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

        const timesVotes: number[][] = [];
        let restVotes = 0;
        let attemptsThatMentionedDay = 0;
        let implausibleCount = 0;
        const implausibleValues: number[] = [];

        for (const attempt of attempts) {
            const rowForDay = attempt.find(e => e.day === day && e.month === month);
            if (!rowForDay) continue;

            if (rowForDay.times && rowForDay.times.length > 0) {
                const bad = rowForDay.times.filter(t => !isPlausibleTime(t));
                if (bad.length > 0) {
                    // An impossible clock time (e.g. 1074 = "10:74") isn't a competing opinion
                    // about the digits, it's an unreadable value — exclude this attempt from
                    // voting on this day entirely rather than letting it "disagree" with a
                    // genuinely correct reading from another attempt.
                    implausibleCount++;
                    implausibleValues.push(...bad);
                    continue;
                }
                attemptsThatMentionedDay++;
                timesVotes.push(rowForDay.times);
            } else if (rowForDay.rest_day === true) {
                attemptsThatMentionedDay++;
                restVotes++;
            } else {
                attemptsThatMentionedDay++;
            }
        }

        const distinctTimeSignatures = new Set(timesVotes.map(t => t.join(",")));
        // "every attempt that mentioned this day" must ALL be times-votes (none rest-votes) for
        // allAgreeOnTimes, and vice versa for allAgreeOnRest — otherwise a mix of "2 said times,
        // 1 said rest day" could slip through as agreement just because the 2 times-votes matched
        // each other, ignoring that a third attempt disagreed about the day's nature entirely.
        const allAgreeOnTimes = timesVotes.length > 0 && timesVotes.length === attemptsThatMentionedDay && distinctTimeSignatures.size === 1;
        const allAgreeOnRest = restVotes > 0 && restVotes === attemptsThatMentionedDay;
        // Attempts that produced an impossible value for this day are excluded from the
        // participation total too — they didn't produce a usable reading, so they shouldn't
        // count against "did everyone weigh in". Still requires at least 2 valid attempts to
        // agree (not just 1) so a day isn't accepted off a single surviving attempt when the
        // other two were both unreadable — that's too little redundancy to trust unguessed.
        const effectiveTotal = attempts.length - implausibleCount;
        const fullyParticipated = !requireFullParticipation || attemptsThatMentionedDay === effectiveTotal;
        const sufficientRedundancy = !requireFullParticipation || attemptsThatMentionedDay >= 2;
        const unanimous = fullyParticipated && sufficientRedundancy && (allAgreeOnTimes || allAgreeOnRest);

        if (unanimous && allAgreeOnTimes) {
            entries.push({ day, month, times: timesVotes[0], guessed: false, rest_day: false, notes: null });
        } else if (unanimous && allAgreeOnRest) {
            entries.push({ day, month, times: null, guessed: false, rest_day: true, notes: null });
        } else if (attemptsThatMentionedDay > 0 || implausibleCount > 0) {
            // something was reported, but not unanimously — dropped rather than guessed
            const reasons: string[] = [];
            if (requireFullParticipation && attemptsThatMentionedDay < effectiveTotal) {
                reasons.push(`only ${attemptsThatMentionedDay}/${effectiveTotal} valid attempts reported anything for this day`);
            }
            if (requireFullParticipation && !sufficientRedundancy && attemptsThatMentionedDay > 0) {
                reasons.push(`only 1 valid attempt remained after discarding unreadable values, not enough redundancy to trust unguessed`);
            }
            if (distinctTimeSignatures.size > 1) {
                reasons.push(`conflicting time readings (${[...distinctTimeSignatures].join(" vs ")})`);
            }
            if (timesVotes.length > 0 && restVotes > 0) {
                reasons.push(`some attempts saw clock times, others saw a rest day`);
            }
            if (implausibleCount > 0) {
                reasons.push(`${implausibleCount} attempt(s) reported an impossible clock time (${implausibleValues.join(", ")}) and were excluded from voting`);
            }
            if (reasons.length === 0) continue; // e.g. lenient mode, single non-conflicting mention already accepted above
            warnings.push({
                source,
                reason: `day=${day} month=${month}: not unanimous across scan attempts (${reasons.join("; ")}) — dropped rather than guessed, please check the source PDF for this date directly`,
            });
        }
        // else: no attempt produced usable data for this day — left out entirely, surfaces later
        // via server.ts's coverage check.
    }

    return { entries, warnings };
}
