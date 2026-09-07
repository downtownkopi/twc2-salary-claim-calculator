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

The app's default OT rate (`getEffectiveOtRate()`) is the IPA letter's own declared rate if one was
extracted, falling back to 1.5× the computed hourly basic rate above only when the IPA didn't state
one — this is what MOM has on record for the worker, not necessarily the same as what a payslip
shows was actually paid. A payslip's stated hourly OT rate is scanned separately (see §10) and can
differ from the IPA's — sometimes a genuine underpayment (the whole point of a wage claim), so the
app doesn't auto-prefer either one: the caseworker picks once, claim-wide — next to "Declared OT
rate" in the IPA summary card — which rate actually drives every month's claim math.

## 3. Hours of work (s.38, s.40)

- Default max: **8 hours/day or 44 hours/week**.
- Flexible-arrangement variants (by agreement in the contract of service) can push this to 9
  hours/day or 48 hours/week in a given week, provided the *average* stays within limits over the
  agreed pattern (e.g. alternate-week schemes average ≤44h/week, capped at 88h per 2-week period).
  - The ≤5-working-day-a-week variant (s.38(1)(e)) requires the week to have **no more than 5**
    working days. A "5.5-day week" (6 distinct working days, one of them a half-day) does **not**
    qualify for this proviso's 9h/day extension — only the alternate-week variant (proviso (f))
    or the shift-worker rule (s.40) could apply instead. Relevant when a 5.5-day worker's timesheet
    shows >8h on a full working day.
- Shift workers (s.40): may exceed 6 consecutive hours / 8h/day / 44h/week, but the **average
  over any continuous 3-week period must not exceed 44h/week**.
- Hard ceiling: **12 hours/day**, except for specific emergencies (accident, essential community
  work, defence/security, urgent machinery repair, unforeseeable interruption).
- **Overtime capped at 72 hours/month.**
- **OT rate: not less than 1.5× the hourly basic rate** (see Fourth Schedule above), for any hours
  beyond the daily/weekly limit worked at the employer's request.
- **Rest/meal break (s.38(1)(a) and proviso (c))**: an employee must not work more than **6
  consecutive hours without a break**. If the work must be carried on continuously, the employee
  can instead be required to work up to **8 consecutive hours**, provided the break(s) taken
  during that stretch total **at least 45 minutes**. This is the statutory floor behind the app's
  "Standard break" field — the field itself is a caseworker-declared value used only to flag a
  timesheet row whose extracted break doesn't match it, not a live check against this 45-minute
  floor.

## 4. Rest day (s.36, s.37)

- Every employee gets **1 whole unpaid rest day per week**, default Sunday unless the employer
  sets a different day. Shift workers can instead get a rotating continuous 30-hour rest period.
- **Pay for working on a rest day depends on who initiated it** — the app captures this via a
  per-row "who asked for this work?" radio (worker vs employer):

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

Note on the literal statute mechanism (s.88(1)(b)), for reference against the rule above: the Act
itself doesn't frame this as "pick whichever is higher" — it says that when a public holiday falls
on a rest day, the holiday itself shifts whole to the next working day, and the original rest day
stays a plain rest day (paid under the s.37 rest-day-worked formula if worked, not the PH formula).
The caseworker's higher-of-the-two rule is a deliberate practical simplification on top of that, not
a literal reading — keep applying it as-is unless it's revisited, but don't be surprised if the two
don't match section-for-section.

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

## 8. Leave entitlements

Both entitlements below only start after **≥3 months' service**; nothing accrues before that.
These back the app's "Claim salary-in-lieu of paid annual leave" and "Claim sick leave pay"
optional claims.

- **Annual leave (s.88A)**: 7 days in year 1 of continuous service, +1 day per subsequent
  completed year, capped at 14 days. Under 12 months' service in a leave-year, entitlement is
  pro-rated by completed months (half-day-or-more fractions round up, below half-day round down —
  s.88A(3)). Paid at the **gross rate of pay**. On termination, unused leave must be paid out in
  cash **unless the employee was dismissed for misconduct** (s.88A(8)) — a case detail the app's
  salary-in-lieu-of-leave claim doesn't currently ask about, so a misconduct dismissal needs a
  caseworker override.
- **Sick leave (s.89)**: paid at the **gross rate of pay** (excluding shift allowance unless
  hospitalised). Entitlement is a step table by completed months of service, not a smooth
  prorate:

  | Completed service | Non-hospitalisation days/year | Hospitalisation days/year (inclusive of the non-hosp days) |
  |---|---|---|
  | < 3 months | 0 (not entitled) | 0 |
  | 3 months | 5 | 15 |
  | 4 months | 8 | 30 |
  | 5 months | 11 | 45 |
  | 6+ months | 14 | 60 |

  - No paid sick leave on a rest day, a public holiday, a day of paid annual leave, or a
    non-working day (s.89(6)).
  - **Certification requirement (s.89(4))** — sick leave is only payable if it's certified by a
    medical practitioner; if the certifying practitioner isn't one appointed by the employer, the
    employee must also have informed (or tried to inform) the employer within **48 hours** of the
    absence starting. Uncertified leave, or leave failing that 48-hour notice, is treated as
    unauthorised absence, not paid sick leave. This is the statutory basis for the app's Medical
    certificates check — a claimed sick/MC day without a matching certificate on file is unpaid
    unless one is produced (see [Not yet wired](#not-yet-wired-into-the-app) — this part *is*
    wired in, via the MC-vs-claimed-date cross-check).

## 9. Salary period (s.20)

- An employer may fix a salary period; it must not exceed **one month**, and if none is fixed the
  Act deems it to be **one month** (s.20(1)–(3)).
- This is the statutory backing for the app's "Claim period" field and the month-by-month
  breakdown the app renders — a monthly salary period is the default and the near-universal case
  for the workers this app processes. The claim period itself (start/end dates) is an app-level
  scoping input, not a term the Act defines directly; it just keeps auto-filled shift rows inside
  the dates the worker actually claims to have been employed, and bounds which monthly salary
  periods get included.

## 10. Documents referenced by the app, and their relationship to the Act

- **IPA letter** — an In-Principle Approval letter is issued under the **Employment of Foreign
  Manpower Act**, not the Employment Act 1968. It's used here only as a source for the declared
  basic monthly salary figure that all the Employment Act formulas above run on — it isn't itself
  an Employment Act document.
- **Timesheet files** — not a document the Act names or defines; used as the primary evidence of
  hours actually worked, which the above formulas are then applied to. Optional (not just "not
  required by the Act" but literally not enforced by the app either) when a payslip covers a
  month's overtime instead — the claim period's start/end dates then become the only source of
  which dates get an auto-filled placeholder row.
- **Payslip** — also not an Act-defined document; an alternate source for two independently-chosen
  things: a period's stated overtime-hours figure (per day, per week, or per month, whichever a
  given slip shows), picked per MONTH, used in place of summed timesheet rows when no daily
  timesheet is available for that stretch; and the payslip's own stated hourly OT rate, picked once
  claim-wide (not per month — see §2 above), used in place of the Fourth Schedule/s.38(6) rate
  (ordinarily the IPA's declared rate) when the caseworker decides the payslip's rate — not the
  IPA's — is the one to claim against. Both default to the pre-payslip behavior (timesheet-derived
  hours, IPA-derived rate) unless explicitly switched.

  When no timesheet is attached at all, basic salary itself is also driven by the payslip: every
  calendar month any payslip entry's period touches is assumed a full month worked (days claimed =
  days in month), since there's no day-level evidence to prorate against otherwise. This is still
  clamped against the declared claim period, if one was set — a claim period starting 2025-09-03
  excludes 2025-09-01/02 from September's days claimed even though the payslip's own period covers
  the whole month, prorating that month down accordingly rather than counting it as full. Never
  applies once even one timesheet file is attached; a real timesheet's actual coverage is never
  overridden by this assumption.
- **Bank statement files** — not an Act-defined document; used only as an independent check of
  what was actually paid, compared against what the Act above says should have been owed.
- **Medical certificates** — the app's proof requirement for a claimed sick/MC day maps directly
  onto the s.89(4) certification rule (§8 above): no matching certificate on file means that day
  is unpaid unless one is produced.
- **Medical bills** — not tied to any Employment Act leave provision; these are invoices/receipts
  for medical costs, checked against a separate question (was the worker actually reimbursed),
  unrelated to the sick-leave-days entitlement computed under s.89.

## Not yet wired into the app

Most of the reference material above is now implemented in `public/index.html` (OT/rest-day/PH
dollar amounts from the Fourth Schedule, the rest-day initiator radio, the 72h/month OT cap flag,
the s.89 sick-leave tiers, the s.88A annual-leave payout, and the MC-vs-claimed-date check). What's
still outstanding:
- Surface late-payment (s.21) as a distinct flaggable issue once proof-of-payment dates are
  captured (payslip/bank statement scanning gives paid amounts, but not per-payment dates yet — see
  general TWC2 case-assessment transcript from earlier in this project's history for that gap).
- The s.88A(8) misconduct-dismissal exception for annual-leave payout isn't asked about in the
  salary-in-lieu-of-leave claim form — currently assumes every termination qualifies for payout.
