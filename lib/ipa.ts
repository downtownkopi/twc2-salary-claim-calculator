import { sendVisionRequest, extractJsonBlock } from "./ocr";

export type IpaAmount = { type: string; amount: number };

// Every field mirrors one line of the IPA's own declared terms — no field here is ever computed
// from another (e.g. hourlyBasicRate is never derived by dividing basicMonthlySalary ourselves).
// A claim's downstream OT/PH math and discrepancy checks (declared OT rate vs statutory minimum,
// allowances/deductions vs what the payslip/bank statement actually shows) depend on these being
// exactly what MOM has on record, not a plausible-looking estimate.
export type IpaFields = {
    workerName: string | null;
    workerFin: string | null;
    employerName: string | null;
    employerUen: string | null;
    occupation: string | null;
    sector: string | null;
    basicMonthlySalary: number | null;
    fixedMonthlyAllowances: IpaAmount[];
    fixedMonthlyDeductions: IpaAmount[];
    dailyBasicRate: number | null;
    hourlyBasicRate: number | null;
    otRate: number | null; // hourly OT rate declared to MOM, SGD
    workingHoursPerDay: number | null;
    workingDaysPerWeek: number | null;
    wpValidityStart: string | null; // YYYY-MM-DD
    wpValidityEnd: string | null;
    notes: string | null;
};

const PROMPT = `This is a Singapore Ministry of Manpower (MOM) In-Principle Approval (IPA) letter for a Work Permit (WP) holder. It states the employment terms the employer declared when applying for the worker's Work Permit — used here to later check whether the worker was actually paid what was declared.

Read the ENTIRE document and extract exactly these fields. If a field is not stated anywhere on the document, output null for it — do NOT guess, estimate, or calculate a value that isn't directly printed/written.

- workerName: the Work Permit holder's own full name as printed (not the employer's name)
- workerFin: the worker's FIN (Foreign Identification Number). Exactly one letter, then digits only, then exactly one letter — e.g. "G1234567X". Never two letters together at the start or end (e.g. "GB1234567X" is wrong — re-read the character, it's a single letter that only looks like two, often a serif "G" or a smudge next to it). A partial/masked FIN such as "419K" (digits then one letter, front letter cut off) is fine as printed. If what's printed doesn't fit "1 letter + digits + 1 letter" even after a careful re-read, still output exactly what's printed, but say so in notes so a human re-checks it.
- employerName: company name
- employerUen: company UEN (Unique Entity Number, Singapore business registration format, e.g. "201512345A")
- occupation: job title as stated, e.g. "General Worker", "Welder", "Construction Worker"
- sector: industry sector as stated, e.g. "Construction", "Marine", "Manufacturing", "Process"
- basicMonthlySalary: worker's fixed basic monthly salary in SGD, before overtime, as a plain number (no currency symbol, no commas)
- fixedMonthlyAllowances: array of {type, amount} — one entry per fixed monthly allowance stated (e.g. food, housing, transport, attendance). [] if none are stated.
- fixedMonthlyDeductions: array of {type, amount} — one entry per fixed monthly deduction declared. [] if none are stated.
- dailyBasicRate: daily basic rate in SGD as a number, or null if not separately stated
- hourlyBasicRate: hourly basic rate in SGD as a number, or null if not separately stated
- otRate: the hourly overtime rate declared to MOM, in SGD, as a number, or null if not stated
- workingHoursPerDay: normal working hours per day, as a number, or null if not stated
- workingDaysPerWeek: normal working days per week, as a number, or null if not stated
- wpValidityStart: Work Permit validity start date, YYYY-MM-DD, or null if not stated
- wpValidityEnd: Work Permit validity end date, YYYY-MM-DD, or null if not stated
- notes: null normally. If anything is illegible, ambiguous, or contradictory, or you filled in a value you're not fully confident about, explain briefly here so a human can review.

Every numeric value must be exactly what is printed or written on the document. Never infer one field from another — e.g. if hourlyBasicRate isn't separately printed, leave it null even though it could in theory be derived from basicMonthlySalary; that derivation is a downstream calculation, not something to do here.

Output ONLY a valid JSON object with exactly these fields, no markdown fences, no other text.`;

/**
 * Coerces the model's `fixedMonthlyAllowances`/`fixedMonthlyDeductions` output into a clean
 * `IpaAmount[]`, discarding anything malformed rather than throwing.
 *
 * @param v - The raw parsed JSON value for the field.
 * @returns A valid `IpaAmount[]`, `[]` if `v` isn't an array at all.
 */
function normalizeAmounts(v: unknown): IpaAmount[] {
    if (!Array.isArray(v)) return [];
    return v
        .filter((x): x is { type: unknown; amount: unknown } => typeof x === "object" && x !== null)
        .map(x => ({
            type: typeof x.type === "string" ? x.type : "unspecified",
            amount: typeof x.amount === "number" ? x.amount : 0,
        }));
}

/** Coerces a value to a number, or `null` if it isn't one. */
function num(v: unknown): number | null {
    return typeof v === "number" ? v : null;
}

/** Coerces a value to a trimmed, non-empty string, or `null` otherwise. */
function str(v: unknown): string | null {
    return typeof v === "string" && v.trim() ? v.trim() : null;
}

// A real (or partial/masked) FIN is one letter, then digits only, then one letter — never two
// letters in a row at either end. Checked here rather than trusted from the prompt alone, since a
// model misread (e.g. "GB495419K", a genuine "G" plus an extra letter) is exactly the kind of
// error a re-read instruction alone doesn't reliably catch.
const FIN_FORMAT = /^[A-Za-z]\d+[A-Za-z]$/;
const PARTIAL_FIN_FORMAT = /^\d+[A-Za-z]$/; // masked front letter, e.g. "419K"

/**
 * Flags (via the notes string, without discarding the value) a FIN that doesn't match the
 * expected "1 letter + digits + 1 letter" (or masked "digits + 1 letter") shape.
 *
 * @param fin - The extracted FIN, already passed through {@link fixFinDigitB}.
 * @param existingNotes - Any notes the model already produced, to append to rather than overwrite.
 * @returns `existingNotes` unchanged if the FIN looks valid, otherwise `existingNotes` with a flag appended.
 */
function checkFinFormat(fin: string | null, existingNotes: string | null): string | null {
    if (fin === null || FIN_FORMAT.test(fin) || PARTIAL_FIN_FORMAT.test(fin)) return existingNotes;
    const flag = `workerFin "${fin}" doesn't match the expected FIN format (1 letter, then digits only, then 1 letter) — please verify against the source document.`;
    return existingNotes ? `${existingNotes} ${flag}` : flag;
}

// "B" and "8" are the single most common OCR mix-up in the digit run of a FIN — the digit portion
// is everything except the leading/trailing letter, so only that middle stretch gets corrected,
// never the two real letters framing it (or a partial/masked FIN's single trailing letter).
/**
 * Corrects the single most common OCR mix-up in a FIN's digit run: a misread `B` where an `8`
 * belongs. Only touches the middle (digit) portion, never the framing letter(s).
 *
 * @param fin - The raw extracted FIN, or `null`.
 * @returns The corrected FIN, or the original value unchanged if too short/`null` to have a middle.
 */
function fixFinDigitB(fin: string | null): string | null {
    if (fin === null || fin.length < 2) return fin;
    const middle = fin.slice(1, -1).replace(/B/g, "8");
    return fin[0] + middle + fin[fin.length - 1];
}

// Single deterministic pass (temperature 0), no multi-attempt reconciliation — unlike a dense
// handwritten timesheet table, an IPA is one MOM-issued, mostly-printed page with a small,
// well-labeled set of fields, so the row-repetition/pattern-completion failure mode that
// motivates timecard's 3x-temperature reconciliation (server.ts) doesn't apply here.
/**
 * Extracts a Work Permit IPA letter's declared employment terms from a single page image.
 *
 * @param base64Image - The IPA letter's first page image, base64-encoded (no data URL prefix).
 * @returns The extracted fields (each `null` if not printed on the document — never inferred),
 * and this call's cost in USD.
 * @throws If the model's reply can't be parsed as a JSON object.
 */
export async function extractIpaFields(base64Image: string): Promise<{ fields: IpaFields; cost: number }> {
    // 2000 was enough for qwen/gemini but produced "Unexpected end of JSON input" (mid-object
    // truncation, not empty output) once the default model moved to xiaomi/mimo-v2.5 — same
    // reasoning-overhead-eats-the-budget failure mode extractPageContext and verifyDatesOnPage were
    // already bumped for, just landing here too now that this 15-field object (including two
    // variable-length allowance/deduction arrays) gives it more to genuinely say. Bumped with real
    // headroom rather than the smallest number that happened to pass one test.
    const { content, cost } = await sendVisionRequest(base64Image, PROMPT, 0, 42, 4000);
    let parsed: any;
    try {
        parsed = JSON.parse(extractJsonBlock(content));
    } catch (e: any) {
        // The raw model reply is logged server-side in full (can be long) and echoed back
        // truncated in the thrown message (server.ts surfaces this as ipaWarning) — a bare
        // "Unexpected token" error gives no way to tell whether the model wrapped the JSON in
        // prose, emitted two objects, or something else entirely without re-running the request.
        console.error("extractIpaFields: failed to parse model output as JSON. Raw content:\n", content);
        throw new Error(`${e.message} — raw reply started with: ${content.slice(0, 200)}`);
    }

    const workerFin = fixFinDigitB(str(parsed.workerFin));

    const fields: IpaFields = {
        workerName: str(parsed.workerName),
        workerFin,
        employerName: str(parsed.employerName),
        employerUen: str(parsed.employerUen),
        occupation: str(parsed.occupation),
        sector: str(parsed.sector),
        basicMonthlySalary: num(parsed.basicMonthlySalary),
        fixedMonthlyAllowances: normalizeAmounts(parsed.fixedMonthlyAllowances),
        fixedMonthlyDeductions: normalizeAmounts(parsed.fixedMonthlyDeductions),
        dailyBasicRate: num(parsed.dailyBasicRate),
        hourlyBasicRate: num(parsed.hourlyBasicRate),
        otRate: num(parsed.otRate),
        workingHoursPerDay: num(parsed.workingHoursPerDay),
        workingDaysPerWeek: num(parsed.workingDaysPerWeek),
        wpValidityStart: str(parsed.wpValidityStart),
        wpValidityEnd: str(parsed.wpValidityEnd),
        notes: checkFinFormat(workerFin, str(parsed.notes)),
    };

    return { fields, cost };
}
