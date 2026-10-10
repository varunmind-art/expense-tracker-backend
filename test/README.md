# Backend test harness (P0-0)

## Why zero dependencies

This baseline suite uses **Node's built-in test runner** (`node:test`), not
Vitest/Jest. That is a deliberate deviation from the original P0 plan, for three
concrete reasons:

1. **`node_modules/` is tracked by git in this repo** (4,568 of 4,584 tracked
   files — see the P0-0 findings). Running `npm install` here churns thousands
   of tracked files, which conflicts with the standing instruction to preserve
   existing work and to keep each change reviewable.
2. Zero network dependency, so the suite runs anywhere with Node >= 20.
3. The regression risk we need to lock down first is **pure logic** (scheduling,
   date windows, CSV escaping, validation predicates) — `node:test` covers that
   completely.

DB-backed API tests (Supertest) and browser tests (Playwright) remain part of
the plan, but they require a non-production database branch and package installs,
both of which need separate approval. See "Not yet covered" below.

## Running

```bash
cd expense-tracker-backend
npm test                      # runs everything under test/
node --test test/baseline/scheduling.test.js   # one file
```

The suite is timezone-independent for local-calendar arithmetic (assertions use
local getters). The two places where the server timezone genuinely changes
behaviour — the echoed `month` label and CSV dates — are asserted against a
computed expectation and documented inline.

## Layout

```
test/
  support/
    legacy-logic.js   verbatim copy of the pure logic currently inside
                      src/server.js, with defects annotated and the source
                      line ranges cited. DO NOT "fix" this file.
    dates.js          local-calendar formatting helpers
  baseline/
    scheduling.test.js   computeNextExecution / cron advance  (P0-4, P0-5)
    date-range.test.js   month-window parsing                (P0-6)
    csv.test.js          /api/export/csv line builder         (P0-6, P1)
    validation.test.js   amount/type/frequency/enum guards    (P0-4, P1)
```

## What this suite is for

These are **characterization tests**: they pin down what the code does *today*,
defects included, and they are green now. When a fix milestone lands, the
assertions marked `DEFECT` are inverted to the corrected expectation. That
intentional diff is the audit trail proving behaviour changed — and it produces
the before/after evidence required for the recurring-schedule report.

Tests marked `(correct today)` guard behaviour that must **not** regress.

## Why `legacy-logic.js` is a copy

`src/server.js` cannot be imported in a test: importing it opens a port
(`app.listen`), instantiates `PrismaClient`, schedules a cron job and starts a
10-second timer. Testing the real module therefore requires the P1 module split
(deferred until after the pending Accounts/Loans commit, so the two changes stay
separately reviewable).

Fidelity of the copy is verified mechanically: with comments and whitespace
stripped, the transcribed `computeNextExecution` body is byte-identical to
`src/server.js:167-207`, apart from one documented, test-only clock seam
(`nowIn`) that makes the tests deterministic.

## Not yet covered (needs separate approval / installs)

- **DB-backed API + authorization tests** (Supertest): tenant isolation, reset
  tokens rejected as session tokens, 4xx-not-5xx validation matrix. Requires a
  non-production database branch and a package install.
- **Browser regression tests** (Playwright): password-reset round trip, dashboard
  and budget time windows, deep-link refresh.

These are tracked in the P0 plan and will be added when the environment is
approved.
