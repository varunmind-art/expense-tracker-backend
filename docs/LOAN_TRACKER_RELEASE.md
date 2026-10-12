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

Confirm the production migration state **before** changing anything.

```bash
cd expense-tracker-backend
# Uses the production DIRECT_URL from the Render environment, not from this repo.
DATABASE_URL="<production DIRECT_URL>" npx prisma migrate status
```

Expected: a list of migrations with `20261004_add_accounts_and_loans` and
`20261010225757_add_user_token_version` marked as applied or pending.

Record the output. If `migrate status` reports a **failed** migration or drift,
stop and investigate — do not proceed to `migrate deploy`.

### Step 1 — Back up production ⛔

Take a Neon branch or a `pg_dump` of the production database. Both migrations are
additive (new tables, one new column with a default), so a rollback should not be
needed, but the backup must exist before the schema changes.

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
**rebuild**, not just a restart.

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

1. **Clean-install build is unproven.** `node_modules` is committed, so
   `npm install` on a clean Render builder has not been exercised end to end.
   Step 3 is the first real test of that path; if it fails, the fallback is to
   build from the committed `node_modules` and ensure `prisma generate` still runs.
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
