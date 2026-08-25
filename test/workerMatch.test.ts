import { describe, expect, it } from "vitest";
import { matchWorker, type RosterCandidate } from "../lib/workerMatch";

describe("matchWorker", () => {
    it("returns null when there are no candidates", () => {
        expect(matchWorker([], "Ang See Choon", null)).toBeNull();
    });

    it("finds an exact name match with high confidence", () => {
        const candidates: RosterCandidate[] = [
            { workerName: "Thiri Myat Noe", workerIc: "396L" },
            { workerName: "Ang See Choon", workerIc: "925A" },
        ];
        const result = matchWorker(candidates, "Ang See Choon", null);
        expect(result).toMatchObject({ index: 1, confidence: "high" });
    });

    it("tolerates a single-character OCR typo via edit distance", () => {
        const candidates: RosterCandidate[] = [{ workerName: "Ang See Choob", workerIc: "925A" }];
        const result = matchWorker(candidates, "Ang See Choon", null);
        expect(result).toMatchObject({ index: 0, confidence: "high" });
    });

    it("matches reordered name tokens via token overlap", () => {
        const candidates: RosterCandidate[] = [{ workerName: "See Choon Ang", workerIc: "925A" }];
        const result = matchWorker(candidates, "Ang See Choon", null);
        expect(result).toMatchObject({ index: 0, confidence: "high" });
    });

    it("returns no confident match for a completely different name with no FIN corroboration", () => {
        const candidates: RosterCandidate[] = [{ workerName: "Nyein Chan Aung", workerIc: "311M" }];
        const result = matchWorker(candidates, "Ang See Choon", "925A");
        expect(result?.confidence).toBe("none");
    });

    it("promotes a borderline name match to high confidence when the partial FIN matches exactly", () => {
        // "Ang See" vs "Ang C Choon" shares one token ("Ang") — a real but weak signal on its own,
        // not enough to cross the high-confidence bar by name alone.
        const candidates: RosterCandidate[] = [{ workerName: "Ang C Choon", workerIc: "925A" }];
        const weak = matchWorker(candidates, "Ang See", null);
        expect(weak?.confidence).not.toBe("high");

        const corroborated = matchWorker(candidates, "Ang See", "925A");
        expect(corroborated).toMatchObject({ index: 0, confidence: "high" });
    });

    it("does not let an exact FIN match alone override a near-zero name score", () => {
        const candidates: RosterCandidate[] = [{ workerName: "Completely Different Person", workerIc: "925A" }];
        const result = matchWorker(candidates, "Ang See Choon", "925A");
        expect(result?.confidence).not.toBe("high");
    });

    it("ignores a FIN that isn't in the masked partial format", () => {
        const candidates: RosterCandidate[] = [{ workerName: "Someone Else", workerIc: "G1234567X" }];
        const result = matchWorker(candidates, "Ang See Choon", "G1234567X");
        // full (non-masked) FIN format isn't corroborated by this function — name alone must carry it
        expect(result?.confidence).toBe("none");
    });

    it("picks the best-scoring candidate among several", () => {
        const candidates: RosterCandidate[] = [
            { workerName: "Nyein Chan Aung", workerIc: "311M" },
            { workerName: "Ang See Choon", workerIc: "925A" },
            { workerName: "Thet Naung Oo", workerIc: "845P" },
        ];
        const result = matchWorker(candidates, "Ang See Choon", "925A");
        expect(result).toMatchObject({ index: 1, confidence: "high" });
    });

    it("returns null when neither target name nor FIN is available (nothing to score against)", () => {
        const candidates: RosterCandidate[] = [{ workerName: "Ang See Choon", workerIc: "925A" }];
        const result = matchWorker(candidates, null, null);
        expect(result).toBeNull();
    });
});
