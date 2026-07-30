import ExcelJS from "exceljs";
import JSZip from "jszip";

export type TimeEntry = {
    date: Date; // year already resolved by caller (OCR'd year is unreliable, see server.ts)
    clockIn: number; // HHMM 24hr, e.g. 800 = 8:00am, 2200 = 10:00pm
    clockOut: number;
    source: string; // e.g. "timesheet1.pdf p2"
    guessed: boolean; // true if the model inferred this rather than reading it directly
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
    | "system"; // file-level errors (couldn't read a PDF, etc.)

export type FillWarning = {
    source: string;
    reason: string;
    category: WarningCategory;
    date?: string; // YYYY-MM-DD, when this warning concerns one specific date
};

function toLocalDateString(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// A day explicitly marked as a rest day/off/holiday on the actual page — genuine observed data
// (the model read and reported it directly), not something inferred or fabricated.
export type RestDay = { year: number; month: number; day: number; source: string }; // month is 1-12

// One row per calendar date, already collapsed to a single start/end/lunch-break — the shape the
// human-review step (public/index.html) edits before generating the final spreadsheet. Multi-shift
// days are pre-collapsed into this same shape (span + observed gap as the break) so the review UI
// only ever needs to show three plain fields per date, matching how a person would actually
// describe a single day's work.
export type ReviewRow = {
    date: string; // YYYY-MM-DD
    clockIn: number | null; // HHMM 24hr, null only when restDay
    clockOut: number | null;
    lunchBreakHours: number | null; // null only when restDay
    restDay: boolean;
    guessed: boolean; // true if any underlying shift was a model guess or an implausible reading — surfaced as a "please double-check" hint, not enforced
    notes: string | null;
    source: string;
};

export const MONTH_ABBR = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Matches the template's own data-row font (verified on N/O/M cells). Applied explicitly to
// every cell we write, since ExcelJS doesn't resolve column/row-inherited formatting the way
// Excel itself does — a cell we touch that never had its own per-cell style (e.g. the new
// Remarks column) would otherwise fall back to a generic default instead of matching the sheet.
const DATA_FONT: Partial<ExcelJS.Font> = { name: "Calibri", size: 12 };

function sheetNameFor(date: Date): string {
    return `2-${MONTH_ABBR[date.getMonth()]} ${date.getFullYear()}`;
}

function colLettersToNum(letters: string): number {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
}

function colNumToLetters(num: number): string {
    let letters = "";
    while (num > 0) {
        const rem = (num - 1) % 26;
        letters = String.fromCharCode(65 + rem) + letters;
        num = Math.floor((num - 1) / 26);
    }
    return letters;
}

// exceljs has a real bug (independent of anything we write) where the <dimension> element it
// serializes for some worksheets in this template undershoots the actual used range — e.g.
// declaring "Q1:V44" when the sheet's real data spans "A1:V44". That's a schema-level
// inconsistency Excel's file-format validator rejects outright ("problem with content..."),
// reproduces even with zero modifications (confirmed: load calculation.xltx, write it straight
// back out, several sheets already show the wrong dimension). exceljs's `dimensions` is
// read-only, so there's no supported way to override it through the object model — this patches
// the actual XML after writeBuffer(), recomputing each worksheet's true min/max row and column
// straight from its own <c r="..."> cell references and correcting the declared range.
async function fixWorksheetDimensions(buffer: Buffer): Promise<Buffer> {
    const zip = await JSZip.loadAsync(buffer);
    const sheetFiles = Object.keys(zip.files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));

    for (const name of sheetFiles) {
        const file = zip.file(name);
        if (!file) continue;
        const xml = await file.async("string");

        let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
        const cellRefRegex = /<c r="([A-Z]+)(\d+)"/g;
        let match: RegExpExecArray | null;
        while ((match = cellRefRegex.exec(xml)) !== null) {
            const col = colLettersToNum(match[1]);
            const row = parseInt(match[2], 10);
            if (col < minCol) minCol = col;
            if (col > maxCol) maxCol = col;
            if (row < minRow) minRow = row;
            if (row > maxRow) maxRow = row;
        }
        if (minCol === Infinity) continue; // no cells at all, nothing to fix

        const correctRange = `${colNumToLetters(minCol)}${minRow}:${colNumToLetters(maxCol)}${maxRow}`;
        const fixedXml = xml.replace(/<dimension ref="[^"]*"\s*\/>/, `<dimension ref="${correctRange}"/>`);
        zip.file(name, fixedXml);
    }

    // jszip defaults to STORE (no compression) on regenerate, unlike exceljs's original DEFLATE
    // output — match it explicitly rather than leave the container-level format silently
    // different from what a real xlsx normally looks like.
    const fixedBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return fixedBuffer;
}

// HHMM (e.g. 800, 2200, 2400) -> minutes since midnight
function toMinutes(hhmm: number): number {
    return Math.trunc(hhmm / 100) * 60 + (hhmm % 100);
}

// Duration of a single shift in hours, handling an overnight wrap within the same entry
function shiftHours(clockIn: number, clockOut: number): number {
    let minutes = toMinutes(clockOut) - toMinutes(clockIn);
    if (minutes < 0) minutes += 24 * 60;
    return minutes / 60;
}

type Shift = { clockIn: number; clockOut: number; source: string; guessed: boolean; implausible?: boolean };

// A day with 2+ distinct shifts (e.g. a morning block and an evening block) collapses to one
// row: full span = first clock-in to last clock-out, and the gap(s) between shifts become the
// meal break (summed if there are 3+ shifts, i.e. 2+ gaps). This lets the day still go through
// N/O like a normal single-shift day, just with the template's default meal-break (column G)
// overridden by the actual observed gap instead of assumed.
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
const FALLBACK_LUNCH_BREAK_HOURS = 1;

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
// standardLunchHours is the caseworker's declared standard (public/index.html's lunch-break
// radio group), used as the assumed break for a single, unremarkable shift — there's nothing
// actually read off the page for that case (a single clock-in/clock-out pair says nothing about
// the meal break), so adopting the declared standard directly is more accurate than a hardcoded
// guess, and means it won't spuriously disagree with itself later (public/index.html's
// checkLunchMismatch compares every row's lunchBreakHours against this same declared value). A
// multi-shift day is different: the gap between shifts IS something actually observed on the
// page, so that stays as the real measured value — genuinely comparable against the declared
// standard, and worth a mismatch warning if it disagrees.
export function buildReviewRows(entries: TimeEntry[], restDays: RestDay[], standardLunchHours: number = FALLBACK_LUNCH_BREAK_HOURS): ReviewRow[] {
    type Cell = { date: Date; shifts: Shift[]; source: string };
    const byDate = new Map<string, Cell>();

    for (const entry of entries) {
        const key = toLocalDateString(entry.date);
        const cell = byDate.get(key) ?? { date: entry.date, shifts: [], source: entry.source };
        const isDuplicate = cell.shifts.some(s => s.clockIn === entry.clockIn && s.clockOut === entry.clockOut);
        if (!isDuplicate) {
            cell.shifts.push({ clockIn: entry.clockIn, clockOut: entry.clockOut, source: entry.source, guessed: entry.guessed });
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
            rows.push({
                date: toLocalDateString(date),
                clockIn: shifts[0].clockIn,
                clockOut: shifts[0].clockOut,
                lunchBreakHours: standardLunchHours,
                restDay: false,
                guessed: anyGuessed || implausible,
                notes: implausible ? `implausible shift duration (${hours}h) as originally scanned — please verify` : null,
                source: sourceList,
            });
        } else {
            const sorted = [...shifts].sort((a, b) => toMinutes(a.clockIn) - toMinutes(b.clockIn));
            const { start, end, spanHours, breakHours } = computeSpanAndBreak(sorted);
            const implausible = spanHours >= 24 || breakHours < 0 || breakHours >= spanHours;
            rows.push({
                date: toLocalDateString(date),
                clockIn: start,
                clockOut: end,
                lunchBreakHours: implausible ? standardLunchHours : Math.round(breakHours * 100) / 100,
                restDay: false,
                guessed: true, // a multi-shift collapse always needs a human glance, even when internally consistent
                notes: `${shifts.length} shifts originally scanned (${sorted.map(s => `${s.clockIn}-${s.clockOut}`).join(", ")}) collapsed into one span — please verify`,
                source: sourceList,
            });
        }
    }

    for (const r of restDays) {
        rows.push({
            date: `${r.year}-${String(r.month).padStart(2, "0")}-${String(r.day).padStart(2, "0")}`,
            clockIn: null,
            clockOut: null,
            lunchBreakHours: null,
            restDay: true,
            guessed: false,
            notes: null,
            source: r.source,
        });
    }

    return rows.sort((a, b) => a.date.localeCompare(b.date));
}

// Loads calculation.xltx and writes each (already human-reviewed) row directly.
// - Every day, goes into "Start Time w/o :" (N) / "End Time w/o :" (O), which feed the template's
//   own B/C/D/E/I/L formulas. The lunch break (column G) is always written from the row's
//   lunchBreakHours — every row carries an explicit value (defaulted by buildReviewRows, editable
//   by the human reviewer), so there's no separate "leave the template default" case to handle
//   here.
// - A row still marked `guessed` (the human reviewer didn't clear it) gets a "Remarks" note and a
//   highlighted fill so it's obvious at a glance which cells were flagged as needing a look.
export async function fillTimesheetFromRows(
    templatePath: string,
    rows: ReviewRow[]
): Promise<{ buffer: Buffer; warnings: FillWarning[]; writtenDates: Date[] }> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(templatePath);
    workbook.calcProperties.fullCalcOnLoad = true; // force Excel to recompute formulas on open

    // Two independent pre-existing defects in how this template's formulas round-trip through
    // ExcelJS, both confirmed to reproduce with zero modifications (load calculation.xltx, write
    // it straight back out) and both flagged by Excel's "problem with some content" repair
    // dialog:
    //
    // 1. Shared formulas. The template's daily-row formulas are Excel "shared formulas" (one
    //    master cell + a range of dependents that inherit it). ExcelJS's writer can assign a
    //    dependent cell a shared-formula group ID whose declared range doesn't actually cover
    //    it — a hard schema violation. Fixed by expanding every shared-formula cell to a fully
    //    standalone one: `.formula` already resolves the correctly-translated per-cell text, so
    //    reassigning it drops the shared-group metadata entirely.
    //
    // 2. Stale cached formula results. Some formula cells (e.g. VLOOKUPs on "1-Calc- Monthly Pay"
    //    keyed off the intentionally-blank "Worker Details" sheet) cache a result — error
    //    (t="e", <v>#N/A</v>) or plain string (t="str") alike — straight from the template. That
    //    exact cell is byte-identical in the pristine, untouched .xltx — but a .xltx is normally
    //    opened via Excel's "new from template" flow, which may never expose this to the
    //    stricter validation a direct .xlsx open goes through (confirmed via a completely
    //    independent library, openpyxl: its round-trip of the same cells drops the cached value
    //    and type marker entirely, keeping only the formula). Since we already set
    //    fullCalcOnLoad above (Excel recomputes everything on open regardless), every cached
    //    formula result is functionally redundant — dropped unconditionally rather than ship a
    //    value Excel may reject outright.
    workbook.eachSheet(ws => {
        ws.eachRow({ includeEmpty: false }, row => {
            row.eachCell({ includeEmpty: false }, cell => {
                if (cell.formula) {
                    cell.value = { formula: cell.formula }; // de-share (if applicable) + drop cached result
                }
            });
        });
    });

    const warnings: FillWarning[] = [];

    // No human can work 24h+ in a calendar day. The review UI already lets a human fix an
    // implausible row before it gets here, but that isn't a data-integrity guarantee — enforce it
    // here too rather than trusting the submitted value not to be an impossible shift.
    const MAX_DAILY_HOURS = 24;

    const writtenDates: Date[] = [];

    function setCell(cell: ExcelJS.Cell, value: ExcelJS.CellValue) {
        cell.value = value;
        cell.style = { ...cell.style, font: DATA_FONT };
    }

    for (const r of rows) {
        if (r.restDay) continue; // nothing to write — a blank N/O row already reads as unworked

        const [y, m, d] = r.date.split("-").map(Number);
        const date = new Date(y, m - 1, d);
        const sheetName = sheetNameFor(date);
        const worksheet = workbook.getWorksheet(sheetName);
        if (!worksheet) {
            warnings.push({
                source: r.source,
                reason: `${date.toDateString()} falls outside the template's supported range (no sheet "${sheetName}")`,
                category: "skipped_invalid",
                date: r.date,
            });
            continue;
        }
        if (r.clockIn === null || r.clockOut === null) {
            warnings.push({ source: r.source, reason: `${date.toDateString()}: missing start/end time, skipped`, category: "skipped_invalid", date: r.date });
            continue;
        }

        const hours = shiftHours(r.clockIn, r.clockOut);
        const lunchBreak = r.lunchBreakHours ?? 0;
        if (hours <= 0 || hours >= MAX_DAILY_HOURS || lunchBreak < 0 || lunchBreak >= hours) {
            warnings.push({
                source: r.source,
                reason: `${date.toDateString()}: ${r.clockIn}-${r.clockOut} with ${lunchBreak}h break (${hours}h span) is not a valid shift — skipped, please fix and regenerate`,
                category: "skipped_invalid",
                date: r.date,
            });
            continue;
        }

        const row = date.getDate() + 1; // row 2 = day 1, per template layout
        const nCell = worksheet.getCell(`N${row}`);
        const oCell = worksheet.getCell(`O${row}`);
        const gCell = worksheet.getCell(`G${row}`);
        setCell(nCell, r.clockIn);
        setCell(oCell, r.clockOut);
        setCell(gCell, lunchBreak);
        writtenDates.push(date);
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const buffer = await fixWorksheetDimensions(Buffer.from(arrayBuffer));
    return { buffer, warnings, writtenDates };
}
