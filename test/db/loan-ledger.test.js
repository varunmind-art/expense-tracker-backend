'use strict';

/**
 * Staged-disbursement and historical-ledger API (database-backed).
 *
 * Drives the real Express app over HTTP against the verified Neon development
 * database. Every row is created under the `p07-` fixture user and removed again.
 *
 * The two SBI acceptance identities are asserted here at the API level:
 *   insurance: 1,86,474 + 4,798 - 1,91,271.99 = 0.01
 *   main:      cumulative 44,91,590 and a 30 Sep balance of 44,78,991
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runPreflight } = require('./preflight');
runPreflight();

const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({ sendMail: async () => ({ messageId: 'p11-stub' }) });

const { app, prisma } = require('../../src/server');
const { createFixtures, ID, SYNTHETIC_PASSWORD, PREFIX } = require('./fixtures');

const P = 'p11-';
let server;
let baseUrl;
let tokenA;
let tokenB;

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
};

const login = async (email) => {
  const res = await api('POST', '/api/auth/login', { body: { email, password: SYNTHETIC_PASSWORD } });
  assert.equal(res.status, 200, res.text);
  return res.json.token;
};

const makeLoan = async (overrides = {}) =>
  api('POST', '/api/loans', {
    token: tokenA,
    body: {
      name: `${P}Ledger loan`,
      originalPrincipal: 186474,
      interestRate: 7.9,
      emiAmount: 1402,
      startDate: '2026-05-01',
      endDate: '2026-06-05',
      emiDay: 5,
      sanctionedLimit: 580100,
      ...overrides,
    },
  });

const cleanupLoan = async (id) => {
  await prisma.loanEmiSchedule.deleteMany({ where: { loanId: id } });
  await prisma.loanDisbursement.deleteMany({ where: { loanId: id } });
  await prisma.loanInterestPosting.deleteMany({ where: { loanId: id } });
  await prisma.loanPayment.deleteMany({ where: { loanId: id } });
  await prisma.loan.deleteMany({ where: { id } });
};

test.before(async () => {
  await createFixtures(prisma);

  const stale = await prisma.loan.findMany({ where: { userId: { startsWith: PREFIX } }, select: { id: true } });
  for (const loan of stale) await cleanupLoan(loan.id);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  tokenA = await login('p07-user-a@example.invalid');
  tokenB = await login('p07-user-b@example.invalid');
});

test.after(async () => {
  const stale = await prisma.loan.findMany({ where: { userId: { startsWith: PREFIX } }, select: { id: true } });
  for (const loan of stale) await cleanupLoan(loan.id);
  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// sanctioned limit vs disbursed principal
// ---------------------------------------------------------------------------

test('the sanctioned limit is stored separately from the disbursed principal', async () => {
  const created = await makeLoan();
  assert.equal(created.status, 201, created.text);

  assert.equal(created.json.sanctionedLimit, 580100);
  assert.equal(created.json.originalPrincipal, 186474);
  assert.equal(created.json.currentPrincipal, 186474);
  assert.equal(created.json.disbursedPrincipal, 0, 'nothing is drawn until a tranche is recorded');

  const list = await api('GET', `/api/loans/${created.json.id}/disbursements`, { token: tokenA });
  assert.equal(list.json.sanctionedLimit, 580100);
  assert.equal(list.json.totalDisbursed, 0);
  assert.equal(list.json.undrawnLimit, 580100);

  await cleanupLoan(created.json.id);
});

// ---------------------------------------------------------------------------
// the insurance loan identity
// ---------------------------------------------------------------------------

test('ACCEPTANCE (API): the insurance loan reconciles to 0.01', async () => {
  const created = await makeLoan({ name: `${P}Loan Protect` });
  const id = created.json.id;

  await api('POST', `/api/loans/${id}/disbursements`, {
    token: tokenA,
    body: { amount: 186474, date: '2026-05-20', reference: 'LP-T1', note: 'Tranche 1' },
  });
  await api('POST', `/api/loans/${id}/interest-postings`, {
    token: tokenA,
    body: { amount: 4798, date: '2026-06-01', kind: 'INTEREST', reference: 'LP-INT-1' },
  });
  // A historical repayment is imported with the bank's own verified split. The
  // manual payment endpoint deliberately refuses a split it cannot reconcile.
  const importRes = await api('POST', `/api/loans/${id}/import/commit`, {
    token: tokenA,
    body: {
      confirm: true,
      csv: 'Date,Narration,Amount,Principal,Interest,Reference\n14/10/2026,Final repayment,191271.99,186473.99,4798,LP-R1\n',
    },
  });
  assert.equal(importRes.status, 201, importRes.text);

  const recon = await api('GET', `/api/loans/${id}/reconciliation?statedBalance=0.01`, { token: tokenA });
  assert.equal(recon.status, 200, recon.text);
  assert.equal(recon.json.disbursedPrincipal, 186474);
  assert.equal(recon.json.totalInterestPosted, 4798);
  assert.equal(recon.json.totalRepaid, 191271.99);
  assert.equal(recon.json.bankBalance, 0.01);
  assert.equal(recon.json.variance, 0);
  assert.equal(recon.json.reconciled, true);

  // The loan's own outstanding principal is a separate figure.
  assert.equal(recon.json.outstandingPrincipal, 0.01);

  await cleanupLoan(id);
});

test('ACCEPTANCE (API): the main loan disbursement and 30 September balance', async () => {
  const created = await makeLoan({
    name: `${P}Main loan`,
    originalPrincipal: 4491590,
    sanctionedLimit: 7000000,
    interestRate: 8.5,
    emiAmount: 40000,
    startDate: '2026-04-01',
    endDate: '2041-03-05',
  });
  const id = created.json.id;

  await api('POST', `/api/loans/${id}/disbursements`, { token: tokenA, body: { amount: 2000000, date: '2026-04-01', reference: 'HL-T1' } });
  await api('POST', `/api/loans/${id}/disbursements`, { token: tokenA, body: { amount: 2491590, date: '2026-07-01', reference: 'HL-T2' } });
  await api('POST', `/api/loans/${id}/interest-postings`, { token: tokenA, body: { amount: 45000, date: '2026-09-30', kind: 'INTEREST', reference: 'HL-INT-1' } });
  const importRes = await api('POST', `/api/loans/${id}/import/commit`, {
    token: tokenA,
    body: {
      confirm: true,
      csv: 'Date,Narration,Amount,Principal,Interest,Reference\n30/09/2026,Interest servicing repayment,57599,0,45000,HL-R1\n',
    },
  });
  assert.equal(importRes.status, 201, importRes.text);

  const recon = await api('GET', `/api/loans/${id}/reconciliation?asOf=2026-09-30&statedBalance=4478991`, { token: tokenA });
  assert.equal(recon.json.disbursedPrincipal, 4491590);
  assert.equal(recon.json.bankBalance, 4478991);
  assert.equal(recon.json.reconciled, true);
  assert.equal(recon.json.sanctionedLimit, 7000000);
  assert.equal(recon.json.undrawnLimit, 2508410);

  await cleanupLoan(id);
});

// ---------------------------------------------------------------------------
// import: dry run then commit
// ---------------------------------------------------------------------------

const IMPORT_CSV = `Date,Narration,Debit,Reference
20/05/2026,Loan Protect disbursement tranche 1,186474,LP-T1
01/06/2026,Interest charged,4798,LP-INT-1
14/10/2026,Repayment received,191271.99,LP-R1
`;

test('import: the preview reports rows and writes nothing', async () => {
  const created = await makeLoan({ name: `${P}Preview` });
  const id = created.json.id;

  const before = await prisma.loanDisbursement.count({ where: { loanId: id } });
  const preview = await api('POST', `/api/loans/${id}/import/preview`, { token: tokenA, body: { csv: IMPORT_CSV } });

  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json.dryRun, true);
  assert.equal(preview.json.committed, false);
  assert.equal(preview.json.summary.new, 3);
  assert.equal(preview.json.summary.duplicates, 0);
  assert.equal(preview.json.blocking, false);
  // The projected reconciliation is available before anything is saved.
  assert.equal(preview.json.reconciliation.bankBalance, 0.01);

  const after = await prisma.loanDisbursement.count({ where: { loanId: id } });
  assert.equal(after, before, 'a preview must not write');

  await cleanupLoan(id);
});

test('import: commit requires explicit confirmation and then posts the rows once', async () => {
  const created = await makeLoan({ name: `${P}Commit` });
  const id = created.json.id;

  const noConfirm = await api('POST', `/api/loans/${id}/import/commit`, { token: tokenA, body: { csv: IMPORT_CSV } });
  assert.equal(noConfirm.status, 400, 'commit without confirm:true must be refused');
  assert.match(noConfirm.json.error, /confirm/i);

  const committed = await api('POST', `/api/loans/${id}/import/commit`, { token: tokenA, body: { csv: IMPORT_CSV, confirm: true } });
  assert.equal(committed.status, 201, committed.text);
  assert.deepEqual(committed.json.imported, { disbursements: 1, interestPostings: 1, payments: 1 });

  const recon = await api('GET', `/api/loans/${id}/reconciliation?statedBalance=0.01`, { token: tokenA });
  assert.equal(recon.json.bankBalance, 0.01);
  assert.equal(recon.json.reconciled, true);

  // Re-importing the same file must post nothing.
  const again = await api('POST', `/api/loans/${id}/import/commit`, { token: tokenA, body: { csv: IMPORT_CSV, confirm: true } });
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.json.imported, { disbursements: 0, interestPostings: 0, payments: 0 });
  assert.equal(again.json.skipped, 3);

  // A repayment without a bank split is stored but flagged.
  const payments = await prisma.loanPayment.findMany({ where: { loanId: id } });
  const imported = payments.find((p) => p.source === 'IMPORT');
  assert.ok(imported);
  assert.equal(imported.allocationVerified, false);
  assert.equal(Number(imported.totalAmount), 191271.99);
  assert.equal(Number(imported.principalAmount), 0, 'no split is invented');

  await cleanupLoan(id);
});

test('import: unreadable rows block the commit entirely', async () => {
  const created = await makeLoan({ name: `${P}Blocked` });
  const id = created.json.id;

  const bad = `Date,Narration,Amount\n31/02/2026,Bad date,100\n01/06/2027,Good,500\n`;
  const preview = await api('POST', `/api/loans/${id}/import/preview`, { token: tokenA, body: { csv: bad } });
  assert.equal(preview.json.blocking, true);
  assert.equal(preview.json.summary.invalid, 1);

  const commit = await api('POST', `/api/loans/${id}/import/commit`, { token: tokenA, body: { csv: bad, confirm: true } });
  assert.equal(commit.status, 400);

  assert.equal(await prisma.loanDisbursement.count({ where: { loanId: id } }), 0);

  await cleanupLoan(id);
});

// ---------------------------------------------------------------------------
// EMI schedule, pre-EMI, re-pricing, stopping, duplicate posting
// ---------------------------------------------------------------------------

test('schedule: generate, re-price the tail, and never rewrite confirmed history', async () => {
  const created = await makeLoan({ name: `${P}Schedule` });
  const id = created.json.id;

  const gen = await api('POST', `/api/loans/${id}/emi-schedule/generate`, {
    token: tokenA,
    body: { firstDueDate: '2026-05-05', installments: 4, amount: 2800, kind: 'PRE_EMI' },
  });
  assert.equal(gen.status, 201, gen.text);
  assert.equal(gen.json.count, 4);
  assert.equal(gen.json.rows[0].kind, 'PRE_EMI');
  assert.equal(gen.json.rows[0].status, 'SCHEDULED');

  // Confirming one instalment books a real payment.
  const first = gen.json.rows[0];
  const confirm = await api('POST', `/api/loans/${id}/emi-schedule/${first.id}/confirm`, { token: tokenA, body: { amount: 2800 } });
  assert.equal(confirm.status, 201, confirm.text);
  assert.equal(confirm.json.row.status, 'CONFIRMED');
  assert.equal(confirm.json.row.confirmedPaymentId, confirm.json.payment.id);

  // Confirming the same row twice must be refused.
  const twice = await api('POST', `/api/loans/${id}/emi-schedule/${first.id}/confirm`, { token: tokenA, body: { amount: 2800 } });
  assert.equal(twice.status, 409);
  assert.match(twice.json.error, /already confirmed/i);

  // Re-price a future row.
  const third = gen.json.rows[2];
  const repriced = await api('PATCH', `/api/loans/${id}/emi-schedule/${third.id}`, { token: tokenA, body: { amount: 51140.13 } });
  assert.equal(repriced.status, 200, repriced.text);
  assert.equal(repriced.json.row.amount, 51140.13);

  // A confirmed row cannot be re-priced: it is history.
  const repriceConfirmed = await api('PATCH', `/api/loans/${id}/emi-schedule/${first.id}`, { token: tokenA, body: { amount: 1 } });
  assert.equal(repriceConfirmed.status, 409);

  // Rebuilding refuses to clobber an existing schedule without explicit replace.
  const rebuild = await api('POST', `/api/loans/${id}/emi-schedule/generate`, {
    token: tokenA,
    body: { firstDueDate: '2026-05-05', installments: 2, amount: 100, kind: 'EMI' },
  });
  assert.equal(rebuild.status, 409);

  await cleanupLoan(id);
});

test('schedule: stopping future deductions preserves all historical payments', async () => {
  const created = await makeLoan({ name: `${P}Stop` });
  const id = created.json.id;

  const gen = await api('POST', `/api/loans/${id}/emi-schedule/generate`, {
    token: tokenA,
    body: { firstDueDate: '2026-05-05', installments: 4, amount: 1402, kind: 'EMI' },
  });
  assert.equal(gen.status, 201);

  // Settle the first two, as the insurance loan's history is settled.
  for (const row of gen.json.rows.slice(0, 2)) {
    const r = await api('POST', `/api/loans/${id}/emi-schedule/${row.id}/confirm`, { token: tokenA, body: { amount: 1402 } });
    assert.equal(r.status, 201, r.text);
  }
  const paymentsBefore = await prisma.loanPayment.count({ where: { loanId: id } });
  assert.equal(paymentsBefore, 2);

  const stop = await api('POST', `/api/loans/${id}/emi-schedule/stop`, {
    token: tokenA,
    body: { fromDate: '2026-06-15', reason: 'Loan closed' },
  });
  assert.equal(stop.status, 200, stop.text);
  assert.equal(stop.json.stopped, 2);
  assert.equal(stop.json.preserved, 2);

  // History survives untouched; the future is stopped.
  assert.equal(await prisma.loanPayment.count({ where: { loanId: id } }), paymentsBefore, 'no payment was removed');
  const rows = await prisma.loanEmiSchedule.findMany({ where: { loanId: id }, orderBy: { sequence: 'asc' } });
  assert.equal(rows[0].status, 'CONFIRMED');
  assert.equal(rows[1].status, 'CONFIRMED');
  assert.equal(rows[2].status, 'STOPPED');
  assert.equal(rows[3].status, 'STOPPED');
  assert.equal(Number(rows[2].amount), 1402, 'stopping does not change amounts');

  // A stopped row can never be confirmed.
  const confirmStopped = await api('POST', `/api/loans/${id}/emi-schedule/${rows[2].id}/confirm`, { token: tokenA, body: {} });
  assert.equal(confirmStopped.status, 409);

  await cleanupLoan(id);
});

test('schedule: successive amounts are supported without touching earlier rows', async () => {
  const created = await makeLoan({ name: `${P}Amounts` });
  const id = created.json.id;

  const gen = await api('POST', `/api/loans/${id}/emi-schedule/generate`, {
    token: tokenA,
    body: { firstDueDate: '2026-05-05', installments: 3, amount: 2800, kind: 'PRE_EMI' },
  });
  assert.equal(gen.status, 201);

  await api('PATCH', `/api/loans/${id}/emi-schedule/${gen.json.rows[1].id}`, { token: tokenA, body: { amount: 3000 } });
  await api('PATCH', `/api/loans/${id}/emi-schedule/${gen.json.rows[2].id}`, { token: tokenA, body: { amount: 51140.13 } });

  const after = await api('GET', `/api/loans/${id}/emi-schedule`, { token: tokenA });
  assert.deepEqual(after.json.rows.map((r) => r.amount), [2800, 3000, 51140.13]);

  await cleanupLoan(id);
});

// ---------------------------------------------------------------------------
// ownership
// ---------------------------------------------------------------------------

test('the ledger endpoints are owned through the parent loan', async () => {
  const created = await makeLoan({ name: `${P}Private` });
  const id = created.json.id;
  await api('POST', `/api/loans/${id}/disbursements`, { token: tokenA, body: { amount: 1000, date: '2026-05-20', reference: 'X1' } });

  const paths = [
    ['GET', `/api/loans/${id}/disbursements`],
    ['POST', `/api/loans/${id}/disbursements`],
    ['GET', `/api/loans/${id}/interest-postings`],
    ['POST', `/api/loans/${id}/interest-postings`],
    ['GET', `/api/loans/${id}/reconciliation`],
    ['POST', `/api/loans/${id}/import/preview`],
    ['POST', `/api/loans/${id}/import/commit`],
    ['GET', `/api/loans/${id}/emi-schedule`],
    ['POST', `/api/loans/${id}/emi-schedule/generate`],
    ['POST', `/api/loans/${id}/emi-schedule/stop`],
  ];

  for (const [method, path] of paths) {
    // GET/HEAD cannot carry a body through fetch.
    const needsBody = method !== 'GET' && method !== 'HEAD';
    const res = await api(method, path, needsBody
      ? { token: tokenB, body: { amount: 1, csv: 'Date,Amount\n01/01/2027,1\n', confirm: true } }
      : { token: tokenB });
    assert.equal(res.status, 404, `user B must not reach ${method} ${path}: ${res.status}`);
  }

  const list = await api('GET', `/api/loans/${id}/disbursements`, { token: tokenA });
  assert.equal(list.json.count, 1, 'the attempts changed nothing');

  await cleanupLoan(id);
});
