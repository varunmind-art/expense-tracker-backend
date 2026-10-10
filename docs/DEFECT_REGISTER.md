# Expense Tracker — Consolidated Defect & Risk Register

Durable counterpart to the assessment reports. Covers **both** repositories:
`expense-tracker-backend` (referenced as `src/…`, `prisma/…`) and
`expense-tracker-frontend` (referenced as `FE:…`).

**Status legend:** `OPEN` · `FIXED` · `CORRECTED` (earlier report was wrong) ·
`DEFERRED` (needs approval) · `BLOCKED`

Last updated: P0-2 Phase A.

---

## P0 — approved programme

| ID | Defect | Evidence | Status |
|----|--------|----------|--------|
| **P0-1** | Deleting a category cascades to `Expense`/`Budget`/`RecurringRule` and destroys financial records. User Guide promises the opposite. | `prisma/schema.prisma:60,76,93`; `src/server.js` DELETE `/api/categories/:id`; `docs/USER_GUIDE.md:630` | **OPEN** — revised to category **archiving**; migration prepared only, not applied |
| **P0-2** | Reset-token privilege escalation: reset links were valid Bearer tokens; session tokens could be replayed as reset tokens; no password validation | `src/server.js` `authenticateToken`, `/api/auth/forgot-password`, `/api/auth/reset-password` | **Phase A FIXED** (`8991d64`). **Phase B OPEN** — session revocation after password change needs `passwordChangedAt` + schema approval |
| **P0-3** | Password-reset flow is broken end to end: the backend emails `${FRONTEND_URL}/reset-password?token=…` but no such route or component exists, so users who forget a password are permanently locked out | `src/server.js` forgot-password handler; `FE: src/App.jsx:50-63` (`grep -rn reset-password src/` → 0 hits) | **OPEN** — approved |
| **P0-4** | `PUT /api/recurring-rules/:id` does not allowlist `frequency`; an unknown value makes the scheduler return the clock unchanged, so the rule refires and duplicates an expense on **every** run, permanently | `src/server.js` PUT handler; `computeNextExecution` fall-through; cron predicate `nextExecution <= today` | **OPEN** — approved (tests already pin it in `test/baseline/scheduling.test.js`) |
| **P0-5** | MONTHLY scheduling skips an entire month when the run day exceeds the target month's length. Proved blast radius: **31/31** day-of-month values mis-schedule from Jan 31. Also: the cron duplicates `computeNextExecution` with divergent rules, is not transactional, and drops missed periods. | `computeNextExecution` (`setMonth` before `setDate`); cron inline advance; boot-time `setTimeout` | **OPEN** — approved |
| **P0-6** | Time-window inconsistencies: (a) month parsing is duplicated 3× and unvalidated (`?month=abc` → 500; out-of-range months silently roll over); (b) month windows exclude the final second (`.001`–`.999`) because the end boundary has `milliseconds = 0`; (c) **the echoed `month` label is derived via `toISOString().slice(0,7)` and is therefore server-timezone dependent** — on a host east of UTC, `?month=2026-03` returns `month: "2026-02"`; (d) `FE:` dashboard mixes three windows on one screen; budget progress ignores `b.period` and clamps overspend at 100% | `src/server.js` dashboard/stats/incomes month blocks; `FE: src/components/Dashboard/Dashboard.jsx:28-34,56,68`; `FE: BudgetProgress.jsx:25` | **OPEN** — approved |
| **P0-7** | Migration/constraint verification | — | **BLOCKED** — read-only check approved *in principle*; awaiting confirmation of a dedicated non-production Neon branch. Neon branches must not be assumed anonymized; no production records into the dev environment |

### Added to P0 by review decision

| ID | Defect | Evidence | Status |
|----|--------|----------|--------|
| **P0-6(e)** | **CSV export can emit the wrong date.** Rows stored at *local* midnight (exactly what the recurring cron writes) export one day early on a host east of UTC, because the export formats with `toISOString()`. UI-created rows are unaffected (date-only strings parse as UTC midnight). | cron `today.setHours(0,0,0,0)`; CSV builder; pinned in `test/baseline/csv.test.js` | **OPEN** — added to P0 |
| **P0-5(b)** | **WEEKLY scheduling inconsistencies.** `computeNextExecution` honours `dayOfWeek`; the cron's inline advance ignores it entirely and returns the same date for all 7 configured weekdays. The two implementations disagree. | pinned in `test/baseline/scheduling.test.js` | **OPEN** — folded into P0-5 |
| **P0-6(f)** | **Server-timezone month label.** See P0-6(c). Correct on Render (UTC), wrong on any host east of UTC. | `legacyMonthLabel`; pinned in `test/baseline/date-range.test.js` | **OPEN** — folded into P0-6 |

---

## Corrections (previously reported, now disproved)

| Finding | Earlier claim | Verified reality | Status |
|---------|---------------|------------------|--------|
| `?month=2024-13` window | "spans two months (2024-12-01 → 2025-01-31) labelled `2024-12`" | A **one-month** window: 2025-01-01 → 2025-01-31, mislabelled `2024-12`. The silent-rollover class of bug stands; the specific window did not. | **CORRECTED — closed, not open.** Pinned by test so it cannot drift back |
| Income negative amounts | implied negatives pass validation everywhere | Incomes **do** reject negatives (`-5` → 400). The bypass is specifically the `NaN` path (`"abc"`, `"1e999"`). Unvalidated negatives apply to budgets, recurring rules and pending imports, which have no guard at all | **CORRECTED** — nuance folded into the validation items below |

---

## Preserved validation findings (pending prioritisation)

No endpoint-level schema validator exists; validation is inconsistent and partly client-only.

| ID | Finding | Evidence |
|----|---------|----------|
| V-1 | `POST /api/expenses` has **no** amount validation (no positivity, no finiteness, no upper bound) | expenses POST handler; contrast the income guard |
| V-2 | Income amount guard is bypassable: `!"abc"` is false and `NaN <= 0` is false, so it reaches `parseFloat` → NaN → Prisma error → **500 instead of 400** | `test/baseline/validation.test.js` |
| V-3 | `PUT /api/expenses/:id` writes `type` verbatim with no allowlist; any value other than `EXPENSE`/`SAVINGS` makes the row vanish from the dashboard, merchant stats and frequency simultaneously | expenses PUT; dashboard/stats filters |
| V-4 | `categoryId` is never ownership-verified in 7 write paths while `accountId` is — cross-tenant read via `include: { category: true }` | budgets POST/PUT, recurring-rules POST/PUT, pending PUT/confirm, expenses POST/PUT |
| V-5 | `isActive`, `source`, `period`, `dayOfMonth` (1–31), `dayOfWeek` (0–6) and `limit` accept any JSON type or out-of-range values | merchant-list, incomes, budgets, recurring-rules, merchants/transactions |
| V-6 | ~49 blanket `res.status(500)` blocks conflate `P2025` (not found) and `P2002`/`P2009` (invalid) with real outages; ~12 omit `console.error` entirely | no global error handler, no JSON 404 handler |
| V-7 | No password policy anywhere: register checks truthiness only, `bcrypt` cost 10, no rate limiting on auth endpoints, user enumeration via `404 "No user found with this email."` | `src/server.js` register/login/forgot-password; `FE: src/components/Auth/Register.jsx:48-52` |

---

## Second-order and infrastructure risks

| ID | Finding | Evidence |
|----|---------|----------|
| I-1 | `node_modules/` is committed: **4,568 of 4,584** tracked files; `expense-tracker-backend/.gitignore` contains only `.env`. Any `npm install` churns thousands of tracked files — this is why the test harness uses `node:test` | `git ls-files` |
| I-2 | Frontend `.env` is committed (key `VITE_API_URL` only — no secret). Backend `.env` is correctly ignored | `git ls-files`; no credential patterns found in any tracked file |
| I-3 | No CI/CD, no Dockerfile, no `render.yaml`/`vercel.json`; no `prisma migrate deploy`, no `postinstall`, no `engines` pin. Migrations are applied by hand | repo scan |
| I-4 | `src/server.js.backup` (1,586 lines, untracked) is byte-for-byte the old `HEAD` plus a 224-line accounts block. Its only unique content is now in git (`dbf70ad`), so it is safe to delete | verified by diff |
| I-5 | `setup-frontend.sh` (tracked, 798 lines) regenerates 17 source files from September scaffolding and would clobber the current app | `grep -c "cat > src/"` → 17 |
| I-6 | No graceful shutdown (`SIGTERM`/`$disconnect`), no `/health`, no security headers, `cors()` with no origin allowlist, `x-powered-by` not disabled | `src/server.js` |
| I-7 | Gmail refresh token stored in plaintext; `oauth2Client` is a module-level singleton mutated per request, so concurrent syncs can read one user's mailbox with another's token | `prisma/schema.prisma`; Gmail sync flow |

---

## Frontend findings (component-level addendum)

| ID | Finding | Evidence |
|----|---------|----------|
| F-H1 | Dashboard mixes three time windows on one screen (filter-scoped expenses vs month-scoped summary vs a second `summaryMonth` computed from `now`) | `FE: src/components/Dashboard/Dashboard.jsx:28-34,56,68,125,127,157,164` |
| F-H2 | Budget progress compares a filter-scoped expense list against period-based budgets, ignores `b.period`, and clamps overspend at 100% so over-budget is invisible | `FE: src/components/Dashboard/BudgetProgress.jsx:6-27`; `BudgetManager.jsx:130-131` |
| F-M1 | Drawer "Categories" tab ignores the page month filter and queries the current month, so a merchant with spend in the selected month shows "No category data yet." | `FE: MerchantTransactionsDrawer.jsx:159-162` |
| F-M2 | No request cancellation anywhere; last response wins, so rapid month changes can display the wrong month's figures | dashboard, expenses, incomes, insights, drawer effects |
| F-M3 | All list mutations use the captured array instead of a functional updater → lost updates and resurrected rows | 5 components, ~20 sites |
| F-M4 | Non-idempotent toggle with no in-flight guard → UI/DB desync | `FE: RecurringRules.jsx:98-106` |
| F-M5 | Create/delete paths missing submit guards (category, alias, delete) while the expense form has one | `FE: CategoryManager.jsx:364`; `MerchantInsights.jsx:265` |
| F-M6 | Reporting labels misstate the data: "Total" includes savings that are also shown separately; "Merchants Active" is a search-filtered count; "All Time" is a 12-month figure | `FE: ExpenseList.jsx:125-128,217-228`; `MerchantInsights.jsx:337,390,423` |
| F-M7 | Keyboard gaps: `<tr onClick>` with no `tabIndex`/`role`/`onKeyDown`; modals and drawer without Escape, focus trap or `role="dialog"` | `FE: MerchantInsights.jsx:396-402`; `RecurringRules.jsx:371-468`; `CategoryManager.jsx:421-466`; `MerchantTransactionsDrawer.jsx:237-265` |
| F-M8 | No ErrorBoundary + unguarded nested API-shape access → one bad response white-screens the app; `JSON.parse` of localStorage unguarded in `AuthContext` | `grep -rn "ErrorBoundary" src/` → 0; `FE: AuthContext.jsx:11` |
| F-L* | Low-severity cluster: `formatIndianCurrency("")` → `"₹NaN.undefined"` (latent, unreachable today); two sums omit `parseFloat` (safe today because the API emits numbers, but Prisma `Decimal` serializes as a string); inconsistent date formatting (bare `toLocaleDateString()` vs `'en-IN'`); no `URL.revokeObjectURL`; drawer staleness on reopen | see component addendum |

---

## Fixed / verified

| Item | Evidence |
|------|----------|
| Accounts & Loans baseline preserved and committed with a rollback point | `dbf70ad`; schema purely additive (0 removed, 32 added); Prisma call sites unchanged apart from `prisma.account.*`; 0 string literals removed |
| Baseline regression harness | `3d675a2`; 42 characterization tests; zero new dependencies |
| P0-2 Phase A | `8991d64`; 21 new spec tests; 63 total passing |
