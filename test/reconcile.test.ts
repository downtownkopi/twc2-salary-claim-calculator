import { describe, expect, it } from "vitest";
import { reconcileAttempts, reconcileRosterAttempts, type ParsedEntry, type RosterPageAttempt, type RosterRow } from "../lib/reconcile";

function times(day: number, month: number, t: number[], overrides: Partial<ParsedEntry> = {}): ParsedEntry {
    return { day, month, year: null, times: t, hoursWorked: null, otHours: null, noBreak: null, guessed: null, rest_day: null, notes: null, bbox: null, ...overrides };
}

function rosterRow(overrides: Partial<RosterRow> = {}): RosterRow {
    return { workerName: null, workerIc: null, actualTimeIn: null, actualTimeOut: null, mealBreakHours: null, struckThrough: false, notes: null, ...overrides };
}

function rosterAttempt(workers: RosterRow[], day: number | null = 14, month: number | null = 10): RosterPageAttempt {
    return { day, month, workers };
}

function rest(day: number, month: number, notes: string | null = null): ParsedEntry {
    return { day, month, year: null, times: null, hoursWorked: null, otHours: null, noBreak: null, guessed: null, rest_day: true, notes, bbox: null };
}

function hours(day: number, month: number, hoursWorked: number, otHours: number | null = null): ParsedEntry {
    return { day, month, year: null, times: null, hoursWorked, otHours, noBreak: null, guessed: null, rest_day: null, notes: null, bbox: null };
}

describe("reconcileAttempts", () => {
    it("accepts a day when all attempts agree on times", () => {
        const attempts = [[times(1, 6, [800, 1700])], [times(1, 6, [800, 1700])], [times(1, 6, [800, 1700])]];
        const { entries, warnings } = reconcileAttempts(attempts, "test");
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ day: 1, month: 6, times: [800, 1700], guessed: false, rest_day: false });
        expect(warnings).toHaveLength(0);
    });

    it("treats a trailing 0 as equivalent to 2400 (both mean shift ends at midnight)", () => {
        const attempts = [[times(3, 3, [800, 2400])], [times(3, 3, [800, 0])], [times(3, 3, [800, 2400])]];
        const { entries, warnings } = reconcileAttempts(attempts, "test");
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ day: 3, month: 3, times: [800, 2400], guessed: false });
        expect(warnings).toHaveLength(0);
    });

    it("does not normalize a leading 0 (a genuine midnight shift START is a different claim)", () => {
        const attempts = [[times(3, 3, [0, 800])], [times(3, 3, [0, 800])], [times(3, 3, [0, 800])]];
        const { entries } = reconcileAttempts(attempts, "test");
        expect(entries[0].times).toEqual([0, 800]);
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

    it("defaults to 08:00-17:00 when there's no majority (3-way split), instead of dropping the day", () => {
        const attempts = [[times(1, 6, [800, 1700])], [times(1, 6, [800, 1800])], [times(1, 6, [900, 1700])]];
        const { entries, warnings } = reconcileAttempts(attempts, "test");
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ times: [800, 1700], guessed: true });
        expect(entries[0].notes).toMatch(/defaulted to 08:00/);
        expect(warnings).toHaveLength(0);
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

    it("defaults to 08:00-17:00 when attempts disagree on the data model itself, instead of dropping the day", () => {
        const attempts = [[times(1, 6, [800, 1700])], [rest(1, 6)], [hours(1, 6, 8)]];
        const { entries, warnings } = reconcileAttempts(attempts, "test");
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ times: [800, 1700], guessed: true });
        expect(entries[0].notes).toMatch(/data model itself/);
        expect(warnings).toHaveLength(0);
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

    it("still requires at least 2 agreeing attempts even with requireFullParticipation true and only one mentions the day — defaults instead of dropping", () => {
        const attempts = [[times(1, 6, [800, 1700])], [], []];
        const { entries, warnings } = reconcileAttempts(attempts, "test", true);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ times: [800, 1700], guessed: true });
        expect(warnings).toHaveLength(0);
    });

    it("merges multiple punch-log objects for the same day within one attempt, sorted ascending", () => {
        const attempt: ParsedEntry[] = [times(1, 6, [1700]), times(1, 6, [800])];
        const { entries } = reconcileAttempts([attempt, attempt, attempt], "test");
        expect(entries[0].times).toEqual([800, 1700]);
    });

    it("keeps each entry's own printed year when a page's table spans a year boundary (e.g. a duty-roster week running 29/12/25 through 4/1/26)", () => {
        const dec31 = times(31, 12, [800, 1700], { year: 2025 });
        const jan1 = times(1, 1, [900, 1800], { year: 2026 });
        const attempts = [[dec31, jan1], [dec31, jan1], [dec31, jan1]];
        const { entries } = reconcileAttempts(attempts, "test");
        expect(entries).toHaveLength(2);
        const dec = entries.find(e => e.day === 31 && e.month === 12);
        const jan = entries.find(e => e.day === 1 && e.month === 1);
        expect(dec?.year).toBe(2025);
        expect(jan?.year).toBe(2026);
    });

    it("leaves year null when no attempt reports one (the overwhelming majority of real pages)", () => {
        const attempts = [[times(1, 6, [800, 1700])], [times(1, 6, [800, 1700])], [times(1, 6, [800, 1700])]];
        const { entries } = reconcileAttempts(attempts, "test");
        expect(entries[0].year).toBeNull();
    });

});

describe("reconcileRosterAttempts", () => {
    it("accepts a unanimous match across all attempts", () => {
        const attempt = () =>
            rosterAttempt([
                rosterRow({ workerName: "Shun Lae Thiri", workerIc: "442P" }),
                rosterRow({ workerName: "Ang See Choon", workerIc: "925A", actualTimeIn: 900, actualTimeOut: 1830, mealBreakHours: 0.5 }),
            ]);
        const { date, entry, allRows, warnings } = reconcileRosterAttempts([attempt(), attempt(), attempt()], "roster.pdf p1", "Ang See Choon", "925A", 2025);
        expect(date).toEqual({ day: 14, month: 10 });
        expect(entry).toMatchObject({ day: 14, month: 10, actualTimeIn: 900, actualTimeOut: 1830, mealBreakHours: 0.5, guessed: false, matchConfidence: "high" });
        expect(allRows[entry!.matchedRowIndex].workerName).toBe("Ang See Choon");
        expect(warnings).toHaveLength(0);
    });

    it("falls back to a flagged majority reading when 2 of 3 attempts agree on the matched row's times", () => {
        const target = (timeOut: number) => rosterRow({ workerName: "Ang See Choon", workerIc: "925A", actualTimeIn: 900, actualTimeOut: timeOut });
        const attempts = [
            rosterAttempt([target(1830)]),
            rosterAttempt([target(1830)]),
            rosterAttempt([target(1900)]),
        ];
        const { entry } = reconcileRosterAttempts(attempts, "roster.pdf p1", "Ang See Choon", "925A", 2025);
        expect(entry).toMatchObject({ actualTimeOut: 1830, guessed: true });
        expect(entry!.notes).toMatch(/majority reading/);
    });

    it("defaults to 08:00-17:00 (but still reports the match) when confident attempts disagree with no majority", () => {
        const attempts = [
            rosterAttempt([rosterRow({ workerName: "Ang See Choon", workerIc: "925A", actualTimeIn: 900, actualTimeOut: 1830 })]),
            rosterAttempt([rosterRow({ workerName: "Ang See Choon", workerIc: "925A", actualTimeIn: 900, actualTimeOut: 1900 })]),
        ];
        const { entry, warnings } = reconcileRosterAttempts(attempts, "roster.pdf p1", "Ang See Choon", "925A", 2025);
        expect(entry).toMatchObject({ actualTimeIn: 800, actualTimeOut: 1700, guessed: true, matchConfidence: "high" });
        expect(entry!.notes).toMatch(/defaulted to 08:00/);
        expect(warnings.some(w => w.category === "dropped_disagreement")).toBe(false);
    });

    it("reports no entry (needs manual pick) when no attempt confidently matches the target worker", () => {
        const attempts = [
            rosterAttempt([rosterRow({ workerName: "Nyein Chan Aung", workerIc: "311M", actualTimeIn: 700, actualTimeOut: 1900 })]),
        ];
        const { entry, allRows, warnings } = reconcileRosterAttempts(attempts, "roster.pdf p1", "Ang See Choon", "925A", 2025);
        expect(entry).toBeNull();
        expect(allRows).toHaveLength(1);
        expect(warnings.some(w => w.category === "flagged_review" && /pick the correct row manually/.test(w.reason))).toBe(true);
    });

    it("reports no date and no entry when no attempt can determine the page's date", () => {
        const attempts = [rosterAttempt([rosterRow({ workerName: "Ang See Choon", workerIc: "925A" })], null, null)];
        const { date, entry, warnings } = reconcileRosterAttempts(attempts, "roster.pdf p1", "Ang See Choon", "925A", 2025);
        expect(date).toBeNull();
        expect(entry).toBeNull();
        expect(warnings[0].category).toBe("system");
    });

    it("excludes struck-through rows from matching and from allRows", () => {
        const attempts = [
            rosterAttempt([rosterRow({ workerName: "Ang See Choon", workerIc: "925A", actualTimeIn: 900, actualTimeOut: 1830, struckThrough: true })]),
        ];
        const { entry, allRows } = reconcileRosterAttempts(attempts, "roster.pdf p1", "Ang See Choon", "925A", 2025);
        expect(entry).toBeNull();
        expect(allRows).toHaveLength(0);
    });

    it("flags a single confidently-matching attempt as still needing verification", () => {
        const attempts = [
            rosterAttempt([rosterRow({ workerName: "Ang See Choon", workerIc: "925A", actualTimeIn: 900, actualTimeOut: 1830 })]),
            rosterAttempt([rosterRow({ workerName: "Someone Else", workerIc: "111Z" })]),
            rosterAttempt([rosterRow({ workerName: "Someone Else Too", workerIc: "222Y" })]),
        ];
        const { entry } = reconcileRosterAttempts(attempts, "roster.pdf p1", "Ang See Choon", "925A", 2025);
        expect(entry).toMatchObject({ actualTimeIn: 900, actualTimeOut: 1830, guessed: true });
        expect(entry!.notes).toMatch(/only one scan attempt/);
    });

    it("dedupes allRows by worker name across attempts", () => {
        const attempts = [
            rosterAttempt([rosterRow({ workerName: "Ang See Choon", workerIc: "925A" }), rosterRow({ workerName: "Thet Naung Oo", workerIc: "845P" })]),
            rosterAttempt([rosterRow({ workerName: "Ang See Choon", workerIc: "925A" }), rosterRow({ workerName: "Thet Naung Oo", workerIc: "845P" })]),
        ];
        const { allRows } = reconcileRosterAttempts(attempts, "roster.pdf p1", "Ang See Choon", "925A", 2025);
        expect(allRows).toHaveLength(2);
    });
});
