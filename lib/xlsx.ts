export type TimeEntry = {
    date: Date; // year already resolved by caller (OCR'd year is unreliable, see server.ts)
    clockIn: number; // HHMM 24hr, e.g. 800 = 8:00am, 2200 = 10:00pm
    clockOut: number;
    source: string; // e.g. "timesheet1.pdf p2"
    guessed: boolean; // true if the model inferred this rather than reading it directly
    // True only when the source page explicitly stated no meal break was taken this date (e.g.
    // "no lunch"/"no break" written on the row) — see server.ts's buildPrompt. Distinct from simply
    // not knowing (false), which lets buildReviewRows fall back to the caseworker's declared
    // standard break as usual.
    noBreak: boolean;
    // The day's own printed cumulative break duration, in hours, if the source page states one
    // directly (e.g. a third column alongside start/end time that's a break total, not a third
    // clock time — some timesheets print exactly this shape). null when nothing of the kind is
    // printed, which lets buildReviewRows fall back to noBreak/the caseworker's declared standard
    // break as usual. Distinct from a multi-shift day's gap-as-break (computeSpanAndBreak below) —
    // that's an OBSERVED gap between two real shifts; this is a figure the document states outright.
    breakHours: number | null;
    // Where on the page image this entry was read from, as fractions (0-1) of the image's
    // width/height — lets the review UI draw a highlight box over the source image on hover. null
    // if the scan didn't return a usable box (or this entry didn't come from a bbox-aware path,
    // e.g. the worker-roster branch).
    bbox: { x: number; y: number; w: number; h: number } | null;
};

// Every warning is tagged with a category so the UI can group a long, otherwise-flat list into
// something scannable, and a date (YYYY-MM-DD) when it's about one specific day, so a generic
// catch-all warning about that same day (e.g. the coverage check) can be suppressed instead of
// repeating what a more specific warning already said.
export type WarningCategory =
    | "dropped_disagreement" // reconciliation/verification rejected a day due to conflicting reads
    | "missing_data" // coverage check: nothing usable found anywhere for this day
    | "flagged_review" // written to the sheet, but flagged (guess, implausible-but-kept, multi-shift collapse)
    | "skipped_invalid" // skipped due to structurally invalid data (bad date, odd time count, etc.)
    | "scan_quality" // page/attempt-level issues (truncation, failed calls, verification pass itself failing)
    | "system" // file-level errors (couldn't read a PDF, etc.)
    | "outside_claim_period"; // read off the source page fine, but the date falls outside the declared claim period — excluded from the claim

export type FillWarning = {
    source: string;
    reason: string;
    category: WarningCategory;
    date?: string; // YYYY-MM-DD, when this warning concerns one specific date
};

/**
 * Formats a `Date` as `YYYY-MM-DD` in local time (never `.toISOString()`, which would shift the
 * calendar date in timezones ahead of UTC).
 *
 * @param d - The date to format.
 * @returns The formatted string.
 */
function toLocalDateString(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// A day explicitly marked as a rest day/off/holiday on the actual page — genuine observed data
// (the model read and reported it directly), not something inferred or fabricated.
// notes carries through the literal leave-type text (e.g. "MC", "-") server.ts's buildPrompt asks
// the model to transcribe for a non-plain-rest-day mark, so a caseworker sees WHY a day has no
// hours instead of a bare unlabeled rest day. null for an actual plain rest day.
export type RestDay = {
    year: number;
    month: number;
    day: number;
    source: string;
    notes: string | null;
    // Same best-effort hover-highlight box as TimeEntry.bbox above.
    bbox: { x: number; y: number; w: number; h: number } | null;
}; // month is 1-12

// One row per calendar date, already collapsed to a single start/end/break — the shape the
// human-review step (public/index.html) edits before generating the final spreadsheet. Multi-shift
// days are pre-collapsed into this same shape (span + observed gap as the break) so the review UI
// only ever needs to show three plain fields per date, matching how a person would actually
// describe a single day's work.
export type ReviewRow = {
    date: string; // YYYY-MM-DD
    clockIn: number | null; // HHMM 24hr, null only when restDay
    clockOut: number | null;
    breakHours: number | null; // null only when restDay
    restDay: boolean;
    guessed: boolean; // true if any underlying shift was a model guess or an implausible reading — surfaced as a "please double-check" hint, not enforced
    notes: string | null;
    source: string;
    // Same best-effort hover-highlight box as TimeEntry.bbox — for a multi-shift day, the first
    // (chronologically earliest) shift's box, since the whole span collapses into one row anyway.
    bbox: { x: number; y: number; w: number; h: number } | null;
};

export const MONTH_ABBR = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Converts a bare HHMM clock time to minutes since midnight.
 *
 * @param hhmm - The clock time, e.g. `800` for 8:00am, `2200` for 10:00pm.
 * @returns Minutes since midnight.
 */
function toMinutes(hhmm: number): number {
    return Math.trunc(hhmm / 100) * 60 + (hhmm % 100);
}

/**
 * Computes a single shift's duration in hours, handling an overnight wrap (clock-out earlier than
 * clock-in means the shift crossed midnight).
 *
 * @param clockIn - Shift start, bare HHMM.
 * @param clockOut - Shift end, bare HHMM.
 * @returns The shift's duration in hours.
 */
function shiftHours(clockIn: number, clockOut: number): number {
    let minutes = toMinutes(clockOut) - toMinutes(clockIn);
    if (minutes < 0) minutes += 24 * 60;
    return minutes / 60;
}

type Shift = { clockIn: number; clockOut: number; source: string; guessed: boolean; implausible?: boolean; noBreak: boolean; breakHours: number | null; bbox: ReviewRow["bbox"] };

// A day with 2+ distinct shifts (e.g. a morning block and an evening block) collapses to one
// row: full span = first clock-in to last clock-out, and the gap(s) between shifts become the
// meal break (summed if there are 3+ shifts, i.e. 2+ gaps). This lets the day still go through
// N/O like a normal single-shift day, just with the template's default meal-break (column G)
// overridden by the actual observed gap instead of assumed.
/**
 * Collapses a day's multiple shifts into one overall span (first clock-in to last clock-out) plus
 * the total break time (the gap(s) between consecutive shifts).
 *
 * @param sortedShifts - The day's shifts, sorted chronologically by clock-in.
 * @returns The overall `start`/`end` clock times, the full `spanHours`, and the total `breakHours`.
 */
function computeSpanAndBreak(sortedShifts: Shift[]): { start: number; end: number; spanHours: number; breakHours: number } {
    const start = sortedShifts[0].clockIn;
    const end = sortedShifts[sortedShifts.length - 1].clockOut;
    const spanHours = shiftHours(start, end);

    let breakMinutes = 0;
    for (let i = 1; i < sortedShifts.length; i++) {
        let gap = toMinutes(sortedShifts[i].clockIn) - toMinutes(sortedShifts[i - 1].clockOut);
        if (gap < 0) gap += 24 * 60; // gap crosses midnight
        breakMinutes += gap;
    }
    return { start, end, spanHours, breakHours: breakMinutes / 60 };
}

// Fallback "Meal Time hrs" (column G) default when the caller doesn't declare a standard — kept
// so buildReviewRows still has a sane value with no arguments (existing callers/tests).
const FALLBACK_BREAK_HOURS = 1;

// Groups raw scanned TimeEntry rows into ONE ReviewRow per calendar date — collapsing 2+ shifts
// (e.g. a morning block and an evening block) into a single span + observed gap-as-break, exactly
// like the spreadsheet write step used to do internally. Pulled out on its own (rather than fused
// into the write step) so the result can be shown to a human for editing BEFORE anything is
// written to the spreadsheet — the whole point of the review step this feeds.
//
// Deliberately more lenient than the old direct-to-spreadsheet path: an implausible reading (0h,
// 24h+, a bad multi-shift span) still produces a best-effort row rather than being silently
// dropped, since a human reviewing the row can fix or discard it themselves — dropping it here
// would hide the very thing the review step exists to catch.
//
// standardBreakHours is the caseworker's declared standard (public/index.html's break radio
// group), used as the assumed break for a single, unremarkable shift ONLY when nothing about the
// break was actually read off the page for that day (the common case — a single clock-in/clock-out
// pair with no separate break figure printed anywhere near it) — adopting the declared standard
// directly is more accurate than a hardcoded guess there, and means it won't spuriously disagree
// with itself later (public/index.html's checkBreakMismatch compares every row's breakHours against
// this same declared value). Two cases override that default with something actually observed,
// same priority both times — a real figure from the page beats an assumption either way: a day's
// own printed break-duration column (TimeEntry.breakHours — some timesheets print start/end time
// plus a separate cumulative break total rather than a second shift), and a multi-shift day's
// observed gap between shifts (computeSpanAndBreak below).
/**
 * Groups raw scanned `TimeEntry` rows into one `ReviewRow` per calendar date, collapsing 2+ shifts
 * into a single span with the observed gap as the break, ready for human review before anything is
 * written to the spreadsheet.
 *
 * @param entries - The raw scanned clock-in/clock-out entries.
 * @param restDays - The raw scanned rest days.
 * @param standardBreakHours - The caseworker's declared standard break, used as the assumed break
 * for a single (non-multi-shift) day where nothing about the break was actually observed.
 * @returns One `ReviewRow` per calendar date, sorted by date.
 */
export function buildReviewRows(entries: TimeEntry[], restDays: RestDay[], standardBreakHours: number = FALLBACK_BREAK_HOURS): ReviewRow[] {
    type Cell = { date: Date; shifts: Shift[]; source: string };
    const byDate = new Map<string, Cell>();

    for (const entry of entries) {
        const key = toLocalDateString(entry.date);
        const cell = byDate.get(key) ?? { date: entry.date, shifts: [], source: entry.source };
        const isDuplicate = cell.shifts.some(s => s.clockIn === entry.clockIn && s.clockOut === entry.clockOut);
        if (!isDuplicate) {
            cell.shifts.push({ clockIn: entry.clockIn, clockOut: entry.clockOut, source: entry.source, guessed: entry.guessed, noBreak: entry.noBreak, breakHours: entry.breakHours, bbox: entry.bbox });
        }
        byDate.set(key, cell);
    }

    const rows: ReviewRow[] = [];
    for (const { date, shifts } of byDate.values()) {
        const anyGuessed = shifts.some(s => s.guessed);
        const sourceList = [...new Set(shifts.map(s => s.source))].join(", ");

        if (shifts.length === 1) {
            const hours = shiftHours(shifts[0].clockIn, shifts[0].clockOut);
            const implausible = hours <= 0 || hours >= 24;
            // An explicit "no break"/"no lunch" reading, or a printed break-duration figure,
            // overrides the assumed standard break — both are something actually observed on the
            // page, not an absence of information (see server.ts's buildPrompt and
            // TimeEntry.noBreak/breakHours above), so either is exactly as trustworthy as the
            // multi-shift branch's observed gap below. A printed breakHours figure wins over a bare
            // "no break" note if somehow both were set (shouldn't happen in practice — a row either
            // states a break duration or explicitly has none). An implausible shift still wins over
            // either (that note already asks for a full re-check of the row anyway).
            const noBreak = shifts[0].noBreak && !implausible;
            const printedBreakHours = shifts[0].breakHours;
            rows.push({
                date: toLocalDateString(date),
                clockIn: shifts[0].clockIn,
                clockOut: shifts[0].clockOut,
                breakHours: !implausible && printedBreakHours !== null ? printedBreakHours : noBreak ? 0 : standardBreakHours,
                restDay: false,
                guessed: anyGuessed || implausible,
                notes: implausible
                    ? `implausible shift duration (${hours}h) as originally scanned — please verify`
                    : noBreak
                        ? "no break/lunch indicated on source — break set to 0h, please verify"
                        : null,
                source: sourceList,
                bbox: shifts[0].bbox,
            });
        } else {
            const sorted = [...shifts].sort((a, b) => toMinutes(a.clockIn) - toMinutes(b.clockIn));
            const { start, end, spanHours, breakHours } = computeSpanAndBreak(sorted);
            const implausible = spanHours >= 24 || breakHours < 0 || breakHours >= spanHours;
            rows.push({
                date: toLocalDateString(date),
                clockIn: start,
                clockOut: end,
                breakHours: implausible ? standardBreakHours : Math.round(breakHours * 100) / 100,
                restDay: false,
                guessed: true, // a multi-shift collapse always needs a human glance, even when internally consistent
                notes: `${shifts.length} shifts originally scanned (${sorted.map(s => `${s.clockIn}-${s.clockOut}`).join(", ")}) collapsed into one span — please verify`,
                source: sourceList,
                // The earliest shift's box — the whole span collapses into one row anyway, so this
                // just points the reviewer at roughly the right area rather than a precise span.
                bbox: sorted[0].bbox,
            });
        }
    }

    for (const r of restDays) {
        rows.push({
            date: `${r.year}-${String(r.month).padStart(2, "0")}-${String(r.day).padStart(2, "0")}`,
            clockIn: null,
            clockOut: null,
            breakHours: null,
            restDay: true,
            guessed: false,
            notes: r.notes,
            source: r.source,
            bbox: r.bbox,
        });
    }

    return rows.sort((a, b) => a.date.localeCompare(b.date));
}

