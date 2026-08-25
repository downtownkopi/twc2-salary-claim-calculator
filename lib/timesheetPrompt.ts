import type { PageDataModel } from "./ocr";

// Handwritten years are frequently misread by OCR (e.g. "2023" instead of "2026") — this per-row
// scan still never asks the model for a year, only day/month/clock times, same as before. The
// year used below is resolved ONCE per job (runProcessJob's prescan, before this function is ever
// called) from page-level PRINTED/TYPED headers via extractPageContext (lib/ocr.ts) — a much safer
// read than trusting handwritten digits in the row data itself — validated against SUPPORTED_YEARS
// before any scanning starts, since this template only has sheets for SUPPORTED_YEARS.
//
// A real-world upload batch turned out to span far more variety than "one row per day, clock
// in/out times, handwritten" — see the format survey behind this revision: two-half-month
// side-by-side tables, weekly calendar grids, free-form diagonal lists, punch cards, typed
// (non-handwritten) sheets, mixed English/Chinese/Bengali, and — critically — pages that record
// only a total hours-worked(+OT) figure per day with NO clock times anywhere. The prompt below no
// longer assumes handwriting or a single table shape, and adds hoursWorked/otHours as the
// alternative to `times` for that last case. dataModelHint comes from extractPageContext's cheap
// full-page classification pass — a hint to lean on, not a hard rule, since a single page can
// occasionally mix both models.
/**
 * Builds the per-row transcription prompt for one timesheet page scan attempt.
 *
 * @param year - The claim year already resolved for this page (never asked of the model itself —
 * handwritten years are unreliable; see the comment above).
 * @param pageContext - Any page-level context already found (e.g. a month header), from {@link
 * extractPageContext} in `./ocr`.
 * @param dataModelHint - The page's classified data model, used as a hint rather than a hard rule.
 * @returns The full prompt text to send alongside the page image.
 */
export function buildPrompt(
    year: number,
    pageContext: string,
    dataModelHint: PageDataModel,
): string {
    const hintLine =
        dataModelHint === "hours_total"
            ? "An earlier pass guessed that this page records total hours worked (and possibly overtime) rather than clock in/out times. Treat this only as a hint and verify the actual image. If clock times are visibly present, extract those instead."
            : dataModelHint === "clock_times"
                ? "An earlier pass guessed that this page records actual clock in/out times. Treat this only as a hint and verify the actual image."
                : dataModelHint === "punch_log"
                    ? "An earlier pass guessed that this page is a phone application's punch-log screen containing individual timestamped events. Treat this only as a hint and verify the actual image."
                    : "An earlier pass could not confidently determine the page's data model. Determine it from the actual image.";

    return `You are extracting attendance and work-time information from a single page of a worker's time or attendance record.

        The page is used to fill a wage-claim spreadsheet for the year ${year}.

        The page may be:
        - handwritten or typed/computer-generated
        - in English, Chinese, Bengali, or a mixture of languages
        - a traditional row-per-day table
        - two half-month tables side by side
        - a weekly/monthly calendar grid
        - a free-form handwritten list
        - a punch card
        - a phone application's punch-log screen
        - another unfamiliar attendance/time layout

        Your primary responsibility is ACCURATE VISUAL TRANSCRIPTION.

        Read what is actually visible in the image.

        Do NOT invent, reconstruct, or "repair" information that is not clearly supported by the image.

        Do NOT use patterns from other dates to fill in missing information.

        Do NOT change a visually read value merely because another value would make more logical sense.

        Downstream code will perform business-rule validation and calculations.

        PAGE-LEVEL CONTEXT:
        ${pageContext || "none found"}

        FORMAT HINT:
        ${hintLine}

        IMPORTANT: The page-level context and format hint are supporting information only. Always verify them against the actual image.

        --------------------------------------------------
        1. IDENTIFY EVERY POPULATED DATE ENTRY
        --------------------------------------------------

        Identify every actual date entry visible on this page.

        A date entry may be represented by:
        - a table row
        - a calendar-grid cell
        - a free-form dated entry
        - one or more punch-log records belonging to the same date

        Do NOT assume that every day of the month appears.

        Do NOT output completely blank rows or cells.

        However, ANY visible mark means the date entry is populated and must be output, including:
        - clock times
        - total hours
        - overtime
        - checkmarks
        - tally marks
        - dashes
        - X marks
        - leave codes
        - handwritten notes
        - other visible notation

        The only reason to omit a date entirely is that its corresponding region is genuinely completely blank.

        --------------------------------------------------
        2. READ EACH DATE INDEPENDENTLY
        --------------------------------------------------

        Every date must be read independently from its own visual region.

        Never copy or infer information from:
        - previous rows
        - following rows
        - neighboring calendar cells
        - neighboring columns
        - other dates
        - repeated weekdays
        - repeated weekly patterns
        - visually similar handwriting
        - dominant values appearing elsewhere on the page

        A repeated pattern is NOT evidence that another date contains the same value.

        For example, if dates 9 and 11 both contain "09:00 - 19:00", but date 10 contains only a checkmark, do NOT give date 10 the times from dates 9 or 11.

        Only report clock times that are actually visible inside that date's own region.

        --------------------------------------------------
        3. EXTRACT CLOCK TIMES
        --------------------------------------------------

        When actual clock times are visible for a date, extract EVERY clock-time value belonging to that date.

        Do not decide how many shifts the worker worked.

        Do not pair or group the times into shifts.

        Simply transcribe every visible clock-time value belonging to that date.

        For a normal table row:
        - read times from left to right

        For a calendar cell:
        - read times in the natural top-to-bottom/reading order inside that cell

        For a free-form entry:
        - use the natural reading order of that entry

        Return clock times as bare 24-hour integers with no colon.

        Examples:
        - 8:00am -> 800
        - 8:30am -> 830
        - 1:30pm -> 1330
        - 10:00pm -> 2200

        Do not include seconds.

        A normal day with one shift might therefore produce:

        [800, 1700]

        A split day might produce:

        [800, 1200, 1300, 1700]

        A day with three shifts might produce six values.

        Report every visible time. Do not stop after finding the first pair.

        --------------------------------------------------
        4. SCAN THE ENTIRE LOGICAL DATE REGION
        --------------------------------------------------

        Before finalizing a date, inspect the entire region belonging to that date.

        For a table:
        - inspect the full width of the row

        For a calendar:
        - inspect the entire cell

        For a free-form entry:
        - inspect the complete logical entry

        Do not stop after finding the first clock-in/clock-out pair.

        A row may contain 2, 4, 6, or more clock-time values.

        If more than two time values are visible, report ALL of them.

        --------------------------------------------------
        5. 12AM AND 12PM
        --------------------------------------------------

        Distinguish noon and midnight carefully.

        - 12pm = 1200
        - 12am = midnight

        When midnight is the endpoint of a shift that began earlier on that calendar date, represent it as 2400 where appropriate.

        For example:

        6am - 12pm, 6pm - 12am

        becomes:

        [600, 1200, 1800, 2400]

        Do not convert both occurrences of "12" to the same value when the visual context distinguishes noon from midnight.

        If the distinction genuinely cannot be determined from the image, do not guess. Return null for the times and explain the ambiguity in notes.

        --------------------------------------------------
        6. OVERNIGHT SHIFTS
        --------------------------------------------------

        An overnight shift may contain a time that is numerically smaller than the preceding time.

        For example:

        2200 - 0600

        is valid visual information.

        Do NOT reorder the times.

        Do NOT change 0600 to another value.

        Report the values in the order they are visually written.

        If the sequence appears unusual, preserve the visual transcription. Do not alter it merely to make the numbers increase.

        --------------------------------------------------
        7. HOUR-ONLY CLOCK-TIME SHORTHAND
        --------------------------------------------------

        Some workers write clock-in/out times using shorthand such as:

        08/20

        or:

        08-20

        even when the printed column label does not indicate that the field is for time.

        When the actual row/context clearly shows that such a value represents clock hours, interpret it as:

        [800, 2000]

        Do NOT automatically interpret every NN/NN or NN-NN value as a date.

        A real calendar date normally belongs to the date/day portion of the record. A second date-like value elsewhere may instead be a clock-time shorthand.

        Use the actual contents and visual structure of the row.

        If the meaning genuinely remains ambiguous, do not guess. Return the affected time information as null and explain the ambiguity in notes.

        --------------------------------------------------
        8. HOURS-ONLY RECORDS
        --------------------------------------------------

        Some pages record only total hours worked per day, without clock in/out times.

        Examples:

        8

        8 + 2 OT

        8.5 hours

        If a date genuinely has NO clock times and instead provides only a total-hours figure:

        - times = null
        - hoursWorked = the visible total
        - otHours = the visible overtime, if any

        For example:

        8 + 2 OT

        means:

        hoursWorked = 8
        otHours = 2

        Do NOT invent clock times from total hours.

        If actual clock times ARE visible for that date, report those in times.

        When times is populated:
        - hoursWorked should be null
        - otHours should be null

        Do not calculate missing clock times from a total-hours value.

        --------------------------------------------------
        9. BARE PRESENCE MARKS
        --------------------------------------------------

        A checkmark, tally mark, X, or similar presence mark does not itself provide a clock time or duration.

        If a date contains only a presence mark:

        - times = null
        - hoursWorked = null
        - otHours = null
        - rest_day = false

        Describe the mark briefly in notes.

        Do NOT infer a duration from the mark.

        Do NOT copy times from surrounding dates.

        --------------------------------------------------
        10. REST DAYS, LEAVE, AND NON-WORKED MARKINGS
        --------------------------------------------------

        If a date is explicitly marked as not worked, still output that date.

        Examples include:
        - OFF
        - REST
        - rest day
        - holiday
        - public holiday
        - MC
        - medical leave
        - AL
        - annual leave
        - EL
        - emergency leave
        - unpaid leave
        - X
        - a deliberate dash indicating a non-worked day
        - another explicit leave/non-work notation

        For an explicitly non-worked date:

        - rest_day = true
        - times = null

        Put the literal visible notation in notes when useful.

        Do NOT infer clock times for a leave/rest entry.

        If an unfamiliar notation is visible but its meaning cannot be determined, transcribe it in notes rather than inventing an interpretation.

        A named public holiday (e.g. a printed "New Year's Day" label on a calendar template) combined with a dash drawn in the SAME box is not a special or ambiguous case — it is simply two signals agreeing with each other that this date was not worked. Do not let the presence of BOTH a printed holiday name AND a dash confuse you into treating the box as needing extra scrutiny or a different rule; it still gets rest_day = true, times = null, exactly like any other box with a dash. A box with a named holiday label is not automatically exempt from also being read for a dash — check every box the same way regardless of what else is printed in it.

        --------------------------------------------------
        11. Dashes AND CHECKMARKS IN CALENDAR GRIDS
        --------------------------------------------------

        A dash or checkmark inside a calendar date cell belongs only to that date.

        Never use neighboring dates to determine what it means.

        For example:

        Date 9:
        09:00 - 19:00

        Date 10:
        -

        Date 11:
        09:00 - 19:00

        Date 10 must NOT receive 09:00 - 19:00.

        A bare dash "-" or short horizontal line drawn in a date's box ALWAYS means that date was not worked — treat it exactly the same as an explicit "OFF"/"rest day" notation from section 10 above, with no exceptions:
        - rest_day = true
        - times = null
        - notes = "-"

        Do not second-guess this by asking "is this dash CLEARLY non-worked, or just a presence mark?" — a dash by itself, with no time text next to it, is never merely a presence mark. It is common for a page to show the SAME repeated time (e.g. "09:00-19:00") in most boxes for a given weekday, with only one or two boxes on that weekday instead containing a bare dash — that repetition elsewhere does NOT make the dash on this date ambiguous; still set rest_day = true, times = null for it. If you find yourself writing "dash mark" or similar into notes for a date, rest_day for that SAME date must be true — never write a dash into notes and then leave rest_day false, that is a direct contradiction.

        A CHECKMARK or tally mark (a tick, a small check symbol — visually distinct from a dash/line) with no time text is a different case: a bare presence mark, not a claim about whether the day was worked.
        - rest_day = false
        - times = null
        - describe it in notes

        --------------------------------------------------
        12. NO-BREAK INFORMATION
        --------------------------------------------------

        Set:

        noBreak = true

        ONLY when the current date explicitly indicates that no meal break was taken.

        Examples include:
        - no lunch
        - no break
        - no meal break
        - straight shift
        - continuous
        - an explicit zero/no-break notation in a clearly identifiable break/lunch field

        The absence of a break entry does NOT mean no break.

        Do NOT infer noBreak from:
        - shift duration
        - number of time values
        - missing lunch information
        - the page template

        If there is no explicit evidence that no break was taken:

        noBreak = false

        --------------------------------------------------
        13. PRINTED COLUMN LABELS MAY BE WRONG
        --------------------------------------------------

        Do not blindly trust printed column labels.

        A worker may write information in a different column from what the printed template intended.

        Interpret the actual content and surrounding visual structure.

        For example, a column printed "Amount" may contain a handwritten clock-time shorthand.

        The actual written content is more important than blindly trusting the printed label.

        However, do not reinterpret genuinely ambiguous information merely because another interpretation is convenient.

        --------------------------------------------------
        14. PUNCH-LOG SCREENSHOTS
        --------------------------------------------------

        Some pages are screenshots of phone clock-in applications.

        These may contain a chronological list of individual timestamped events rather than one row per day.

        Example:

        12-06-2026 06:29:54
        12-06-2026 19:50:07

        For punch-log layouts:

        1. Read every visible timestamp.
        2. Remove seconds completely.
        3. Group all timestamps belonging to the same calendar date into ONE output object.
        4. Sort that date's times chronologically from earliest to latest.
        5. Do not preserve newest-first display order.
        6. Do not output multiple objects for the same date.

        For example:

        20:07:32
        06:26:15

        on the same date becomes:

        [626, 2007]

        Seconds must NOT be included.

        If the date or time cannot be read reliably, do not guess.

        --------------------------------------------------
        15. HANDWRITING AND VISUAL AMBIGUITY
        --------------------------------------------------

        Handwritten digits may be difficult to distinguish.

        If a value could visually be either one digit or another, do not resolve the ambiguity using surrounding patterns.

        For example, if a handwritten value could be 3 or 8:

        Do NOT choose 8 merely because other rows contain 8.

        Do NOT choose the value that makes the work duration look more reasonable.

        If the value cannot be determined reliably from the image:
        - do not guess
        - set times = null for the affected date if the ambiguity prevents reliable extraction
        - explain the ambiguity briefly in notes

        Visual accuracy is more important than producing a complete-looking answer.

        --------------------------------------------------
        16. CLOCK TIMES AND WRITTEN TOTALS
        --------------------------------------------------

        A row may contain both raw clock times and a written total/duration.

        Transcribe both independently.

        Do NOT change the clock times to make them agree with the total.

        Do NOT change the total to make it agree with the clock times.

        If they conflict, preserve the visible information and explain the discrepancy in notes.

        Downstream code will perform arithmetic and business-rule validation.

        --------------------------------------------------
        17. DO NOT APPLY BUSINESS RULES DURING TRANSCRIPTION
        --------------------------------------------------

        Do not modify visually extracted values merely because they violate an expected business rule.

        For example, if the extracted times appear to imply:
        - an unusually long shift
        - an overnight shift
        - a mismatch with total hours
        - an unusual number of clock times

        preserve the actual visual transcription if it can be read.

        If necessary, mention the unusual condition in notes.

        Do NOT "fix" the visual reading to make it conform to a business rule.

        --------------------------------------------------
        18. FINAL VISUAL VERIFICATION
        --------------------------------------------------

        Before returning the result, perform a final independent visual check.

        Verify:

        1. Every populated date visible on the page is represented.
        2. Completely blank dates were not added.
        3. Each date was read from its own visual region.
        4. No value was copied from another date.
        5. No missing clock time was invented.
        6. Every visible clock time belonging to each date was included.
        7. Times are in the correct reading order for that layout.
        8. Punch-log events for the same date were merged.
        9. Punch-log times were sorted chronologically.
        10. Seconds were removed.
        11. 12am and 12pm were distinguished where visually determinable.
        12. Hours-only records did not receive invented clock times.
        13. Leave/rest markings have times = null.
        14. noBreak is true only when explicitly supported by that date's own content.
        15. Printed column labels were not blindly trusted.
        16. Ambiguous handwriting was not silently guessed.
        17. Conflicts between clock times and written totals are described in notes rather than "fixed".

        This verification is a visual verification only.

        Do not change a visually supported value merely to satisfy arithmetic or business rules.

        --------------------------------------------------
        19. OUTPUT SCHEMA
        --------------------------------------------------

        For every populated date entry, output an object containing EXACTLY these fields:

        - day: integer 1-31
        - month: integer 1-12
        - times: array of clock-time integers, or null
        - hoursWorked: number, or null
        - otHours: number, or null
        - noBreak: boolean
        - rest_day: boolean
        - notes: string or null

        Rules:

        times should be null when:
        - no clock times exist
        - the date is explicitly not worked
        - only total hours are present
        - the clock times cannot be read reliably
        - the visible notation does not provide a determinable clock time

        hoursWorked should be populated ONLY when:
        - times is null
        - and a genuine total-hours value is visibly shown

        otHours should be populated ONLY when:
        - an overtime value is explicitly shown
        - alongside an hours-only record

        noBreak:
        - true only when explicitly stated for that date
        - false otherwise

        rest_day:
        - true only when the date is explicitly marked as not worked
        - false otherwise

        notes:
        - normally null
        - use a short explanation when information is ambiguous, missing, unusual, contradictory, or otherwise requires human review
        - for leave/rest markings, include the literal visible notation when useful

        --------------------------------------------------
        20. OUTPUT FORMAT
        --------------------------------------------------

        Return ONLY a valid JSON array.

        Do NOT return:
        - markdown
        - code fences
        - explanations
        - commentary
        - headings
        - text before or after the JSON

        Each object must contain exactly:

        day
        month
        times
        hoursWorked
        otHours
        noBreak
        rest_day
        notes

        Example structure:

        [
        {
            "day": 1,
            "month": 6,
            "times": [800, 1200, 1300, 1700],
            "hoursWorked": null,
            "otHours": null,
            "noBreak": false,
            "rest_day": false,
            "notes": null
        }
        ]`;
}
