import { sendVisionRequestWithTools, PRIMARY_VISION_MODEL, type VisionMessage, type VisionTool, type VisionToolCall } from "./visionClient";
import { cropRegion } from "./images";
import type { ParsedEntry, RosterPageAttempt } from "../reconcile";

// Replaces extractPageContext's fixed dataModel classification (lib/ocr/pageScan.ts) for page
// SHAPE discovery. Rather than a single deterministic call funneling every page into one of a
// fixed, hand-maintained enum, the model gets tools and explores the page itself — cropping in
// when unsure, checking who the target worker is, describing what it found — across several turns
// before committing to an answer. This is what lets a genuinely new page shape (one the 4-way
// enum never anticipated) get handled at all, instead of silently misread.
//
// Deliberately narrower in scope than it might look: this loop only decides WHAT SHAPE the page is
// and extracts rows in that shape's existing schema (ParsedEntry[] or RosterPageAttempt-shaped
// worker rows) — it does NOT replace the deterministic 3x-reconciliation voting
// (lib/reconcile.ts's reconcileAttempts/reconcileRosterAttempts/reconcileGridAttempts) or any
// business-rule/dollar calculation downstream. Three independent loop runs (one per
// SCAN_TEMPERATURES entry, same as the non-agentic path) still feed that same voting machinery
// unchanged — only the discovery/extraction front-end is agentic.

export type ShapeFamily = "one_worker_many_dates" | "one_date_many_workers" | "many_workers_many_dates" | "other";

const SHAPE_FAMILIES: ShapeFamily[] = ["one_worker_many_dates", "one_date_many_workers", "many_workers_many_dates", "other"];

export type AgentEvent = {
    ts: number;
    source: string;
    attempt: number;
    kind: "tool_call" | "info" | "terminal" | "error";
    label: string;
    detail?: string;
};

export type GridWorkerRow = {
    workerName: string | null;
    workerIc: string | null;
    cells: {
        day: number;
        month: number;
        times: number[] | null;
        hoursWorked: number | null;
        otHours: number | null;
        rest_day: boolean | null;
        notes: string | null;
    }[];
};

export type AgentLoopTerminal =
    | { shapeFamily: "one_worker_many_dates"; rows: ParsedEntry[] }
    | { shapeFamily: "one_date_many_workers"; rows: RosterPageAttempt }
    | { shapeFamily: "many_workers_many_dates"; rows: { workers: GridWorkerRow[] } }
    | { shapeFamily: "other"; reason: string };

export type AgentLoopResult = AgentLoopTerminal & { events: AgentEvent[]; cost: number };

const DEFAULT_MAX_TURNS = 8;

const SYSTEM_PROMPT = `You are figuring out the SHAPE of one page of a worker's wage-claim evidence, then extracting the relevant data.

A page can be one of four shapes:
- "one_worker_many_dates": one worker's own attendance record across many dates (a row/cell per date, with clock times, total hours, or rest/leave markings). This includes calendar grids, row-per-day tables, punch-card logs, and phone-app punch logs.
- "one_date_many_workers": an attendance register/muster sheet for ONE shared date, listing MANY DIFFERENT named workers as separate rows.
- "many_workers_many_dates": a duty roster / schedule GRID with many named workers as rows AND many dates as columns in the same page (e.g. a week's schedule for a whole team).
- "other": not a timesheet/attendance page at all, or genuinely too ambiguous/illegible to extract reliably.

You have tools to explore the page before committing to an answer:
- cropRegion: zoom into a rectangular area (fractions 0-1 of the page) ONLY when something SPECIFIC is actually illegible at full size (a particular digit, a cramped handwritten value, a faint mark you genuinely cannot resolve) — not as a routine first step. The page image you're given is already high-resolution; most of it is readable without zooming. Try reading the full page first. Do not reflexively crop into halves/quadrants "just in case" before you've identified an actual problem — every crop is a real cost, and most pages don't need one at all. If you do need to crop, target the SPECIFIC small area that's actually unclear, not a generic half/quadrant split of the whole page.
- getTargetWorker: find out the name/FIN of the specific worker this wage claim is about — important for "one_date_many_workers" and "many_workers_many_dates" pages, where you must extract ONLY that worker's row, not everyone's.
- describeShape: state in your own words what you've figured out so far about the page's layout. Use this once you have a working theory, before extracting.

When you're confident, call exactly one terminal tool:
- emitRows: with your chosen shapeFamily and the extracted rows. \`rows\` must be a REAL JSON array/object value (not a JSON string) using EXACTLY the field names below for your chosen shapeFamily — do not invent different field names.

If shapeFamily is "one_worker_many_dates", rows is a JSON ARRAY, one object per populated date:
  { "day": <1-31>, "month": <1-12>, "times": <array of bare HHMM integers e.g. [800,1700], or null>, "hoursWorked": <number or null>, "otHours": <number or null>, "noBreak": <true only if explicitly stated no break was taken, else false>, "rest_day": <true only if explicitly marked off/rest/leave, else false>, "notes": <string or null> }
  Report EVERY clock-time value visible for a date (a split/overnight day can have 4+ values), left-to-right/top-to-bottom reading order. Use bare 24h integers with no colon (8:00am -> 800, 10:00pm -> 2200).

  Do NOT blindly trust a printed column label — a template column literally labeled "Qty"/"Amount"/"Hrs" can still be where a worker (or an agency filling it in on their behalf) actually wrote CLOCK IN/CLOCK OUT times, reusing a form meant for something else. Read the ACTUAL content, not the label. CHECK FOR A CLOCK-TIME PAIR FIRST: if a date's row has two separate bare 3-4 digit numbers (regardless of which columns they sit under) that EACH plausibly encode a time of day (hour component 0-23, e.g. "800"->8:00, "2200"->22:00, "930"->9:30) and together form a plausible work shift (a start then a later end, allowing an overnight wrap), report them as a clock in/out pair in times — e.g. "800" and "2200" on the same row is almost always 8:00am-10:00pm, not "8 hours, $22". Only fall back to hoursWorked when there is genuinely just ONE number for that date with no plausible second time-like value anywhere on the row, or the number is clearly a small decimal hours figure (e.g. "8" or "8.5", not a 3-4-digit value that could itself encode a clock time). Do not leave both times and hoursWorked null and only describe the value in notes — if a date's row has a number that represents the day's work, commit to reading it as either a clock-time pair or a total-hours figure, whichever the content actually shows; notes is for genuine ambiguity or extra context, not a substitute for extraction.

If shapeFamily is "one_date_many_workers", rows is a JSON OBJECT for the one shared date on the page:
  { "day": <1-31 or null>, "month": <1-12 or null>, "workers": [ { "workerName": <string or null>, "workerIc": <string or null, exactly as printed/masked>, "actualTimeIn": <bare HHMM integer or null>, "actualTimeOut": <bare HHMM integer or null>, "mealBreakHours": <number or null>, "struckThrough": <true if this row is crossed out>, "notes": <string or null> } ] }
  List EVERY worker row on the page, not just the target worker — the caller matches the target worker by name/IC itself.

If shapeFamily is "many_workers_many_dates", rows is a JSON OBJECT:
  { "workers": [ { "workerName": <string or null>, "workerIc": <string or null>, "cells": [ { "day": <1-31>, "month": <1-12>, "times": <array of bare HHMM integers or null>, "hoursWorked": <number or null>, "otHours": <number or null>, "rest_day": <true or false>, "notes": <string or null> } ] } ] }
  List EVERY worker row on the page with their own per-date cells, not just the target worker — the caller matches the target worker by name/IC itself.

- flagForHuman: if the page is "other", or you cannot reliably extract it even after cropping closer.

Read what is actually visible. Do not invent, reconstruct, or guess missing values — leave fields null and explain in notes instead. Do not stop at the first plausible read if cropping closer would resolve genuine ambiguity.`;

function buildTools(): VisionTool[] {
    return [
        {
            name: "cropRegion",
            description: "Crop a SMALL, SPECIFIC rectangular region of the page to look closer at something you genuinely cannot read at full size. Not a routine first step — try reading the full page first, and only crop the actual unclear spot, not a generic half/quadrant of the whole page. Coordinates are fractions (0-1) of the page width/height.",
            parameters: {
                type: "object",
                properties: {
                    left: { type: "number" },
                    top: { type: "number" },
                    width: { type: "number" },
                    height: { type: "number" },
                },
                required: ["left", "top", "width", "height"],
            },
        },
        {
            name: "getTargetWorker",
            description: "Returns the name/FIN of the worker this wage claim is about, already extracted from their IPA letter.",
            parameters: { type: "object", properties: {} },
        },
        {
            name: "describeShape",
            description: "Record your working theory of this page's layout/shape in a short sentence, before extracting.",
            parameters: {
                type: "object",
                properties: { description: { type: "string" } },
                required: ["description"],
            },
        },
        {
            name: "emitRows",
            description: "Terminal. Call once you're confident, with the page's shape family and the extracted rows in that shape's schema (see the system prompt for the exact field names per shapeFamily). `rows` must be a real JSON array or object value, never a JSON-encoded string.",
            parameters: {
                type: "object",
                properties: {
                    shapeFamily: { type: "string", enum: SHAPE_FAMILIES },
                    rows: {
                        description: "A JSON array (for one_worker_many_dates) or JSON object (for one_date_many_workers / many_workers_many_dates) — exact shape per the system prompt. Never a stringified/escaped JSON string.",
                        oneOf: [{ type: "array" }, { type: "object" }],
                    },
                },
                required: ["shapeFamily", "rows"],
            },
        },
        {
            name: "flagForHuman",
            description: "Terminal. Call if the page is not a timesheet/attendance record, or cannot be reliably extracted even after cropping closer.",
            parameters: {
                type: "object",
                properties: { reason: { type: "string" } },
                required: ["reason"],
            },
        },
    ];
}

function imageContent(base64Image: string) {
    return { type: "image_url" as const, imageUrl: { url: `data:image/png;base64,${base64Image}` } };
}

/**
 * Runs one independent agentic discovery+extraction pass over a single page image — the model
 * explores via tool calls (crop closer, check the target worker, describe its theory) before
 * calling a terminal tool with its answer.
 *
 * @param pageImage - The full page image, base64-encoded.
 * @param source - Page identifier (e.g. "file.pdf p2"), used to tag emitted events.
 * @param attemptIndex - Which of the independent scan attempts this is (0-based).
 * @param temperature - Model sampling temperature for this attempt.
 * @param seed - Model sampling seed for this attempt.
 * @param targetWorker - The already-resolved IPA worker identity (never re-fetched by the loop).
 * @param onEvent - Called as each event happens, for live progress streaming to the caller.
 * @param onCost - Called after every vision call with the model id and USD cost, for job-level cost tracking.
 * @param signal - Optional abort signal; checked between turns and passed into each vision call.
 * @param maxTurns - Hard cap on tool-call turns before giving up as `flagForHuman`.
 * @param model - Which vision model to call; defaults to {@link PRIMARY_VISION_MODEL}.
 * @returns The discovered shape family and its extracted rows (or a flag-for-human reason), plus
 * this attempt's full event log and total cost.
 */
export async function runAgentLoop(
    pageImage: string,
    source: string,
    attemptIndex: number,
    temperature: number,
    seed: number,
    targetWorker: { name: string | null; fin: string | null },
    onEvent: (e: AgentEvent) => void,
    onCost: (model: string, cost: number) => void,
    signal?: AbortSignal,
    maxTurns: number = DEFAULT_MAX_TURNS,
    model: string = PRIMARY_VISION_MODEL
): Promise<AgentLoopResult> {
    const events: AgentEvent[] = [];
    const emit = (e: Omit<AgentEvent, "ts" | "source" | "attempt">) => {
        const full: AgentEvent = { ts: Date.now(), source, attempt: attemptIndex, ...e };
        events.push(full);
        onEvent(full);
    };

    let totalCost = 0;
    const tools = buildTools();
    const messages: VisionMessage[] = [
        { role: "user", content: [{ type: "text", text: SYSTEM_PROMPT }, imageContent(pageImage)] },
    ];

    for (let turn = 0; turn < maxTurns; turn++) {
        if (signal?.aborted) {
            emit({ kind: "info", label: "cancelled before completing" });
            return { shapeFamily: "other", reason: "cancelled by user", events, cost: totalCost };
        }

        let response;
        try {
            // A dense page's emitRows call can carry 30-60+ date entries in one function-call
            // argument — matches scanPageImage's budget (lib/ocr/pageScan.ts), bumped for the same
            // reason: too small a cap truncates the JSON mid-array, which then fails to parse as a
            // valid tool call and burns a turn without making progress.
            response = await sendVisionRequestWithTools(messages, tools, temperature, seed, 16000, model, signal, "required");
        } catch (err: any) {
            emit({ kind: "error", label: "vision call failed", detail: err?.message });
            return { shapeFamily: "other", reason: `vision call failed: ${err?.message ?? err}`, events, cost: totalCost };
        }
        totalCost += response.cost;
        onCost(model, response.cost);

        if (response.toolCalls.length === 0) {
            // Shouldn't happen with toolChoice "required", but a model can still answer in prose —
            // nudge it back toward calling a tool rather than silently dropping the page.
            messages.push({ role: "assistant", content: response.content, toolCalls: [] });
            messages.push({
                role: "user",
                content: [{ type: "text", text: "Please call one of the available tools rather than answering in plain text." }],
            });
            continue;
        }

        messages.push({ role: "assistant", content: response.content || null, toolCalls: response.toolCalls });

        let terminal: AgentLoopTerminal | null = null;
        for (const call of response.toolCalls) {
            const result = await executeTool(call, pageImage, targetWorker, emit);
            messages.push({ role: "tool", toolCallId: call.id, content: result.toolResultContent });
            if (result.terminal) terminal = result.terminal;
        }
        if (terminal) return { ...terminal, events, cost: totalCost } as AgentLoopResult;
    }

    emit({ kind: "info", label: `gave up after ${maxTurns} turns without a terminal answer` });
    return { shapeFamily: "other", reason: `did not converge within ${maxTurns} turns`, events, cost: totalCost };
}

type ToolExecutionResult = {
    toolResultContent: Array<{ type: "text"; text: string } | { type: "image_url"; imageUrl: { url: string } }>;
    terminal?: AgentLoopTerminal;
};

async function executeTool(
    call: VisionToolCall,
    pageImage: string,
    targetWorker: { name: string | null; fin: string | null },
    emit: (e: Omit<AgentEvent, "ts" | "source" | "attempt">) => void
): Promise<ToolExecutionResult> {
    const args = (call.arguments ?? {}) as Record<string, any>;

    switch (call.name) {
        case "cropRegion": {
            const bbox = { left: Number(args.left), top: Number(args.top), width: Number(args.width), height: Number(args.height) };
            emit({ kind: "tool_call", label: "Cropping into page region", detail: JSON.stringify(bbox) });
            try {
                const cropped = await cropRegion(pageImage, bbox);
                return { toolResultContent: [{ type: "text", text: "Here is the cropped region:" }, imageContent(cropped)] };
            } catch (err: any) {
                return { toolResultContent: [{ type: "text", text: `crop failed: ${err?.message ?? err}` }] };
            }
        }
        case "getTargetWorker": {
            emit({ kind: "tool_call", label: "Reading target worker identity from IPA" });
            return { toolResultContent: [{ type: "text", text: JSON.stringify(targetWorker) }] };
        }
        case "describeShape": {
            const description = typeof args.description === "string" ? args.description : "";
            emit({ kind: "info", label: "Discovered shape", detail: description });
            return { toolResultContent: [{ type: "text", text: "noted" }] };
        }
        case "emitRows": {
            const shapeFamily = SHAPE_FAMILIES.includes(args.shapeFamily) ? (args.shapeFamily as ShapeFamily) : null;
            if (!shapeFamily || shapeFamily === "other") {
                return {
                    toolResultContent: [
                        { type: "text", text: `shapeFamily must be one of ${SHAPE_FAMILIES.filter(f => f !== "other").join(", ")} — call flagForHuman instead if the page is "other".` },
                    ],
                };
            }
            // Some models still stringify a nested object/array argument despite the schema saying
            // array/object — tolerate that (JSON.parse it) rather than rejecting a confident,
            // otherwise-correct extraction over a serialization quirk.
            let rows = args.rows;
            if (typeof rows === "string") {
                try {
                    rows = JSON.parse(rows);
                } catch {
                    return { toolResultContent: [{ type: "text", text: "rows could not be parsed as JSON — please call emitRows again with rows as a real JSON array/object, not a string." }] };
                }
            }
            const expectArray = shapeFamily === "one_worker_many_dates";
            if (expectArray ? !Array.isArray(rows) : (rows === null || typeof rows !== "object" || Array.isArray(rows))) {
                return {
                    toolResultContent: [
                        { type: "text", text: `rows has the wrong shape for shapeFamily="${shapeFamily}" — expected a JSON ${expectArray ? "array" : "object"} with the exact field names from the system prompt. Please call emitRows again with the correct shape.` },
                    ],
                };
            }
            emit({ kind: "terminal", label: `Extraction complete — shape: ${shapeFamily}` });
            return {
                toolResultContent: [{ type: "text", text: "received" }],
                terminal: { shapeFamily, rows } as AgentLoopTerminal,
            };
        }
        case "flagForHuman": {
            const reason = typeof args.reason === "string" ? args.reason : "unspecified";
            emit({ kind: "terminal", label: "Flagged for human review", detail: reason });
            return { toolResultContent: [{ type: "text", text: "received" }], terminal: { shapeFamily: "other", reason } };
        }
        default:
            return { toolResultContent: [{ type: "text", text: `unknown tool: ${call.name}` }] };
    }
}
