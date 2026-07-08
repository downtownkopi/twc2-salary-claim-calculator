import type { TimeEntry, FillWarning } from "./xlsx";

export type RestDay = { year: number; month: number; day: number }; // month is 1-12

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

// After all pages of all PDFs have been scanned independently (no cross-page memory during OCR),
// this looks for calendar days that NO page produced any entry for at all — true gaps, as opposed
// to confirmed rest days or illegible-but-seen rows. For each gap, it checks whether every other
// occurrence of that weekday in the month agrees on one clock-in/out pattern; if so, it infers the
// gap day from that pattern (marked guessed). Ambiguous or unsupported weekdays are left as
// warnings instead of guessed, since a wrong guess is worse than a visible gap on a wage claim.
export function inferMissingDays(
    entries: TimeEntry[],
    restDays: RestDay[],
    year: number
): { inferred: TimeEntry[]; warnings: FillWarning[] } {
    const inferred: TimeEntry[] = [];
    const warnings: FillWarning[] = [];

    const monthsPresent = new Set<number>([
        ...entries.filter(e => e.date.getFullYear() === year).map(e => e.date.getMonth()),
        ...restDays.filter(r => r.year === year).map(r => r.month - 1),
    ]);

    for (const month of monthsPresent) {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const coveredDays = new Set(
            entries.filter(e => e.date.getFullYear() === year && e.date.getMonth() === month).map(e => e.date.getDate())
        );
        const restDaySet = new Set(
            restDays.filter(r => r.year === year && r.month - 1 === month).map(r => r.day)
        );

        // pattern source: only real (non-guessed) reads, so guesses don't compound on guesses
        const byWeekday = new Map<number, { clockIn: number; clockOut: number }[]>();
        const restWeekdays = new Set<number>();
        for (const e of entries) {
            if (e.date.getFullYear() !== year || e.date.getMonth() !== month || e.guessed) continue;
            const wd = e.date.getDay();
            const list = byWeekday.get(wd) ?? [];
            list.push({ clockIn: e.clockIn, clockOut: e.clockOut });
            byWeekday.set(wd, list);
        }
        for (const day of restDaySet) {
            restWeekdays.add(new Date(year, month, day).getDay());
        }

        for (let day = 1; day <= daysInMonth; day++) {
            if (coveredDays.has(day) || restDaySet.has(day)) continue;

            const date = new Date(year, month, day);
            const weekday = date.getDay();
            const weekdayName = WEEKDAY_NAMES[weekday];
            const monthLabel = `${MONTH_NAMES[month]} ${year}`;
            const candidates = byWeekday.get(weekday) ?? [];

            if (restWeekdays.has(weekday) && candidates.length > 0) {
                warnings.push({
                    source: "cross-page gap-fill",
                    reason: `${date.toDateString()} has no entry, and ${weekdayName}s in ${monthLabel} are inconsistently rest days vs workdays elsewhere — could not infer, left blank`,
                });
                continue;
            }

            const distinctPatterns = new Map<string, { clockIn: number; clockOut: number }>();
            for (const c of candidates) distinctPatterns.set(`${c.clockIn}-${c.clockOut}`, c);

            if (distinctPatterns.size === 0) {
                warnings.push({
                    source: "cross-page gap-fill",
                    reason: `${date.toDateString()} has no entry and no other ${weekdayName} in ${monthLabel} to infer a pattern from — left blank, please review`,
                });
                continue;
            }

            if (distinctPatterns.size > 1) {
                const options = [...distinctPatterns.keys()].join(", ");
                warnings.push({
                    source: "cross-page gap-fill",
                    reason: `${date.toDateString()} has no entry, and ${weekdayName}s in ${monthLabel} show conflicting patterns (${options}) — could not confidently infer, left blank`,
                });
                continue;
            }

            const [pattern] = distinctPatterns.values();
            inferred.push({
                date,
                clockIn: pattern.clockIn,
                clockOut: pattern.clockOut,
                source: `inferred from ${candidates.length} other ${weekdayName}(s) in ${monthLabel} (cross-page gap-fill)`,
                guessed: true,
            });
        }
    }

    return { inferred, warnings };
}
