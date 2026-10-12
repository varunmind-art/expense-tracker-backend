# Loan Tracker — Production Release Plan

**Status: implementation complete and verified in development. NOT DEPLOYED.**
**Production was not accessed, queried or migrated while producing this plan.**

Read this together with `docs/LOAN_TRACKER_CHECKPOINT.md` (the reconnaissance this
build resumed from).

Feature commits:

| Commit | Repo | What |
|---|---|---|
| `df1baf6` | backend | P0-9.1 loan calculation engine (`src/lib/loans.js`) |
| `d866ebf` | backend | P0-9.2 loan APIs (13 routes in `src/server.js`) |
| `3233c0a` | backend | P0-9.4 frontend/API contract test |
| `56a5a04` | frontend | P0-9.3 Loan Tracker UI, routes and navigation |

---

## 1. What is being released

### Backend

- `src/lib/loans.js` — pure loan mathematics. No database, no Express, so it is
  unit-testable offline. Money is integer paise internally; the final instalment
  absorbs the rounding remainder.
- 13 authenticated routes in `src/server.js`:

  | Method | Path | Purpose |
  |---|---|---|
  | GET | `/api/loans` | list, with computed outstanding and progress |
  | POST | `/api/loans` | create |
  | GET | `/api/loans/:id` | detail + payment history |
  | PUT | `/api/loans/:id` | update |
  | PATCH | `/api/loans/:id/toggle` | pause / resume |
  | DELETE | `/api/loans/:id` | delete (payments cascade) |
  | GET | `/api/loans/:id/payments` | payment history + totals |
  | POST | `/api/loans/:id/payments` | record EMI / part-payment / prepayment |
  | PUT | `/api/loans/:id/payments/:paymentId` | edit a payment |
  | DELETE | `/api/loans/:id/payments/:paymentId` | delete a payment |
  | GET | `/api/loans/:id/summary` | outstanding, progress, tenure, payoff |
  | GET | `/api/loans/:id/schedule` | amortization + forward projection |
  | POST | `/api/loans/:id/simulate` | prepayment and rate-change scenarios |
  | POST | `/api/loans/:id/adjust` | manual balance adjustment |

- **No schema change and no new migration.** The `Loan` and `LoanPayment` models
  already exist and were already applied to development by
  `20261004_add_accounts_and_loans`.

### Frontend

- `src/components/Loans/` — `LoansList`, `LoanForm`, `LoanDetail`,
  `LoanPayments`, `AddPaymentModal`, `AmortizationTable`, `PayoffSimulator`.
- `src/utils/loans.js` — display helpers only; contains no loan mathematics.
- Routes `/loans`, `/loans/new`, `/loans/:id`, `/loans/:id/edit` (session-gated).
- A "Loans" navigation entry plus a mobile menu.

---

## 2. Verification evidence (development)

All of the following were run against the verified Neon **development** database
behind the fail-closed preflight (`test/db/preflight.js`), which aborts unless the
branch is `p0-hardening`, the host matches the approved development hostname, and
the target differs from `.env` (production).

| Check | Command | Result |
|---|---|---|
| Loan mathematics (offline) | `node --test test/p0/loans.test.js` | **76/76 pass** |
| Backend offline suite | `npm test` | **291 pass, 0 fail**, 2 pre-existing todos |
| Loan APIs (real HTTP, real DB) | `node --test --test-concurrency=1 test/db/loans.test.js` | **28/28 pass** |
| Whole database suite | `npm run test:db` | **63 pass, 0 fail**, 2 pre-existing todos |
| Frontend suite | `npm test` (frontend) | **64/64 pass** |
| Frontend production build | `npm run build` (frontend) | **built successfully** |
| Prisma Client + backend build | `npm run build` (backend) | **11 models, 106 scalar fields verified** |

Coverage of the acceptance criteria:

1. **Add a loan** — `POST /api/loans` + `LoanForm`; malformed input answers 400, never 500.
2. **Correct EMI and outstanding principal** — `emiFor` pinned to closed-form
   values (1,000,000 @ 8.5% / 240 → 8,678.23); `outstandingBalance` equals
   `originalPrincipal − Σ(principal + extra)`.
3. **Amortization schedule** — schedules close to exactly zero, never go negative,
   and survive 600 periods without floating-point drift.
4. **Record an EMI payment** — interest/principal split pinned; interest is never
   counted as repayment.
5. **Record an additional prepayment** — principal only, no interest, EMI unchanged.
6. **Principal reduction, interest savings, revised payoff** — prepayment shortens
   the tenure by default (Decision B) and the simulator reports interest saved.
7. **Multiple loans from one dashboard** — list endpoint scoped to the caller.
8. **Ownership isolation** — user B receives 404 on every read and write against
   user A's loan, and cannot reach user A's payment ids through their own loan.
9. **Frontend/API contract** — `P0-9.4` pins every field the UI reads.

### Re-verified at the release-readiness gate (2026-10-12)

| Check | Command | Result |
|---|---|---|
| Loan mathematics | `node --test test/p0/loans.test.js` | **76 pass, 0 fail** |
| Backend offline suite | `npm test` | **291 pass, 0 fail**, 2 todo |
| Whole database suite | `npm run test:db` | **62 pass, 0 fail**, 2 todo |
| Loan API tests | `test/db/loans.test.js` | **28 pass, 0 fail** |
| Test-isolation guard | `test/p0/no-server-import.test.js` | **2 pass** |
| Frontend suite | `npm test` | **64 pass, 0 fail** |
| Frontend production build | `npm run build` | built, `dist/` produced |
| Prisma Client + backend build | `npm run build` | **11 models / 106 scalar fields verified** |
| Generated client has the models | runtime probe | `prisma.loan` ✓ `prisma.loanPayment` ✓ `User.tokenVersion` ✓ |
| **Clean-checkout install and build** | repo copied without `node_modules`, then `npm install` → `npm run build` → boot | **exit 0 at every step**; `/ping` → 200, `/api/loans` → 401 |

### Development migration history (read-only probe)

All 10 migrations are `applied`, **0 failed or incomplete**, both required
migrations included, and 12 application tables exist including `Loan` and
`LoanPayment`. The dev database was left with **0 loan and 0 payment rows**, which
confirms the test fixtures clean up after themselves.

Each Prisma migration runs inside a transaction on PostgreSQL, so a migration that
fails part-way is rolled back as a unit and leaves no half-applied schema. Combined
with the fact that both required migrations are **purely additive**
(`ADD COLUMN ... NULL`, `CREATE TABLE`, `CREATE INDEX`, `ADD CONSTRAINT`, and one
`ADD COLUMN ... NOT NULL DEFAULT 0`), the schema step cannot destroy existing
Expense Tracker data.

---

## 3. Release dependencies — read before deploying

### 3.1 The loan migration must exist in production

`20261004_add_accounts_and_loans` creates the `Loan` and `LoanPayment` tables.
It is applied to **development**. Its state in **production is UNVERIFIED** — this
plan did not query production, and nobody should assume either way.

Without it, every `/api/loans` route fails at the database. Deploy the backend
only after `prisma migrate deploy` reports no pending migrations.

### 3.2 The pre-existing `tokenVersion` dependency

`20261010225757_add_user_token_version` adds `User.tokenVersion`, which
`authenticateToken` reads on **every** authenticated request. It is applied to
development only. It is a hard prerequisite: without the column, login succeeds
and then every authenticated call fails, including all loan routes.

**This is not a Loan Tracker change.** It is an existing release dependency that
the loan release sequence must carry, because both migrations land in the same
deploy.

Because it sorts *after* the loan migration by timestamp, a single
`prisma migrate deploy` applies both in the correct order.

### 3.3 Prisma Client generation is mandatory

`node_modules` is committed in the backend repository, and the committed generated
client has historically been stale (it was missing `tokenVersion`). A stale client
fails at runtime, not at build time, unless the build regenerates it.

- `npm run build` runs `prisma generate` **and**
  `node scripts/verify-prisma-client.js`, which fails the build unless every model
  and scalar field in `prisma/schema.prisma` is present in the generated client.
- The `postinstall` script also runs `prisma generate`.

The Render build command must therefore regenerate the client explicitly rather
than relying on the committed `node_modules`.

**Do not commit the `prisma generate` churn.** It rewrites thousands of tracked
files under `node_modules/.prisma/client`; that churn is noise, not a change.

### 3.4 `directUrl` is not declared

`prisma/schema.prisma` declares only `url = env("DATABASE_URL")`. Migrations take
advisory locks, which do not behave correctly through a connection pooler, so the
migration command must use the **unpooled** connection string:

```bash
DATABASE_URL="<production DIRECT_URL>" npx prisma migrate deploy
```

The running application keeps using the pooled `DATABASE_URL`.

### 3.5 Deploy order matters

The frontend calls `/api/loans*`. Deploy it **after** the backend, or the Loans
pages render errors against a 404.

---

## 4. Production release sequence

> **Every step marked ⛔ requires explicit human approval. Do not run it
> unattended.** This workspace's `.env` points at production.

### Step 0 — Pre-flight, read-only ⛔

Confirm the production target and migration state **before** changing anything.

```bash
cd expense-tracker-backend

# 0a. Confirm the target is production and nothing else.
#     Print only the host and database name — never the credential.
DATABASE_URL="<production DIRECT_URL>" npx prisma migrate status

# 0b. Snapshot the pre-migration baseline (read-only). Keep this output.
DATABASE_URL="<production DIRECT_URL>" npx prisma db execute --stdin <<'SQL'
SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at;
SQL
```

Expected: a list of migrations with `20261004_add_accounts_and_loans` and
`20261010225757_add_user_token_version` marked applied or **pending**, and a
baseline snapshot to compare against afterwards.

Also record, as the "known good" reference for acceptance step 8:

```bash
DATABASE_URL="<production DIRECT_URL>" npx prisma db execute --stdin <<'SQL'
SELECT (SELECT COUNT(*) FROM "User") AS users,
       (SELECT COUNT(*) FROM "Expense") AS expenses,
       (SELECT COUNT(*) FROM "Income") AS incomes;
SQL
```

**Stop and investigate if:** the host is not the production host, `migrate status`
reports a **failed** migration, or it reports drift. Do not proceed to
`migrate deploy`.

**Contingency — the tables already exist but the migration is not recorded.**
If `migrate status` says the loan migration is pending yet `"Loan"` already exists
in production (someone created it by hand), `migrate deploy` will fail with
"relation already exists". In that case mark it applied instead of re-running it:

```bash
DATABASE_URL="<production DIRECT_URL>" npx prisma migrate resolve --applied 20261004_add_accounts_and_loans
```

### Step 1 — Back up / establish the restore point ⛔

`pg_dump` and `psql` are **not installed in this workspace**, and the P0-7 policy
forbids copying production financial rows into the development project. So the
backup is Neon's own history, plus a recorded baseline:

1. **Record the restore timestamp.** Immediately before `migrate deploy`, note the
   UTC time (e.g. `date -u +%Y-%m-%dT%H:%M:%SZ`). Neon keeps a continuous
   point-in-time-restore window for the production project; this timestamp is the
   restore point. Confirm the window length in the Neon console first — it must
   comfortably exceed the maintenance window.
2. **Snapshot in-project (optional but preferred).** Create a Neon *branch of the
   production project* as a labelled pre-release snapshot. This stays inside the
   production project and does not copy production rows anywhere new. Do **not**
   branch production into the development project.
3. **Every step above is additive**, so recovery normally means redeploying the
   previous build, not restoring data.

### Step 1b — Rollback actions, in order of severity

| Situation | Action |
|---|---|
| Build or deploy fails | Redeploy the previous Render build. Schema is untouched. |
| A migration fails part-way | It rolled back as a unit. Fix the cause, then re-run `migrate deploy`. If the history row is stuck, `npx prisma migrate resolve --rolled-back <migration_name>`. |
| API returns 500 on all authenticated routes | Suspect a missing `tokenVersion` column. Re-check step 2 and `migrate status`. |
| Frontend broken | Redeploy the previous Vercel build. |
| Data corruption | Restore production to the recorded pre-migration timestamp (Neon PITR / the pre-release branch). **This is the only destructive path — it requires explicit human approval.** |

**Never drop `User.tokenVersion` to roll back.** The current `authenticateToken`
reads it on every authenticated request; leaving the schema ahead of the code is
the safe direction.

### Step 2 — Apply migrations ⛔

```bash
cd expense-tracker-backend
DATABASE_URL="<production DIRECT_URL>" npx prisma migrate deploy
DATABASE_URL="<production DIRECT_URL>" npx prisma migrate status   # confirm: no pending
```

This applies, in timestamp order, whichever of the two migrations is still
pending. It is additive-only: no existing table is dropped or rewritten.

### Step 3 — Deploy the backend to Render

- Branch: `p0-hardening`
- Build command:
  ```bash
  npm install && npx prisma generate && node scripts/verify-prisma-client.js
  ```
- Start command: `npm start`
- Required environment variables (unchanged from the current service):
  `DATABASE_URL` (pooled), `JWT_SECRET`, `EMAIL_USER`, `EMAIL_APP_PASSWORD`,
  `FRONTEND_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REDIRECT_URI`.
- Do **not** add `DIRECT_URL` to the running service; it is only needed for the
  migration command.

A successful build prints `✔ Prisma Client matches prisma/schema.prisma`.
A stale client fails the build here, which is the point of the verifier.

### Step 4 — Verify the deployed API before touching the frontend

```bash
curl -s https://<backend-host>/ping
# {"status":"ok",...}

curl -s -o /dev/null -w '%{http_code}\n' https://<backend-host>/api/loans
# 401 — the route exists and is protected
```

A `401` proves the loan routes are mounted. A `404` means the backend deploy did
not take.

### Step 5 — Deploy the frontend to Vercel

- Branch: `p0-hardening`
- Build command: `npm run build`
- Output directory: `dist`
- Environment variable: `VITE_API_URL=https://<backend-host>/api`

`VITE_*` variables are baked in at build time — changing `VITE_API_URL` requires a
**rebuild**, not just a restart. The value must be the backend origin **including
`/api`**, e.g. `https://<backend-host>/api`, because every call is written as
`api.get('/loans')`.

**CORS needs no configuration.** The backend mounts `app.use(cors())`, so the
Vercel origin does not need to be whitelisted.

### Step 5a — SPA deep-link fallback (conditional)

`/loans/:id` is the primary loan screen, and like the existing `/expenses` and
`/budgets` routes it is client-side. If a **hard refresh or a direct link** to a
sub-route returns a Vercel 404, the project is missing its rewrite and the loan
detail screen is not directly reachable.

The repository has never contained a `vercel.json`, so this cannot be verified from
here. Check it as part of the acceptance test (step 6, item 9). If it fails, add
`vercel.json` to the frontend repository root and redeploy:

```json
{
  "rewrites": [{ "source": "/((?!assets/|favicon\.svg|icon-192\.png|icon-512\.png|icons\.svg|manifest\.webmanifest|registerSW\.js|sw\.js|workbox-).*)", "destination": "/index.html" }]
}
```

The exclusions keep build assets (`/assets/...`) and the service-worker files out
of the rewrite, so the rewrite is safe regardless of whether Vercel resolves
static files before or after rewrites. Deleting the file fully reverts the change.

### Step 6 — Smoke test in the browser

Sign in on the deployed frontend and run the seven acceptance steps:

1. Add a loan (1,000,000 @ 8.5%, 20 years). The EMI must read **₹8,678.24**.
2. The dashboard card shows the outstanding principal and 0% repaid.
3. Open **Schedule** — 240 periods, closing balance 0, exactly one colour for
   forecast.
4. **Record payment** → 8,678.24 → the split is ₹7,083.33 interest / ₹1,594.91
   principal, and the balance falls to ₹9,98,405.09.
5. **Record payment** → Prepayment → 200,000 → outstanding falls by exactly
   200,000 and the EMI is unchanged.
6. Open **Prepayment simulator** — interest saved and tenure reduced are both
   positive and the payoff date moves earlier.
7. Repeat 1–3 with a second loan; both appear on **My Loans**.
8. Confirm the existing Expense Tracker screens and totals are unchanged
   (`/expenses`, `/budgets`, `/income`, the dashboard) and that the row counts
   from step 0b still match for `User`, `Expense` and `Income`.
9. **Hard-refresh** on `/loans/<id>` and load it in a new tab. If this 404s, apply
   step 5a.

Then confirm the payment you recorded did **not** appear as an Expense (Decision
A: `LoanPayment` is the sole source of truth for loan payments).

---

## 5. Rollback

- **Frontend:** redeploy the previous Vercel build. The `/loans` routes are new, so
  a rollback only removes the feature; no existing screen depends on it.
- **Backend:** redeploy the previous Render build. The loan routes are new and
  additive; the previous build simply does not serve them.
- **Database:** both migrations are additive. `Loan` and `LoanPayment` can stay in
  place unused, and `User.tokenVersion` must **not** be dropped — the current
  `authenticateToken` depends on it. Prefer leaving the schema ahead of the code
  over reverting it.

---

## 6. Known limitations (carried, not hidden)

1. **Clean-install build: VERIFIED, with one local-only caveat.** A checkout
   without `node_modules` was installed fresh and built end to end: `npm install`
   (which runs the `prisma generate` postinstall), then `npm run build`
   (regenerate + verify), then a boot check that returned 200 from `/ping` and
   401 from `/api/loans`. This is the same sequence Render will run.
   Caveat, local only: in this workspace `prisma generate` fails with `EPERM`
   because the shared engine cache `~/.cache/prisma` is outside the sandbox and
   not writable. Redirecting `HOME` to a writable directory made it pass. Render
   provides a writable `HOME` and its own cache, so this does not apply there —
   but if the Render build ever fails at `prisma generate`, this is the cause to
   check first.
2. **`DISABLE_SCHEDULERS` is fail-open** — absent means the schedulers run. This is
   a pre-existing risk unrelated to Loan Tracker and is unchanged by this release.
3. **Concurrent payment writes.** Two simultaneous payment requests for the same
   loan each compute the opening balance inside their own transaction. The loan
   balance is resynced from the immutable ledger afterwards, so it cannot drift,
   but the two payments' individual splits are computed against the same opening
   balance. Sequential use — the normal case — is unaffected. Fixing this needs
   row-level locking and is out of scope for this release.
4. **A payment with no `LoanPayment` history cannot be reconciled against a
   mid-term imported balance** once all payments are deleted: the loan returns to
   its original principal. Documented in `resyncLoanLedger`.
5. **Decision A remains "no Expense rows".** Making loan payments optionally
   create an `Expense` would require an `Expense.loanPaymentId` link, i.e. a new
   migration. Not started.

---

## 7. Explicitly NOT done

- No production database was read, written, migrated or backed up.
- No deployment to Render or Vercel was attempted.
- No new Prisma migration was authored.
- The unrelated P0 backlog (category archiving, rate limiting, CSV hardening,
  frontend P0-6 remainder, the production-access impact assessment) was not
  touched.
