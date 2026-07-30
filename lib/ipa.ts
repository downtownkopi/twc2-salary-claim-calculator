import { sendVisionRequest, extractJsonBlock } from "./ocr";

export type IpaAmount = { type: string; amount: number };

// Every field mirrors one line of the IPA's own declared terms — no field here is ever computed
// from another (e.g. hourlyBasicRate is never derived by dividing basicMonthlySalary ourselves).
// A claim's downstream OT/PH math and discrepancy checks (declared OT rate vs statutory minimum,
// allowances/deductions vs what the payslip/bank statement actually shows) depend on these being
// exactly what MOM has on record, not a plausible-looking estimate.
export type IpaFields = {
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

function normalizeAmounts(v: unknown): IpaAmount[] {
    if (!Array.isArray(v)) return [];
    return v
        .filter((x): x is { type: unknown; amount: unknown } => typeof x === "object" && x !== null)
        .map(x => ({
            type: typeof x.type === "string" ? x.type : "unspecified",
            amount: typeof x.amount === "number" ? x.amount : 0,
        }));
}

function num(v: unknown): number | null {
    return typeof v === "number" ? v : null;
}

function str(v: unknown): string | null {
    return typeof v === "string" && v.trim() ? v.trim() : null;
}

// Single deterministic pass (temperature 0), no multi-attempt reconciliation — unlike a dense
// handwritten timesheet table, an IPA is one MOM-issued, mostly-printed page with a small,
// well-labeled set of fields, so the row-repetition/pattern-completion failure mode that
// motivates timecard's 3x-temperature reconciliation (server.ts) doesn't apply here.
export async function extractIpaFields(base64Image: string): Promise<{ fields: IpaFields; cost: number }> {
    const { content, cost } = await sendVisionRequest(base64Image, PROMPT, 0, 42, 2000);
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

    const fields: IpaFields = {
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
        notes: str(parsed.notes),
    };

    return { fields, cost };
}
