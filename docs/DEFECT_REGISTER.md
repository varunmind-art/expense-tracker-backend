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
| **P0-2** | Reset-token privilege escalation: reset links were valid Bearer tokens; session tokens could be replayed as reset tokens; no password validation | `src/server.js` `authenticateToken`, `/api/auth/forgot-password`, `/api/auth/reset-password` | **Phase A FIXED** (`8991d64`). **Phase B prepared** (`f536c27`) — `tokenVersion` counter; migration included but **NOT applied**. Supersedes the approved timestamp design (rationale below) |
| **P0-3** | Password-reset flow was broken end to end: the backend emails `${FRONTEND_URL}/reset-password?token=…` and no such route or component existed, so a forgotten password meant permanent lockout | was: `FE: src/App.jsx` had no `/reset-password` route (`grep -rn reset-password src/` → 0 hits) | **FIXED** (`957ba5f`) — route + component + 33 tests + passing build. Residual gap: no browser execution yet (needs Playwright) |
| **P0-4** | `PUT /api/recurring-rules/:id` did not allowlist `frequency`; an unknown value made the scheduler return the clock unchanged, so the rule refired and duplicated an expense on **every** run, permanently | was: PUT handler had no validation while POST did; `computeNextExecution` fall-through | **FIXED** — both write paths share one allowlist and return 400 `Invalid frequency.`; the scheduler skips an unusable schedule instead of advancing it. Tests: `test/p0/schedule.test.js` |
| **P0-5** | MONTHLY scheduling skipped an entire month when the run day exceeded the target month's length (**31/31** day-of-month values affected). The cron duplicated the scheduler with divergent WEEKLY/YEARLY rules, was non-transactional, and dropped missed periods | was: `setMonth()` before `setDate()`; inline cron copy; separate insert + advance | **FIXED** — single implementation in `src/lib/schedule.js`, correct month-end/leap-year clamping, weekly honours `dayOfWeek`, catch-up with a documented cap, and conditional-claim idempotency inside one transaction. Before/after report: `docs/P0-5_SCHEDULE_CHANGE_REPORT.md` |
| **P0-6** | Time-window inconsistencies: (a) month parsing is duplicated 3× and unvalidated (`?month=abc` → 500; out-of-range months silently roll over); (b) month windows exclude the final second (`.001`–`.999`) because the end boundary has `milliseconds = 0`; (c) **the echoed `month` label is derived via `toISOString().slice(0,7)` and is therefore server-timezone dependent** — on a host east of UTC, `?month=2026-03` returns `month: "2026-02"`; (d) `FE:` dashboard mixes three windows on one screen; budget progress ignores `b.period` and clamps overspend at 100% | `src/server.js` dashboard/stats/incomes month blocks; `FE: src/components/Dashboard/Dashboard.jsx:28-34,56,68`; `FE: BudgetProgress.jsx:25` | **OPEN** — approved |
| **P0-7** | Migration/constraint verification | — | **BLOCKED** — see the environment finding below. No Prisma command may be run against the single configured target until a dedicated non-production branch is confirmed |

### P0-7 environment finding (blocks the check)

The backend has **exactly one** environment file (`.env`) and **exactly one** `DATABASE_URL` key. There is no `.env.local`, `.env.development`, `directUrl` or any other non-production configuration (verified by key names only; no secret values read). Two consequences:

1. Any Prisma command run from this repo today targets the single configured database, which must be treated as **production** until the operator confirms otherwise. Running `prisma migrate status` now is therefore **not authorised**.
2. `DATABASE_URL` contains `-pooler`, i.e. a **Neon pooled endpoint**. Pooled endpoints are unsuitable for migrations (advisory locks / transaction semantics); migrations should use the **direct** endpoint. Recommendation: add `directUrl = env("DIRECT_URL")` to the datasource so application traffic and migrations can use different endpoints.

**Required before the check can run:** an operator-confirmed Neon **branch** connection string (supplied as an invocation-time env override, never committed), plus confirmation from the Neon console that the branch contains **no copied production financial data**. Neon branches must not be assumed anonymised, and production records must not be brought into this environment.

### P0-2 Phase B design decision (recorded)

The approved design compared the token's `iat` against a new `passwordChangedAt` timestamp. **This was superseded by a per-user `tokenVersion` counter**, at your invitation to propose a stronger alternative. Verification showed a concrete defect in the timestamp design: `iat` has **second** precision while a DB timestamp has **millisecond** precision, so a session issued in the same second as a password change can compare as older and be **wrongly rejected**. Truncating the stored timestamp fixes that but opens a **one-second grace window** in which a stolen pre-change token still works. The counter removes the clock from the decision entirely (integer equality: no skew, no tolerance, no instance-clock dependence) and both designs need the same single user read per request. The hazard and the grace window are both demonstrated by test in `test/p0/session-revocation.test.js`. The migration is unapplied, so reverting to the timestamp design is a small, isolated change.

### Elevated to P0 by review decision

| ID | Defect | Evidence | Status |
|----|--------|----------|--------|
| **P0-8** | **No category ownership validation.** `categoryId` is taken from the request body and written with only a foreign-key check, never verifying it belongs to the caller, in **seven** write paths: expenses POST/PUT, budgets POST/PUT, recurring-rules POST/PUT, pending PUT/confirm. Five of them return the referenced category via `include: { category: true }`, so an attacker can read another user's category name, icon and colour. `accountId` **is** correctly checked (`getOwnedAccount`), which is what makes the omission an inconsistency rather than a design choice. | see §V-4 below | **OPEN — elevated to P0.** Implementation, the full ownership audit (accounts, budgets, merchants, recurring rules) and the cross-tenant regression suite are **not yet done**; they need the DB-backed test environment for the positive cases |

### P0-6 status after the latest milestone

**PARTIAL.** Delivered and verified: `src/lib/dateRange.js` (strict month/date validation, half-open windows, timezone-stable labels) and `src/lib/csv.js` (RFC 4180 quoting, formula-injection guard, application-local dates), with 21 tests including wiring guards. The **CSV export endpoint is wired** to the safe builder.

**Still unresolved:** the three backend month endpoints (`/api/dashboard/summary`, `/api/merchants/stats`, `/api/incomes`) still use their own duplicated, unvalidated month parsing and the millisecond-excluding end boundary; and the frontend still mixes three time windows on one screen (F-H1) and ignores `b.period` in budget progress (F-H2). No frontend date-window work has been done.

### Added to P0 by review decision — authentication findings

| ID | Defect | Evidence | Status |
|----|--------|----------|--------|
| **A-1** | **PINLock interferes with the public login and password-recovery routes.** `App.jsx` returns `<PINLock>` *before* `<Routes>`, so when `web_pin` is set it gates the entire app — including `/login`, `/forgot-password` and the new `/reset-password`. A locked-out user must pass a device PIN to reach the screens that exist to recover access. `web_pin` is never written by any UI, so this is latent rather than live. | `FE: src/App.jsx` (PINLock branch precedes `<Routes>`); `grep -rn "web_pin" src/` shows no writer | **OPEN** — fix prepared (below) |
| **A-2** | **Forgot-password account enumeration.** `POST /api/auth/forgot-password` returns `404 "No user found with this email."` for an unknown address versus `200` for a known one, so an attacker can confirm which emails are registered. There is also **no rate limiting** on any auth endpoint, so the endpoint doubles as a mail-bomb primitive. | `src/server.js` forgot-password handler (`if (!user) return res.status(404)`) | **OPEN** — fix prepared (below) |

#### A-1 prepared fix (frontend only, no schema, no DB)

Move the PIN gate so it protects **only authenticated financial screens**, never the public auth routes.

- Keep `PINLock` exactly as strong as it is for the app shell: the gate should wrap the authenticated layout, not precede `<Routes>`.
- Concretely: leave `/login`, `/register`, `/forgot-password` and `/reset-password` reachable without the PIN, and render the PIN gate only for routes that require a session (i.e. inside the `token`-gated branch, or as a layout element around those routes).
- **Do not weaken PIN protection** for authenticated financial screens — those keep the same gate and the same behaviour. This is a routing-order change, not a reduction in protection.
- Recommend adding a "Forgot PIN?" affordance that clears `web_pin` **only after** a successful password reset, so a forgotten PIN is not a second lockout.
- Tests: assert the four public routes render while `web_pin` is set; assert financial routes still show the PIN gate.

#### A-2 prepared fix (small, no dependency)

1. **Consistent public response.** Always return the same `200 { message: 'If that email is registered, a reset link has been sent.' }` regardless of whether the account exists, and only send mail when it does. This removes the enumeration oracle with **no change to the request contract** — the frontend already shows a generic "check your email" state.
2. **Rate limiting.** Not yet implemented, because the choice has a real trade-off and I will not pick it silently:
   - *(a) In-process limiter, zero dependencies.* Protects a single instance; **does not** hold across multiple Render instances or restarts. Honest but partial.
   - *(b) `express-rate-limit` + a shared store (e.g. Redis/Upstash).* Correct across instances; adds a dependency and external service to operate.
   - *(c) Platform-level limiting at the edge.* No code; depends on the hosting tier.
   **Recommendation: (a) now to raise the cost immediately, then (b) when a shared store is acceptable.** The limiter must key on IP **and** the submitted email, must not reveal whether the email exists, and must apply to `/login`, `/register`, `/forgot-password` and `/reset-password`.
3. Also recommended alongside: log the enumeration attempts rather than only rate-limiting them.

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
