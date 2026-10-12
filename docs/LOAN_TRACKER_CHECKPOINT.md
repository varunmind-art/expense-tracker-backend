# Loan Tracker — Progress Checkpoint

**Status: IMPLEMENTATION COMPLETE AND VERIFIED IN DEVELOPMENT. NOT DEPLOYED.**
Production was not accessed, read, migrated or deployed at any point.

- Phase 1 — calculation engine: **done and committed** (`df1baf6`)
- Phase 2 — backend APIs: **done and committed** (`d866ebf`)
- Phase 3 — frontend: **done and committed** (`56a5a04`, frontend repo)
- Phase 4 — verification: **done** (contract test `3233c0a`)
- Phase 5 — release preparation: **done on paper**; the deploy itself is
  **awaiting explicit approval**

The release plan is `docs/LOAN_TRACKER_RELEASE.md`. Read it before deploying.

---

## 1. Final verified state

| Area | State |
|---|---|
| `Loan`, `LoanPayment` schema | Unchanged. No new migration was needed or written |
| Migration in **development** | Applied — proven by the DB tests creating and reading real rows |
| Migration in **production** | **UNVERIFIED** — production was never queried |
| `src/lib/loans.js` | Done — pure, no DB/Express, 76 offline tests |
| Backend loan API | Done — 13 authenticated routes in `src/server.js` |
| Backend loan tests | Done — 28 DB tests over real HTTP |
| Frontend loan UI | Done — 7 components, 4 routes, nav entry, mobile menu |
| Frontend tests / build | Done — 64 tests pass, production build succeeds |

### Test evidence

| Check | Result |
|---|---|
| `node --test test/p0/loans.test.js` | 76 / 76 pass |
| `npm test` (backend offline) | 291 pass, **0 fail**, 2 pre-existing todos |
| `npm run test:db` (whole suite) | 62 pass, **0 fail**, 2 pre-existing todos |
| `npm run test:db` → `test/db/loans.test.js` | 28 / 28 pass |
| `npm test` (frontend) | 64 / 64 pass |
| `npm run build` (frontend) | built successfully |
| `npm run build` (backend) | Prisma Client verified, 11 models / 106 fields |

---

## 2. Business decisions as implemented

**Decision A — a loan payment never creates an `Expense` row.** `LoanPayment` is
the sole source of truth for actual loan payments. Enforced in the routes and
proved by a test that counts `Expense` rows before and after recording a payment.
No `Expense.loanPaymentId` link was added, so no migration was required.

**Decision B — a prepayment reduces the tenure and retains the EMI.** The
`keepEmi: true` default is implemented in `prepaymentSavings` and exposed by
`POST /api/loans/:id/simulate`. The reduce-the-EMI alternative is an explicit
`keepEmi: false` flag and is never stored state. The final instalment absorbs the
rounding remainder.

Other MVP defaults (interest-rate changes apply forward only; half-up rounding to
2dp; zero-interest loans are all principal; `currentPrincipal` is recomputed, never
incremented) are all implemented and tested.

---

## 3. Correctness properties worth knowing before touching this code

1. **Money is integer paise internally.** Rupee inputs are converted once at the
   boundary. Rounding is half-up to 2dp with a `1e-9` nudge. Internal balances
   never drift, which is why a 600-period schedule still closes to exactly zero.
2. **Only `principalAmount + extraPrincipal` reduce the balance.** Summing
   `totalAmount` would double-count the interest portion.
3. **Payments are de-duplicated by id** in `sumPrincipalRepaid`, so replaying a row
   cannot double-count it.
4. **`Loan.currentPrincipal` is derived, never incremented.** `resyncLoanLedger`
   recomputes every `outstandingAfter` in date order after any mutation.
5. **The ledger anchor comes from the FULL ledger**, never a filtered subset.
   Reading the anchor from a list with the edited row already removed recovers the
   opening balance of whichever row became first — that was a real defect during
   this session and it produced a split for an impossible balance.
6. **Ownership is always resolved through the parent `Loan`**
   (`findFirst({ where: { id, userId } })`), then the payment by
   `{ id, loanId }`. `LoanPayment` has no `userId`.
7. **Forecasts are never persisted.** Schedules, payoff dates and savings are
   computed on demand.

---

## 4. Remaining work

### 4.1 Deployment — blocked on explicit human approval

Follow `docs/LOAN_TRACKER_RELEASE.md` exactly. The order is:

1. ⛔ Read-only `prisma migrate status` against **production**.
2. ⛔ Back up production.
3. ⛔ `DATABASE_URL="<production DIRECT_URL>" npx prisma migrate deploy`
   (applies the loan migration **and** the `tokenVersion` dependency).
4. Deploy the backend to Render with
   `npm install && npx prisma generate && node scripts/verify-prisma-client.js`.
5. Verify `/ping` and a `401` from `/api/loans`.
6. Deploy the frontend to Vercel (`VITE_API_URL` baked in at build time).
7. Run the seven-step acceptance smoke test from the release plan.

Two release dependencies that are easy to miss:

- the loan migration (`20261004_add_accounts_and_loans`) must exist in production;
- the pre-existing `tokenVersion` migration (`20261010225757`) is read by
  `authenticateToken` on **every** authenticated request, so its absence breaks
  login-then-any-call, including all loan routes.

### 4.2 Known limitations (documented, not fixed)

- Clean-install build path still unproven (`node_modules` is committed).
- `DISABLE_SCHEDULERS` remains fail-open — pre-existing, unrelated to loans.
- Concurrent payment writes compute their splits against the same opening balance;
  the balance itself is resynced so it cannot drift. Needs row-level locking.
- Deleting every payment resets the loan to its original principal (a mid-term
  import's offset is not separately stored).
- Decision A optional link to `Expense` would need a new migration. Not started.

---

## 5. Standing safety constraints

1. **`.env` in this workspace is PRODUCTION.** `.env.dev` is development. The P0-5C.1a
   incident — a test importing `src/server` with no preflight, loading production
   credentials and running the scheduler against production — is why the next rule
   exists.
2. **Any file that requires `src/server` MUST live in `test/db` and call
   `runPreflight()` before the import.** `test/p0/no-server-import.test.js` enforces
   this; do not weaken it.
3. Run database tests only with `npm run test:db`, or a single file with
   `node --test --test-concurrency=1 test/db/loans.test.js`. Never reset or truncate
   the development database; use scoped fixtures.
4. **Never commit the `prisma generate` churn.** `node_modules` is git-tracked in the
   backend repo, so generation rewrites thousands of tracked files. Commit only the
   intended paths.
5. `src/server.js.backup` is a stray untracked file; leave it alone or delete it
   deliberately.
6. Pending unapproved work elsewhere: the production-access impact assessment,
   category archiving, rate limiting, the frontend P0-6 remainder, CSV hardening.
