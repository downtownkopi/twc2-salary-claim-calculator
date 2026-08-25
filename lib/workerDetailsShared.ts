export type ExportCategoryRow = { month: string; daysOrHours: number | null; earned: number; paid: number; owed: number };
export type ExportCategory = { rows: ExportCategoryRow[]; totalDaysOrHours: number; totalEarned: number; totalPaid: number; totalOwed: number };

// Employment Act ss.10-11 — salary-in-lieu of termination notice. A one-off entitlement, not tied
// to any month, computed client-side (see computeSalaryInLieuOfNotice in public/index.html) and
// passed through as-is; null when the caseworker hasn't opted into claiming it.
export type NoticeClaim = {
    employmentStartDate: string; // YYYY-MM-DD
    terminationDate: string;
    tierLabel: string;
    entitledPay: number;
    noticeGivenPay: number;
    owedAmount: number;
};

// Employment Act s.88A — salary-in-lieu of unused annual leave, paid out on termination. Also a
// one-off entitlement, computed client-side (see computeSalaryInLieuOfLeave in public/index.html);
// null when not claimed, or when the caseworker claimed it but service was 3 months or under
// (s.88A's own qualifying threshold — the client never sends a non-qualifying claim through).
export type LeaveClaim = {
    employmentStartDate: string; // YYYY-MM-DD
    terminationDate: string;
    tierDaysForFinalYear: number;
    proratedEntitlementDays: number;
    daysTaken: number;
    daysOwed: number;
    owedAmount: number;
};

// Employment Act s.89 — sick leave pay. A one-off entitlement, computed client-side (see
// computeSickLeaveClaim in public/index.html); null when not claimed, or when the caseworker
// claimed it but service was under 3 months (s.89's own qualifying threshold).
export type SickClaim = {
    employmentStartDate: string; // YYYY-MM-DD
    asOfDate: string;
    tierLabel: string;
    nonHospCap: number;
    hospCap: number;
    owedNonHospDays: number;
    owedHospDays: number;
    totalDaysOwed: number;
    owedAmount: number;
};

// Not tied to the Employment Act at all — an employer of a Work Permit holder is generally
// required to bear the worker's medical costs (a Work Pass condition, not a specific EA section).
// A one-off entitlement, computed client-side (see computeMedicalBillsClaim in public/index.html)
// from the reviewed Medical bills upload; null when no bills have been reviewed at all.
export type MedicalBillsClaim = {
    totalBilled: number;
    totalReimbursed: number;
    owedAmount: number;
};

export type WorkerDetailsExportPayload = {
    workerName: string | null;
    workerFin: string | null;
    employerName: string | null;
    claimStartDate: string | null; // YYYY-MM-DD
    claimEndDate: string | null;
    workWeekType: number; // 5.5 or 6
    basicSalary: number;
    basic: ExportCategory;
    allowances: ExportCategory;
    overtime: ExportCategory;
    restDays: ExportCategory;
    publicHolidays: ExportCategory;
    noticeClaim: NoticeClaim | null;
    leaveClaim: LeaveClaim | null;
    sickClaim: SickClaim | null;
    medicalBillsClaim: MedicalBillsClaim | null;
};

/**
 * Formats a number as a dollar amount with a `$` sign, e.g. `1234.5` -> `"$1,234.50"`.
 *
 * @param n - The amount to format.
 * @returns The formatted string.
 */
export function formatDollar(n: number): string {
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Table-body cells follow the template's own convention: no $ sign (the column header already
// carries "($)"), and a shortfall (negative) is wrapped in parentheses rather than shown with a
// minus sign.
/**
 * Formats a number for a table body cell: no `$` sign, negative wrapped in parentheses.
 *
 * @param n - The amount to format, e.g. `-50` -> `"(50.00)"`.
 * @returns The formatted string.
 */
export function formatPlain(n: number): string {
    const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return n < 0 ? `(${abs})` : abs;
}

// "YYYY-MM-DD" -> "Monday, 1 September 2025" — parsed as UTC so the calendar date shown always
// matches the date the caseworker typed, regardless of the server's local timezone offset.
/**
 * Formats a `YYYY-MM-DD` claim date as a full weekday+date string, e.g. `"Monday, 1 September 2025"`.
 *
 * @param dateStr - The date to format, or `null`.
 * @returns The formatted string, or `"—"` if `dateStr` is `null`.
 */
export function formatClaimDate(dateStr: string | null): string {
    if (!dateStr) return "—";
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    const weekday = date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    const month = date.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
    return `${weekday}, ${d} ${month} ${y}`;
}

// Shared by both the docx and pdf builders so the two formats can never disagree on the headline
// figures — each is (that category's total earned) minus (total already paid), i.e. the shortfall.
/**
 * Computes the per-category claim shortfalls and the grand total claim amount.
 *
 * @param p - The full export payload.
 * @returns Each category's `claimFor*` shortfall (earned minus paid, or the claim's own `owedAmount`
 * for the one-off claims), plus `totalAmountClaim` summed across all of them.
 */
export function computeClaimTotals(p: WorkerDetailsExportPayload) {
    const claimForBasic = p.basic.totalEarned - p.basic.totalPaid;
    const claimForAllowances = p.allowances.totalEarned - p.allowances.totalPaid;
    const claimForOvertime = p.overtime.totalEarned - p.overtime.totalPaid;
    const claimForRestDays = p.restDays.totalEarned - p.restDays.totalPaid;
    const claimForNotice = p.noticeClaim?.owedAmount ?? 0;
    const claimForLeave = p.leaveClaim?.owedAmount ?? 0;
    const claimForSick = p.sickClaim?.owedAmount ?? 0;
    const claimForMedicalBills = p.medicalBillsClaim?.owedAmount ?? 0;
    const totalAmountClaim = claimForBasic + claimForAllowances + claimForOvertime + claimForRestDays + claimForNotice + claimForLeave + claimForSick + claimForMedicalBills;
    return { claimForBasic, claimForAllowances, claimForOvertime, claimForRestDays, claimForNotice, claimForLeave, claimForSick, claimForMedicalBills, totalAmountClaim };
}

// Column layout shared by both formats: the merged caption row (see each format's own "categoryTable"),
// the header cells, and the body/total row cell values for one of the 4 breakdown tables.
/**
 * Builds the header/body/total row cells for one of the breakdown tables, shared by both the docx
 * and pdf builders.
 *
 * @param category - The category's per-month rows and totals.
 * @param extraColumnLabel - Header for the optional extra column (e.g. `"Hours"`, `"Days"`), or `null` to omit it.
 * @param extraFormat - Formats the extra column's numeric value, e.g. `n.toFixed(1)`.
 * @returns `headers` (column titles), `body` (one string array per month), and `total` (the bottom row).
 */
export function categoryTableRows(category: ExportCategory, extraColumnLabel: string | null, extraFormat: (n: number) => string) {
    const headers = ["Month", ...(extraColumnLabel ? [extraColumnLabel] : []), "($) Earned", "($) Employer Paid", "($) Owed"];
    const body = category.rows.map(r => [
        r.month,
        ...(extraColumnLabel ? [extraFormat(r.daysOrHours ?? 0)] : []),
        formatPlain(r.earned),
        r.paid === 0 ? "-" : formatPlain(r.paid),
        formatPlain(r.owed),
    ]);
    const total = [
        "Total",
        ...(extraColumnLabel ? [extraFormat(category.totalDaysOrHours)] : []),
        formatPlain(category.totalEarned),
        category.totalPaid === 0 ? "-" : formatPlain(category.totalPaid),
        formatPlain(category.totalOwed),
    ];
    return { headers, body, total };
}
