import PDFDocument from "pdfkit";
import { formatDollar, formatClaimDate, computeClaimTotals, categoryTableRows, type WorkerDetailsExportPayload, type ExportCategory } from "./workerDetailsShared";

const BLUE_FILL = "#DCE6F5";
const RED = "#FF0000";
const BLACK = "#000000";
const BLUE = "#0000FF";
const BORDER_1PT = { top: 1, bottom: 1, left: 1, right: 1 };

// Matches the actual template document's own typeface. pdfkit ships Times-Roman/Times-Bold as
// built-in standard fonts (no embedding needed), same as Word's Times New Roman.
const FONT_REGULAR = "Times-Roman";
const FONT_BOLD = "Times-Bold";
const TABLE_TEXT_SIZE = 10;

// @types/pdfkit (0.17.6) predates pdfkit's own table() API (added in 0.19) — the installed
// runtime supports it fully, the published types just haven't caught up yet, so this is a type
// escape hatch, not a runtime workaround.
/**
 * Type-cast escape hatch for pdfkit's `table()` API, which the installed `@types/pdfkit` predates.
 *
 * @param doc - The pdfkit document to draw into.
 * @param opts - pdfkit's own `table()` options object (untyped here — see pdfkit's own docs for its shape).
 */
function drawTable(doc: PDFKit.PDFDocument, opts: unknown) {
    (doc as unknown as { table: (opts: unknown) => void }).table(opts);
}

// Matches the docx builder's HEADING_SIZE_HALF_PT (28 half-points = 14pt) — every section header
// (the 4 red pay-category ones plus Claim Details/Salary Details) renders at this one fixed size,
// same as the docx version, so the two formats look like the same document.
const HEADING_SIZE = 14;

/**
 * Draws a section header (bold, {@link HEADING_SIZE}pt) and resets the doc's font/size/color for
 * whatever follows it.
 *
 * @param doc - The pdfkit document to draw into.
 * @param text - The heading text.
 * @param opts.red - `true` for the 4 red pay-category headers, `false`/omitted for black ones.
 */
function heading(doc: PDFKit.PDFDocument, text: string, opts: { red?: boolean } = {}) {
    doc.moveDown(0.5);
    doc.font(FONT_BOLD).fontSize(HEADING_SIZE).fillColor(opts.red ? RED : BLACK).text(text);
    doc.fillColor(BLACK).font(FONT_REGULAR).fontSize(TABLE_TEXT_SIZE);
    doc.moveDown(0.3);
}

// A gridded "label | value" table — mirrors the template's field-list sections (Name/FIN/Employer,
// Claim Start/End, Work Week/Salary Type/Basic Salary, Claim totals). Label cell shaded light blue,
// same as the docx version. doc's current font/size (Times-Roman 10pt, set once in
// buildWorkerPersonalDetailsPdf) is what cells with no per-cell font override inherit.
/**
 * Draws a 2-column "label | value" table (Name/FIN/Employer, Claim Start/End, etc.) — label cell
 * shaded light blue, both columns centered.
 *
 * @param doc - The pdfkit document to draw into.
 * @param rows - `[label, value]` pairs, one per row.
 * @param boldValueRows - Row indices whose value cell should render bold (e.g. the Total row).
 */
function fieldTable(doc: PDFKit.PDFDocument, rows: [string, string][], boldValueRows: Set<number> = new Set()) {
    drawTable(doc, {
        defaultStyle: { border: BORDER_1PT, padding: 6, font: { size: TABLE_TEXT_SIZE }, align: "center" },
        columnStyles: [{ width: "40%", backgroundColor: BLUE_FILL, font: { src: FONT_BOLD } }, { width: "60%" }],
        rowStyles: (i: number) => (boldValueRows.has(i) ? { font: { src: FONT_BOLD } } : {}),
        data: rows,
    });
    doc.moveDown(0.5);
}

// One of the 4 "Earned vs Paid vs Owed" breakdown tables — merged, light-blue-shaded caption row
// on top (colSpan across every column), then the header row, body rows, and a bold Total row.
/**
 * Draws one of the "Earned vs Employer Paid vs Owed" breakdown tables — a merged, light-blue-shaded
 * caption row, then the header row, body rows, and a bold Total row.
 *
 * @param doc - The pdfkit document to draw into.
 * @param category - The category's per-month rows and totals.
 * @param extraColumnLabel - Header for the optional extra column (e.g. `"Hours"`), or `null` to omit it.
 * @param extraFormat - Formats the extra column's numeric value.
 * @param titleText - The merged caption row's text, e.g. `"Earned Overtime vs Overtime Pay Received by Month"`.
 */
function categoryTable(doc: PDFKit.PDFDocument, category: ExportCategory, extraColumnLabel: string | null, extraFormat: (n: number) => string, titleText: string) {
    const { headers, body, total } = categoryTableRows(category, extraColumnLabel, extraFormat);
    const centerCell = (text: string, bold = false) => ({ text, align: "center", font: { src: bold ? FONT_BOLD : FONT_REGULAR } });
    drawTable(doc, {
        defaultStyle: { border: BORDER_1PT, padding: 6, font: { size: TABLE_TEXT_SIZE } },
        data: [
            [{ text: titleText, colSpan: headers.length, align: "center", backgroundColor: BLUE_FILL, font: { src: FONT_BOLD } }],
            headers.map(h => centerCell(h, true)),
            ...body.map(row => row.map(cell => centerCell(cell))),
            total.map(cell => centerCell(cell, true)),
        ],
    });
    doc.moveDown(0.5);
}

/**
 * Renders the full "Worker Personal Details" claim breakdown as a PDF.
 *
 * @param p - The full export payload (same shape the docx builder consumes).
 * @returns The rendered PDF as a `Buffer`.
 */
export async function buildWorkerPersonalDetailsPdf(p: WorkerDetailsExportPayload): Promise<Buffer> {
    const { claimForBasic, claimForAllowances, claimForOvertime, claimForRestDays, claimForNotice, claimForLeave, claimForSick, claimForMedicalBills, totalAmountClaim } = computeClaimTotals(p);

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "A4", margin: 40 });
        const chunks: Buffer[] = [];
        doc.on("data", chunk => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        doc.font(FONT_BOLD).fontSize(18).fillColor(BLUE).text("Worker Personal Details");
        doc.fillColor(BLACK);
        doc.moveDown(0.5);
        doc.font(FONT_REGULAR).fontSize(TABLE_TEXT_SIZE);

        fieldTable(doc, [
            ["Name", p.workerName ?? "—"],
            ["FIN", p.workerFin ?? "—"],
            ["Name of Employer", p.employerName ?? "—"],
        ]);

        heading(doc, "Claim Details");
        fieldTable(doc, [
            ["Claim Start Date", formatClaimDate(p.claimStartDate)],
            ["Claim End Date", formatClaimDate(p.claimEndDate)],
        ]);

        heading(doc, "Salary Details");
        fieldTable(doc, [
            ["Work Week Type", `${p.workWeekType}-day Work Week`],
            ["Salary Payment Type", "Monthly Basic Salary"],
            ["Basic Salary", formatDollar(p.basicSalary)],
        ]);

        fieldTable(doc, [
            ["Claim for Basic", formatDollar(claimForBasic)],
            ["Claim for Fixed Allowances", formatDollar(claimForAllowances)],
            ["Claim for Overtime", formatDollar(claimForOvertime)],
            ["Claim for Rest Days", formatDollar(claimForRestDays)],
            ...(p.noticeClaim ? [["Claim for Salary-in-lieu of Notice", formatDollar(claimForNotice)] as [string, string]] : []),
            ...(p.leaveClaim ? [["Claim for Salary-in-lieu of Leave", formatDollar(claimForLeave)] as [string, string]] : []),
            ...(p.sickClaim ? [["Claim for Sick Leave Pay", formatDollar(claimForSick)] as [string, string]] : []),
            ...(p.medicalBillsClaim ? [["Claim for Unreimbursed Medical Bills", formatDollar(claimForMedicalBills)] as [string, string]] : []),
            ["Total Amount Claim", formatDollar(totalAmountClaim)],
        ], new Set([4 + (p.noticeClaim ? 1 : 0) + (p.leaveClaim ? 1 : 0) + (p.sickClaim ? 1 : 0) + (p.medicalBillsClaim ? 1 : 0)]));

        if (p.noticeClaim) {
            heading(doc, "Salary-in-lieu of Termination Notice");
            fieldTable(doc, [
                ["Employment Start Date", formatClaimDate(p.noticeClaim.employmentStartDate)],
                ["Termination Date", formatClaimDate(p.noticeClaim.terminationDate)],
                ["Entitlement", p.noticeClaim.tierLabel],
                ["Full Notice Pay", formatDollar(p.noticeClaim.entitledPay)],
                ["Notice Already Given (Paid)", formatDollar(p.noticeClaim.noticeGivenPay)],
                ["Amount Owed", formatDollar(p.noticeClaim.owedAmount)],
            ], new Set([5]));
        }

        if (p.leaveClaim) {
            heading(doc, "Salary-in-lieu of Unused Annual Leave");
            fieldTable(doc, [
                ["Employment Start Date", formatClaimDate(p.leaveClaim.employmentStartDate)],
                ["Termination Date", formatClaimDate(p.leaveClaim.terminationDate)],
                ["Final Leave-Year Entitlement (Prorated)", `${p.leaveClaim.proratedEntitlementDays.toFixed(2)} days`],
                ["Days Already Taken", `${p.leaveClaim.daysTaken.toFixed(2)} days`],
                ["Days Owed", `${p.leaveClaim.daysOwed.toFixed(2)} days`],
                ["Amount Owed", formatDollar(p.leaveClaim.owedAmount)],
            ], new Set([5]));
        }

        if (p.sickClaim) {
            heading(doc, "Sick Leave Pay");
            fieldTable(doc, [
                ["Employment Start Date", formatClaimDate(p.sickClaim.employmentStartDate)],
                ["As-of Date", formatClaimDate(p.sickClaim.asOfDate)],
                ["Entitlement Tier", `${p.sickClaim.tierLabel} (${p.sickClaim.nonHospCap} non-hosp / ${p.sickClaim.hospCap} hosp days)`],
                ["Non-Hospitalization Days Owed", `${p.sickClaim.owedNonHospDays.toFixed(2)} days`],
                ["Hospitalization Days Owed", `${p.sickClaim.owedHospDays.toFixed(2)} days`],
                ["Total Days Owed", `${p.sickClaim.totalDaysOwed.toFixed(2)} days`],
                ["Amount Owed", formatDollar(p.sickClaim.owedAmount)],
            ], new Set([6]));
        }

        if (p.medicalBillsClaim) {
            heading(doc, "Unreimbursed Medical Bills");
            fieldTable(doc, [
                ["Total Billed", formatDollar(p.medicalBillsClaim.totalBilled)],
                ["Total Reimbursed by Employer", formatDollar(p.medicalBillsClaim.totalReimbursed)],
                ["Amount Owed", formatDollar(p.medicalBillsClaim.owedAmount)],
            ], new Set([2]));
        }

        heading(doc, "Non-payment and short payment of basic salary", { red: true });
        categoryTable(doc, p.basic, null, () => "", "Earned Monthly Salary vs Monthly Salary Received by Month");

        heading(doc, "Non-payment and short payment of allowances", { red: true });
        categoryTable(doc, p.allowances, null, () => "", "Earned allowances vs Allowances Received by Month");

        heading(doc, "Overtime payment", { red: true });
        categoryTable(doc, p.overtime, "Hours", n => n.toFixed(1), "Earned Overtime vs Overtime Pay Received by Month");

        heading(doc, "Payment for work on rest days", { red: true });
        categoryTable(doc, p.restDays, "Days", n => n.toFixed(1), "Earned Work on Rest days vs Work on Rest days Pay Received by Month");

        heading(doc, "Payment for work on public holidays", { red: true });
        categoryTable(doc, p.publicHolidays, "Days", n => n.toFixed(1), "Earned Work on Public Holidays vs Work on Public Holidays Pay Received by Month");

        doc.end();
    });
}
