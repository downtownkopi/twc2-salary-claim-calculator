import { describe, expect, it } from "vitest";
import { reconcileAttempts, type ParsedEntry } from "../lib/reconcile";

function times(day: number, month: number, t: number[], overrides: Partial<ParsedEntry> = {}): ParsedEntry {
    return { day, month, times: t, hoursWorked: null, otHours: null, noBreak: null, guessed: null, rest_day: null, notes: null, ...overrides };
}

function rest(day: number, month: number, notes: string | null = null): ParsedEntry {
    return { day, month, times: null, hoursWorked: null, otHours: null, noBreak: null, guessed: null, rest_day: true, notes };
}

function hours(day: number, month: number, hoursWorked: number, otHours: number | null = null): ParsedEntry {
    return { day, month, times: null, hoursWorked, otHours, noBreak: null, guessed: null, rest_day: null, notes: null };
}

describe("reconcileAttempts", () => {
    it("accepts a day when all attempts agree on times", () => {
        const attempts = [[times(1, 6, [800, 1700])], [times(1, 6, [800, 1700])], [times(1, 6, [800, 1700])]];
        const { entries, warnings } = reconcileAttempts(attempts, "test");
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ day: 1, month: 6, times: [800, 1700], guessed: false, rest_day: false });
        expect(warnings).toHaveLength(0);
    });

    it("only marks noBreak when every attempt that agreed on times also reported it", () => {
        const attempts = [
            [times(1, 6, [800, 1700], { noBreak: true })],
            [times(1, 6, [800, 1700], { noBreak: true })],
            [times(1, 6, [800, 1700], { noBreak: false })],
        ];
        const { entries } = reconcileAttempts(attempts, "test");
        expect(entries[0].noBreak).toBe(false);
    });

    it("falls back to a flagged majority reading when 2 of 3 attempts agree", () => {
        const attempts = [[times(1, 6, [800, 1700])], [times(1, 6, [800, 1700])], [times(1, 6, [800, 1800])]];
        const { entries, warnings } = reconcileAttempts(attempts, "test");
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ times: [800, 1700], guessed: true });
        expect(entries[0].notes).toMatch(/majority reading/);
        expect(warnings).toHaveLength(0);
    });

    it("drops a day with no majority (3-way split) and warns instead of guessing", () => {
        const attempts = [[times(1, 6, [800, 1700])], [times(1, 6, [800, 1800])], [times(1, 6, [900, 1700])]];
        const { entries, warnings } = reconcileAttempts(attempts, "test");
        expect(entries).toHaveLength(0);
        expect(warnings).toHaveLength(1);
        expect(warnings[0].category).toBe("dropped_disagreement");
    });

    it("excludes an implausible clock time from voting instead of treating it as disagreement", () => {
        // 1074 has minutes=74, not a real time — should be filtered out, leaving 2 valid agreeing attempts
        const attempts = [[times(1, 6, [800, 1700])], [times(1, 6, [800, 1700])], [times(1, 6, [1074, 1700])]];
        const { entries, warnings } = reconcileAttempts(attempts, "test");
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ times: [800, 1700], guessed: false });
        expect(warnings).toHaveLength(0);
    });

    it("accepts 2400 as a valid midnight sentinel", () => {
        const attempts = [[times(1, 6, [2200, 2400])], [times(1, 6, [2200, 2400])], [times(1, 6, [2200, 2400])]];
        const { entries } = reconcileAttempts(attempts, "test");
        expect(entries[0].times).toEqual([2200, 2400]);
    });

    it("agrees on a rest day even when the leave-type note text differs", () => {
        const attempts = [[rest(1, 6, "MC")], [rest(1, 6, "M/C")], [rest(1, 6, null)]];
        const { entries } = reconcileAttempts(attempts, "test");
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ rest_day: true, notes: "MC" });
    });

    it("agrees on an hours-only reading", () => {
        const attempts = [[hours(1, 6, 8, 2)], [hours(1, 6, 8, 2)], [hours(1, 6, 8, 2)]];
        const { entries } = reconcileAttempts(attempts, "test");
        expect(entries[0]).toMatchObject({ hoursWorked: 8, otHours: 2 });
    });

    it("excludes an implausible hours-worked value (>=24) from voting", () => {
        const attempts = [[hours(1, 6, 8)], [hours(1, 6, 8)], [hours(1, 6, 28)]];
        const { entries } = reconcileAttempts(attempts, "test");
        expect(entries[0]).toMatchObject({ hoursWorked: 8 });
    });

    it("drops a day when attempts disagree on the data model itself", () => {
        const attempts = [[times(1, 6, [800, 1700])], [rest(1, 6)], [hours(1, 6, 8)]];
        const { entries, warnings } = reconcileAttempts(attempts, "test");
        expect(entries).toHaveLength(0);
        expect(warnings[0].reason).toMatch(/data model itself/);
    });

    it("treats [2200, 600] and [600, 2200] as different readings when orderMatters is true (default)", () => {
        const attempts = [[times(1, 6, [2200, 600])], [times(1, 6, [600, 2200])], [times(1, 6, [2200, 600])]];
        const { entries } = reconcileAttempts(attempts, "test", true, undefined, true);
        // majority of 2/3 agree on [2200, 600]
        expect(entries[0]).toMatchObject({ times: [2200, 600], guessed: true });
    });

    it("treats [2200, 600] and [600, 2200] as the same reading when orderMatters is false", () => {
        const attempts = [[times(1, 6, [2200, 600])], [times(1, 6, [600, 2200])], [times(1, 6, [2200, 600])]];
        const { entries, warnings } = reconcileAttempts(attempts, "test", true, undefined, false);
        expect(entries).toHaveLength(1);
        expect(entries[0].guessed).toBe(false);
        expect(warnings).toHaveLength(0);
    });

    it("accepts a day mentioned by only a subset of attempts when requireFullParticipation is false", () => {
        const attempts = [[times(1, 6, [800, 1700])], []];
        const { entries, warnings } = reconcileAttempts(attempts, "test", false);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ times: [800, 1700], guessed: false });
        expect(warnings).toHaveLength(0);
    });

    it("still requires at least 2 agreeing attempts even with requireFullParticipation true and only one mentions the day", () => {
        const attempts = [[times(1, 6, [800, 1700])], [], []];
        const { entries, warnings } = reconcileAttempts(attempts, "test", true);
        expect(entries).toHaveLength(0);
        expect(warnings).toHaveLength(1);
    });

    it("merges multiple punch-log objects for the same day within one attempt, sorted ascending", () => {
        const attempt: ParsedEntry[] = [times(1, 6, [1700]), times(1, 6, [800])];
        const { entries } = reconcileAttempts([attempt, attempt, attempt], "test");
        expect(entries[0].times).toEqual([800, 1700]);
    });

    it("tags warnings with a YYYY-MM-DD date when year is provided", () => {
        const attempts = [[times(1, 6, [800, 1700])], [times(1, 6, [800, 1800])], [times(1, 6, [900, 1700])]];
        const { warnings } = reconcileAttempts(attempts, "test", true, 2025);
        expect(warnings[0].date).toBe("2025-06-01");
    });
});
