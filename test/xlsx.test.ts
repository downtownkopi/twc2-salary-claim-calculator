import { describe, expect, it } from "vitest";
import { buildReviewRows, type RestDay, type TimeEntry } from "../lib/xlsx";

function entry(date: string, clockIn: number, clockOut: number, overrides: Partial<TimeEntry> = {}): TimeEntry {
    return { date: new Date(date), clockIn, clockOut, source: "test.pdf p1", guessed: false, noBreak: false, ...overrides };
}

describe("buildReviewRows", () => {
    it("uses the caseworker's declared standard break for a single unremarkable shift", () => {
        const rows = buildReviewRows([entry("2025-06-01", 800, 1700)], [], 1.5);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ date: "2025-06-01", clockIn: 800, clockOut: 1700, breakHours: 1.5, guessed: false, restDay: false });
    });

    it("defaults the break to 1 hour when no standard is declared", () => {
        const rows = buildReviewRows([entry("2025-06-01", 800, 1700)], []);
        expect(rows[0].breakHours).toBe(1);
    });

    it("zeroes the break and flags it when the source explicitly stated no break was taken", () => {
        const rows = buildReviewRows([entry("2025-06-01", 800, 1700, { noBreak: true })], [], 1);
        expect(rows[0]).toMatchObject({ breakHours: 0, guessed: false });
        expect(rows[0].notes).toMatch(/no break\/lunch/);
    });

    it("flags an implausible single-shift duration and falls back to the standard break", () => {
        // clockIn === clockOut => 0-hour shift, implausible
        const rows = buildReviewRows([entry("2025-06-01", 800, 800)], [], 1.5);
        expect(rows[0]).toMatchObject({ guessed: true, breakHours: 1.5 });
        expect(rows[0].notes).toMatch(/implausible shift duration/);
    });

    it("an implausible shift still overrides a noBreak reading", () => {
        const rows = buildReviewRows([entry("2025-06-01", 800, 800, { noBreak: true })], [], 1.5);
        expect(rows[0].breakHours).toBe(1.5);
        expect(rows[0].notes).toMatch(/implausible/);
    });

    it("collapses 2+ shifts on the same date into one span with the observed gap as the break", () => {
        const rows = buildReviewRows(
            [entry("2025-06-01", 800, 1200), entry("2025-06-01", 1300, 1700)],
            []
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ clockIn: 800, clockOut: 1700, breakHours: 1, guessed: true });
        expect(rows[0].notes).toMatch(/2 shifts originally scanned/);
    });

    it("sums gaps across 3+ shifts on the same date", () => {
        const rows = buildReviewRows(
            [entry("2025-06-01", 700, 900), entry("2025-06-01", 1000, 1200), entry("2025-06-01", 1300, 1700)],
            []
        );
        expect(rows[0]).toMatchObject({ clockIn: 700, clockOut: 1700, breakHours: 2 });
    });

    it("deduplicates identical clock-in/out pairs reported for the same date from different pages", () => {
        const rows = buildReviewRows(
            [entry("2025-06-01", 800, 1700, { source: "a.pdf p1" }), entry("2025-06-01", 800, 1700, { source: "b.pdf p1" })],
            []
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].clockIn).toBe(800);
        expect(rows[0].clockOut).toBe(1700);
    });

    it("appends rest days with null clock/break fields", () => {
        const restDays: RestDay[] = [{ year: 2025, month: 6, day: 2, source: "timesheet.pdf p1", notes: "OFF" }];
        const rows = buildReviewRows([], restDays);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ date: "2025-06-02", clockIn: null, clockOut: null, breakHours: null, restDay: true, notes: "OFF" });
    });

    it("sorts the combined rows by date ascending", () => {
        const restDays: RestDay[] = [{ year: 2025, month: 6, day: 3, source: "t", notes: null }];
        const rows = buildReviewRows([entry("2025-06-05", 800, 1700), entry("2025-06-01", 800, 1700)], restDays);
        expect(rows.map(r => r.date)).toEqual(["2025-06-01", "2025-06-03", "2025-06-05"]);
    });

    it("marks a single-shift row guessed when the model flagged that shift as a guess", () => {
        const rows = buildReviewRows([entry("2025-06-01", 800, 1700, { guessed: true })], []);
        expect(rows[0].guessed).toBe(true);
    });
});
