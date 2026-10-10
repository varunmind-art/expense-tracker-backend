# P0-5 — Recurring schedule change report (before / after)

**Status:** code implemented and locally tested. **Not activated against any real
data** — no migration applied, nothing deployed, and the revised scheduling has
never run against production records.

**How these numbers were produced.** "Before" values come from
`test/support/legacy-logic.js`, a verbatim copy of the replaced code, exercised
by `test/baseline/scheduling.test.js` (still green — it pins the old behaviour as
the reference). "After" values come from `src/lib/schedule.js`, exercised by
`test/p0/schedule.test.js`. Both suites run under `npm test`; both sets of
numbers are actual program output, not hand-written.

Dates are **local calendar dates** (the algorithm is local-calendar arithmetic,
so results are the same on any host timezone).

---

## 1. Confirmed defects fixed

| # | Defect | Root cause |
|---|--------|-----------|
| 1 | MONTHLY skipped an **entire month** whenever the current day exceeded the target month's length | `setMonth()` ran **before** `setDate()`, so a day overflow (Jan 31 → "Feb 31" → Mar 3) was normalised first and the clamp landed in the wrong month. The `if (next.getDate() !== targetDate) next.setDate(0)` guard could therefore never fire |
| 2 | **All 31** day-of-month values were affected when created on the 31st | Same root cause; nothing to do with which day was configured |
| 3 | Leap-year February was skipped | Same root cause |
| 4 | Two scheduling implementations disagreed | The cron had its own inline copy: its WEEKLY branch ignored `dayOfWeek` entirely and its YEARLY branch ignored the day fields |
| 5 | An unsupported `frequency` was accepted on update and then **duplicated the expense on every run, forever** | PUT had no allowlist; the unknown value fell through the scheduler, which returned the input date unchanged, leaving `nextExecution <= today` so the cron re-selected the rule indefinitely |
| 6 | Missed periods were silently dropped | The cron advanced from `today` rather than from the rule's own `nextExecution`, so a rule 3 months overdue fired once and rescheduled to today + 1 period |
| 7 | Non-atomic write | The expense insert and the `nextExecution` advance were separate statements, so a crash between them duplicated the expense on restart |

## 2. MONTHLY: before → after

A rule created on a given date, showing where the next execution landed.

| Created | dayOfMonth | Before | After | Note |
|---|---|---|---|---|
| 2026-01-31 | 31 | 2026-03-31 | **2026-02-28** | February was skipped; now clamped into February |
| 2026-01-31 | 30 | 2026-03-30 | **2026-02-28** | |
| 2026-01-31 | 29 | 2026-03-29 | **2026-02-28** | |
| 2026-01-31 | 15 | 2026-03-15 | **2026-02-15** | a mid-month rule also skipped February |
| 2026-01-31 | 5 | 2026-03-05 | **2026-02-05** | |
| 2026-01-31 | 1 | 2026-03-01 | **2026-02-01** | |
| 2026-03-31 | 31 | 2026-05-31 | **2026-04-30** | April was skipped |
| 2024-01-31 | 31 | 2024-03-31 | **2024-02-29** | leap year |
| 2028-01-31 | 31 | 2028-03-31 | **2028-02-29** | leap year |
| 2026-01-15 | 15 | 2026-02-15 | 2026-02-15 | unchanged — this case was already correct |

**Blast radius.** For a rule created on 2026-01-31, **31 of 31** day-of-month
values previously resolved outside February. After the fix, **31 of 31** resolve
inside February, with days 29–31 clamping to the last day of the month.

## 3. WEEKLY: before → after

From Wednesday 2026-01-07, the configured weekday determines the next run.

| `dayOfWeek` | Old helper | Old cron | After |
|---|---|---|---|
| 0 (Sun) | 2026-01-11 | 2026-01-14 | **2026-01-11** |
| 1 (Mon) | 2026-01-12 | 2026-01-14 | **2026-01-12** |
| 2 (Tue) | 2026-01-13 | 2026-01-14 | **2026-01-13** |
| 3 (Wed) | 2026-01-14 | 2026-01-14 | **2026-01-14** |
| 4 (Thu) | 2026-01-08 | 2026-01-14 | **2026-01-08** |
| 5 (Fri) | 2026-01-09 | 2026-01-14 | **2026-01-09** |
| 6 (Sat) | 2026-01-10 | 2026-01-14 | **2026-01-10** |

The cron returned the same date for all seven configured weekdays — the setting
had no effect on when the expense was actually created. There is now one
implementation, and the configured weekday is honoured.

## 4. YEARLY

| From | Before | After |
|---|---|---|
| 2026-01-31 | 2027-01-31 | 2027-01-31 (unchanged) |
| 2024-03-15 | 2025-03-15 | 2025-03-15 (unchanged) |
| 2024-02-29 | 2025-03-01 | **2025-02-28** (clamped, no longer rolls into March) |

## 5. Unsupported frequency

| Input | Before | After |
|---|---|---|
| `frequency: "MONTHLYY"` | next execution = **today** → rule re-fires and duplicates an expense on **every** run | `null`; the rule is skipped and logged, and PUT now rejects the value with **400 `Invalid frequency.`** |

`test/p0/schedule.test.js` asserts that both write paths consult the same shared
allowlist, so POST and PUT cannot drift apart again.

## 6. Catch-up policy (requires your approval)

**Chosen policy:** materialise every missed period individually, dating each
expense at the period it was **due** (not at the run date), capped at
`MAX_CATCH_UP_PERIODS = 12` per rule per run. If a rule is further behind than
the cap, the remainder is created on the next run and a warning is logged naming
the rule.

Worked example — a monthly rule due 2026-01-15 that could not run until
2026-04-10:

| | Before | After |
|---|---|---|
| Expenses created | 1 (dated 2026-04-10) | 3 (dated 2026-01-15, 2026-02-15, 2026-03-15) |
| Periods lost | 2 | none |

Daily rule due 2026-01-01, running 2026-03-01, cap 5 → 5 periods created and
`hasMore: true`. The alternative policies considered were (a) roll forward and
lose the periods — the old behaviour, rejected because fixed costs like rent and
SIPs would silently vanish from the ledger; and (c) one aggregated catch-up entry
— rejected because it cannot be dated correctly or matched to a month.

**This is a business-rule change and is submitted for your approval before
activation.** Switching to "no catch-up" is a one-constant change
(`MAX_CATCH_UP_PERIODS = 1` would still create the current period; set the policy
in `listDuePeriods` to return an empty list for full roll-forward behaviour).

## 7. Duplicate prevention (idempotency)

Retries and concurrent runs can no longer double-post:

- Each period is **claimed** by a conditional `updateMany` whose `WHERE` includes
  the stored `nextExecution`. Of two concurrent workers, exactly one matches and
  receives `count === 1`; the other receives `0` and skips the period.
- The claim and the expense insert happen in **one `prisma.$transaction`**, so a
  failed insert rolls the claim back rather than losing the period. The result is
  at-most-once **without** being lossy.
- The claim also requires `isActive: true`, so pausing a rule mid-run prevents
  further entries.
- An unsupported schedule is skipped (`due.invalid`) rather than advanced, so it
  cannot produce an infinite stream of duplicates.

**Prepared, NOT applied — stronger database-level guarantee.** A unique
constraint would make duplicates impossible even if the application logic were
bypassed. This needs a schema change and a migration, so it is **deliberately not
written** yet: adding the field to `schema.prisma` before the migration is
applied would make the generated client select a column that does not exist and
break every expense query. Proposed change, to be made in **one commit** when you
approve it:

```sql
-- 1) nullable columns: no backfill, no NOT NULL, existing rows unaffected
ALTER TABLE "Expense" ADD COLUMN "recurringRuleId"   TEXT;
ALTER TABLE "Expense" ADD COLUMN "recurringPeriodKey" TEXT;

-- 2) the guarantee: one expense per rule per period
CREATE UNIQUE INDEX "Expense_recurringRuleId_recurringPeriodKey_key"
  ON "Expense"("recurringRuleId", "recurringPeriodKey");

-- 3) optional FK, so deleting a rule does not destroy its history
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_recurringRuleId_fkey"
  FOREIGN KEY ("recurringRuleId") REFERENCES "RecurringRule"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
```

together with `recurringRuleId String?` / `recurringPeriodKey String?` and
`@@unique([recurringRuleId, recurringPeriodKey])` on `Expense`.
`periodKey()` in `src/lib/schedule.js` already produces the required stable key
(`"2026-02-28"`).

## 8. What is NOT verified

- **No real database.** The transaction, the conditional claim and the migration
  are database guarantees. `prisma.$transaction` with `updateMany` has **not**
  been executed against PostgreSQL — that needs the approved non-production
  environment (P0-7). **Treat concurrency as designed-and-unit-tested, not
  proven.**
- **No concurrent execution was actually run.** The claim logic is unit tested
  for shape and the policy is verified, but two live workers were not raced.
- **Nothing has been deployed**, and no existing rule's `nextExecution` has been
  recalculated. On first run after deploy, existing rules will be caught up
  according to §6 — which is exactly why §6 needs approval first.
- Existing rules whose stored `frequency` is not one of the four supported values
  (only possible if PUT was used before this fix) will be **skipped and logged**
  rather than advanced, so they stop duplicating but also stop producing entries
  until corrected.
