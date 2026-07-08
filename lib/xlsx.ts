import ExcelJS from "exceljs";

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

// Loads calculation.xltx and fills each date's row.
// - A single shift on a day goes into "Start Time w/o :" (N) / "End Time w/o :" (O), which feed
//   the template's own B/C/D/E/I/L formulas.
// - Multiple distinct shifts on the same day (e.g. split day/night shift) can't fit one N/O pair,
//   so per the template's own instructions (Definitions-formulas!B11: "fill in daily start and
//   end times, OR work-hours including meal-times") their durations are summed into
//   "Enter Timecard Hours" (M) instead, which bypasses N/O/B/C entirely.
// - Any shift the model marked as a best-guess (rather than read directly) gets a "Remarks" note
//   and a highlighted fill so it's obvious at a glance which cells need double-checking.
export async function fillTimesheet(
    templatePath: string,
    entries: TimeEntry[]
): Promise<{ buffer: Buffer; warnings: FillWarning[]; writtenDates: Date[] }> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(templatePath);
    workbook.calcProperties.fullCalcOnLoad = true; // force Excel to recompute formulas on open

    const warnings: FillWarning[] = [];
    type Shift = { clockIn: number; clockOut: number; source: string; guessed: boolean };
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

        if (validShifts.length === 1) {
            const totalHours = shiftHours(validShifts[0].clockIn, validShifts[0].clockOut);
            if (totalHours >= MAX_DAILY_HOURS) continue; // filtered above, but keep the invariant explicit
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
            const totalHours = validShifts.reduce((sum, s) => sum + shiftHours(s.clockIn, s.clockOut), 0);
            const breakdown = validShifts.map(s => `${s.clockIn}-${s.clockOut}`).join(", ");
            if (totalHours >= MAX_DAILY_HOURS) {
                warnings.push({
                    source: validShifts.map(s => s.source).join(", "),
                    reason: `shifts for ${date.toDateString()} (${breakdown}) sum to ${totalHours}h, which is >= 24h in one day — skipped entirely, please verify against the original page`,
                });
                continue;
            }
            const mCell = worksheet.getCell(`M${row}`);
            setCell(mCell, totalHours);
            writtenDates.push(date);
            const remarkText = `${validShifts.length} shifts (${breakdown}) summed to ${totalHours}h — verify`
                + (anyGuessed ? " (includes a model-derived guess — please double check)" : "");
            setRemark(worksheet, row, sheetName, remarkText, anyGuessed);
            if (anyGuessed) highlightCell(mCell);
            warnings.push({
                source: validShifts.map(s => s.source).join(", "),
                reason: `${validShifts.length} shifts detected for ${date.toDateString()} (${breakdown}) — summed to ${totalHours}h in "Enter Timecard Hours", please verify`,
            });
        }
    }

    for (const sheetName of sheetsWithRemarks) {
        setCell(workbook.getWorksheet(sheetName)!.getCell(`${REMARKS_COL}1`), "Remarks");
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return { buffer: Buffer.from(arrayBuffer), warnings, writtenDates };
}
