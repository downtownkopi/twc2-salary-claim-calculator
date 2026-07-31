# Singapore public holidays — 2025 & 2026

Verified against the official MOM dataset on data.gov.sg (not hallucinated) so the app never
needs to re-search for this. Where a holiday's original date falls on a Sunday, MOM gazettes the
following Monday as the paid off-in-lieu day — that Monday is the date used here, since it's the
actual paid-holiday date for wage-claim purposes. The original Sunday is just an ordinary Sunday
(handled separately by the app's rest-day check, not double-counted here).

## 2025 (11 gazetted holidays)

| Date | Holiday |
|---|---|
| 2025-01-01 | New Year's Day |
| 2025-01-29 | Chinese New Year |
| 2025-01-30 | Chinese New Year (Day 2) |
| 2025-03-31 | Hari Raya Puasa |
| 2025-04-18 | Good Friday |
| 2025-05-01 | Labour Day |
| 2025-05-03 | Polling Day (one-off, GE2025) |
| 2025-05-12 | Vesak Day |
| 2025-06-07 | Hari Raya Haji |
| 2025-08-09 | National Day |
| 2025-10-20 | Deepavali |
| 2025-12-25 | Christmas Day |

Note: Polling Day 2025-05-03 is a one-off gazetted holiday for the 2025 General Election, not an
annually recurring public holiday — don't carry it forward to future years.

## 2026 (11 gazetted holidays)

| Date | Holiday |
|---|---|
| 2026-01-01 | New Year's Day |
| 2026-02-17 | Chinese New Year |
| 2026-02-18 | Chinese New Year (Day 2) |
| 2026-03-21 | Hari Raya Puasa |
| 2026-04-03 | Good Friday |
| 2026-05-01 | Labour Day |
| 2026-05-27 | Hari Raya Haji |
| 2026-06-01 | Vesak Day (observed — original date Sun 2026-05-31) |
| 2026-08-10 | National Day (observed — original date Sun 2026-08-09) |
| 2026-11-09 | Deepavali (observed — original date Sun 2026-11-08) |
| 2026-12-25 | Christmas Day |

## Sources

- https://data.gov.sg/datasets/d_3751791452397f1b1c80c451447e40b7/view (MOM, 2025)
- https://data.gov.sg/datasets/d_149b61ad0a22f61c09dc80f2df5bbec8/view (MOM, 2026)
- https://www.mom.gov.sg/employment-practices/public-holidays

## Where this is used in the app

`public/index.html` — `PUBLIC_HOLIDAYS` (client-side, date → holiday name map) drives the
public-holiday-worked guardrail on each review row. Update that object directly if MOM revises a
gazetted date, and add this doc's table for the new year at the same time.
