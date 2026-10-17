import { appendFile, mkdir } from "fs/promises";
import * as path from "path";

// Local-disk diagnostics for vision-call timeouts/retries/cost — the gap between a scan's
// displayed cost total and what OpenRouter actually billed (see visionClient.ts's
// AbortController fix) was only visible after the fact, with no record of how often timeouts/
// retries actually happen or how long calls take. Every attempt's outcome gets appended here so
// a future debugging session can grep real data instead of re-guessing from theory.
const LOG_DIR = process.env.VISION_DEBUG_LOG_DIR || path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "vision-debug.log");

let dirReady: Promise<void> | null = null;
function ensureLogDir(): Promise<void> {
    if (!dirReady) dirReady = mkdir(LOG_DIR, { recursive: true }).then(() => undefined);
    return dirReady;
}

export type VisionLogEvent =
    | { type: "attempt_start"; model: string; attempt: number; requestBytes: number }
    | { type: "attempt_success"; model: string; attempt: number; elapsedMs: number; cost: number; truncated: boolean }
    | { type: "attempt_timeout"; model: string; attempt: number; elapsedMs: number; willRetry: boolean }
    | { type: "attempt_rate_limited"; model: string; attempt: number; elapsedMs: number; willRetry: boolean }
    | { type: "attempt_aborted_external"; model: string; attempt: number; elapsedMs: number }
    | { type: "attempt_error"; model: string; attempt: number; elapsedMs: number; message: string };

// Fire-and-forget — a logging failure (disk full, read-only fs) must never break a real scan,
// so write errors are swallowed here rather than surfaced to the caller.
export function logVisionEvent(event: VisionLogEvent): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    ensureLogDir()
        .then(() => appendFile(LOG_FILE, line))
        .catch(err => console.error("vision debug log write failed:", err));
}
