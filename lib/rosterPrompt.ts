// A worker-roster page (lib/ocr/pageScan.ts's PageDataModel "worker_roster") is the inverse shape
// of every other timesheet page this app reads: ONE shared date, MANY different named workers as
// rows — an agency/hotel-maintained attendance register, not one worker's own multi-date record.
// This prompt asks for the page's date once plus every worker's row, mirroring
// lib/timesheetPrompt.ts's "accurate visual transcription, never invent/infer" conventions and its
// bare-HHMM clock-time format (so downstream code — lib/workerMatch.ts, lib/reconcile.ts's
// reconcileRosterAttempts — can treat a matched row's times exactly like any other TimeEntry).
/**
 * Builds the extraction prompt for one worker-roster page scan attempt.
 *
 * @returns The full prompt text to send alongside the page image.
 */
export function buildRosterPrompt(): string {
    return `You are extracting one day's worker attendance register from a single page.

This page lists MULTIPLE DIFFERENT WORKERS, each as their own row, all for ONE shared date (unlike
a normal timesheet, which is one worker's own record across many dates). The worker names and IC/FIN
numbers are often pre-printed or typed by the agency; the actual time in/out and signatures are
usually handwritten, filled in by the worker or a supervisor.

Your primary responsibility is ACCURATE VISUAL TRANSCRIPTION.

Read what is actually visible in the image. Do NOT invent, reconstruct, or "repair" information
that is not clearly supported by the image. Do NOT copy a value from one worker's row into
another's — every row must be read independently from its own visual region, even when several
rows share the same printed scheduled shift text.

--------------------------------------------------
1. THE PAGE'S DATE
--------------------------------------------------

Find the single date this whole page's rows belong to — usually a header near the top (e.g.
"14 OCT 2025 (TUESDAY)"). Report it as day (1-31) and month (1-12). If genuinely no date is
legible anywhere on the page, return both as null rather than guessing.

--------------------------------------------------
2. IDENTIFY EVERY WORKER ROW
--------------------------------------------------

List every worker row visible on the page, in the order they appear. A row usually has: a name, an
IC/FIN number (often partial/masked, e.g. "442P" — a few digits plus a letter), a scheduled shift,
an actual time in with signature, an actual time out with signature, and a meal break.

A row whose name or IC number is struck through / crossed out with a line drawn through the text
means that worker was removed from this roster — still list the row (so it's visible what was
crossed out), but set struckThrough = true for it. Do not silently omit it.

Do NOT invent a row for a blank line with no name at all.

The page is sometimes a PHOTOGRAPH of a physical page taken at a slight angle rather than a flat
scan, which can make the printed table lines slant diagonally across the image instead of running
perfectly horizontal. Check for this before reading any values: if the table lines are slanted, a
value sitting slightly above or below where a perfectly horizontal line would put it can visually
drift toward the row above or below it. When you notice slant, trace that ROW'S OWN printed line
(however slanted) across the full width of the table, and only use values that sit ON that same
slanted line — do not assume a value belongs to a different row just because it looks vertically
closer to it on a quick glance. If a value's row placement is genuinely ambiguous because of the
skew, say so in that row's notes rather than guessing which row it belongs to. On a normal, flat
(non-slanted) page, rows are simply the ordinary horizontal table rows — don't look for slant that
isn't there.

Every row must be read from its own line only. Never carry a name, IC number, time, or meal-break
value from one row into an adjacent row, whether or not the page happens to be slanted.

READ EACH ROW BY ANCHORING TO ITS NAME, NOT BY SCANNING EACH COLUMN SEPARATELY. Do not read down the
whole "actual time in" column, then down the whole "actual time out" column, then down the whole
"meal break" column, as separate top-to-bottom passes — that is the single most common way a value
ends up attached to the wrong worker, since a small vertical misalignment between columns then
silently shifts every value down by one row. Instead, process one worker at a time: find that
worker's name, then read every other field for that SAME row moving left to right at that name's
own vertical position, then move on to the next name. Only after finishing one row's own name, IC,
actual time in, actual time out, and meal break should you move to the next row.

--------------------------------------------------
3. WORKER NAME AND IC NUMBER
--------------------------------------------------

Transcribe workerName and workerIc exactly as printed/written, including a masked/partial IC number
exactly as shown (do not attempt to complete it into a full FIN). If a field is present but
illegible, use null for that field rather than guessing, and mention it in notes.

--------------------------------------------------
4. ACTUAL TIME IN / OUT
--------------------------------------------------

Extract the ACTUAL time in and actual time out for this worker on this date — not the scheduled
shift column, which is a separate printed plan, not what actually happened. Return each as a bare
24-hour integer with no colon (e.g. 7:00am -> 700, 6:00pm -> 1800, matching the same convention
used elsewhere in this app). If either is blank, unsigned, or illegible, return null for that
field — do not assume it matches the scheduled shift.

--------------------------------------------------
5. MEAL BREAK
--------------------------------------------------

Extract the meal break duration in decimal hours (e.g. "0.5hr" or "1/2 hr" -> 0.5, "1hr" -> 1). If
no meal break is shown for this row, return null.

--------------------------------------------------
6. NOTES
--------------------------------------------------

Use notes for anything that needs a human's attention: illegible fields, a struck-through row, a
row where the actual time only partially fills in (e.g. time out recorded but time in blank), or
any other ambiguity. Otherwise leave notes null.

--------------------------------------------------
7. OUTPUT FORMAT
--------------------------------------------------

Return ONLY a valid JSON object, no markdown fences, no commentary before or after it:

{
  "day": integer 1-31 or null,
  "month": integer 1-12 or null,
  "workers": [
    {
      "workerName": string or null,
      "workerIc": string or null,
      "actualTimeIn": integer (bare HHMM) or null,
      "actualTimeOut": integer (bare HHMM) or null,
      "mealBreakHours": number or null,
      "struckThrough": boolean,
      "notes": string or null
    }
  ]
}

Example:

{
  "day": 14,
  "month": 10,
  "workers": [
    { "workerName": "Ang See Choon", "workerIc": "925A", "actualTimeIn": 900, "actualTimeOut": 1830, "mealBreakHours": 0.5, "struckThrough": false, "notes": null }
  ]
}`;
}
