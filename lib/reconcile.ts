import type { FillWarning } from "./xlsx";
import { matchWorker, type RosterCandidate, type WorkerMatchConfidence } from "./workerMatch";

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
    // True only when the page explicitly states no meal break was taken this date (see
    // server.ts's buildPrompt) — distinct from simply not knowing, which is false/null and lets
    // the caseworker's declared standard break apply downstream as usual (lib/xlsx.ts's
    // buildReviewRows). Only meaningful alongside `times`; null/ignored on a rest day or
    // hours-only row where there's no break to speak of either way.
    noBreak: boolean | null;
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
/**
 * Checks whether a bare HHMM integer can represent a real clock time (minutes 00-59, hours 0-23,
 * or the documented `2400` midnight sentinel) — used to exclude unreadable values from voting
 * rather than letting them "disagree" with a genuinely correct reading.
 *
 * @param t - The clock time as a bare HHMM integer, e.g. `800` for 8:00am.
 * @returns Whether `t` could represent a real clock time.
 */
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
/**
 * Checks whether an hours-worked/OT-hours value is plausible for a single calendar day (under 24,
 * and — unless `allowZero` — above 0).
 *
 * @param h - The hours value to check.
 * @param allowZero - `true` for otHours (legitimately 0 on a no-overtime day); `false` for
 * hoursWorked (a genuine 0 should have come through as a rest day instead).
 * @returns Whether `h` is a plausible single-day hours value.
 */
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
/**
 * Reconciles multiple independent scan attempts of the same page (or band) into one agreed-upon
 * entry per day — strict unanimity by default, with a majority fallback for clock times, and an
 * explicit "dropped, not guessed" warning for anything that couldn't be resolved either way.
 *
 * @param attempts - One `ParsedEntry[]` per independent scan attempt of the same source material.
 * @param source - Page/band identifier, used to tag any warnings produced.
 * @param requireFullParticipation - `true` (default) requires every attempt to mention a day and
 * all of them to agree — for reconciling attempts that all saw the exact same image. `false`
 * allows agreement from a subset of attempts — for merging already-reconciled results across bands
 * that only partially overlap.
 * @param year - Used only to build the `date` field on warnings (for downstream deduping); never
 * needed for the reconciliation logic itself.
 * @param orderMatters - `true` (default) treats `[2200, 600]` and `[600, 2200]` as different (real)
 * readings, since a table row's left-to-right order is meaningful (an overnight shift must not be
 * reordered). Pass `false` only for punch-log pages, where each punch is independently timestamped
 * and reading order carries no real signal.
 * @returns The reconciled entries (one per agreed-upon day) and any warnings for days that
 * couldn't be resolved.
 */
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
        // Notes from attempts that voted rest_day — carries e.g. "MC"/"AL"/"-" (the literal
        // leave-type mark buildPrompt asks the model to transcribe) through to the final merged
        // entry, which the allAgreeOnRest branch below used to discard entirely.
        const restNotes: (string | null)[] = [];
        // Parallel to timesVotes (pushed together below, same index) — whether that specific
        // attempt's reading of this day said no break was taken. Requiring EVERY attempt that
        // agreed on the times to also agree noBreak is true (see the unanimous branch below) means
        // one attempt missing/not noticing the "no lunch" text just falls back to false (the safe
        // default), rather than a single attempt's noBreak claim overriding the others.
        const noBreakVotes: boolean[] = [];
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
                          noBreak: matches.every(m => m.noBreak === true),
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
                noBreakVotes.push(rowForDay.noBreak === true);
            } else if (rowForDay.rest_day === true) {
                attemptsThatMentionedDay++;
                restVotes++;
                restNotes.push(rowForDay.notes);
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

        // 2-of-3 style majority fallback for `times` specifically, used only when strict unanimity
        // (below) fails. A single dissenting attempt among an otherwise-agreeing group is common
        // with ambiguous handwriting (e.g. a 6 vs 9, or a 7pm vs 8pm clock-out) — dropping the whole
        // day in that case throws away 2 independent, agreeing reads over one outlier. Requires a
        // STRICT majority (more than half of the times votes), not just a plurality, so a 3-way
        // split (1-1-1) still can't "win" by having merely the largest of three equal groups — and
        // still requires every attempt that mentioned the day to have voted on times specifically
        // (no mixing with rest/hours votes), same as the unanimous case. Always ships flagged
        // (guessed: true) rather than as a clean confirmed read — see buildReviewRows/warnings below.
        let majorityTimes: { times: number[]; agreeCount: number; totalCount: number; noBreak: boolean } | null = null;
        if (timesVotes.length > 0 && timesVotes.length === attemptsThatMentionedDay && distinctTimeSignatures.size > 1) {
            const groups = new Map<string, { times: number[]; count: number; noBreakVotesInGroup: boolean[] }>();
            timesVotes.forEach((t, idx) => {
                const sig = (orderMatters ? t : [...t].sort((a, b) => a - b)).join(",");
                const group = groups.get(sig) ?? { times: t, count: 0, noBreakVotesInGroup: [] };
                group.count++;
                group.noBreakVotesInGroup.push(noBreakVotes[idx]);
                groups.set(sig, group);
            });
            let best: { times: number[]; count: number; noBreakVotesInGroup: boolean[] } | null = null;
            for (const g of groups.values()) {
                if (!best || g.count > best.count) best = g;
            }
            if (best && best.count > timesVotes.length / 2) {
                majorityTimes = {
                    times: best.times,
                    agreeCount: best.count,
                    totalCount: timesVotes.length,
                    noBreak: best.noBreakVotesInGroup.every(v => v === true),
                };
            }
        }
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
            // Only true if EVERY attempt that agreed on the times also independently noticed the
            // "no break" text — one attempt not mentioning it falls back to false (the caseworker's
            // declared standard break applies downstream) rather than a single attempt's claim
            // zeroing out the break for everyone.
            const outputNoBreak = noBreakVotes.length > 0 && noBreakVotes.every(v => v === true);
            entries.push({ day, month, times: outputTimes, hoursWorked: null, otHours: null, noBreak: outputNoBreak, guessed: false, rest_day: false, notes: null });
        } else if (unanimous && allAgreeOnRest) {
            // Attempts don't have to agree on the exact wording (one might transcribe "MC", another
            // "M/C") to still unanimously agree it's a leave-type rest day — take whichever non-null
            // note the first attempt that had one wrote, rather than requiring textual unanimity.
            entries.push({ day, month, times: null, hoursWorked: null, otHours: null, noBreak: null, guessed: false, rest_day: true, notes: restNotes.find(Boolean) ?? null });
        } else if (unanimous && allAgreeOnHours) {
            entries.push({ day, month, times: null, hoursWorked: hoursVotes[0].hoursWorked, otHours: hoursVotes[0].otHours, noBreak: null, guessed: false, rest_day: false, notes: null });
        } else if (fullyParticipated && sufficientRedundancy && majorityTimes) {
            entries.push({
                day,
                month,
                times: majorityTimes.times,
                hoursWorked: null,
                otHours: null,
                noBreak: majorityTimes.noBreak,
                guessed: true,
                rest_day: false,
                notes: `majority reading (${majorityTimes.agreeCount}/${majorityTimes.totalCount} attempts agreed on ${majorityTimes.times.join(",")}) — not unanimous, please verify against the source PDF`,
            });
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

// A worker-roster page (lib/ocr/pageScan.ts's PageDataModel "worker_roster") is the inverse shape
// of a normal timesheet page: ONE shared date, MANY named workers as rows. reconcileAttempts above
// is keyed by day/month across a single worker's own rows — that key doesn't apply here, since
// every row on a roster page shares the same date and differs by WHICH WORKER it belongs to. This
// is a separate, smaller reconciliation: per attempt, find the target worker's row (lib/workerMatch.ts),
// then reconcile just that row's own fields across the attempts that found it confidently.
export type RosterRow = {
    workerName: string | null;
    workerIc: string | null;
    actualTimeIn: number | null; // bare HHMM, same convention as ParsedEntry.times
    actualTimeOut: number | null;
    mealBreakHours: number | null;
    struckThrough: boolean; // a row crossed out on the source document — excluded from matching entirely
    notes: string | null;
};

export type RosterPageAttempt = {
    day: number | null;
    month: number | null;
    workers: RosterRow[];
};

export type RosterReconciledEntry = {
    day: number;
    month: number;
    actualTimeIn: number | null;
    actualTimeOut: number | null;
    mealBreakHours: number | null;
    guessed: boolean;
    matchConfidence: WorkerMatchConfidence;
    matchedRowIndex: number; // index into the returned allRows — which table row was auto-selected
    notes: string | null;
};

/**
 * Reconciles multiple independent scan attempts of the same worker-roster page into one entry for
 * the target worker — first resolving the page's shared date by majority vote, then finding the
 * target worker's row within each attempt (via {@link matchWorker}), then reconciling that row's
 * actual time in/out and meal break across the attempts that found it with high confidence.
 *
 * @param attempts - One parsed roster-page reading per independent scan attempt.
 * @param source - Page identifier, used to tag any warnings produced.
 * @param targetName - The IPA's extracted worker name to match against.
 * @param targetFin - The IPA's extracted (possibly masked) FIN, or `null`.
 * @param year - Used only to build a `date` field on warnings, once the page's day/month are known.
 * @returns The page's resolved shared date (`null` only if no attempt could determine it at all —
 * kept separate from `entry` so a caller can still build a full date for a manually-picked row even
 * when no worker was confidently auto-matched), the reconciled entry for the target worker (`null`
 * if the date couldn't be resolved, or no attempt confidently matched the worker), every
 * non-struck-through row seen across attempts (deduped by worker name, for a manual "pick a
 * different row" fallback), and any warnings produced.
 */
export function reconcileRosterAttempts(
    attempts: RosterPageAttempt[],
    source: string,
    targetName: string | null,
    targetFin: string | null,
    year?: number
): { date: { day: number; month: number } | null; entry: RosterReconciledEntry | null; allRows: RosterRow[]; warnings: FillWarning[] } {
    const warnings: FillWarning[] = [];

    // ---- resolve the page's shared date via majority vote across attempts ----
    const dateVotes = new Map<string, number>();
    for (const a of attempts) {
        if (a.day === null || a.month === null) continue;
        const key = `${a.month}-${a.day}`;
        dateVotes.set(key, (dateVotes.get(key) ?? 0) + 1);
    }
    let bestDateKey: string | null = null;
    let bestDateCount = 0;
    for (const [key, count] of dateVotes) {
        if (count > bestDateCount) {
            bestDateKey = key;
            bestDateCount = count;
        }
    }
    if (bestDateKey === null) {
        warnings.push({
            source,
            reason: "worker-roster page: no scan attempt could determine this page's shared date (no legible date header) — page skipped, please check the source PDF directly",
            category: "system",
        });
        return { date: null, entry: null, allRows: [], warnings };
    }
    const [month, day] = bestDateKey.split("-").map(Number);
    const dateStr = year ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : undefined;

    // ---- per attempt: find that attempt's best candidate row for the target worker ----
    const votes: { row: RosterRow; confidence: WorkerMatchConfidence }[] = [];
    const seenNames = new Set<string>();
    const allRows: RosterRow[] = [];
    for (const a of attempts) {
        const usableRows = a.workers.filter(w => !w.struckThrough);
        for (const row of usableRows) {
            const key = (row.workerName ?? "").trim().toLowerCase();
            if (key && !seenNames.has(key)) {
                seenNames.add(key);
                allRows.push(row);
            }
        }
        const candidates: RosterCandidate[] = usableRows.map(w => ({ workerName: w.workerName, workerIc: w.workerIc }));
        const match = matchWorker(candidates, targetName, targetFin);
        if (match && match.confidence === "high") {
            votes.push({ row: usableRows[match.index], confidence: match.confidence });
        }
    }
    // allRows is deduped by normalized name (built above) — this finds a matched vote's row by that
    // same key, so the caller (public/index.html) can highlight which table row was auto-selected.
    function indexInAllRows(row: RosterRow): number {
        const key = (row.workerName ?? "").trim().toLowerCase();
        return allRows.findIndex(r => (r.workerName ?? "").trim().toLowerCase() === key);
    }

    if (votes.length === 0) {
        warnings.push({
            source,
            reason: "worker-roster page: no scan attempt confidently matched the target worker by name/IC — please pick the correct row manually from this page",
            category: "flagged_review",
            date: dateStr,
        });
        return { date: { day, month }, entry: null, allRows, warnings };
    }

    // ---- reconcile the voting attempts' actual time in/out (unanimity, then majority fallback) ----
    const timeSignatures = new Map<string, number>();
    for (const v of votes) {
        timeSignatures.set(`${v.row.actualTimeIn}|${v.row.actualTimeOut}`, (timeSignatures.get(`${v.row.actualTimeIn}|${v.row.actualTimeOut}`) ?? 0) + 1);
    }
    let bestTimeSig: string | null = null;
    let bestTimeCount = 0;
    for (const [sig, count] of timeSignatures) {
        if (count > bestTimeCount) {
            bestTimeSig = sig;
            bestTimeCount = count;
        }
    }
    const unanimous = bestTimeSig !== null && bestTimeCount === votes.length;
    const majority = bestTimeSig !== null && bestTimeCount > votes.length / 2;

    if (!unanimous && !majority) {
        warnings.push({
            source,
            reason: "worker-roster page: target worker was identified, but scan attempts disagreed on actual time in/out with no majority — dropped rather than guessed, please check the source page directly",
            category: "dropped_disagreement",
            date: dateStr,
        });
        return {
            date: { day, month },
            entry: {
                day,
                month,
                actualTimeIn: null,
                actualTimeOut: null,
                mealBreakHours: null,
                guessed: true,
                matchConfidence: votes[0].confidence,
                matchedRowIndex: indexInAllRows(votes[0].row),
                notes: "target worker identified, but actual time in/out could not be reconciled across scan attempts — please verify against the source page",
            },
            allRows,
            warnings,
        };
    }

    const winningVotes = votes.filter(v => `${v.row.actualTimeIn}|${v.row.actualTimeOut}` === bestTimeSig);
    const [timeInStr, timeOutStr] = bestTimeSig!.split("|");
    const actualTimeIn = timeInStr === "null" ? null : Number(timeInStr);
    const actualTimeOut = timeOutStr === "null" ? null : Number(timeOutStr);

    // Meal break: majority among the winning (time-agreeing) votes only — no separate redundancy
    // requirement, since it's a much lower-stakes field than the actual clock times themselves.
    const breakVotes = new Map<string, number>();
    for (const v of winningVotes) {
        breakVotes.set(String(v.row.mealBreakHours), (breakVotes.get(String(v.row.mealBreakHours)) ?? 0) + 1);
    }
    let bestBreakKey: string | null = null;
    let bestBreakCount = 0;
    for (const [key, count] of breakVotes) {
        if (count > bestBreakCount) {
            bestBreakKey = key;
            bestBreakCount = count;
        }
    }
    const mealBreakHours = bestBreakKey && bestBreakKey !== "null" ? Number(bestBreakKey) : null;

    // Same "at least 2 agreeing attempts" trust bar as reconcileAttempts's sufficientRedundancy —
    // a single confident-match attempt (however unanimous with itself) still needs a human glance.
    const guessed = !unanimous || winningVotes.length < 2;
    const notesParts: string[] = [];
    if (!unanimous) notesParts.push(`majority reading (${bestTimeCount}/${votes.length} confident attempts agreed)`);
    if (winningVotes.length < 2) notesParts.push("only one scan attempt confidently matched this worker — please verify");
    for (const v of winningVotes) if (v.row.notes && !notesParts.includes(v.row.notes)) notesParts.push(v.row.notes);

    return {
        date: { day, month },
        entry: {
            day,
            month,
            actualTimeIn,
            actualTimeOut,
            mealBreakHours,
            guessed,
            matchConfidence: winningVotes[0].confidence,
            matchedRowIndex: indexInAllRows(winningVotes[0].row),
            notes: notesParts.length > 0 ? notesParts.join("; ") : null,
        },
        allRows,
        warnings,
    };
}
