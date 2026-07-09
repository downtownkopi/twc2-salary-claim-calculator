import ExcelJS from "exceljs";
import JSZip from "jszip";

export type TimeEntry = {
    date: Date; // year already resolved by caller (OCR'd year is unreliable, see server.ts)
    clockIn: number; // HHMM 24hr, e.g. 800 = 8:00am, 2200 = 10:00pm
    clockOut: number;
    source: string; // e.g. "timesheet1.pdf p2"
    guessed: boolean; // true if the model inferred this rather than reading it directly
};

export type FillWarning = {
    source: string;
    reason: string;
};

// A day explicitly marked as a rest day/off/holiday on the actual page — genuine observed data
// (the model read and reported it directly), not something inferred or fabricated.
export type RestDay = { year: number; month: number; day: number; source: string }; // month is 1-12

export const MONTH_ABBR = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Highlight fill for any cell the model derived by best-guess rather than reading directly
const GUESS_FILL: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFF2A6" }, // light yellow
};

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

type Shift = { clockIn: number; clockOut: number; source: string; guessed: boolean };

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

// Loads calculation.xltx and fills each date's row.
// - Every day, single- or multi-shift alike, goes into "Start Time w/o :" (N) / "End Time w/o :"
//   (O), which feed the template's own B/C/D/E/I/L formulas. A single shift writes its clock-in/
//   out directly, leaving the template's default "Meal Time hrs" (G) untouched. 2+ shifts (e.g.
//   a morning block and an evening block) collapse to one row: N/O become the first clock-in and
//   last clock-out, and the gap(s) between shifts are summed into G, overriding the default with
//   the actual observed break — the template's D/I formulas then compute hours/overtime
//   correctly off the real break instead of the assumed one.
// - Any shift the model marked as a best-guess (rather than read directly) gets a "Remarks" note
//   and a highlighted fill so it's obvious at a glance which cells need double-checking.
export async function fillTimesheet(
    templatePath: string,
    entries: TimeEntry[]
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
    type Cell = { sheetName: string; row: number; date: Date; shifts: Shift[] };
    const byCell = new Map<string, Cell>();

    for (const entry of entries) {
        const sheetName = sheetNameFor(entry.date);
        const worksheet = workbook.getWorksheet(sheetName);
        if (!worksheet) {
            warnings.push({
                source: entry.source,
                reason: `${entry.date.toDateString()} falls outside the template's supported range (no sheet "${sheetName}")`,
            });
            continue;
        }

        const row = entry.date.getDate() + 1; // row 2 = day 1, per template layout
        const key = `${sheetName}|${row}`;
        const cell = byCell.get(key) ?? { sheetName, row, date: entry.date, shifts: [] };
        const isDuplicate = cell.shifts.some(
            s => s.clockIn === entry.clockIn && s.clockOut === entry.clockOut
        );
        if (!isDuplicate) {
            cell.shifts.push({ clockIn: entry.clockIn, clockOut: entry.clockOut, source: entry.source, guessed: entry.guessed });
        }
        byCell.set(key, cell);
    }

    // Column P is blank/unused on every monthly sheet (verified against the template), and its
    // own instructions (Definitions-formulas!B16) explicitly allow adding columns for extra info.
    const REMARKS_COL = "P";
    const sheetsWithRemarks = new Set<string>();

    // No human can work 24h+ in a calendar day. This is also asked of the model in the prompt,
    // but LLM instruction-following isn't a data-integrity guarantee — enforce it here too rather
    // than trusting the model not to write an impossible shift into a wage-claim spreadsheet.
    const MAX_DAILY_HOURS = 24;

    const writtenDates: Date[] = [];

    // ExcelJS shares style objects by reference across cells with identical template formatting —
    // assigning `.fill`/`.font` directly mutates that shared style and silently affects unrelated
    // cells too. Cloning `.style` first gives this cell its own style object.
    function highlightCell(cell: ExcelJS.Cell) {
        cell.style = { ...cell.style, fill: GUESS_FILL };
    }

    function setCell(cell: ExcelJS.Cell, value: ExcelJS.CellValue) {
        cell.value = value;
        cell.style = { ...cell.style, font: DATA_FONT };
    }

    function setRemark(worksheet: ExcelJS.Worksheet, row: number, sheetName: string, text: string, highlight: boolean) {
        const cell = worksheet.getCell(`${REMARKS_COL}${row}`);
        setCell(cell, text);
        if (highlight) highlightCell(cell);
        sheetsWithRemarks.add(sheetName);
    }

    for (const { sheetName, row, date, shifts } of byCell.values()) {
        const worksheet = workbook.getWorksheet(sheetName)!;

        // drop any individual shift with a zero or 24h+ duration — can't be real
        const validShifts = shifts.filter(s => {
            const hours = shiftHours(s.clockIn, s.clockOut);
            if (hours <= 0 || hours >= MAX_DAILY_HOURS) {
                warnings.push({
                    source: s.source,
                    reason: `implausible shift ${s.clockIn}-${s.clockOut} on ${date.toDateString()} (${hours}h) — skipped, please verify against the original page`,
                });
                return false;
            }
            return true;
        });
        if (validShifts.length === 0) continue;

        const anyGuessed = validShifts.some(s => s.guessed);
        const sourceList = validShifts.map(s => s.source).join(", ");

        if (validShifts.length === 1) {
            const nCell = worksheet.getCell(`N${row}`);
            const oCell = worksheet.getCell(`O${row}`);
            setCell(nCell, validShifts[0].clockIn);
            setCell(oCell, validShifts[0].clockOut);
            writtenDates.push(date);
            if (anyGuessed) {
                highlightCell(nCell);
                highlightCell(oCell);
                setRemark(worksheet, row, sheetName, "Model-derived guess — please double check", true);
            }
        } else {
            // 2+ shifts (e.g. a morning block and an evening block) collapse to one row: full
            // span = first clock-in to last clock-out, and the gap(s) between shifts become the
            // meal break (column G), overriding the template's default — the same N/O columns
            // a single-shift day uses, just with the real break instead of the assumed one.
            const sorted = [...validShifts].sort((a, b) => toMinutes(a.clockIn) - toMinutes(b.clockIn));
            const breakdown = sorted.map(s => `${s.clockIn}-${s.clockOut}`).join(", ");
            const { start, end, spanHours, breakHours } = computeSpanAndBreak(sorted);

            if (spanHours >= MAX_DAILY_HOURS || breakHours < 0 || breakHours >= spanHours) {
                warnings.push({
                    source: sourceList,
                    reason: `shifts for ${date.toDateString()} (${breakdown}) span ${spanHours}h with ${breakHours}h break — implausible, skipped entirely, please verify against the original page`,
                });
                continue;
            }

            const nCell = worksheet.getCell(`N${row}`);
            const oCell = worksheet.getCell(`O${row}`);
            const gCell = worksheet.getCell(`G${row}`);
            setCell(nCell, start);
            setCell(oCell, end);
            setCell(gCell, breakHours);
            writtenDates.push(date);

            const remarkText = `${validShifts.length} shifts (${breakdown}) — treated as ${start}-${end} with ${breakHours}h break (meal time overridden from default), please verify`
                + (anyGuessed ? " (includes a model-derived guess)" : "");
            setRemark(worksheet, row, sheetName, remarkText, true);
            highlightCell(nCell);
            highlightCell(oCell);
            highlightCell(gCell);
            warnings.push({
                source: sourceList,
                reason: `${validShifts.length} shifts detected for ${date.toDateString()} (${breakdown}) — treated as single span ${start}-${end} with ${breakHours}h meal break, please verify`,
            });
        }
    }

    for (const sheetName of sheetsWithRemarks) {
        setCell(workbook.getWorksheet(sheetName)!.getCell(`${REMARKS_COL}1`), "Remarks");
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const buffer = await fixWorksheetDimensions(Buffer.from(arrayBuffer));
    return { buffer, warnings, writtenDates };
}
