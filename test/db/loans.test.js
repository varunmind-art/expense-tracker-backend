'use strict';

/**
 * Loan Tracker (P0-9) — DATABASE-BACKED API TESTS.
 *
 * These drive the real Express app over HTTP against the verified Neon
 * development database. Nothing is mocked except outbound email.
 *
 * Every loan row created here is prefixed `p09-`, and every payment row hangs
 * off one of those loans. Cleanup deletes exactly those rows and nothing else;
 * the development database is never reset, truncated or dropped.
 *
 * Run with: npm run test:db   (the preflight below is fail-closed)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ── preflight FIRST, before anything can load configuration ──────────────────
// Requiring src/server without this would read the repository's production .env
// and arm the real cron with a boot-time scheduler run. That is the P0-5C.1a
// incident; test/p0/no-server-import.test.js enforces this ordering.
const { runPreflight } = require('./preflight');
runPreflight();

// Stub outbound email before the app is required.
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({ sendMail: async () => ({ messageId: 'p09-stub' }) });

const { app, prisma } = require('../../src/server');
const { createFixtures, ID, SYNTHETIC_PASSWORD, PREFIX } = require('./fixtures');

const LOAN_PREFIX = 'p09-';

let server;
let baseUrl;
let tokenA;
let tokenB;

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
};

const login = async (email) => {
  const res = await api('POST', '/api/auth/login', { body: { email, password: SYNTHETIC_PASSWORD } });
  assert.equal(res.status, 200, `login failed for ${email}: ${res.text}`);
  return res.json.token;
};

/** A fresh loan owned by user A, created through the API. */
const makeLoan = async (overrides = {}) =>
  api('POST', '/api/loans', {
    token: tokenA,
    body: {
      name: `${LOAN_PREFIX}Home loan`,
      lender: 'P09 Lender',
      loanType: 'HOME_LOAN',
      originalPrincipal: 1000000,
      interestRate: 8.5,
      startDate: '2026-01-01',
      endDate: '2046-01-05',
      emiDay: 5,
      paymentAccountId: ID.accountA1,
      ...overrides,
    },
  });

const deleteLoanRow = async (id) => {
  await prisma.loanPayment.deleteMany({ where: { loanId: id } });
  await prisma.loan.deleteMany({ where: { id } });
};

test.before(async () => {
  await createFixtures(prisma);

  // Remove any loans left behind by an earlier interrupted run.
  const stale = await prisma.loan.findMany({
    where: { userId: { startsWith: PREFIX } },
    select: { id: true },
  });
  for (const loan of stale) await deleteLoanRow(loan.id);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  tokenA = await login('p07-user-a@example.invalid');
  tokenB = await login('p07-user-b@example.invalid');
});

test.after(async () => {
  const stale = await prisma.loan.findMany({
    where: { userId: { startsWith: PREFIX } },
    select: { id: true },
  });
  for (const loan of stale) await deleteLoanRow(loan.id);
  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

test('POST /api/loans creates a loan and derives a correct EMI', async () => {
  const res = await makeLoan();
  assert.equal(res.status, 201, res.text);

  const loan = res.json;
  assert.match(loan.id, /^c[a-z0-9]+$/i);
  assert.equal(loan.name, `${LOAN_PREFIX}Home loan`);
  assert.equal(loan.originalPrincipal, 1000000);
  assert.equal(loan.currentPrincipal, 1000000);
  assert.equal(loan.interestRate, 8.5);
  // 1,000,000 @ 8.5% over 240 months, rounded UP so it clears the tenure.
  assert.equal(loan.emiAmount, 8678.24);
  assert.equal(loan.endDate !== null, true);
  assert.equal(loan.summary.outstandingPrincipal, 1000000);
  assert.equal(loan.summary.progressPercent, 0);
  assert.equal(loan.summary.isClosed, false);

  await deleteLoanRow(loan.id);
});

test('POST /api/loans never creates an Expense row (Decision A)', async () => {
  const before = await prisma.expense.count({ where: { userId: ID.userA } });
  const created = await makeLoan({ name: `${LOAN_PREFIX}No expense loan` });
  assert.equal(created.status, 201, created.text);

  const after = await prisma.expense.count({ where: { userId: ID.userA } });
  assert.equal(after, before, 'creating a loan must not touch the expense ledger');

  await api('POST', `/api/loans/${created.json.id}/payments`, {
    token: tokenA,
    body: { amount: 8678.24, kind: 'EMI', date: '2026-02-05' },
  });

  const afterwards = await prisma.expense.count({ where: { userId: ID.userA } });
  assert.equal(afterwards, before, 'recording a loan payment must not create an Expense');

  await deleteLoanRow(created.json.id);
});

test('POST /api/loans rejects malformed input with 400, never a 500', async () => {
  const cases = [
    [{ name: '' }, /name is required/i],
    [{ originalPrincipal: -1000 }, /positive number/i],
    [{ originalPrincipal: 0 }, /positive number/i],
    [{ originalPrincipal: 'abc' }, /positive number/i],
    [{ interestRate: 'abc' }, /non-negative number/i],
    [{ interestRate: -1 }, /non-negative number/i],
    [{ loanType: 'MORTGAGE' }, /Invalid loan type/i],
    [{ emiDay: 45 }, /between 1 and 31/i],
    [{ startDate: 'nonsense' }, /valid date/i],
    [{ startDate: '2026-05-01', endDate: '2026-01-01' }, /before the start date/i],
    [{ paymentAccountId: 'p09-does-not-exist' }, /account not found/i],
    [{ currentPrincipal: 2000000 }, /cannot exceed the original/i],
  ];

  for (const [overrides, pattern] of cases) {
    const res = await makeLoan({ name: `${LOAN_PREFIX}Bad`, ...overrides });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(overrides)}: ${res.text}`);
    assert.match(res.json.error, pattern);
  }
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

test('GET /api/loans lists only the caller loans, with a computed summary', async () => {
  const mine = await makeLoan({ name: `${LOAN_PREFIX}Listed A` });
  const theirs = await api('POST', '/api/loans', {
    token: tokenB,
    body: { name: `${LOAN_PREFIX}Listed B`, originalPrincipal: 500000, interestRate: 10, emiAmount: 10623.52 },
  });
  assert.equal(theirs.status, 201, theirs.text);

  const listA = await api('GET', '/api/loans', { token: tokenA });
  assert.equal(listA.status, 200);
  const idsA = listA.json.map((loan) => loan.id);
  assert.ok(idsA.includes(mine.json.id));
  assert.ok(!idsA.includes(theirs.json.id), 'user A must not see user B loans');
  for (const loan of listA.json) {
    assert.equal(typeof loan.summary.outstandingPrincipal, 'number');
  }

  const listB = await api('GET', '/api/loans', { token: tokenB });
  const idsB = listB.json.map((loan) => loan.id);
  assert.ok(idsB.includes(theirs.json.id));
  assert.ok(!idsB.includes(mine.json.id), 'user B must not see user A loans');

  await deleteLoanRow(mine.json.id);
  await deleteLoanRow(theirs.json.id);
});

test('GET /api/loans/:id returns the loan, its summary and its payment history', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Detail` });
  const id = created.json.id;

  await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 8678.24, kind: 'EMI', date: '2026-02-05' },
  });

  const res = await api('GET', `/api/loans/${id}`, { token: tokenA });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.id, id);
  assert.equal(res.json.payments.length, 1);
  assert.equal(res.json.summary.paymentCount, 1);
  assert.equal(res.json.summary.outstandingPrincipal, 998405.09);
  assert.equal(res.json.payments[0].interestAmount, 7083.33);
  assert.equal(res.json.payments[0].principalAmount, 1594.91);

  await deleteLoanRow(id);
});

// ---------------------------------------------------------------------------
// update / toggle / delete
// ---------------------------------------------------------------------------

test('PUT /api/loans/:id updates the loan and recomputes the balance from the ledger', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Update` });
  const id = created.json.id;

  await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 8678.24, kind: 'EMI', date: '2026-02-05' },
  });

  const res = await api('PUT', `/api/loans/${id}`, {
    token: tokenA,
    body: { name: `${LOAN_PREFIX}Renamed`, lender: 'P09 New Lender' },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.name, `${LOAN_PREFIX}Renamed`);
  assert.equal(res.json.lender, 'P09 New Lender');
  // The ledger, not the request body, still decides the balance.
  assert.equal(res.json.currentPrincipal, 998405.09);

  // The existing payment rows must survive a loan update.
  const payments = await api('GET', `/api/loans/${id}/payments`, { token: tokenA });
  assert.equal(payments.json.count, 1);

  await deleteLoanRow(id);
});

test('PUT /api/loans/:id rejects an invalid account and an over-large current principal', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}UpdateGuard` });
  const id = created.json.id;

  const badAccount = await api('PUT', `/api/loans/${id}`, {
    token: tokenA,
    body: { paymentAccountId: 'p09-nope' },
  });
  assert.equal(badAccount.status, 400);

  const badPrincipal = await api('PUT', `/api/loans/${id}`, {
    token: tokenA,
    body: { currentPrincipal: 5000000 },
  });
  assert.equal(badPrincipal.status, 400);
  assert.match(badPrincipal.json.error, /cannot exceed the original/i);

  await deleteLoanRow(id);
});

test('PATCH /api/loans/:id/toggle flips isActive', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Toggle` });
  const id = created.json.id;
  assert.equal(created.json.isActive, true);

  const off = await api('PATCH', `/api/loans/${id}/toggle`, { token: tokenA });
  assert.equal(off.status, 200);
  assert.equal(off.json.isActive, false);

  const on = await api('PATCH', `/api/loans/${id}/toggle`, { token: tokenA });
  assert.equal(on.json.isActive, true);

  await deleteLoanRow(id);
});

test('DELETE /api/loans/:id removes the loan and cascades its payments', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Cascade` });
  const id = created.json.id;

  await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 8678.24, kind: 'EMI', date: '2026-02-05' },
  });
  assert.equal(await prisma.loanPayment.count({ where: { loanId: id } }), 1);

  const res = await api('DELETE', `/api/loans/${id}`, { token: tokenA });
  assert.equal(res.status, 200, res.text);

  assert.equal(await prisma.loan.count({ where: { id } }), 0);
  assert.equal(
    await prisma.loanPayment.count({ where: { loanId: id } }),
    0,
    'LoanPayment rows must cascade with the loan'
  );
});

// ---------------------------------------------------------------------------
// payments
// ---------------------------------------------------------------------------

test('POST /api/loans/:id/payments records an EMI with a correct split', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Emi` });
  const id = created.json.id;

  const res = await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 8678.24, kind: 'EMI', date: '2026-02-05', note: 'February EMI' },
  });
  assert.equal(res.status, 201, res.text);

  const payment = res.json.payment;
  assert.equal(payment.interestAmount, 7083.33); // 1,000,000 * 8.5% / 12
  assert.equal(payment.principalAmount, 1594.91);
  assert.equal(payment.extraPrincipal, 0);
  assert.equal(payment.totalAmount, 8678.24);
  assert.equal(payment.outstandingAfter, 998405.09);
  assert.equal(payment.note, 'February EMI');
  assert.equal(res.json.loan.currentPrincipal, 998405.09);
  assert.equal(res.json.summary.principalRepaid, 1594.91);
  assert.equal(res.json.summary.totalInterestPaid, 7083.33);

  // interest + principal + extra === total, always.
  assert.equal(
    Math.round((payment.interestAmount + payment.principalAmount + payment.extraPrincipal) * 100),
    Math.round(payment.totalAmount * 100)
  );

  await deleteLoanRow(id);
});

test('a prepayment does not advance the next due instalment, an EMI does', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}DuePointer`, startDate: '2026-01-01', endDate: '2046-01-05' });
  const id = created.json.id;

  const fresh = await api('GET', `/api/loans/${id}/summary`, { token: tokenA });
  const firstDue = fresh.json.nextDueDate;
  assert.ok(firstDue, 'a fresh loan has a next due instalment');
  assert.equal(new Date(firstDue).getDate(), 5);
  assert.equal(new Date(firstDue).getMonth(), 1); // 5 Feb 2026
  // The payoff is the loan's own final instalment, never today + months.
  assert.equal(
    new Date(fresh.json.estimatedPayoffDate).getTime() > new Date(firstDue).getTime(),
    true
  );

  // A principal-only prepayment must NOT settle the February instalment.
  await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 100000, kind: 'PREPAYMENT', date: '2026-02-05' },
  });
  const afterPrepay = await api('GET', `/api/loans/${id}/summary`, { token: tokenA });
  assert.equal(afterPrepay.json.nextDueDate, firstDue, 'a prepayment must not advance the due date');
  assert.equal(afterPrepay.json.settledInstallments, 0);
  assert.equal(afterPrepay.json.outstandingPrincipal, 900000);
  assert.ok(
    new Date(afterPrepay.json.estimatedPayoffDate) < new Date(fresh.json.estimatedPayoffDate),
    'a prepayment must still shorten the loan'
  );

  // A recorded EMI settles exactly one instalment and advances the due date.
  await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 8678.24, kind: 'EMI', date: '2026-02-05' },
  });
  const afterEmi = await api('GET', `/api/loans/${id}/summary`, { token: tokenA });
  assert.equal(afterEmi.json.settledInstallments, 1);
  assert.equal(new Date(afterEmi.json.nextDueDate).getMonth(), 2); // 5 Mar 2026

  await deleteLoanRow(id);
});

test('POST /api/loans/:id/payments records a prepayment as principal only', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Prepay` });
  const id = created.json.id;

  await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 8678.24, kind: 'EMI', date: '2026-02-05' },
  });

  const res = await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 200000, kind: 'PREPAYMENT', date: '2026-03-05', note: 'Annual bonus' },
  });
  assert.equal(res.status, 201, res.text);

  assert.equal(res.json.payment.interestAmount, 0, 'a prepayment must not charge interest');
  assert.equal(res.json.payment.principalAmount, 0);
  assert.equal(res.json.payment.extraPrincipal, 200000);
  assert.equal(res.json.payment.totalAmount, 200000);
  assert.equal(res.json.payment.outstandingAfter, 798405.09);
  assert.equal(res.json.loan.currentPrincipal, 798405.09);

  await deleteLoanRow(id);
});

test('POST /api/loans/:id/payments rejects invalid amounts, kinds, dates and splits', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}PayGuard` });
  const id = created.json.id;

  const cases = [
    [{ amount: 0 }, /greater than zero/i],
    [{ amount: -500 }, /greater than zero/i],
    [{ amount: 'abc' }, /greater than zero/i],
    [{ amount: 100, kind: 'TRANSFER' }, /Invalid payment kind/i],
    [{ amount: 100, date: 'not-a-date' }, /valid date/i],
    [{ amount: 1000, principalAmount: 100, interestAmount: 100, extraPrincipal: 100 }, /add up to the total/i],
    [{ amount: 1000, principalAmount: 5000, interestAmount: 0, extraPrincipal: 0 }, /add up to the total/i],
  ];

  for (const [body, pattern] of cases) {
    const res = await api('POST', `/api/loans/${id}/payments`, { token: tokenA, body });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}: ${res.text}`);
    assert.match(res.json.error, pattern);
  }

  await deleteLoanRow(id);
});

test('POST /api/loans/:id/payments clamps an oversized payment to the balance', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Overpay`, originalPrincipal: 50000, interestRate: 0, emiAmount: 10000 });
  const id = created.json.id;

  const res = await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 90000, kind: 'PREPAYMENT', date: '2026-02-05' },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.payment.extraPrincipal, 50000);
  assert.equal(res.json.payment.outstandingAfter, 0);
  assert.equal(res.json.loan.currentPrincipal, 0);

  // The loan is now closed and must refuse further payments.
  const after = await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 1000, kind: 'EMI', date: '2026-03-05' },
  });
  assert.equal(after.status, 400);
  assert.match(after.json.error, /already fully repaid/i);

  await deleteLoanRow(id);
});

test('POST /api/loans/:id/payments accepts an explicit, reconciled split', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Split` });
  const id = created.json.id;

  // A split that does not add up to the total is refused outright.
  const mismatched = await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: {
      amount: 10000,
      principalAmount: 2916.67,
      interestAmount: 7083.34, // one paise too many
      extraPrincipal: 0,
      date: '2026-02-05',
    },
  });
  assert.equal(mismatched.status, 400);
  assert.match(mismatched.json.error, /add up to the total/i);

  // A split that does reconcile is stored exactly as supplied.
  const accepted = await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: {
      amount: 10000,
      principalAmount: 2916.67,
      interestAmount: 7083.33,
      extraPrincipal: 0,
      date: '2026-02-05',
    },
  });
  assert.equal(accepted.status, 201, accepted.text);
  assert.equal(accepted.json.payment.interestAmount, 7083.33);
  assert.equal(accepted.json.payment.principalAmount, 2916.67);
  assert.equal(accepted.json.payment.totalAmount, 10000);
  assert.equal(accepted.json.loan.currentPrincipal, 997083.33);

  await deleteLoanRow(id);
});

test('an explicit split cannot drive the outstanding balance below zero', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}TinySplit`, originalPrincipal: 1000, interestRate: 8.5 });
  const id = created.json.id;

  const res = await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 2000, principalAmount: 2000, interestAmount: 0, extraPrincipal: 0, date: '2026-02-05' },
  });
  assert.equal(res.status, 400, res.text);
  assert.match(res.json.error, /below zero/i);

  const loan = await prisma.loan.findUnique({ where: { id } });
  assert.equal(Number(loan.currentPrincipal), 1000, 'a rejected payment must not change the balance');

  await deleteLoanRow(id);
});

test('GET /api/loans/:id/payments returns the history and its totals', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}History` });
  const id = created.json.id;

  await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 8678.24, kind: 'EMI', date: '2026-02-05' },
  });
  await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 100000, kind: 'PREPAYMENT', date: '2026-03-05' },
  });

  const res = await api('GET', `/api/loans/${id}/payments`, { token: tokenA });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.count, 2);
  assert.equal(res.json.totals.totalPrincipal, 1594.91);
  assert.equal(res.json.totals.totalExtra, 100000);
  assert.equal(res.json.totals.totalInterest, 7083.33);
  assert.equal(res.json.totals.totalPaid, 108678.24);
  assert.equal(res.json.outstandingPrincipal, 898405.09);
  // Chronological order, oldest first.
  assert.ok(new Date(res.json.payments[0].date) < new Date(res.json.payments[1].date));

  await deleteLoanRow(id);
});

test('PUT /api/loans/:id/payments/:pid edits a payment and resyncs the ledger', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}EditPay` });
  const id = created.json.id;

  const first = await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 8678.24, kind: 'EMI', date: '2026-02-05' },
  });
  const second = await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 8678.24, kind: 'EMI', date: '2026-03-05' },
  });
  assert.equal(second.status, 201, second.text);

  const edited = await api('PUT', `/api/loans/${id}/payments/${first.json.payment.id}`, {
    token: tokenA,
    body: { amount: 10000, date: '2026-02-05' },
  });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.payment.totalAmount, 10000);

  // Recompute the expected balance by hand from the ledger.
  const history = await api('GET', `/api/loans/${id}/payments`, { token: tokenA });
  assert.equal(history.json.count, 2);
  const repaid = history.json.totals.totalPrincipal + history.json.totals.totalExtra;
  assert.equal(
    Math.round(history.json.outstandingPrincipal * 100),
    Math.round((1000000 - repaid) * 100)
  );

  // The second payment's outstandingAfter must have been resynced, not left stale.
  const rows = history.json.payments;
  assert.equal(
    Math.round(rows[1].outstandingAfter * 100),
    Math.round((1000000 - (rows[0].principalAmount + rows[0].extraPrincipal + rows[1].principalAmount + rows[1].extraPrincipal)) * 100)
  );

  await deleteLoanRow(id);
});

test('DELETE /api/loans/:id/payments/:pid restores the balance', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}DeletePay` });
  const id = created.json.id;

  const payment = await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 200000, kind: 'PREPAYMENT', date: '2026-02-05' },
  });
  assert.equal(payment.json.loan.currentPrincipal, 800000);

  const res = await api('DELETE', `/api/loans/${id}/payments/${payment.json.payment.id}`, { token: tokenA });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.loan.currentPrincipal, 1000000, 'deleting the only payment restores the principal');
  assert.equal(res.json.summary.paymentCount, 0);

  const gone = await api('GET', `/api/loans/${id}/payments`, { token: tokenA });
  assert.equal(gone.json.count, 0);

  await deleteLoanRow(id);
});

// ---------------------------------------------------------------------------
// computed endpoints
// ---------------------------------------------------------------------------

test('GET /api/loans/:id/schedule separates actuals from the forecast', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Schedule` });
  const id = created.json.id;

  await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 8678.24, kind: 'EMI', date: '2026-02-05' },
  });

  const res = await api('GET', `/api/loans/${id}/schedule`, { token: tokenA });
  assert.equal(res.status, 200, res.text);

  assert.equal(res.json.contractualMonths, 240);
  assert.equal(res.json.schedule.rows.length, 240);
  assert.equal(res.json.schedule.planned.closesToZero, true);
  assert.equal(res.json.schedule.planned.totalPrincipal, 1000000);

  // Exactly one period is covered by an actual payment.
  const paid = res.json.schedule.rows.filter((row) => row.status === 'PAID');
  const forecast = res.json.schedule.rows.filter((row) => row.status === 'FORECAST');
  const overdue = res.json.schedule.rows.filter((row) => row.status === 'OVERDUE');
  assert.equal(paid.length, 1, JSON.stringify(res.json.schedule.rows.filter((r) => r.status !== 'FORECAST')));
  assert.equal(paid[0].period, 1);
  assert.equal(paid[0].actual.principalAmount, 1594.91);
  assert.equal(paid[0].actual.paymentIds.length, 1);
  assert.equal(forecast[0].actual, null);

  // Every period is accounted for, and no unrecorded instalment disappears.
  assert.equal(paid.length + forecast.length + overdue.length, 240);

  // The invariant that matters, and which is independent of the wall clock: an
  // instalment whose due date has passed with nothing recorded must never be
  // presented as a forecast.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const row of forecast) {
    assert.ok(new Date(row.date).getTime() >= today.getTime(), `period ${row.period} is past due but labelled FORECAST`);
  }
  // ...and because only the very first EMI was recorded, every later instalment
  // whose due date has passed must show as overdue rather than disappearing into
  // the forecast.
  assert.ok(overdue.length > 0, 'the fixture starts in 2026, so instalments are overdue');
  assert.equal(overdue[0].period, 2, 'the instalment right after the paid one is the first overdue');
  for (const row of overdue) {
    assert.ok(new Date(row.date).getTime() < today.getTime(), `period ${row.period} is not past due but labelled OVERDUE`);
    assert.equal(row.actual, null);
  }

  // The projection starts from the reduced balance.
  assert.equal(res.json.projection.fromBalance, 998405.09);
  assert.ok(res.json.projection.periods > 0);
  assert.ok(res.json.projection.totalInterest > 0);

  // Every floating-point invariant must hold in the serialised schedule too.
  for (const row of res.json.schedule.rows) {
    assert.ok(row.closingBalance >= 0);
    assert.ok(row.interest >= 0 && row.principal >= 0 && row.extraPrincipal >= 0);
    assert.equal(
      Math.round(row.openingBalance * 100) - Math.round(row.principal * 100) - Math.round(row.extraPrincipal * 100),
      Math.round(row.closingBalance * 100),
      `row ${row.period} does not reconcile`
    );
  }

  await deleteLoanRow(id);
});

test('GET /api/loans/:id/summary reports outstanding, tenure and payoff', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Summary` });
  const id = created.json.id;

  const before = await api('GET', `/api/loans/${id}/summary`, { token: tokenA });
  assert.equal(before.status, 200, before.text);
  assert.equal(before.json.outstandingPrincipal, 1000000);
  assert.equal(before.json.progressPercent, 0);
  assert.equal(before.json.remainingMonths, 240);
  assert.equal(before.json.principalRepaid, 0);
  assert.ok(before.json.estimatedPayoffDate);

  await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 8678.24, kind: 'EMI', date: '2026-02-05' },
  });

  const after = await api('GET', `/api/loans/${id}/summary`, { token: tokenA });
  assert.equal(after.json.outstandingPrincipal, 998405.09);
  assert.equal(after.json.principalRepaid, 1594.91);
  assert.equal(after.json.totalInterestPaid, 7083.33);
  assert.ok(after.json.progressPercent > 0);
  assert.ok(after.json.remainingMonths < 240);

  await deleteLoanRow(id);
});

test('POST /api/loans/:id/simulate shows interest saved and tenure reduced (Decision B)', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Simulate` });
  const id = created.json.id;

  const res = await api('POST', `/api/loans/${id}/simulate`, {
    token: tokenA,
    body: { extraAmount: 200000 },
  });
  assert.equal(res.status, 200, res.text);

  const simulation = res.json.prepayment;
  assert.ok(simulation.interestSaved > 0, 'a prepayment must save interest');
  assert.ok(simulation.monthsSaved > 0, 'a prepayment must shorten the tenure');
  assert.equal(simulation.emiAfter, 8678.24, 'Decision B: the EMI is retained');
  assert.equal(simulation.keepEmi, true);
  assert.ok(new Date(simulation.newPayoffDate) < new Date(simulation.baseline.payoffDate));
  assert.equal(simulation.monthsSaved, simulation.baseline.months - simulation.scenario.months);

  await deleteLoanRow(id);
});

test('POST /api/loans/:id/simulate supports the reduce-EMI alternative and a rate change', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Simulate2` });
  const id = created.json.id;

  const reduceEmi = await api('POST', `/api/loans/${id}/simulate`, {
    token: tokenA,
    body: { extraAmount: 200000, keepEmi: false },
  });
  assert.equal(reduceEmi.status, 200, reduceEmi.text);
  assert.ok(reduceEmi.json.prepayment.emiAfter < 8678.24);
  assert.equal(reduceEmi.json.prepayment.monthsSaved, 0);

  const rate = await api('POST', `/api/loans/${id}/simulate`, {
    token: tokenA,
    body: { extraAmount: 0, newRate: 9.5, fromPeriod: 25 },
  });
  assert.equal(rate.status, 200, rate.text);
  assert.ok(rate.json.rateChange);
  assert.equal(rate.json.rateChange.changedFrom, 25);
  assert.ok(rate.json.rateChange.totalInterestDelta > 0, 'a rate rise must cost more');
  assert.ok(rate.json.rateChange.emiForSameTenure > 8678.24);

  const bad = await api('POST', `/api/loans/${id}/simulate`, {
    token: tokenA,
    body: { extraAmount: -100 },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /non-negative/i);

  const badRate = await api('POST', `/api/loans/${id}/simulate`, {
    token: tokenA,
    body: { newRate: 500 },
  });
  assert.equal(badRate.status, 400);

  await deleteLoanRow(id);
});

test('POST /api/loans/:id/adjust records a labelled principal adjustment', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Adjust` });
  const id = created.json.id;

  const res = await api('POST', `/api/loans/${id}/adjust`, {
    token: tokenA,
    body: { amount: 25000, note: 'Corrected opening balance', date: '2026-02-05' },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.payment.extraPrincipal, 25000);
  assert.equal(res.json.payment.interestAmount, 0);
  assert.equal(res.json.payment.note, 'Corrected opening balance');
  assert.equal(res.json.loan.currentPrincipal, 975000);

  const bad = await api('POST', `/api/loans/${id}/adjust`, { token: tokenA, body: { amount: -1 } });
  assert.equal(bad.status, 400);

  await deleteLoanRow(id);
});

// ---------------------------------------------------------------------------
// ownership isolation (the P0-8 lesson)
// ---------------------------------------------------------------------------

test('a loan owned by another user is invisible and immutable', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Private A` });
  const id = created.json.id;

  const payment = await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 8678.24, kind: 'EMI', date: '2026-02-05' },
  });
  const paymentId = payment.json.payment.id;

  // Reads
  for (const path of [`/api/loans/${id}`, `/api/loans/${id}/summary`, `/api/loans/${id}/schedule`, `/api/loans/${id}/payments`]) {
    const res = await api('GET', path, { token: tokenB });
    assert.equal(res.status, 404, `user B must not read ${path}: ${res.status} ${res.text}`);
  }

  // Writes
  const writes = [
    ['PUT', `/api/loans/${id}`, { name: `${LOAN_PREFIX}Hijacked` }],
    ['PATCH', `/api/loans/${id}/toggle`, {}],
    ['DELETE', `/api/loans/${id}`, undefined],
    ['POST', `/api/loans/${id}/payments`, { amount: 1000, kind: 'EMI' }],
    ['PUT', `/api/loans/${id}/payments/${paymentId}`, { amount: 1 }],
    ['DELETE', `/api/loans/${id}/payments/${paymentId}`, undefined],
    ['POST', `/api/loans/${id}/simulate`, { extraAmount: 1000 }],
    ['POST', `/api/loans/${id}/adjust`, { amount: 1000 }],
  ];

  for (const [method, path, body] of writes) {
    const res = await api(method, path, { token: tokenB, body });
    assert.equal(res.status, 404, `user B must not ${method} ${path}: ${res.status} ${res.text}`);
  }

  // Nothing was mutated by the attempts.
  const stillThere = await api('GET', `/api/loans/${id}`, { token: tokenA });
  assert.equal(stillThere.status, 200);
  assert.equal(stillThere.json.name, `${LOAN_PREFIX}Private A`);
  assert.equal(stillThere.json.payments.length, 1);

  await deleteLoanRow(id);
});

test('a payment id from another user cannot be edited through your own loan', async () => {
  const loanA = await makeLoan({ name: `${LOAN_PREFIX}Cross A` });
  const paymentA = await api('POST', `/api/loans/${loanA.json.id}/payments`, {
    token: tokenA,
    body: { amount: 5000, kind: 'PREPAYMENT', date: '2026-02-05' },
  });

  const loanB = await api('POST', '/api/loans', {
    token: tokenB,
    body: { name: `${LOAN_PREFIX}Cross B`, originalPrincipal: 100000, interestRate: 10, emiAmount: 5000 },
  });

  // User B owns loanB but must not reach user A's payment through it.
  const edited = await api(
    'PUT',
    `/api/loans/${loanB.json.id}/payments/${paymentA.json.payment.id}`,
    { token: tokenB, body: { amount: 1 } }
  );
  assert.equal(edited.status, 404, edited.text);

  const deleted = await api(
    'DELETE',
    `/api/loans/${loanB.json.id}/payments/${paymentA.json.payment.id}`,
    { token: tokenB }
  );
  assert.equal(deleted.status, 404, deleted.text);

  // User A's payment is untouched.
  const survivor = await prisma.loanPayment.findUnique({ where: { id: paymentA.json.payment.id } });
  assert.ok(survivor);
  assert.equal(Number(survivor.extraPrincipal), 5000);

  await deleteLoanRow(loanA.json.id);
  await deleteLoanRow(loanB.json.id);
});

test('an unauthenticated request is refused on every loan route', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Auth` });
  const id = created.json.id;

  const paths = [
    ['GET', '/api/loans'],
    ['POST', '/api/loans'],
    ['GET', `/api/loans/${id}`],
    ['PUT', `/api/loans/${id}`],
    ['DELETE', `/api/loans/${id}`],
    ['GET', `/api/loans/${id}/payments`],
    ['POST', `/api/loans/${id}/payments`],
    ['GET', `/api/loans/${id}/schedule`],
    ['GET', `/api/loans/${id}/summary`],
    ['POST', `/api/loans/${id}/simulate`],
  ];

  for (const [method, path] of paths) {
    // A GET/HEAD request must not carry a body, so only the write verbs get one.
    const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
    const res = await api(method, path, needsBody ? { body: {} } : {});
    assert.equal(res.status, 401, `${method} ${path} must require a token`);
  }

  await deleteLoanRow(id);
});

// ---------------------------------------------------------------------------
// end to end: the acceptance path
// ---------------------------------------------------------------------------

test('acceptance: add a loan, pay an EMI, prepay, and see the payoff move', async () => {
  // 1. Add a loan.
  const created = await makeLoan({ name: `${LOAN_PREFIX}Acceptance`, originalPrincipal: 2000000, interestRate: 9, startDate: '2026-01-01', endDate: '2046-01-05' });
  assert.equal(created.status, 201, created.text);
  const id = created.json.id;

  // 2. Correct EMI and outstanding principal.
  const emi = created.json.emiAmount;
  assert.equal(emi, 17994.52);
  assert.equal(created.json.currentPrincipal, 2000000);

  // 3. The amortization schedule.
  const schedule = await api('GET', `/api/loans/${id}/schedule`, { token: tokenA });
  assert.equal(schedule.json.contractualMonths, 240);
  assert.equal(schedule.json.schedule.planned.closesToZero, true);

  // 4. Record an EMI payment.
  const emiPayment = await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: emi, kind: 'EMI', date: '2026-02-05' },
  });
  assert.equal(emiPayment.status, 201, emiPayment.text);
  assert.equal(emiPayment.json.payment.interestAmount, 15000); // 2,000,000 * 9% / 12
  assert.equal(emiPayment.json.payment.principalAmount, 2994.52);
  assert.equal(emiPayment.json.loan.currentPrincipal, 1997005.48);

  const beforePrepayment = await api('GET', `/api/loans/${id}/summary`, { token: tokenA });
  const payoffBefore = new Date(beforePrepayment.json.estimatedPayoffDate);

  // 5. Record an additional prepayment.
  const prepayment = await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 300000, kind: 'PREPAYMENT', date: '2026-03-05', note: 'Bonus' },
  });
  assert.equal(prepayment.status, 201, prepayment.text);
  assert.equal(prepayment.json.loan.currentPrincipal, 1697005.48);

  // 6. Principal reduction, interest savings and a revised payoff date.
  const simulation = await api('POST', `/api/loans/${id}/simulate`, {
    token: tokenA,
    body: { extraAmount: 300000 },
  });
  assert.equal(simulation.status, 200, simulation.text);
  assert.ok(simulation.json.prepayment.interestSaved > 0);
  assert.ok(simulation.json.prepayment.monthsSaved > 0);
  assert.equal(simulation.json.prepayment.emiAfter, emi);
  assert.ok(new Date(simulation.json.prepayment.newPayoffDate) < payoffBefore);

  const afterSummary = await api('GET', `/api/loans/${id}/summary`, { token: tokenA });
  assert.equal(afterSummary.json.outstandingPrincipal, 1697005.48);
  assert.ok(new Date(afterSummary.json.estimatedPayoffDate) < payoffBefore);

  // 7. Manage multiple loans from one dashboard.
  const second = await makeLoan({ name: `${LOAN_PREFIX}Acceptance car`, loanType: 'CAR_LOAN', originalPrincipal: 600000, interestRate: 11, startDate: '2026-01-01', endDate: '2031-01-01' });
  assert.equal(second.status, 201, second.text);

  const list = await api('GET', '/api/loans', { token: tokenA });
  const listed = list.json.filter((loan) => loan.id === id || loan.id === second.json.id);
  assert.equal(listed.length, 2);
  for (const loan of listed) {
    assert.equal(typeof loan.summary.outstandingPrincipal, 'number');
    assert.ok(loan.emiAmount > 0);
  }

  await deleteLoanRow(id);
  await deleteLoanRow(second.json.id);
});

// ---------------------------------------------------------------------------
// frontend contract
// ---------------------------------------------------------------------------

/**
 * The Loan UI reads these exact field names. Rendering a missing field shows
 * "undefined" or "₹NaN" on screen, so the contract is asserted here rather than
 * discovered by a user. If any of these change, the frontend must change too.
 */
const assertHasKeys = (object, keys, where) => {
  for (const key of keys) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(object, key),
      `${where} is missing the field "${key}" that the frontend reads`
    );
  }
};

test('the API payload carries every field the Loan UI reads', async () => {
  const created = await makeLoan({ name: `${LOAN_PREFIX}Contract` });
  const id = created.json.id;

  await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 8678.24, kind: 'EMI', date: '2026-02-05', note: 'February EMI' },
  });
  await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 50000, kind: 'PREPAYMENT', date: '2026-03-05' },
  });

  // ---- GET /api/loans (the dashboard cards) --------------------------------
  const list = await api('GET', '/api/loans', { token: tokenA });
  const item = list.json.find((loan) => loan.id === id);
  assert.ok(item, 'the created loan must appear in the list');
  assertHasKeys(
    item,
    ['id', 'name', 'lender', 'loanType', 'originalPrincipal', 'currentPrincipal', 'interestRate', 'emiAmount', 'startDate', 'endDate', 'emiDay', 'isActive', 'paymentAccountId', 'summary', 'nextEmiDate'],
    'GET /api/loans[]'
  );
  assertHasKeys(
    item.summary,
    ['originalPrincipal', 'outstandingPrincipal', 'principalRepaid', 'totalAmountPaid', 'totalInterestPaid', 'progressPercent', 'interestRate', 'emiAmount', 'remainingMonths', 'estimatedPayoffDate', 'paymentCount', 'isClosed', 'lastPaymentDate'],
    'GET /api/loans[].summary'
  );

  // ---- GET /api/loans/:id/payments (the history table) --------------------
  const history = await api('GET', `/api/loans/${id}/payments`, { token: tokenA });
  assertHasKeys(history.json, ['loanId', 'count', 'totals', 'outstandingPrincipal', 'payments'], 'GET /api/loans/:id/payments');
  assertHasKeys(
    history.json.totals,
    ['totalPaid', 'totalPrincipal', 'totalExtra', 'totalInterest'],
    'GET /api/loans/:id/payments.totals'
  );
  assertHasKeys(
    history.json.payments[0],
    ['id', 'loanId', 'date', 'totalAmount', 'principalAmount', 'interestAmount', 'extraPrincipal', 'outstandingAfter', 'note'],
    'GET /api/loans/:id/payments.payments[]'
  );

  // ---- GET /api/loans/:id/schedule (the amortization table) ---------------
  const schedule = await api('GET', `/api/loans/${id}/schedule`, { token: tokenA });
  assertHasKeys(schedule.json, ['loan', 'summary', 'contractualMonths', 'scheduledEmi', 'schedule', 'projection'], 'GET /api/loans/:id/schedule');
  assertHasKeys(schedule.json.schedule, ['rows', 'planned', 'actualTotals'], 'schedule.schedule');
  assertHasKeys(
    schedule.json.schedule.planned,
    ['periods', 'totalInterest', 'totalPrincipal', 'totalExtra', 'totalPayments', 'closesToZero', 'amortizes'],
    'schedule.planned'
  );
  assertHasKeys(
    schedule.json.projection,
    ['fromBalance', 'remainingMonths', 'periods', 'totalInterest', 'totalPayments', 'closesToZero', 'amortizes', 'estimatedPayoffDate', 'rows'],
    'schedule.projection'
  );

  const paidRow = schedule.json.schedule.rows.find((row) => row.status === 'PAID');
  assert.ok(paidRow, 'the recorded EMI must mark a period as paid');
  assertHasKeys(
    paidRow,
    ['period', 'date', 'openingBalance', 'interest', 'principal', 'extraPrincipal', 'emi', 'scheduledEmi', 'totalPayment', 'closingBalance', 'isFinal', 'status', 'actual'],
    'schedule.rows[]'
  );
  assertHasKeys(
    paidRow.actual,
    ['totalAmount', 'principalAmount', 'interestAmount', 'extraPrincipal', 'count', 'date', 'paymentIds'],
    'schedule.rows[].actual'
  );
  const forecastRow = schedule.json.schedule.rows.find((row) => row.status === 'FORECAST');
  assert.equal(forecastRow.actual, null, 'a forecast row must not carry actuals');

  // ---- POST /api/loans/:id/simulate (the simulator) ----------------------
  const simulation = await api('POST', `/api/loans/${id}/simulate`, {
    token: tokenA,
    body: { extraAmount: 100000, newRate: 9.5 },
  });
  assertHasKeys(
    simulation.json.prepayment,
    ['baseline', 'scenario', 'interestSaved', 'monthsSaved', 'newPayoffDate', 'principalReducedImmediately', 'emiAfter', 'keepEmi', 'closesToZero', 'amortizes'],
    'simulate.prepayment'
  );
  assertHasKeys(simulation.json.prepayment.baseline, ['totalInterest', 'months', 'payoffDate'], 'prepayment.baseline');
  assertHasKeys(simulation.json.prepayment.scenario, ['totalInterest', 'months', 'payoffDate'], 'prepayment.scenario');
  assertHasKeys(
    simulation.json.rateChange,
    ['newRatePercent', 'changedFrom', 'unaffectedPeriods', 'balanceAtChange', 'newTotalInterest', 'totalInterestDelta', 'newPayoffDate', 'monthsDelta', 'emiForSameTenure', 'baseline'],
    'simulate.rateChange'
  );

  await deleteLoanRow(id);
});

// ---------------------------------------------------------------------------
// API-level timeline consistency (the production Motiaz Blue Ridge shape)
// ---------------------------------------------------------------------------

test('a loan whose maturity falls off the EMI day keeps one consistent timeline', async () => {
  // Rs 55,00,000 @ 7.5%, disbursed 1 Apr 2026, EMIs on the 5th, maturing
  // 30 Mar 2041. The 179-instalment instalment is 51,140.13.
  const created = await makeLoan({
    name: `${LOAN_PREFIX}Timeline`,
    originalPrincipal: 5500000,
    interestRate: 7.5,
    emiAmount: 51140.13,
    startDate: '2026-04-01',
    endDate: '2041-03-30',
    emiDay: 5,
  });
  assert.equal(created.status, 201, created.text);
  const id = created.json.id;

  const detail = await api('GET', `/api/loans/${id}`, { token: tokenA });
  const summary = detail.json.summary;
  const schedule = await api('GET', `/api/loans/${id}/schedule`, { token: tokenA });
  const simulation = await api('POST', `/api/loans/${id}/simulate`, { token: tokenA, body: { extraAmount: 0 } });

  // --- the term is 179, not 180, and it comes from the first EMI date --------
  assert.equal(summary.installments, 179);
  assert.equal(summary.termSource, 'endDate');
  assert.equal(schedule.json.contractualMonths, 179);
  assert.equal(schedule.json.schedule.rows.length, 179);

  // --- every date derives from the loan's own timeline, not the wall clock ---
  assert.equal(new Date(summary.firstDueDate).getDate(), 5);
  assert.equal(new Date(summary.firstDueDate).getMonth(), 4); // 5 May 2026
  assert.equal(new Date(summary.firstDueDate).getFullYear(), 2026);

  const rows = schedule.json.schedule.rows;
  assert.equal(new Date(rows[0].date).getTime(), new Date(summary.firstDueDate).getTime());
  assert.equal(new Date(rows[178].date).getTime(), new Date(summary.finalScheduledDate).getTime());
  assert.equal(new Date(rows[178].date).getMonth(), 2); // March 2041
  assert.equal(new Date(rows[178].date).getFullYear(), 2041);

  // --- the next due instalment is the first UNPAID one, never a calendar guess
  assert.equal(new Date(summary.nextDueDate).getTime(), new Date(rows[0].date).getTime());
  assert.equal(new Date(detail.json.nextEmiDate).getTime(), new Date(summary.nextDueDate).getTime());

  // --- the dashboard payoff is the loan's final instalment ------------------
  assert.equal(new Date(summary.estimatedPayoffDate).getTime(), new Date(rows[178].date).getTime());

  // --- dashboard, schedule and simulator all report the SAME payoff ---------
  assert.equal(
    new Date(schedule.json.projection.estimatedPayoffDate).getTime(),
    new Date(summary.estimatedPayoffDate).getTime(),
    'the schedule projection must agree with the dashboard'
  );
  assert.equal(
    new Date(simulation.json.prepayment.baseline.payoffDate).getTime(),
    new Date(summary.estimatedPayoffDate).getTime(),
    'the simulator baseline must agree with the dashboard'
  );
  assert.equal(
    new Date(schedule.json.summary.estimatedPayoffDate).getTime(),
    new Date(summary.estimatedPayoffDate).getTime()
  );

  // --- unrecorded historical instalments are visible, not assumed paid ------
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const pastDue = rows.filter((row) => new Date(row.date).getTime() < today.getTime());
  assert.ok(pastDue.length > 0, 'this loan started in the past, so instalments are past due');
  assert.equal(summary.overdueInstallments, pastDue.length);
  assert.equal(summary.settledInstallments, 0);
  assert.equal(summary.paymentCount, 0);
  for (const row of pastDue) {
    assert.equal(row.status, 'OVERDUE', `period ${row.period} is past due but labelled ${row.status}`);
  }
  for (const row of rows.filter((r) => new Date(r.date).getTime() >= today.getTime())) {
    assert.equal(row.status, 'FORECAST', `period ${row.period} is in the future but labelled ${row.status}`);
  }

  // --- no projection has been mistaken for a payment -----------------------
  assert.equal(summary.outstandingPrincipal, 5500000);
  assert.equal(summary.principalRepaid, 0);
  assert.equal(summary.progressPercent, 0);
  assert.equal(summary.isClosed, false);

  // --- a prepayment shortens it without settling any instalment ------------
  await api('POST', `/api/loans/${id}/payments`, {
    token: tokenA,
    body: { amount: 1000000, kind: 'PREPAYMENT', date: '2026-05-05' },
  });
  const after = await api('GET', `/api/loans/${id}/summary`, { token: tokenA });
  assert.equal(after.json.nextDueDate, summary.nextDueDate, 'a prepayment must not advance the due date');
  assert.equal(after.json.outstandingPrincipal, 4500000);
  assert.ok(after.json.remainingMonths < 179);
  assert.ok(
    new Date(after.json.estimatedPayoffDate).getTime() < new Date(summary.estimatedPayoffDate).getTime(),
    'a prepayment must move the payoff earlier'
  );

  await deleteLoanRow(id);
});
