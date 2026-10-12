# Loan Tracker — Progress Checkpoint

**Status: NOT STARTED (reconnaissance complete). Session ended at execution limit.**
Written at the point of session exhaustion so the next session can resume without
repeating analysis. Read this file first.

---

## 1. Verified current state (with evidence)

| Area | State |
|---|---|
| `Loan` model | **Exists** in `prisma/schema.prisma`, complete |
| `LoanPayment` model | **Exists**, complete |
| Migration applied to dev | **Yes** — `20261004_add_accounts_and_loans`; the `Loan` and `LoanPayment` tables were confirmed present by the P0-7 post-migration verification (11 app tables) |
| Backend loan API | **DOES NOT EXIST** — `grep -rin "loan" src/` returns **zero** matches |
| Frontend loan UI | **DOES NOT EXIST** — no loan files, no `/loans` route in `src/App.jsx` |
| Existing loan tests | **None** |

**Correction to an earlier report:** the "5 new routes" in commit `dbf70ad` were
**Accounts** routes (`/api/accounts`, `/api/accounts/:id`, `/api/accounts/:id/toggle`),
**not** loan routes. Any earlier claim that loan APIs existed was wrong.

So this is a **greenfield feature build on an already-applied schema**. No migration
is needed for the MVP — the schema is sufficient as-is.

### `Loan` fields (from schema)
`id, name, lender?, loanType (default HOME_LOAN), originalPrincipal Dec(14,2),
currentPrincipal Dec(14,2), interestRate? Dec(6,3), emiAmount? Dec(14,2),
startDate?, endDate?, emiDay?, isActive (default true),
paymentAccountId? -> Account (onDelete: SetNull), userId -> User (Cascade),
payments[], createdAt, updatedAt, @@index([userId])`

### `LoanPayment` fields
`id, date, totalAmount Dec(14,2), principalAmount Dec(14,2),
interestAmount Dec(14,2), extraPrincipal Dec(0) Dec(14,2),
outstandingAfter? Dec(14,2), note?, loanId -> Loan (Cascade),
createdAt, @@index([loanId])`

Note: `LoanPayment` has **no `userId`** — user isolation must be enforced through
the parent `Loan` (this is exactly the P0-8 lesson: verify ownership via the parent,
never trust a record id).

---

## 2. MVP defaults (routine ambiguities resolved — no approval needed)

1. **Loan repayments do NOT create `Expense` rows.** Loan payments live only in
   `LoanPayment`. This is what "avoid generating duplicate Expense records" means
   and it keeps a single source of truth for spending.
2. **Prepayment default: reduce tenure, keep EMI unchanged** (the Indian
   home-loan convention). Offer the alternative as an explicit flag on the
   simulator, not as stored state.
3. **Interest rate change:** applies from the next unpaid period forward; past
   `LoanPayment` rows are immutable history.
4. **Rounding:** half-up to 2 decimal places; the **final instalment absorbs the
   rounding remainder** so the schedule closes to exactly zero.
5. **Part-payment vs extra principal:** a part-payment reduces principal
   immediately and does not change the EMI; recorded as `extraPrincipal` with
   `principalAmount = 0` (or the split the user supplies).
6. **Zero-interest loans:** allowed (`interestRate = 0`); every rupee is principal.
7. **`currentPrincipal` is authoritative** and must equal
   `originalPrincipal - sum(principalAmount + extraPrincipal)`. Recompute it after
   every payment mutation rather than incrementally drifting.
8. **Forecast vs actual are separate types:** amortization/payoff projections are
   computed on the fly and never persisted; only `LoanPayment` rows are stored.

### Material decisions still needing the user (do not guess)
- **A.** Should a loan payment *optionally* create a linked `Expense` row for
  budget/dashboard visibility? Default is **no**; if yes, it needs a schema link
  (`Expense.loanPaymentId`) — i.e. a migration.
- **B.** Should EMI amounts auto-adjust when a prepayment is recorded under a
  "reduce EMI" preference? Default: **no**, tenure shortens.

---

## 3. Backend work remaining

### 3a. New pure calculation module `src/lib/loans.js` (no DB, no Express)
Functions to implement and unit-test offline:
- `emiFor(principal, annualRatePercent, months)` -> EMI (handle rate = 0)
- `buildAmortizationSchedule({ principal, annualRatePercent, emi, startDate, extraPrincipal })`
  -> array of `{ period, date, openingBalance, interest, principal, extraPrincipal, emi, closingBalance }`
- `outstandingBalance(loan, payments, asOfDate)` -> never negative
- `splitEmi(openingBalance, annualRatePercent, emi)` -> `{ interest, principal, isFinal }`
- `remainingTenure(balance, annualRatePercent, emi)` -> months
- `payoffDate(balance, annualRatePercent, emi, fromDate)` -> Date
- `prepaymentSavings({ ...payments }, extraAmount)` -> `{ interestSaved, monthsSaved, newPayoffDate }`
- `rateChangeImpact(schedule, newRatePercent)` -> revised schedule
- `clampToZero(value)` — guard so balance can never go negative
- Rounding helper: half-up to 2 dp; final instalment absorbs the remainder.

**Critical:** these must be pure functions with money handled carefully. Prefer
integer paise internally or `Number` with explicit 2-dp rounding at each boundary —
do **not** let float error accumulate across a 240-period schedule.

### 3b. Routes to add in `src/server.js` (follow existing conventions)
All routes: `authenticateToken`, and **ownership via the parent `Loan`**
(`where: { id, userId: req.user.id }` — verified in P0-8 to enforce the extra filter).

```
GET    /api/loans                      list (with computed outstanding + progress)
POST   /api/loans                      create
GET    /api/loans/:id                  detail
PUT    /api/loans/:id                  update
DELETE /api/loans/:id                  delete (LoanPayment cascades)
PATCH  /api/loans/:id/toggle           isActive
GET    /api/loans/:id/schedule         computed amortization (NOT persisted)
GET    /api/loans/:id/summary          outstanding, progress %, tenure left, payoff date
POST   /api/loans/:id/payments         record EMI / part-payment / prepayment
PUT    /api/loans/:id/payments/:pid    edit a payment (recompute currentPrincipal)
DELETE /api/loans/:id/payments/:pid    delete a payment (recompute currentPrincipal)
POST   /api/loans/:id/simulate         payoff simulator (body: extraAmount, newRate?)
POST   /api/loans/:id/adjust           manual balance adjustment (writes a LoanPayment with note)
```

Validation rules: reject negative amounts; reject a payment that would drive
`currentPrincipal` below zero (or clamp and record the final instalment); reject
non-numeric `interestRate`; use the existing `authorizeCategory`-style pattern of a
generic 400 rather than leaking Prisma errors (P2 lesson).

### 3c. Migration needed?
**None for the MVP.** The schema already supports everything above. Only the
optional decision **A** would require a new additive migration.

---

## 4. Frontend work remaining

New files under `src/components/Loans/`:
```
LoansList.jsx          My Loans dashboard: cards with outstanding, progress bar, next EMI
LoanForm.jsx           Add + Edit (shared), validation, account picker
LoanDetail.jsx         Overview / Payments / Schedule tabs
LoanPayments.jsx       Repayment history table (actual payments)
AddPaymentModal.jsx    EMI | Part-payment | Prepayment modes, live preview of impact
AmortizationTable.jsx  Computed schedule, forecast styling clearly distinct from actuals
PayoffSimulator.jsx    extraAmount + rate slider, shows interest saved & months saved
```
New helper: `src/utils/loans.js` re-exporting/wrapping the backend formulas for
client-side preview (or compute preview server-side via `/simulate` to avoid
duplicating money logic — **prefer server-side to keep one source of truth**).

Routes in `src/App.jsx` (all session-gated, matching existing style):
```
/loans            -> LoansList
/loans/new        -> LoanForm
/loans/:id        -> LoanDetail
/loans/:id/edit   -> LoanForm
```
Navigation: add a "Loans" entry alongside Expenses / Budgets / Income / Recurring
in the `Layout` sidebar; must work on mobile (existing responsive pattern).

Follow existing UI conventions: Tailwind 3, same card/table/modal primitives as
`components/Expenses` and `components/Budgets`. Match the existing
loading/error/empty-state handling.

---

## 5. Tests to add

Offline (`test/p0/loans.test.js`) — pure functions, no DB:
- EMI formula against hand-computed values (e.g. 1,000,000 @ 8.5% / 240 months).
- Zero-interest loan splits entirely to principal.
- Schedule closes to exactly 0 and never goes negative.
- Final instalment absorbs rounding remainder.
- Prepayment reduces total interest and shortens tenure.
- Rate change recomputes forward only.
- `outstandingBalance` matches `originalPrincipal - sum(principal + extra)`.

Database-backed (`test/db/loans.test.js`) — **must start with `runPreflight()` before
requiring `src/server`** (see safety below):
- Create / read / update / delete a loan.
- Record and edit payments; `currentPrincipal` stays correct.
- User A cannot read, update or delete user B's loan or payments (P0-8 pattern).
- A payment cannot drive the balance negative.
- `LoanPayment` rows survive a `Loan` update; delete a loan and its payments cascade.

---

## 6. Production readiness

- **`prisma generate` must run in the build** — the generated client was stale
  (missing `tokenVersion`) and `scripts/verify-prisma-client.js` now exists to fail
  the build. Render build command must be:
  `npm ci && npx prisma generate && node scripts/verify-prisma-client.js`
- **`tokenVersion` migration is applied to development only.** Deploying the
  current backend requires it in production first — a release-plan dependency.
- The `Loan`/`LoanPayment` migration is **already applied to development**; it must
  also be applied to production as part of the release.
- Clean-install build path is **unproven** (npm cache ownership blocked it).
- **Do not deploy or touch production without explicit approval.**

---

## 7. Next executable task

**Start here, in this order:**

1. Write `src/lib/loans.js` with the pure functions listed in 3a, plus
   `test/p0/loans.test.js`. Run `npm test`. This is self-contained, needs no
   database, and is the foundation everything else depends on.
2. Add the `/api/loans*` routes to `src/server.js` (3b) following the existing
   `authenticateToken` + parent-ownership pattern.
3. Add `test/db/loans.test.js` (preflight first!) and run `npm run test:db`.
4. Build the frontend under `src/components/Loans/` + routes + nav.
5. Run full suites: `npm test`, `npm run test:db`, frontend `npm test`, and the
   frontend `npm run build`.

---

## 8. Safety constraints — READ BEFORE WRITING ANY CODE

1. **`.env` in this workspace is PRODUCTION.** `.env.dev` is development. There was
   a real incident (P0-5C.1a) where a test imported `src/server` with no preflight,
   which loaded production credentials and ran the scheduler against production.
2. **Any file that requires `src/server` MUST live in `test/db` and call
   `runPreflight()` BEFORE the import.** `test/p0/no-server-import.test.js` now
   enforces this — do not weaken it.
3. `DISABLE_SCHEDULERS` is currently **fail-open** (absent = schedulers ON). Until
   that default is inverted, never import `src/server` without the preflight.
4. Run database tests only with `npm run test:db` (serialised, preflight-guarded).
5. Do not reset or truncate the development database; use scoped fixtures.
6. Pending unapproved work elsewhere: the production-access impact assessment
   (read-only queries A–D were proposed but **not executed**), category archiving,
   rate limiting, frontend P0-6 remainder, CSV hardening.
7. Working tree has one stray untracked file: `src/server.js.backup`.
8. `node_modules` is git-tracked in this repo, so `prisma generate` churns
   thousands of tracked files — do not commit that churn.
