# Employment Act 1968 — rules relevant to salary claim processing

Extracted from `Employment Act 1968` (2020 Revised Edition, informal consolidation in force
5/12/2025, 139 pages). Source PDF is the user's local copy, not checked into this repo — this
file exists so future work doesn't require re-reading it. Section numbers below are citations
into that Act; re-check the source if a rule here seems off, since the Act does get amended.

Scope note: only the parts relevant to computing/verifying a wage claim were extracted in depth.
Parts covering trade unions, children/young persons, maternity benefit mechanics, arrest/inspection
powers, and procedural/court matters were skimmed for relevance and are not reproduced here.

## 1. Who this even applies to (s.35)

Part 4 (rest days, hours of work, overtime) only applies to:
- **Workmen** (First Schedule — cleaners, construction workers, labourers, machine
  operators/assemblers, metal/machinery workers, train/bus/lorry/van drivers, train/bus
  inspectors, all piece-rate workmen) earning **≤$4,500/month basic** (excluding OT, bonus, AWS,
  productivity incentive, allowances)
- Other non-managerial/non-executive employees earning **≤$2,600/month basic**

The migrant/Work-Permit-holder workers this app processes (construction, labour, driving roles)
are First Schedule "workmen" almost by definition, and their basic salaries are essentially always
well under $4,500/month — so Part 4 protections apply to effectively every claim this app handles.
Not yet encoded anywhere in the app.

## 2. Rate conversion formulas (Third & Fourth Schedule)

The missing link between IPA's declared basic monthly salary and actual dollar amounts owed.

**Third Schedule** — daily rate for a monthly-rated employee working the same number of days every
week (s.107A):
```
daily gross rate of pay = (12 × monthly gross rate of pay) / (52 × days required to work per week)
daily basic rate of pay = (12 × monthly basic rate of pay) / (52 × days required to work per week)
```
(Schedule also covers piece-rate and variable-days-per-week cases — see the Act directly if a
claim needs those, not reproduced here since not yet relevant to this app's scope.)

**Fourth Schedule** — hourly basic rate of pay, specifically for OT calculation (s.38(6)):

| Employee type | Hourly basic rate formula |
|---|---|
| Workman, monthly rate | `(12 × monthly basic rate of pay) / (52 × 44)` |
| Non-workman, monthly basic rate | `(12 × monthly basic rate of pay) / (52 × 44)` |
| Workman/non-workman, piece rate | total weekly pay at basic rate ÷ total hours worked that week |
| Workman/non-workman, hourly rate | actual hourly basic rate |
| Workman/non-workman, daily rate | daily basic rate ÷ working hours per day |

For the overwhelming majority of claims (monthly-rated workman): **hourly basic rate = monthly
basic salary × 12 ÷ 2288**.

## 3. Hours of work (s.38, s.40)

- Default max: **8 hours/day or 44 hours/week**.
- Flexible-arrangement variants (by agreement in the contract of service) can push this to 9
  hours/day or 48 hours/week in a given week, provided the *average* stays within limits over the
  agreed pattern (e.g. alternate-week schemes average ≤44h/week, capped at 88h per 2-week period).
- Shift workers (s.40): may exceed 6 consecutive hours / 8h/day / 44h/week, but the **average
  over any continuous 3-week period must not exceed 44h/week**.
- Hard ceiling: **12 hours/day**, except for specific emergencies (accident, essential community
  work, defence/security, urgent machinery repair, unforeseeable interruption).
- **Overtime capped at 72 hours/month.**
- **OT rate: not less than 1.5× the hourly basic rate** (see Fourth Schedule above), for any hours
  beyond the daily/weekly limit worked at the employer's request.

## 4. Rest day (s.36, s.37)

- Every employee gets **1 whole unpaid rest day per week**, default Sunday unless the employer
  sets a different day. Shift workers can instead get a rotating continuous 30-hour rest period.
- **Pay for working on a rest day depends on who initiated it** — a distinction this app does not
  currently capture anywhere:

  | Initiated by | Worked ≤ half normal hours | Worked > half, ≤ normal hours | Worked > normal hours |
  |---|---|---|---|
  | **Employee's own request** | ½ day's basic pay | 1 day's basic pay | 1 day's basic pay + 1.5× hourly rate for the excess |
  | **Employer's request** | 1 full day's basic pay | 2 days' basic pay | 2 days' basic pay + 1.5× hourly rate for the excess |

  "Normal hours of work" = the agreed daily hours in the contract, or 8 hours/day if unstated.

## 5. Public holiday pay (s.88)

Matches what the caseworker described in the earlier training-call summary: for a workman (or any
employee Part 4 covers), if required to work on a public holiday, pay = **gross rate of pay for
that day + one extra day's pay at the basic rate** — i.e. gross + basic, not a flat 2×. (A
different rule, s.88(4A) — gross rate + a day off in lieu, no extra cash by default — applies only
to higher-earning employees Part 4 does *not* cover; not relevant to this app's target workers.)

If a public holiday falls on Sunday, the worker gets whichever is more favourable — this app
should compare the PH formula against the Sunday/rest-day formula for that date rather than assume
PH always wins (per the caseworker's original point that Sunday work should use the higher rate).

## 6. Contractor / subcontractor liability (s.65)

Where a principal contracts with a contractor (who may use a subcontractor) for labour, and salary
is owed to a workman, the **principal, contractor, and subcontractor are all jointly and severally
liable** with the actual employer — capped at one month's salary for any party that isn't the
direct employer. Relevant when scoping who a claim can legally be filed against, not just the
worker's direct employer.

## 7. Salary payment timing (s.21)

- Regular salary: must be paid within **7 days** after the end of the salary period.
- Overtime pay specifically: must be paid within **14 days** after the end of the salary period in
  which the OT was worked.

Useful for flagging late payment as a distinct violation, separate from underpayment.

## 8. Leave entitlements (secondary — not core to OT/wage math, noted for completeness)

- **Annual leave (s.88A)**: 7 days in year 1 of continuous service, +1 day per subsequent year, capped at 14 days.
- **Sick leave (s.89)**: after ≥6 months' service, 14 days/year (no hospitalisation) or 60 days/year
  (hospitalisation), pro-rated down for 3–6 months' service, none before 3 months.

## Not yet wired into the app

Everything above is reference material only — none of it is implemented in `server.ts`/`lib/`
yet. Candidate next steps discussed:
- Compute actual OT/rest-day/PH dollar amounts from IPA's basic salary using the Fourth Schedule
  formula, instead of just extracting basic salary + allowances as raw fields.
- Add a "who initiated this rest-day work" input per rest-day-worked row (worker vs employer),
  since the payable amount differs by 2× depending on which.
- Cross-check whether a claim's date range/OT hours ever exceeds the 72h/month statutory cap, as a
  sanity flag (a scan reading that implies more than that in a month is worth a second look).
- Surface late-payment (s.21) as a distinct flaggable issue once proof-of-payment dates are captured (payslip/bank statement scanning is still unbuilt — see general TWC2 case-assessment
  transcript from earlier in this project's history for that gap).
