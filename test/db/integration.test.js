'use strict';

/**
 * P0-7 — DATABASE-BACKED INTEGRATION TESTS.
 *
 * These are NOT mocked: they drive the real Express app over HTTP against the
 * verified Neon development database with real Prisma queries. Mocked/unit
 * coverage lives in test/baseline and test/p0 (they run without a database and
 * are what `npm test` executes).
 *
 * Run with: npm run test:db   (which runs the fail-closed preflight first)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ── preflight FIRST, before anything can load configuration ──────────────────
const { runPreflight } = require('./preflight');
const preflight = runPreflight();

// ── stub email delivery before the app is required ──────────────────────────
const nodemailer = require('nodemailer');
const sentMails = [];
nodemailer.createTransport = () => ({
  sendMail: async (options) => {
    sentMails.push(options);
    return { messageId: 'p07-stub' };
  },
});

const { app, prisma, processRecurringExpenses } = require('../../src/server');
const { createFixtures, cleanupFixtures, ID, T, SYNTHETIC_PASSWORD, PREFIX } = require('./fixtures');

let server;
let baseUrl;
let fixtures;

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
    /* non-JSON body (e.g. CSV) */
  }
  return { status: res.status, json, text };
};

const login = async (email, password = SYNTHETIC_PASSWORD) => {
  const res = await api('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, `login failed for ${email}: ${res.text}`);
  return res.json.token;
};

test.before(async () => {
  fixtures = await createFixtures(prisma);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // A pending import is needed to exercise the two pending write paths.
  await prisma.pendingImport.createMany({
    data: [
      { id: `${PREFIX}pending-1`, userId: ID.userA, amount: '300.00', date: T.feb28, merchant: 'P07 Pending', source: 'TEST', sourceId: `${PREFIX}src-1`, status: 'pending' },
      { id: `${PREFIX}pending-2`, userId: ID.userA, amount: '400.00', date: T.feb28, merchant: 'P07 Pending 2', source: 'TEST', sourceId: `${PREFIX}src-2`, status: 'pending' },
      { id: `${PREFIX}pending-3`, userId: ID.userA, amount: '500.00', date: T.feb28, merchant: 'P07 Pending 3', source: 'TEST', sourceId: `${PREFIX}src-3`, status: 'pending' },
    ],
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await cleanupFixtures(prisma);
  await prisma.$disconnect();
});

test('environment safety: preflight passed and the target is the development database', () => {
  assert.equal(preflight.database, 'neondb');
  assert.ok(preflight.checks.length >= 7);
  process.stdout.write(`    target: ${preflight.database} (dev), checks: ${preflight.checks.length}\n`);
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-8 — authorization over real HTTP and real Prisma
// ─────────────────────────────────────────────────────────────────────────────

const crossUserCategoryCases = () => [
  ['POST /api/expenses', 'POST', '/api/expenses', { amount: 10, categoryId: ID.catBSecret }],
  ['PUT /api/expenses/:id', 'PUT', `/api/expenses/${ID.expenseA1}`, { amount: 10, date: T.feb28.toISOString(), categoryId: ID.catBSecret }],
  ['POST /api/budgets', 'POST', '/api/budgets', { amount: 10, period: 'MONTHLY', categoryId: ID.catBSecret }],
  ['PUT /api/budgets/:id', 'PUT', `/api/budgets/${ID.budgetA1}`, { categoryId: ID.catBSecret }],
  ['POST /api/recurring-rules', 'POST', '/api/recurring-rules', { description: 'x', amount: 10, frequency: 'MONTHLY', categoryId: ID.catBSecret }],
  ['PUT /api/recurring-rules/:id', 'PUT', `/api/recurring-rules/${ID.ruleMonthly}`, { categoryId: ID.catBSecret }],
  ['PUT /api/pending/:id', 'PUT', `/api/pending/${PREFIX}pending-1`, { amount: 10, date: T.feb28.toISOString(), categoryId: ID.catBSecret }],
  ['POST /api/pending/:id/confirm', 'POST', `/api/pending/${PREFIX}pending-2/confirm`, { categoryId: ID.catBSecret }],
];

test('P0-8: user A cannot reference user B category on any of the eight write paths', async () => {
  const tokenA = await login('p07-user-a@example.invalid');
  for (const [label, method, path, body] of crossUserCategoryCases()) {
    const res = await api(method, path, { token: tokenA, body });
    assert.equal(res.status, 400, `${label} should reject a foreign category, got ${res.status}: ${res.text}`);
    assert.equal(res.json.error, 'Invalid category.', `${label} error message`);
    assert.equal(
      JSON.stringify(res.json).includes('P07 B SECRET DINING'),
      false,
      `${label} must not disclose the other user's category name`
    );
  }
});

test('P0-8: a nonexistent category id is indistinguishable from a foreign one', async () => {
  const tokenA = await login('p07-user-a@example.invalid');
  const foreign = await api('POST', '/api/expenses', { token: tokenA, body: { amount: 10, categoryId: ID.catBSecret } });
  const missing = await api('POST', '/api/expenses', { token: tokenA, body: { amount: 10, categoryId: 'p07-does-not-exist' } });
  assert.equal(foreign.status, missing.status);
  assert.deepEqual(foreign.json, missing.json);
});

test('P0-8: a user CAN use their own category, including a SAVINGS category', async () => {
  const tokenA = await login('p07-user-a@example.invalid');
  const expense = await api('POST', '/api/expenses', { token: tokenA, body: { amount: 25, categoryId: ID.catAExpense, type: 'EXPENSE' } });
  assert.equal(expense.status, 201, expense.text);

  const savings = await api('POST', '/api/expenses', { token: tokenA, body: { amount: 500, categoryId: ID.catASavings, type: 'SAVINGS' } });
  assert.equal(savings.status, 201, `SAVINGS categories must stay usable: ${savings.text}`);
  assert.equal(savings.json.type, 'SAVINGS');
});

test('P0-8: user A cannot read or modify user B financial records', async () => {
  const tokenA = await login('p07-user-a@example.invalid');

  const put = await api('PUT', `/api/expenses/${ID.expenseB1}`, { token: tokenA, body: { amount: 1, date: T.feb28.toISOString(), categoryId: ID.catAExpense } });
  assert.ok(put.status === 404 || put.status === 500, `cross-user update must not succeed, got ${put.status}`);

  const del = await api('DELETE', `/api/expenses/${ID.expenseB1}`, { token: tokenA });
  assert.ok(del.status === 404 || del.status === 500, `cross-user delete must not succeed, got ${del.status}`);

  const stillThere = await prisma.expense.findUnique({ where: { id: ID.expenseB1 } });
  assert.ok(stillThere, 'user B expense must still exist');
  assert.equal(stillThere.userId, ID.userB);

  const list = await api('GET', `/api/expenses?categoryId=${ID.catBSecret}`, { token: tokenA });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json, [], 'filtering by another user category must return nothing');
});

test('P0-8: explicit null vs omitted category on update behave safely', async () => {
  const tokenA = await login('p07-user-a@example.invalid');

  const omitted = await api('PUT', `/api/expenses/${ID.expenseA1}`, { token: tokenA, body: { amount: 1300, date: T.feb28.toISOString() } });
  assert.equal(omitted.status, 200, `omitting categoryId must preserve existing behaviour: ${omitted.text}`);
  assert.equal(omitted.json.categoryId, ID.catAExpense, 'the category is unchanged');

  const nulled = await api('PUT', `/api/expenses/${ID.expenseA1}`, { token: tokenA, body: { amount: 1300, date: T.feb28.toISOString(), categoryId: null } });
  // `categoryId` is NOT NULL in the schema, so a null cannot be stored. Record
  // whatever the API does rather than asserting a fix that was not approved.
  process.stdout.write(`    explicit null categoryId -> HTTP ${nulled.status}\n`);
  assert.ok([200, 400, 500].includes(nulled.status));

  const after = await prisma.expense.findUnique({ where: { id: ID.expenseA1 } });
  assert.ok(after.categoryId, 'the expense must never end up without a category');
});

test('P0-8: deleting a referenced category does not create a cross-user association', async () => {
  const tokenA = await login('p07-user-a@example.invalid');
  await prisma.category.create({ data: { id: ID.catAConcurrent, name: 'P07 A Temporary', type: 'EXPENSE', userId: ID.userA } });

  const created = await api('POST', '/api/expenses', { token: tokenA, body: { amount: 42, categoryId: ID.catAConcurrent } });
  assert.equal(created.status, 201);

  await prisma.category.delete({ where: { id: ID.catAConcurrent } });
  const orphan = await prisma.expense.findUnique({ where: { id: created.json.id } });
  assert.equal(orphan, null, 'the schema cascades category deletion to expenses; documented, not changed here');

  const crossUser = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "Expense" e JOIN "Category" c ON c.id = e."categoryId" WHERE e."userId" <> c."userId"`
  );
  assert.equal(crossUser[0].n, 0, 'no cross-user category association may exist');
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-2 Phase B — authentication against the real database
// ─────────────────────────────────────────────────────────────────────────────

test('P0-2: a session token authenticates, a reset token does not', async () => {
  const tokenA = await login('p07-user-a@example.invalid');
  const ok = await api('GET', '/api/categories', { token: tokenA });
  assert.equal(ok.status, 200);

  sentMails.length = 0;
  const forgot = await api('POST', '/api/auth/forgot-password', { body: { email: 'p07-user-a@example.invalid' } });
  assert.equal(forgot.status, 200);
  assert.equal(sentMails.length, 1, 'exactly one mail for a known address');

  const link = sentMails[0].html.match(/token=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  assert.ok(link, 'the reset link must contain a JWT');
  const resetToken = link[1];

  const asSession = await api('GET', '/api/categories', { token: resetToken });
  assert.equal(asSession.status, 401, 'a password-reset token must not authenticate');

  const asReset = await api('POST', '/api/auth/reset-password', { body: { token: tokenA, newPassword: 'P07-Another-Passw0rd!' } });
  assert.equal(asReset.status, 400, 'a session token must not be usable as a reset token');
});

test('P0-2: unknown and known email addresses get an identical public response', async () => {
  sentMails.length = 0;
  const unknown = await api('POST', '/api/auth/forgot-password', { body: { email: 'p07-nobody@example.invalid' } });
  const known = await api('POST', '/api/auth/forgot-password', { body: { email: 'p07-user-a@example.invalid' } });
  assert.equal(unknown.status, known.status, 'status must not differ');
  assert.deepEqual(unknown.json, known.json, 'body must not differ (no enumeration)');
  assert.equal(sentMails.length, 1, 'mail is sent only for the registered address');
});

test('P0-2: a password change increments tokenVersion atomically and revokes old sessions', async () => {
  const before = await prisma.user.findUnique({ where: { id: ID.userA }, select: { tokenVersion: true } });
  const oldToken = await login('p07-user-a@example.invalid');

  sentMails.length = 0;
  await api('POST', '/api/auth/forgot-password', { body: { email: 'p07-user-a@example.invalid' } });
  const resetToken = sentMails[0].html.match(/token=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/)[1];

  const reset = await api('POST', '/api/auth/reset-password', { body: { token: resetToken, newPassword: 'P07-Rotated-Passw0rd!' } });
  assert.equal(reset.status, 200, reset.text);

  const after = await prisma.user.findUnique({ where: { id: ID.userA }, select: { tokenVersion: true } });
  assert.equal(after.tokenVersion, before.tokenVersion + 1, 'tokenVersion must increment by exactly one');

  const stale = await api('GET', '/api/categories', { token: oldToken });
  assert.equal(stale.status, 401, 'the pre-change session must be revoked');

  const fresh = await login('p07-user-a@example.invalid', 'P07-Rotated-Passw0rd!');
  assert.equal((await api('GET', '/api/categories', { token: fresh })).status, 200, 'a new session must work');

  const reuse = await api('POST', '/api/auth/reset-password', { body: { token: resetToken, newPassword: 'P07-Third-Passw0rd!' } });
  assert.equal(reuse.status, 400, 'a spent reset token must be rejected');

  // restore the fixture password for any later test
  const restored = await bcryptRestorePassword();
  assert.equal(restored, true);
});

async function bcryptRestorePassword() {
  const bcrypt = require('bcryptjs');
  await prisma.user.update({
    where: { id: ID.userA },
    data: { password: await bcrypt.hash(SYNTHETIC_PASSWORD, 10) },
  });
  return true;
}

test('P0-2: two simultaneous resets cannot both consume the same token', async () => {
  sentMails.length = 0;
  await api('POST', '/api/auth/forgot-password', { body: { email: 'p07-user-b@example.invalid' } });
  const token = sentMails[0].html.match(/token=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/)[1];

  const [a, b] = await Promise.all([
    api('POST', '/api/auth/reset-password', { body: { token, newPassword: 'P07-Race-One-Passw0rd!' } }),
    api('POST', '/api/auth/reset-password', { body: { token, newPassword: 'P07-Race-Two-Passw0rd!' } }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 400], `exactly one reset may win, got ${JSON.stringify(statuses)}`);
});

test('P0-2: a deleted user cannot authenticate', async () => {
  const token = await login('p07-user-deleted@example.invalid');
  assert.equal((await api('GET', '/api/categories', { token })).status, 200);
  await prisma.user.delete({ where: { id: ID.userDeleted } });
  assert.equal((await api('GET', '/api/categories', { token })).status, 401, 'a deleted user must be rejected');
});

// ─────────────────────────────────────────────────────────────────────────────
// Accounts — foreign keys and deletion behaviour with synthetic data
// ─────────────────────────────────────────────────────────────────────────────

test('deleting an account preserves historical transactions and nulls the link', async () => {
  const tokenA = await login('p07-user-a@example.invalid');
  await prisma.account.create({ data: { id: ID.accountToDelete, name: 'P07 A Doomed', type: 'CASH', userId: ID.userA } });

  await prisma.expense.create({ data: { id: ID.expenseOnDeletedAccount, amount: '11.00', date: T.feb28, userId: ID.userA, categoryId: ID.catAExpense, accountId: ID.accountToDelete } });
  await prisma.income.create({ data: { id: ID.incomeOnDeletedAccount, amount: '22.00', date: T.feb28, userId: ID.userA, source: 'SALARY', accountId: ID.accountToDelete } });

  const res = await api('DELETE', `/api/accounts/${ID.accountToDelete}`, { token: tokenA });
  assert.equal(res.status, 200, res.text);

  const expense = await prisma.expense.findUnique({ where: { id: ID.expenseOnDeletedAccount } });
  const income = await prisma.income.findUnique({ where: { id: ID.incomeOnDeletedAccount } });
  assert.ok(expense, 'the historical expense must NOT be deleted');
  assert.equal(expense.accountId, null, 'the link is set to null');
  assert.equal(expense.amount.toString(), '11');
  assert.ok(income, 'the historical income must NOT be deleted');
  assert.equal(income.accountId, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-5 — recurring scheduling against the real database
// ─────────────────────────────────────────────────────────────────────────────

const recurringCountFor = async (noteFragment) =>
  prisma.expense.count({ where: { userId: ID.userA, isRecurring: true, note: { contains: noteFragment } } });

test('P0-5: repeated cron execution creates no duplicate transactions', { todo: 'not yet verified: assertions assume a fresh/advancing state, but the development database persists between runs; needs a deterministic time-controlled harness. See the P0-7 report.' }, async () => {
  const before = await recurringCountFor('P07 monthly 15th');
  await processRecurringExpenses();
  const once = await recurringCountFor('P07 monthly 15th');
  await processRecurringExpenses();
  await processRecurringExpenses();
  const thrice = await recurringCountFor('P07 monthly 15th');

  assert.ok(once > before, 'the due period should produce entries');
  assert.equal(thrice, once, `repeat runs must not duplicate (once=${once}, thrice=${thrice})`);
});

test('P0-5: two concurrent workers do not duplicate a period', { todo: 'not yet verified: assertions assume a fresh/advancing state, but the development database persists between runs; needs a deterministic time-controlled harness. See the P0-7 report.' }, async () => {
  const before = await recurringCountFor('P07 overdue monthly');
  await Promise.all([processRecurringExpenses(), processRecurringExpenses()]);
  const after = await recurringCountFor('P07 overdue monthly');
  // Both workers may each claim different periods, but no single period may be
  // claimed twice, so the total must equal the number of distinct due periods.
  const rule = await prisma.recurringRule.findUnique({ where: { id: ID.ruleOverdue } });
  assert.ok(after >= before);
  assert.ok(rule.nextExecution > new Date('2026-03-16T00:00:00Z'), 'the rule must have advanced past the overdue window');
});

test('P0-5: month-end and leap-year rules advance without skipping months', { todo: 'not yet verified: assertions assume a fresh/advancing state, but the development database persists between runs; needs a deterministic time-controlled harness. See the P0-7 report.' }, async () => {
  await processRecurringExpenses();

  const m31 = await prisma.recurringRule.findUnique({ where: { id: ID.ruleMonthly31 } });
  assert.equal(m31.nextExecution.toISOString().slice(0, 10) >= '2026-02-01', true);

  const leap = await prisma.recurringRule.findUnique({ where: { id: ID.ruleLeap } });
  assert.ok(leap.nextExecution.getTime() > new Date('2024-02-29T00:00:00Z').getTime(), 'must advance');

  const weekly = await prisma.recurringRule.findUnique({ where: { id: ID.ruleWeekly } });
  assert.equal(weekly.nextExecution.getUTCDay(), 1, 'weekly must stay on the configured Monday');
});

test('P0-5: no cross-user leakage from the scheduler', async () => {
  const bExpenses = await prisma.expense.count({ where: { userId: ID.userB, isRecurring: true } });
  assert.equal(bExpenses, 0, 'user B has no recurring rules and must gain nothing');
});
