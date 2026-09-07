import { describe, expect, it } from "vitest";
import { periodRange, mergePayslipEntries, type PayslipEntry } from "../lib/payslips";

function entry(overrides: Partial<PayslipEntry>): PayslipEntry {
    return {
        granularity: "month",
        date: null,
        weekStart: null,
        weekEnd: null,
        yearMonth: null,
        overtimeHours: 0,
        hourlyRate: null,
        confirmedByAttempts: null,
        ...overrides,
    };
}

describe("periodRange", () => {
    it("a day entry's range is that single date", () => {
        expect(periodRange(entry({ granularity: "day", date: "2025-06-15" }))).toEqual({ start: "2025-06-15", end: "2025-06-15" });
    });

    it("a week entry's range is exactly weekStart..weekEnd as given", () => {
        expect(periodRange(entry({ granularity: "week", weekStart: "2025-06-09", weekEnd: "2025-06-15" }))).toEqual({ start: "2025-06-09", end: "2025-06-15" });
    });

    it("a month entry's range is that month's first and last day", () => {
        expect(periodRange(entry({ granularity: "month", yearMonth: "2025-06" }))).toEqual({ start: "2025-06-01", end: "2025-06-30" });
    });

    it("handles February in a leap year correctly", () => {
        expect(periodRange(entry({ granularity: "month", yearMonth: "2024-02" }))).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    });

    it("handles February in a non-leap year correctly", () => {
        expect(periodRange(entry({ granularity: "month", yearMonth: "2025-02" }))).toEqual({ start: "2025-02-01", end: "2025-02-28" });
    });

    it("returns null for an entry missing the field its own granularity requires", () => {
        expect(periodRange(entry({ granularity: "week", weekStart: "2025-06-09", weekEnd: null }))).toBeNull();
        expect(periodRange(entry({ granularity: "day", date: null }))).toBeNull();
        expect(periodRange(entry({ granularity: "month", yearMonth: null }))).toBeNull();
    });
});

describe("mergePayslipEntries", () => {
    it("unions entries across attempts by period identity and majority-votes the hours figure", () => {
        const attempts: PayslipEntry[][] = [
            [entry({ granularity: "month", yearMonth: "2025-06", overtimeHours: 12 })],
            [entry({ granularity: "month", yearMonth: "2025-06", overtimeHours: 12 })],
            [entry({ granularity: "month", yearMonth: "2025-06", overtimeHours: 15 })],
        ];
        const merged = mergePayslipEntries(attempts);
        expect(merged).toHaveLength(1);
        expect(merged[0].overtimeHours).toBe(12);
        expect(merged[0].confirmedByAttempts).toEqual({ seen: 3, total: 3 });
    });

    it("keeps distinct periods as separate entries", () => {
        const attempts: PayslipEntry[][] = [
            [
                entry({ granularity: "month", yearMonth: "2025-06", overtimeHours: 12 }),
                entry({ granularity: "month", yearMonth: "2025-07", overtimeHours: 8 }),
            ],
        ];
        const merged = mergePayslipEntries(attempts);
        expect(merged).toHaveLength(2);
    });

    it("majority-votes the hourly rate independently of the hours figure", () => {
        const attempts: PayslipEntry[][] = [
            [entry({ granularity: "month", yearMonth: "2025-09", overtimeHours: 68, hourlyRate: 5.63 })],
            [entry({ granularity: "month", yearMonth: "2025-09", overtimeHours: 68, hourlyRate: 5.63 })],
            [entry({ granularity: "month", yearMonth: "2025-09", overtimeHours: 68, hourlyRate: 5.68 })],
        ];
        const merged = mergePayslipEntries(attempts);
        expect(merged).toHaveLength(1);
        expect(merged[0].hourlyRate).toBe(5.63);
    });

    it("majority-votes null when most attempts found no rate printed", () => {
        const attempts: PayslipEntry[][] = [
            [entry({ granularity: "month", yearMonth: "2025-09", overtimeHours: 68, hourlyRate: null })],
            [entry({ granularity: "month", yearMonth: "2025-09", overtimeHours: 68, hourlyRate: null })],
            [entry({ granularity: "month", yearMonth: "2025-09", overtimeHours: 68, hourlyRate: 5.63 })],
        ];
        const merged = mergePayslipEntries(attempts);
        expect(merged[0].hourlyRate).toBeNull();
    });
});
