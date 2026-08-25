import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, WidthType, AlignmentType, BorderStyle } from "docx";
import { formatDollar, formatClaimDate, computeClaimTotals, categoryTableRows, type WorkerDetailsExportPayload, type ExportCategory } from "./workerDetailsShared";

export type { WorkerDetailsExportPayload, ExportCategory, ExportCategoryRow } from "./workerDetailsShared";

// Matches the actual template document's own typeface — set explicitly on every run rather than
// relying on Word's "Normal" style default (which varies by template/viewer, usually Calibri).
const FONT = "Times New Roman";
const TABLE_TEXT_SIZE_HALF_PT = 20; // 10pt — every table cell (labels, values, headers, body, captions)
const BLUE = "0000FF";
const BLACK = "000000";

// Every section header (the 4 breakdown-category ones plus Claim Details/Salary Details) renders
// at this one fixed size — set explicitly on the run rather than left to Word's "Heading 2" style,
// since relying on the style let the apparent size drift depending on the viewer/theme. Only the
// document title (buildWorkerPersonalDetailsDocx's own first paragraph) is deliberately bigger.
const HEADING_SIZE_HALF_PT = 28; // 14pt

// The 4 pay-category section headers render in red — everything else (title, Claim/Salary
// Details) stays black.
/**
 * Builds a section header paragraph (bold, {@link HEADING_SIZE_HALF_PT}).
 *
 * @param text - The heading text.
 * @param opts.red - `true` for the 4 red pay-category headers, `false`/omitted for black ones.
 * @returns The heading paragraph.
 */
function heading(text: string, opts: { red?: boolean } = {}): Paragraph {
    return new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
        children: [new TextRun({ text, bold: true, font: FONT, size: HEADING_SIZE_HALF_PT, color: opts.red ? "FF0000" : BLACK })],
    });
}

// Single black hairline on every edge — matches the template's own tables, which all use Word's
// built-in "TableGrid" style (visible grid, not borderless). Set at both table level (tblBorders)
// and per-cell (each TableCell's own borders) — some docx viewers only honor one or the other, so
// both are set to guarantee the grid actually renders everywhere, not just in Word itself.
const GRID_BORDERS = {
    top: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
    bottom: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
    left: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
    right: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
    insideVertical: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
};
const CELL_BORDERS = {
    top: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
    bottom: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
    left: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
    right: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
};

/**
 * Builds a table-cell text run in the document's shared font/size/color.
 *
 * @param text - The cell text.
 * @param opts.bold - Whether to render it bold.
 * @returns The text run.
 */
function tableText(text: string, opts: { bold?: boolean } = {}): TextRun {
    return new TextRun({ text, font: FONT, size: TABLE_TEXT_SIZE_HALF_PT, color: BLACK, bold: opts.bold ?? false });
}

// A gridded "label | value" table — mirrors the template's field-list sections (Name/FIN/Employer,
// Claim Start/End, Work Week/Salary Type/Basic Salary, Claim totals).
/**
 * Builds a 2-column "label | value" table (Name/FIN/Employer, Claim Start/End, etc.) — label cell
 * shaded light blue, both columns centered.
 *
 * @param rows - `[label, value]` pairs, one per row.
 * @param boldValueRows - Row indices whose value cell should render bold (e.g. the Total row).
 * @returns The table.
 */
function fieldTable(rows: [string, string][], boldValueRows: Set<number> = new Set()): Table {
    return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: GRID_BORDERS,
        rows: rows.map(([label, value], i) => new TableRow({
            children: [
                new TableCell({ width: { size: 40, type: WidthType.PERCENTAGE }, borders: CELL_BORDERS, shading: { fill: "DCE6F5" }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [tableText(label, { bold: true })] })] }),
                new TableCell({ width: { size: 60, type: WidthType.PERCENTAGE }, borders: CELL_BORDERS, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [tableText(value, { bold: boldValueRows.has(i) })] })] }),
            ],
        })),
    });
}

// `titleText`, when given, becomes its own row spanning every column (columnSpan) above the
// header row — the "Earned X vs X Pay Received by Month" caption, merged into the table itself
// rather than a separate paragraph floating above it.
/**
 * Builds a full grid table: optional merged caption row, header row, body rows, and a bold Total row.
 *
 * @param headerCells - Column header labels.
 * @param bodyRows - One string array per data row.
 * @param totalRow - The bottom Total row's cell values.
 * @param titleText - When given, becomes its own row spanning every column above the header row
 * (the "Earned X vs X Pay Received by Month" caption); omitted entirely if not given.
 * @returns The table.
 */
function gridTable(headerCells: string[], bodyRows: string[][], totalRow: string[], titleText?: string): Table {
    const titleRow = titleText !== undefined
        ? new TableRow({
            children: [new TableCell({
                columnSpan: headerCells.length,
                borders: CELL_BORDERS,
                shading: { fill: "DCE6F5" },
                children: [new Paragraph({ children: [tableText(titleText, { bold: true })], alignment: AlignmentType.CENTER })],
            })],
        })
        : null;
    const headerRow = new TableRow({
        tableHeader: true,
        children: headerCells.map(text => new TableCell({ borders: CELL_BORDERS, children: [new Paragraph({ children: [tableText(text, { bold: true })], alignment: AlignmentType.CENTER })] })),
    });
    const rows = bodyRows.map(cells => new TableRow({
        children: cells.map(text => new TableCell({ borders: CELL_BORDERS, children: [new Paragraph({ children: [tableText(text)], alignment: AlignmentType.CENTER })] })),
    }));
    const total = new TableRow({
        children: totalRow.map(text => new TableCell({ borders: CELL_BORDERS, children: [new Paragraph({ children: [tableText(text, { bold: true })], alignment: AlignmentType.CENTER })] })),
    });
    return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: GRID_BORDERS, rows: [...(titleRow ? [titleRow] : []), headerRow, ...rows, total] });
}

// Shared shape for all four "Earned vs Paid vs Owed" breakdown tables — only the extra
// days/hours column (or its absence, for the basic-salary table) differs between them.
/**
 * Builds one of the "Earned vs Employer Paid vs Owed" breakdown tables.
 *
 * @param category - The category's per-month rows and totals.
 * @param extraColumnLabel - Header for the optional extra column (e.g. `"Hours"`), or `null` to omit it.
 * @param extraFormat - Formats the extra column's numeric value.
 * @param titleText - The merged caption row's text.
 * @returns The table.
 */
function categoryTable(category: ExportCategory, extraColumnLabel: string | null, extraFormat: (n: number) => string, titleText: string): Table {
    const { headers, body, total } = categoryTableRows(category, extraColumnLabel, extraFormat);
    return gridTable(headers, body, total, titleText);
}

/**
 * Renders the full "Worker Personal Details" claim breakdown as a Word document.
 *
 * @param p - The full export payload (same shape the pdf builder consumes).
 * @returns The rendered .docx as a `Buffer`.
 */
export async function buildWorkerPersonalDetailsDocx(p: WorkerDetailsExportPayload): Promise<Buffer> {
    const { claimForBasic, claimForAllowances, claimForOvertime, claimForRestDays, claimForNotice, claimForLeave, claimForSick, claimForMedicalBills, totalAmountClaim } = computeClaimTotals(p);

    const doc = new Document({
        sections: [{
            children: [
                new Paragraph({
                    heading: HeadingLevel.HEADING_1,
                    spacing: { after: 200 },
                    children: [new TextRun({ text: "Worker Personal Details", bold: true, font: FONT, size: 36, color: BLUE })],
                }),
                fieldTable([
                    ["Name", p.workerName ?? "—"],
                    ["FIN", p.workerFin ?? "—"],
                    ["Name of Employer", p.employerName ?? "—"],
                ]),

                heading("Claim Details"),
                fieldTable([
                    ["Claim Start Date", formatClaimDate(p.claimStartDate)],
                    ["Claim End Date", formatClaimDate(p.claimEndDate)],
                ]),

                heading("Salary Details"),
                fieldTable([
                    ["Work Week Type", `${p.workWeekType}-day Work Week`],
                    ["Salary Payment Type", "Monthly Basic Salary"],
                    ["Basic Salary", formatDollar(p.basicSalary)],
                ]),

                new Paragraph({ text: "", spacing: { after: 120 } }),
                fieldTable([
                    ["Claim for Basic", formatDollar(claimForBasic)],
                    ["Claim for Fixed Allowances", formatDollar(claimForAllowances)],
                    ["Claim for Overtime", formatDollar(claimForOvertime)],
                    ["Claim for Rest Days", formatDollar(claimForRestDays)],
                    ...(p.noticeClaim ? [["Claim for Salary-in-lieu of Notice", formatDollar(claimForNotice)] as [string, string]] : []),
                    ...(p.leaveClaim ? [["Claim for Salary-in-lieu of Leave", formatDollar(claimForLeave)] as [string, string]] : []),
                    ...(p.sickClaim ? [["Claim for Sick Leave Pay", formatDollar(claimForSick)] as [string, string]] : []),
                    ...(p.medicalBillsClaim ? [["Claim for Unreimbursed Medical Bills", formatDollar(claimForMedicalBills)] as [string, string]] : []),
                    ["Total Amount Claim", formatDollar(totalAmountClaim)],
                ], new Set([4 + (p.noticeClaim ? 1 : 0) + (p.leaveClaim ? 1 : 0) + (p.sickClaim ? 1 : 0) + (p.medicalBillsClaim ? 1 : 0)])),

                ...(p.noticeClaim ? [
                    heading("Salary-in-lieu of Termination Notice"),
                    fieldTable([
                        ["Employment Start Date", formatClaimDate(p.noticeClaim.employmentStartDate)],
                        ["Termination Date", formatClaimDate(p.noticeClaim.terminationDate)],
                        ["Entitlement", p.noticeClaim.tierLabel],
                        ["Full Notice Pay", formatDollar(p.noticeClaim.entitledPay)],
                        ["Notice Already Given (Paid)", formatDollar(p.noticeClaim.noticeGivenPay)],
                        ["Amount Owed", formatDollar(p.noticeClaim.owedAmount)],
                    ], new Set([5])),
                ] : []),

                ...(p.leaveClaim ? [
                    heading("Salary-in-lieu of Unused Annual Leave"),
                    fieldTable([
                        ["Employment Start Date", formatClaimDate(p.leaveClaim.employmentStartDate)],
                        ["Termination Date", formatClaimDate(p.leaveClaim.terminationDate)],
                        ["Final Leave-Year Entitlement (Prorated)", `${p.leaveClaim.proratedEntitlementDays.toFixed(2)} days`],
                        ["Days Already Taken", `${p.leaveClaim.daysTaken.toFixed(2)} days`],
                        ["Days Owed", `${p.leaveClaim.daysOwed.toFixed(2)} days`],
                        ["Amount Owed", formatDollar(p.leaveClaim.owedAmount)],
                    ], new Set([5])),
                ] : []),

                ...(p.sickClaim ? [
                    heading("Sick Leave Pay"),
                    fieldTable([
                        ["Employment Start Date", formatClaimDate(p.sickClaim.employmentStartDate)],
                        ["As-of Date", formatClaimDate(p.sickClaim.asOfDate)],
                        ["Entitlement Tier", `${p.sickClaim.tierLabel} (${p.sickClaim.nonHospCap} non-hosp / ${p.sickClaim.hospCap} hosp days)`],
                        ["Non-Hospitalization Days Owed", `${p.sickClaim.owedNonHospDays.toFixed(2)} days`],
                        ["Hospitalization Days Owed", `${p.sickClaim.owedHospDays.toFixed(2)} days`],
                        ["Total Days Owed", `${p.sickClaim.totalDaysOwed.toFixed(2)} days`],
                        ["Amount Owed", formatDollar(p.sickClaim.owedAmount)],
                    ], new Set([6])),
                ] : []),

                ...(p.medicalBillsClaim ? [
                    heading("Unreimbursed Medical Bills"),
                    fieldTable([
                        ["Total Billed", formatDollar(p.medicalBillsClaim.totalBilled)],
                        ["Total Reimbursed by Employer", formatDollar(p.medicalBillsClaim.totalReimbursed)],
                        ["Amount Owed", formatDollar(p.medicalBillsClaim.owedAmount)],
                    ], new Set([2])),
                ] : []),

                heading("Non-payment and short payment of basic salary", { red: true }),
                categoryTable(p.basic, null, () => "", "Earned Monthly Salary vs Monthly Salary Received by Month"),

                heading("Non-payment and short payment of allowances", { red: true }),
                categoryTable(p.allowances, null, () => "", "Earned allowances vs Allowances Received by Month"),

                heading("Overtime payment", { red: true }),
                categoryTable(p.overtime, "Hours", n => n.toFixed(1), "Earned Overtime vs Overtime Pay Received by Month"),

                heading("Payment for work on rest days", { red: true }),
                categoryTable(p.restDays, "Days", n => n.toFixed(1), "Earned Work on Rest days vs Work on Rest days Pay Received by Month"),

                heading("Payment for work on public holidays", { red: true }),
                categoryTable(p.publicHolidays, "Days", n => n.toFixed(1), "Earned Work on Public Holidays vs Work on Public Holidays Pay Received by Month"),
            ],
        }],
    });

    return Packer.toBuffer(doc);
}
