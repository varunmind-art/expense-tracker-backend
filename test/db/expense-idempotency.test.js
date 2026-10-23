'use strict';

/**
 * Android companion app — DATABASE-BACKED SYNC TESTS.
 *
 * Covers the contract the Kiwi share flow depends on:
 *   - an `externalRef` is unique per user and source, so a repeated share,
 *     an app restart or a network retry can never create a second expense;
 *   - the same ref from a *different* user does not collide (per-user scoping);
 *   - the provenance fields are stored and returned.
 *
 * Run with: npm run test:db   (the preflight below is fail-closed)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ── preflight FIRST, before anything can load configuration ──────────────────
const { runPreflight } = require('./preflight');
runPreflight();

const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({ sendMail: async () => ({ messageId: 'kiwi-stub' }) });

const { app, prisma } = require('../../src/server');
const { createFixtures, ID, SYNTHETIC_PASSWORD } = require('./fixtures');

const REF_PREFIX = 'kiwi-test-';

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
    json = null;
  }
  return { status: res.status, json, text };
};

const login = async (email) => {
  const res = await api('POST', '/api/auth/login', {
    body: { email, password: SYNTHETIC_PASSWORD },
  });
  assert.equal(res.status, 200, `login failed for ${email}: ${res.text}`);
  return res.json.token;
};

const expensePayload = (categoryId, externalRef) => ({
  amount: '190.00',
  date: '2026-10-22',
  merchant: 'Govind',
  note: 'Scan and Pay',
  type: 'EXPENSE',
  categoryId,
  source: 'KIWI',
  externalRef,
});

test.before(async () => {
  await createFixtures(prisma);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tokenA = await login('p07-user-a@example.invalid');
  tokenB = await login('p07-user-b@example.invalid');
});

test.after(async () => {
  if (prisma) {
    await prisma.expense.deleteMany({ where: { externalRef: { startsWith: REF_PREFIX } } });
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('a repeated share of the same receipt is rejected, not duplicated', async () => {
  const ref = `${REF_PREFIX}upi-415623987412`;

  const first = await api('POST', '/api/expenses', {
    token: tokenA,
    body: expensePayload(ID.catAExpense, ref),
  });
  assert.equal(first.status, 201, first.text);
  assert.equal(first.json.source, 'KIWI');
  assert.equal(first.json.externalRef, ref);

  // Exactly what a retry, a repeated share or a restarted app would send.
  const second = await api('POST', '/api/expenses', {
    token: tokenA,
    body: expensePayload(ID.catAExpense, ref),
  });
  assert.equal(second.status, 409, 'the duplicate must be refused');
  assert.equal(second.json.code, 'DUPLICATE_EXTERNAL_REF');

  const rows = await prisma.expense.findMany({ where: { userId: ID.userA, externalRef: ref } });
  assert.equal(rows.length, 1, 'exactly one expense must exist');
});

test('a different transaction is accepted', async () => {
  const res = await api('POST', '/api/expenses', {
    token: tokenA,
    body: expensePayload(ID.catAExpense, `${REF_PREFIX}upi-999999999999`),
  });
  assert.equal(res.status, 201, res.text);
});

test('the same ref from another user does not collide', async () => {
  const ref = `${REF_PREFIX}shared-ref-across-users`;

  const forA = await api('POST', '/api/expenses', {
    token: tokenA,
    body: expensePayload(ID.catAExpense, ref),
  });
  assert.equal(forA.status, 201, forA.text);

  // Same value, different user: scoping is per user, so this must succeed.
  const forB = await api('POST', '/api/expenses', {
    token: tokenB,
    body: expensePayload(ID.catBExpense, ref),
  });
  assert.equal(forB.status, 201, forB.text);

  assert.notEqual(forA.json.id, forB.json.id);
});

test('an expense without a source still works as before', async () => {
  const res = await api('POST', '/api/expenses', {
    token: tokenA,
    body: {
      amount: '45.50',
      date: '2026-10-23',
      merchant: 'Plain entry',
      type: 'EXPENSE',
      categoryId: ID.catAExpense,
    },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.source, null);
  assert.equal(res.json.externalRef, null);

  // Two identical manual entries are still allowed: only externalRef is unique.
  const again = await api('POST', '/api/expenses', {
    token: tokenA,
    body: {
      amount: '45.50',
      date: '2026-10-23',
      merchant: 'Plain entry',
      type: 'EXPENSE',
      categoryId: ID.catAExpense,
    },
  });
  assert.equal(again.status, 201, again.text);
});
