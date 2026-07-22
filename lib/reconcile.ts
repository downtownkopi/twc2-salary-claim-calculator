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
    // Some source pages (a real-world upload batch turned out to include many of these — see
    // lib/ocr.ts's PageDataModel) record only a total number of hours worked per day, with no
    // clock in/out times anywhere on the page. hoursWorked/otHours are the alternative to `times`
    // for that case — always null together with times being populated, never both at once (times
    // takes priority whenever clock times are genuinely present, per the scan prompt).
    hoursWorked: number | null;
    otHours: number | null;
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
    const hours = Math.floor(t / 100);
    // Real failure mode: a source timestamp with seconds (e.g. "19:50:07" from a phone app's
    // punch-log screen) getting mashed into one bare number instead of the colon just being
    // dropped — 195007 passes a minutes-only check (07 < 60) despite being nonsense. Hours must
    // be a real hour-of-day.
    return minutes < 60 && hours < 24;
}

// Same "unreadable value, not a competing opinion" reasoning as isPlausibleTime, applied to the
// hours_total data model: no one works 24+ hours in a single calendar day, so a value at or above
// that is a misread digit, not a genuine disagreement for reconciliation to weigh. otHours is
// legitimately 0 on a no-overtime day, so zero is only rejected for hoursWorked itself (a day with
// a genuine 0 hoursWorked reading should have come through as a rest day instead, not this field).
function isPlausibleHours(h: number, allowZero: boolean): boolean {
    return allowZero ? h >= 0 && h < 24 : h > 0 && h < 24;
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
    requireFullParticipation = true,
    // Only used to build the `date` field on warnings (so the UI/server can dedupe against a
    // later generic "no data for this day" warning about the same date) — reconciliation itself
    // never needs the year, since day/month alone is enough to group attempts.
    year?: number,
    // A table row's left-to-right value order is semantically meaningful (an overnight shift like
    // [2200, 600] must NOT be reordered — reversing it would silently claim a 6am-10pm shift
    // instead of the real 10pm-6am one), so by default two attempts reporting the same values in
    // different order genuinely disagree. A punch-log page (lib/ocr.ts's PageDataModel
    // "punch_log" — a phone app's chronological list of individual timestamped events, not a
    // table) has no such row order to preserve: each punch is independently timestamped by the
    // app itself, so the model reconstructing which came first from page-reading order is prone
    // to getting it backwards, and "same two values, different order" there is the SAME reading,
    // not a conflicting one. Pass false only for pages classified as punch-log.
    orderMatters = true
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
        // hoursWorked is always paired with whatever otHours the same attempt reported (or null),
        // kept together so "8h+2 OT" and "8h+0 OT" from different attempts are correctly treated
        // as disagreeing readings rather than silently averaged/merged.
        const hoursVotes: { hoursWorked: number; otHours: number | null }[] = [];
        let restVotes = 0;
        let attemptsThatMentionedDay = 0;
        let implausibleCount = 0;
        const implausibleValues: number[] = [];

        for (const attempt of attempts) {
            // A punch-log-style page (a phone app's chronological list of individual clock
            // in/out events, rather than a day-per-row table) can legitimately produce MULTIPLE
            // objects for the same calendar date within one attempt — one per punch. The prompt
            // asks the model to merge these itself, but this is a safety net for when it doesn't:
            // combine every matching object's times into one array, sorted chronologically
            // (ascending) since separate punch entries carry no other ordering signal, unlike a
            // single table row's left-to-right reading order (which IS preserved as-is, matters
            // for legitimate overnight-spanning shifts, and is never reordered here).
            const matches = attempt.filter(e => e.day === day && e.month === month);
            if (matches.length === 0) continue;
            const rowForDay: ParsedEntry =
                matches.length === 1
                    ? matches[0]
                    : {
                          day,
                          month,
                          times: matches.some(m => m.times && m.times.length > 0)
                              ? matches.flatMap(m => m.times ?? []).sort((a, b) => a - b)
                              : null,
                          hoursWorked: matches.find(m => m.hoursWorked !== null)?.hoursWorked ?? null,
                          otHours: matches.find(m => m.otHours !== null)?.otHours ?? null,
                          guessed: matches.some(m => m.guessed === true),
                          rest_day: matches.every(m => m.rest_day === true),
                          notes: matches.map(m => m.notes).filter(Boolean).join("; ") || null,
                      };

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
            } else if (rowForDay.hoursWorked !== null && rowForDay.hoursWorked !== undefined) {
                // hours_total data model (lib/ocr.ts's PageDataModel) — same "unreadable value,
                // not a real reading" exclusion as an implausible clock time above.
                const otOk = rowForDay.otHours === null || rowForDay.otHours === undefined || isPlausibleHours(rowForDay.otHours, true);
                if (!isPlausibleHours(rowForDay.hoursWorked, false) || !otOk) {
                    implausibleCount++;
                    implausibleValues.push(rowForDay.hoursWorked, ...(rowForDay.otHours ? [rowForDay.otHours] : []));
                    continue;
                }
                attemptsThatMentionedDay++;
                hoursVotes.push({ hoursWorked: rowForDay.hoursWorked, otHours: rowForDay.otHours ?? null });
            } else {
                attemptsThatMentionedDay++;
            }
        }

        const distinctTimeSignatures = new Set(
            timesVotes.map(t => (orderMatters ? t : [...t].sort((a, b) => a - b)).join(","))
        );
        const distinctHoursSignatures = new Set(hoursVotes.map(v => `${v.hoursWorked}|${v.otHours ?? ""}`));
        // "every attempt that mentioned this day" must ALL agree on the SAME data model (times-only,
        // rest-only, or hours-only) for any of these to count as agreement — otherwise a mix of
        // "2 said times, 1 said rest day" could slip through just because the 2 times-votes matched
        // each other, ignoring that a third attempt disagreed about the day's nature entirely.
        const allAgreeOnTimes = timesVotes.length > 0 && timesVotes.length === attemptsThatMentionedDay && distinctTimeSignatures.size === 1;
        const allAgreeOnRest = restVotes > 0 && restVotes === attemptsThatMentionedDay;
        const allAgreeOnHours = hoursVotes.length > 0 && hoursVotes.length === attemptsThatMentionedDay && distinctHoursSignatures.size === 1;
        // Attempts that produced an impossible value for this day are excluded from the
        // participation total too — they didn't produce a usable reading, so they shouldn't
        // count against "did everyone weigh in". Still requires at least 2 valid attempts to
        // agree (not just 1) so a day isn't accepted off a single surviving attempt when the
        // other two were both unreadable — that's too little redundancy to trust unguessed.
        const effectiveTotal = attempts.length - implausibleCount;
        const fullyParticipated = !requireFullParticipation || attemptsThatMentionedDay === effectiveTotal;
        const sufficientRedundancy = !requireFullParticipation || attemptsThatMentionedDay >= 2;
        const unanimous = fullyParticipated && sufficientRedundancy && (allAgreeOnTimes || allAgreeOnRest || allAgreeOnHours);

        if (unanimous && allAgreeOnTimes) {
            // When order doesn't matter, timesVotes[0] itself might happen to be in the "wrong"
            // (page-reading) order even though it agrees with the others post-sort — output the
            // canonical ascending order rather than whichever attempt happened to be first.
            const outputTimes = orderMatters ? timesVotes[0] : [...timesVotes[0]].sort((a, b) => a - b);
            entries.push({ day, month, times: outputTimes, hoursWorked: null, otHours: null, guessed: false, rest_day: false, notes: null });
        } else if (unanimous && allAgreeOnRest) {
            entries.push({ day, month, times: null, hoursWorked: null, otHours: null, guessed: false, rest_day: true, notes: null });
        } else if (unanimous && allAgreeOnHours) {
            entries.push({ day, month, times: null, hoursWorked: hoursVotes[0].hoursWorked, otHours: hoursVotes[0].otHours, guessed: false, rest_day: false, notes: null });
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
            if (distinctHoursSignatures.size > 1) {
                reasons.push(`conflicting hours-worked readings (${[...distinctHoursSignatures].join(" vs ")})`);
            }
            if ((timesVotes.length > 0 ? 1 : 0) + (restVotes > 0 ? 1 : 0) + (hoursVotes.length > 0 ? 1 : 0) > 1) {
                reasons.push(`attempts disagreed on the data model itself (some saw clock times, some a rest day, some only total hours)`);
            }
            if (implausibleCount > 0) {
                reasons.push(`${implausibleCount} attempt(s) reported an impossible clock time or hours value (${implausibleValues.join(", ")}) and were excluded from voting`);
            }
            if (reasons.length === 0) continue; // e.g. lenient mode, single non-conflicting mention already accepted above
            warnings.push({
                source,
                reason: `day=${day} month=${month}: not unanimous across scan attempts (${reasons.join("; ")}) — dropped rather than guessed, please check the source PDF for this date directly`,
                category: "dropped_disagreement",
                date: year ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : undefined,
            });
        }
        // else: no attempt produced usable data for this day — left out entirely, surfaces later
        // via server.ts's coverage check.
    }

    return { entries, warnings };
}
