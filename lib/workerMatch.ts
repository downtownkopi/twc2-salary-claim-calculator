import { PARTIAL_FIN_FORMAT } from "./ipa";

export type RosterCandidate = { workerName: string | null; workerIc: string | null };
export type WorkerMatchConfidence = "high" | "low" | "none";
export type WorkerMatchResult = { index: number; confidence: WorkerMatchConfidence; score: number };

/** Lowercases, trims, and collapses internal whitespace — so "  Ang   See Choon" and "ang see choon" compare equal. */
function normalizeName(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Classic Levenshtein edit distance between two strings.
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns The minimum number of single-character insertions/deletions/substitutions to turn `a` into `b`.
 */
function levenshtein(a: string, b: string): number {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
    for (let i = 0; i < rows; i++) d[i][0] = i;
    for (let j = 0; j < cols; j++) d[0][j] = j;
    for (let i = 1; i < rows; i++) {
        for (let j = 1; j < cols; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        }
    }
    return d[rows - 1][cols - 1];
}

// Two independent signals, the better of which wins — a roster row's name can differ from the
// IPA's in ways an edit-distance ratio alone won't catch well (word order swapped between a
// Western "given family" convention and how an agency happened to type it, e.g. "See Choon Ang"
// vs "Ang See Choon"), and ways a token-overlap ratio alone won't catch well (a single misread
// letter inside one word, e.g. "Choon" vs "Choob"). Taking whichever score is higher means either
// kind of near-miss is still recognized, without either check dragging the other's score down.
/**
 * Scores how likely `candidateName` and `targetName` refer to the same person — the higher of a
 * token-overlap score (robust to word-order differences) and a normalized edit-distance score
 * (robust to single-character OCR noise).
 *
 * @param candidateName - A roster row's extracted worker name.
 * @param targetName - The IPA's extracted worker name to match against.
 * @returns A score from 0 (no resemblance) to 1 (identical after normalization).
 */
function nameSimilarity(candidateName: string, targetName: string): number {
    const a = normalizeName(candidateName);
    const b = normalizeName(targetName);
    if (!a || !b) return 0;
    if (a === b) return 1;

    const tokensA = new Set(a.split(" ").filter(Boolean));
    const tokensB = new Set(b.split(" ").filter(Boolean));
    const intersection = [...tokensA].filter(t => tokensB.has(t)).length;
    const union = new Set([...tokensA, ...tokensB]).size;
    const tokenScore = union === 0 ? 0 : intersection / union;

    const distance = levenshtein(a, b);
    const editScore = 1 - distance / Math.max(a.length, b.length);

    return Math.max(tokenScore, editScore);
}

const HIGH_CONFIDENCE_THRESHOLD = 0.75;
const LOW_CONFIDENCE_THRESHOLD = 0.4;
// A guaranteed floor when a roster row's masked IC exactly matches the IPA's masked FIN — a
// partial FIN still carries enough entropy (a few digits + a letter) that an exact match between
// two DIFFERENT workers on the same page is unlikely, so this alone should be enough to call it a
// confident match even if OCR mangled the name badly. Requires a REAL name-similarity signal, not
// just "not literally zero" — the edit-distance half of nameSimilarity alone puts most unrelated
// name pairs of similar length somewhere around 0.15-0.22 purely from length normalization noise
// (confirmed empirically), so a bar that low would let an IC/FIN collision promote a match against
// an essentially unrelated name. 0.3 sits above that noise floor.
const FIN_CORROBORATION_MIN_NAME_SCORE = 0.3;

// Every worker-roster page scan attempt runs this independently against its own extracted rows
// (see lib/reconcile.ts's reconcileRosterAttempts) — an attempt with no confident match contributes
// nothing to that page's result, same "excluded from voting, not a real reading" philosophy
// lib/reconcile.ts already applies to an implausible clock time.
/**
 * Finds which of a roster page's extracted worker rows most likely belongs to the target worker,
 * using fuzzy name matching corroborated by an exact masked-FIN match when available.
 *
 * @param candidates - This attempt's extracted worker rows (name + IC only).
 * @param targetName - The IPA's extracted worker name.
 * @param targetFin - The IPA's extracted (possibly masked) FIN, or `null` if not available.
 * @returns The best-scoring candidate's index/confidence/score, or `null` if `candidates` is empty.
 */
export function matchWorker(candidates: RosterCandidate[], targetName: string | null, targetFin: string | null): WorkerMatchResult | null {
    if (candidates.length === 0) return null;

    const normalizedTargetFin = targetFin && PARTIAL_FIN_FORMAT.test(targetFin) ? targetFin.toLowerCase() : null;

    let best: WorkerMatchResult = { index: -1, confidence: "none", score: 0 };
    candidates.forEach((c, index) => {
        const nameScore = targetName && c.workerName ? nameSimilarity(c.workerName, targetName) : 0;
        const finMatches = normalizedTargetFin !== null && c.workerIc !== null && c.workerIc.trim().toLowerCase() === normalizedTargetFin;

        let score = nameScore;
        let confidence: WorkerMatchConfidence =
            score >= HIGH_CONFIDENCE_THRESHOLD ? "high" : score >= LOW_CONFIDENCE_THRESHOLD ? "low" : "none";

        if (finMatches && nameScore >= FIN_CORROBORATION_MIN_NAME_SCORE) {
            score = Math.max(score, HIGH_CONFIDENCE_THRESHOLD);
            confidence = "high";
        }

        if (score > best.score) best = { index, confidence, score };
    });

    return best.index === -1 ? null : best;
}
