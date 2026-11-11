// Golden-master regression harness for the OCR agent loop (lib/ocr/agentLoop.ts).
//
// There is no hand-labeled ground-truth dataset for this pipeline yet — building one requires a
// human to verify real wage-claim documents field by field, which this script cannot do safely on
// its own. Instead this is a *regression* harness: each fixture's golden.json is a snapshot of
// what the pipeline actually produced on a real page, reviewed/corrected by a human once, then
// committed. Re-running the harness re-scans the same page and flags any drift from that snapshot
// (from a prompt edit, model swap, or temperature change) plus hard schema/plausibility violations
// that are never acceptable regardless of the snapshot.
//
// Usage:
//   npx tsx scripts/eval.ts                              run all fixtures, report drift
//   npx tsx scripts/eval.ts --record <id> <pdf> <page>    extract a page + scan it once, write/overwrite
//                                                          test/eval/fixtures/<id>/{page.png,meta.json,golden.json}
//                                                          (--worker-name / --worker-fin optional)
//
// After --record, open golden.json and fix anything the model got wrong before trusting it as the
// baseline — the harness only tells you when later runs disagree with the FILE, not with reality.
//
// test/eval/fixtures/ is gitignored: page.png/golden.json/meta.json are extracted straight from
// real wage-claim documents and can carry worker PII (name, FIN, IC), same reason sample-data/
// itself is never committed. Fixtures are local-only.
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import * as path from "path";
import { pdfToImages } from "../lib/ocr/images";
import { runAgentLoop, type AgentLoopTerminal } from "../lib/ocr/agentLoop";
import { isPlausibleHours, isPlausibleTime } from "../lib/reconcile";

const FIXTURES_DIR = path.join(__dirname, "..", "test", "eval", "fixtures");

type Meta = { targetWorker: { name: string | null; fin: string | null } };

function parseArgs(argv: string[]) {
    const recordIdx = argv.indexOf("--record");
    if (recordIdx === -1) return { mode: "run" as const };
    const [id, pdf, pageStr] = argv.slice(recordIdx + 1, recordIdx + 4);
    if (!id || !pdf || !pageStr) {
        throw new Error("--record requires <id> <pdfPath> <pageIndex>");
    }
    const nameIdx = argv.indexOf("--worker-name");
    const finIdx = argv.indexOf("--worker-fin");
    return {
        mode: "record" as const,
        id,
        pdf,
        page: Number(pageStr),
        workerName: nameIdx !== -1 ? argv[nameIdx + 1] : null,
        workerFin: finIdx !== -1 ? argv[finIdx + 1] : null,
    };
}

async function record(id: string, pdfPath: string, pageIndex: number, workerName: string | null, workerFin: string | null) {
    const fixtureDir = path.join(FIXTURES_DIR, id);
    await mkdir(fixtureDir, { recursive: true });

    const tmpDir = path.join(fixtureDir, ".pages-tmp");
    const pages = await pdfToImages(pdfPath, tmpDir);
    const base64 = await pages.get(pageIndex);
    await writeFile(path.join(fixtureDir, "page.png"), Buffer.from(base64, "base64"));
    await pages.cleanup();

    const meta: Meta = { targetWorker: { name: workerName, fin: workerFin } };
    await writeFile(path.join(fixtureDir, "meta.json"), JSON.stringify(meta, null, 2));

    const result = await scanFixture(fixtureDir, meta);
    const { events, cost, ...terminal } = result;
    await writeFile(path.join(fixtureDir, "golden.json"), JSON.stringify(terminal, null, 2));

    console.log(`Recorded ${id}: shapeFamily=${result.shapeFamily}, cost=$${cost.toFixed(4)}`);
    console.log(`Review ${path.join(fixtureDir, "golden.json")} and fix any misreads before trusting it as a baseline.`);
}

async function scanFixture(fixtureDir: string, meta: Meta) {
    const base64 = (await readFile(path.join(fixtureDir, "page.png"))).toString("base64");
    return runAgentLoop(
        base64,
        fixtureDir,
        0,
        0,
        42,
        meta.targetWorker,
        () => {},
        () => {}
    );
}

// Flags values that are structurally impossible regardless of what the golden file says — these
// fail the harness even on a fixture with no drift at all, since no baseline should ever contain
// them (same checks lib/reconcile.ts applies before trusting a vote).
function plausibilityViolations(terminal: AgentLoopTerminal): string[] {
    const problems: string[] = [];
    const checkEntry = (times: number[] | null, hoursWorked: number | null, otHours: number | null, where: string) => {
        if (times) {
            for (const t of times) if (!isPlausibleTime(t)) problems.push(`${where}: implausible clock time ${t}`);
        }
        if (hoursWorked !== null && !isPlausibleHours(hoursWorked, false)) problems.push(`${where}: implausible hoursWorked ${hoursWorked}`);
        if (otHours !== null && !isPlausibleHours(otHours, true)) problems.push(`${where}: implausible otHours ${otHours}`);
    };

    if (terminal.shapeFamily === "one_worker_many_dates") {
        for (const r of terminal.rows) checkEntry(r.times, r.hoursWorked, r.otHours, `day ${r.month}/${r.day}`);
    } else if (terminal.shapeFamily === "many_workers_many_dates") {
        for (const w of terminal.rows.workers) {
            for (const c of w.cells) checkEntry(c.times, c.hoursWorked, c.otHours, `${w.workerName ?? "?"} day ${c.month}/${c.day}`);
        }
    } else if (terminal.shapeFamily === "one_date_many_workers") {
        for (const w of terminal.rows.workers) {
            if (w.actualTimeIn !== null && !isPlausibleTime(w.actualTimeIn)) problems.push(`${w.workerName ?? "?"}: implausible actualTimeIn ${w.actualTimeIn}`);
            if (w.actualTimeOut !== null && !isPlausibleTime(w.actualTimeOut)) problems.push(`${w.workerName ?? "?"}: implausible actualTimeOut ${w.actualTimeOut}`);
        }
    }
    return problems;
}

// Only the fields that actually matter for a wage claim are compared — notes (free text, legitimately
// reworded between runs even when the reading is identical) and bbox (a best-effort visual estimate,
// not a claim about the data) are dropped before diffing, so the harness flags real drift in what
// was extracted, not incidental rewording of a correct answer.
function stripCosmetic(entry: Record<string, unknown>): Record<string, unknown> {
    const { notes, bbox, ...rest } = entry;
    return rest;
}

function diffTerminal(golden: AgentLoopTerminal, actual: AgentLoopTerminal): string[] {
    if (golden.shapeFamily !== actual.shapeFamily) {
        return [`shapeFamily changed: ${golden.shapeFamily} -> ${actual.shapeFamily}`];
    }
    const diffs: string[] = [];

    const normalize = (terminal: AgentLoopTerminal): unknown => {
        if (terminal.shapeFamily === "one_worker_many_dates") return terminal.rows.map(stripCosmetic);
        if (terminal.shapeFamily === "one_date_many_workers") {
            return { day: terminal.rows.day, month: terminal.rows.month, workers: terminal.rows.workers.map(stripCosmetic) };
        }
        if (terminal.shapeFamily === "many_workers_many_dates") {
            return terminal.rows.workers.map(w => ({ workerName: w.workerName, workerIc: w.workerIc, cells: w.cells.map(stripCosmetic) }));
        }
        return (terminal as { reason: string }).reason;
    };

    const a = JSON.stringify(normalize(golden));
    const b = JSON.stringify(normalize(actual));
    if (a !== b) diffs.push(`rows/reason differ from golden.json on the fields that matter (day/month/times/hoursWorked/otHours/rest_day) — run --record to inspect, or diff manually`);
    return diffs;
}

async function run() {
    const ids = (await readdir(FIXTURES_DIR, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
    if (ids.length === 0) {
        console.log(`No fixtures in ${FIXTURES_DIR}. Create one with: npx tsx scripts/eval.ts --record <id> <pdf> <pageIndex>`);
        return;
    }

    let failures = 0;
    let totalCost = 0;
    for (const id of ids) {
        const fixtureDir = path.join(FIXTURES_DIR, id);
        const meta: Meta = JSON.parse(await readFile(path.join(fixtureDir, "meta.json"), "utf8"));
        const golden: AgentLoopTerminal = JSON.parse(await readFile(path.join(fixtureDir, "golden.json"), "utf8"));

        const result = await scanFixture(fixtureDir, meta);
        totalCost += result.cost;
        const { events, cost, ...actual } = result;

        const violations = plausibilityViolations(actual);
        const drift = diffTerminal(golden, actual);

        if (violations.length === 0 && drift.length === 0) {
            console.log(`PASS ${id}`);
        } else {
            failures++;
            console.log(`FAIL ${id}`);
            for (const v of violations) console.log(`  [plausibility] ${v}`);
            for (const d of drift) console.log(`  [drift] ${d}`);
        }
    }

    console.log(`\n${ids.length - failures}/${ids.length} fixtures passed. Total scan cost: $${totalCost.toFixed(4)}`);
    if (failures > 0) process.exitCode = 1;
}

const args = parseArgs(process.argv.slice(2));
if (args.mode === "record") {
    record(args.id, args.pdf, args.page, args.workerName, args.workerFin).catch(err => {
        console.error(err);
        process.exitCode = 1;
    });
} else {
    run().catch(err => {
        console.error(err);
        process.exitCode = 1;
    });
}
