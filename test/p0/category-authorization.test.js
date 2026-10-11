'use strict';

/**
 * P0-8 — category ownership authorization.
 *
 * These are MOCKED-DATABASE tests: the lookup is injected, so they run with no
 * database and no network. They are NOT database-backed integration tests —
 * those are listed at the bottom and require the approved non-production
 * environment.
 *
 * Two synthetic users, each with their own categories.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  INVALID_RESOURCE_ERROR,
  isUsableId,
  authorizeCategory,
  authorizeResource,
} = require('../../src/lib/authorization');

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic fixtures
// ─────────────────────────────────────────────────────────────────────────────

const USER_A = 'user_a';
const USER_B = 'user_b';

const CATEGORIES = [
  { id: 'cat-a1', userId: USER_A, name: 'A Groceries', type: 'EXPENSE' },
  { id: 'cat-a2', userId: USER_A, name: 'A Mutual Funds', type: 'SAVINGS' },
  { id: 'cat-b1', userId: USER_B, name: 'B Secret Dining', type: 'EXPENSE' },
];

/** A correct, userId-scoped lookup. Records the args it was called with. */
const makeLookup = () => {
  const calls = [];
  const lookup = async (args) => {
    calls.push(args);
    return CATEGORIES.find((c) => c.id === args.id && c.userId === args.userId) || null;
  };
  return { lookup, calls };
};

// ─────────────────────────────────────────────────────────────────────────────
// Owned references keep working (no legitimate behaviour is broken)
// ─────────────────────────────────────────────────────────────────────────────

test('a user can use their own category', async () => {
  const { lookup } = makeLookup();
  const result = await authorizeCategory(lookup, USER_A, 'cat-a1');
  assert.equal(result.ok, true);
  assert.equal(result.category.id, 'cat-a1');
  assert.equal(result.category.name, 'A Groceries');
});

test('a user can use their own SAVINGS category (type is not restricted)', async () => {
  // Savings categories are legitimately used for budgets and recurring rules
  // (SIP tracking), so type compatibility must NOT be enforced as a block.
  const { lookup } = makeLookup();
  const result = await authorizeCategory(lookup, USER_A, 'cat-a2');
  assert.equal(result.ok, true);
  assert.equal(result.category.type, 'SAVINGS');
});

test('an absent reference is optional, not an error', async () => {
  const { lookup, calls } = makeLookup();
  for (const absent of [undefined, null, '']) {
    const result = await authorizeCategory(lookup, USER_A, absent);
    assert.equal(result.ok, true, `${String(absent)} must be treated as omitted`);
    assert.equal(result.category, null);
  }
  assert.equal(calls.length, 0, 'no lookup for an omitted reference');
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-user references are rejected, and must not disclose anything
// ─────────────────────────────────────────────────────────────────────────────

test('user A cannot reference user B category', async () => {
  const { lookup } = makeLookup();
  const result = await authorizeCategory(lookup, USER_A, 'cat-b1');
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, INVALID_RESOURCE_ERROR);
  assert.equal('category' in result, false, 'no category object is returned');
});

test('user B cannot reference user A category', async () => {
  const { lookup } = makeLookup();
  const result = await authorizeCategory(lookup, USER_B, 'cat-a1');
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test('a cross-user rejection discloses nothing about the other user', async () => {
  const { lookup } = makeLookup();
  const result = await authorizeCategory(lookup, USER_A, 'cat-b1');
  const serialized = JSON.stringify(result);
  for (const secret of ['B Secret Dining', 'user_b', 'cat-b1', 'SAVINGS']) {
    assert.equal(serialized.includes(secret), false, `must not leak ${secret}`);
  }
});

test('a foreign id and a nonexistent id produce byte-identical responses', async () => {
  const { lookup } = makeLookup();
  const foreign = await authorizeCategory(lookup, USER_A, 'cat-b1');
  const missing = await authorizeCategory(lookup, USER_A, 'cat-does-not-exist');
  const malformed = await authorizeCategory(lookup, USER_A, 12345);

  assert.deepEqual(foreign, missing);
  assert.deepEqual(foreign, malformed);
  assert.equal(JSON.stringify(foreign), JSON.stringify(missing));
  // If these differed, the endpoint would be an oracle for "does this id exist
  // and belong to someone else".
});

// ─────────────────────────────────────────────────────────────────────────────
// The lookup must be scoped to the authenticated user
// ─────────────────────────────────────────────────────────────────────────────

test('the lookup is always called with the authenticated userId, never a client value', async () => {
  const { lookup, calls } = makeLookup();
  await authorizeCategory(lookup, USER_A, 'cat-a1');
  await authorizeCategory(lookup, USER_B, 'cat-b1');
  assert.deepEqual(calls, [
    { id: 'cat-a1', userId: USER_A },
    { id: 'cat-b1', userId: USER_B },
  ]);
});

test('a missing authenticated userId is refused rather than looked up unscoped', async () => {
  const { lookup, calls } = makeLookup();
  for (const badUser of [undefined, null, '', '   ', 42, {}]) {
    const result = await authorizeCategory(lookup, badUser, 'cat-a1');
    assert.equal(result.ok, false, `userId ${JSON.stringify(badUser)} must be refused`);
    assert.equal(result.status, 400);
  }
  assert.equal(calls.length, 0, 'must not reach the database without a tenant');
});

test('SENSITIVITY: a lookup that ignores userId WOULD leak, which is why the query is asserted', async () => {
  // Demonstrates the residual dependency: the helper cannot save a query that
  // forgets to filter. This is exactly the mistake the original code made.
  const unscoped = async ({ id }) => CATEGORIES.find((c) => c.id === id) || null;
  const result = await authorizeCategory(unscoped, USER_A, 'cat-b1');
  assert.equal(result.ok, true, 'an unscoped lookup defeats the helper');
  assert.equal(result.category.name, 'B Secret Dining');
  // The structural test below therefore pins the real query to filter by userId.
});

// ─────────────────────────────────────────────────────────────────────────────
// Input hygiene
// ─────────────────────────────────────────────────────────────────────────────

test('isUsableId accepts only non-blank strings', () => {
  assert.equal(isUsableId('abc'), true);
  for (const bad of ['', '   ', null, undefined, 42, {}, [], true]) {
    assert.equal(isUsableId(bad), false, `${JSON.stringify(bad)}`);
  }
});

test('authorizeResource applies the same rule to other owned resources', async () => {
  const accounts = [
    { id: 'acct-a', userId: USER_A },
    { id: 'acct-b', userId: USER_B },
  ];
  const lookup = async ({ id, userId }) =>
    accounts.find((a) => a.id === id && a.userId === userId) || null;

  const owned = await authorizeResource(lookup, USER_A, 'acct-a', 'Invalid account.');
  assert.equal(owned.ok, true);

  const foreign = await authorizeResource(lookup, USER_A, 'acct-b', 'Invalid account.');
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'Invalid account.');

  const absent = await authorizeResource(lookup, USER_A, null, 'Invalid account.');
  assert.equal(absent.ok, true);
  assert.equal(absent.resource, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// The write-path sequence: a cross-user edit must not touch the record
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirror of the PUT /api/expenses/:id order of operations: first the target
 * record is resolved with userId in the WHERE clause, then the category is
 * authorized, and only then is anything written. Proves the guard runs before
 * the write and that nothing is persisted on rejection.
 */
const simulateExpenseUpdate = async ({ expenses, lookup, userId, expenseId, categoryId }) => {
  const target = expenses.find((e) => e.id === expenseId && e.userId === userId) || null;
  if (!target) {
    return { status: 404, error: 'Not found', writes: 0 };
  }
  const check = await authorizeCategory(lookup, userId, categoryId);
  if (!check.ok) {
    return { status: check.status, error: check.error, writes: 0 };
  }
  target.categoryId = categoryId;
  return { status: 200, writes: 1, categoryId: target.categoryId };
};

test('editing an owned transaction to another user category is rejected with no write', async () => {
  const { lookup } = makeLookup();
  const expenses = [{ id: 'exp-a1', userId: USER_A, categoryId: 'cat-a1' }];

  const result = await simulateExpenseUpdate({
    expenses,
    lookup,
    userId: USER_A,
    expenseId: 'exp-a1',
    categoryId: 'cat-b1',
  });

  assert.equal(result.status, 400);
  assert.equal(result.error, INVALID_RESOURCE_ERROR);
  assert.equal(result.writes, 0, 'nothing may be written');
  assert.equal(expenses[0].categoryId, 'cat-a1', 'the record is unchanged');
});

test('editing an owned transaction to an owned category still works', async () => {
  const { lookup } = makeLookup();
  const expenses = [{ id: 'exp-a1', userId: USER_A, categoryId: 'cat-a1' }];

  const result = await simulateExpenseUpdate({
    expenses,
    lookup,
    userId: USER_A,
    expenseId: 'exp-a1',
    categoryId: 'cat-a2',
  });

  assert.equal(result.status, 200);
  assert.equal(result.writes, 1);
  assert.equal(expenses[0].categoryId, 'cat-a2');
});

test('a user cannot edit another user transaction at all', async () => {
  const { lookup } = makeLookup();
  const expenses = [{ id: 'exp-b1', userId: USER_B, categoryId: 'cat-b1' }];

  const result = await simulateExpenseUpdate({
    expenses,
    lookup,
    userId: USER_A,
    expenseId: 'exp-b1',
    categoryId: 'cat-a1',
  });

  assert.equal(result.status, 404, 'another user record is simply not found');
  assert.equal(result.writes, 0);
  assert.equal(expenses[0].categoryId, 'cat-b1');
});

// ─────────────────────────────────────────────────────────────────────────────
// Structural guarantees: every path is guarded, and the query is scoped
// ─────────────────────────────────────────────────────────────────────────────

const SERVER = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');

const handlerRegion = (routeOpen, nextRouteOpen) => {
  const start = SERVER.indexOf(routeOpen);
  assert.notEqual(start, -1, `route not found: ${routeOpen}`);
  return SERVER.slice(start, SERVER.indexOf(nextRouteOpen, start));
};

test('all eight category-accepting write paths call the authorization helper', () => {
  const routes = [
    ["app.post(\n  '/api/expenses',", "app.put(\n  '/api/expenses/:id',"],
    ["app.put(\n  '/api/expenses/:id',", "app.delete(\n  '/api/expenses/:id',"],
    ["app.post(\n  '/api/budgets',", "app.put(\n  '/api/budgets/:id',"],
    ["app.put(\n  '/api/budgets/:id',", "app.delete(\n  '/api/budgets/:id',"],
    ["app.post(\n  '/api/recurring-rules',", "app.put(\n  '/api/recurring-rules/:id',"],
    ["app.put(\n  '/api/recurring-rules/:id',", "app.patch(\n  '/api/recurring-rules/:id/toggle',"],
    ["app.put(\n  '/api/pending/:id',", "app.delete(\n  '/api/pending/:id',"],
    ["app.post(\n  '/api/pending/:id/confirm',", "// =========================================="],
  ];
  for (const [open, next] of routes) {
    const region = handlerRegion(open, next);
    assert.match(region, /authorizeCategory\(/, `${open.split('\n')[0]} must authorize categoryId`);
    assert.match(region, /findOwnedCategory/, 'must use the scoped lookup');
    assert.match(region, /req\.user\.id/, 'must use the authenticated user');
    assert.equal(region.includes('req.body.userId'), false, 'must never trust a client userId');
  }
});

test('the category lookup filters by userId inside the WHERE clause', () => {
  const start = SERVER.indexOf('const findOwnedCategory =');
  const region = SERVER.slice(start, SERVER.indexOf('\n};', start));
  assert.match(region, /userId: args\.userId/, 'the query must scope by the authenticated user');
  assert.match(region, /id: args\.id/);
  assert.match(region, /prisma\.category\.findFirst/);
});

test('update and delete paths scope the target record by userId as well', () => {
  // Target-record ownership, separate from the category reference.
  for (const [open, next] of [
    ["app.put(\n  '/api/expenses/:id',", "app.delete(\n  '/api/expenses/:id',"],
    ["app.put(\n  '/api/budgets/:id',", "app.delete(\n  '/api/budgets/:id',"],
    ["app.put(\n  '/api/recurring-rules/:id',", "app.patch(\n  '/api/recurring-rules/:id/toggle',"],
    ["app.put(\n  '/api/pending/:id',", "app.delete(\n  '/api/pending/:id',"],
  ]) {
    const region = handlerRegion(open, next);
    assert.match(region, /userId: req\.user\.id/, `${open.split('\n')[0]} must scope the record`);
  }
});

test('no endpoint anywhere accepts a userId from the request', () => {
  for (const pattern of [/req\.body\.userId/, /req\.query\.userId/, /req\.params\.userId/]) {
    assert.equal(pattern.test(SERVER), false, `found ${pattern}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit of the other referenced resources
// ─────────────────────────────────────────────────────────────────────────────

test('AUDIT: account references are authorized via getOwnedAccount', () => {
  // accounts were already correct before P0-8; asserted so a regression fails.
  for (const [open, next] of [
    ["app.post(\n  '/api/expenses',", "app.put(\n  '/api/expenses/:id',"],
    ["app.put(\n  '/api/expenses/:id',", "app.delete(\n  '/api/expenses/:id',"],
    ["app.post(\n  '/api/incomes',", "app.delete(\n  '/api/incomes/:id',"],
  ]) {
    const region = handlerRegion(open, next);
    assert.match(region, /getOwnedAccount\(/, `${open.split('\n')[0]} must check the account`);
  }
});

test('AUDIT: merchant references are scoped by userId', () => {
  const start = SERVER.indexOf("'/api/merchant-list'");
  const region = SERVER.slice(start, SERVER.indexOf("// ==========================================", start));
  const findFirsts = (region.match(/prisma\.merchant\.findFirst\(/g) || []).length;
  const scoped = (region.match(/userId: req\.user\.id/g) || []).length;
  assert.ok(findFirsts >= 1, 'merchant lookups exist');
  assert.ok(scoped >= findFirsts, `every merchant lookup must be scoped (${scoped} scoped vs ${findFirsts} lookups)`);
});

test('AUDIT: no endpoint accepts a budgetId or ruleId as a cross-reference', () => {
  // Budgets and recurring rules are addressed by their own id (scoped) and are
  // never referenced from another resource, so there is no reference to check.
  assert.equal(/budgetId\s*[,:}]/.test(SERVER.replace(/req\.params\.id/g, '')), false);
  assert.equal(/recurringRuleId/.test(SERVER), false);
});

test('AUDIT: the GET /api/expenses categoryId filter is userId-scoped, so it cannot leak', () => {
  const region = handlerRegion("app.get(\n  '/api/expenses',", "app.post(\n  '/api/expenses',");
  assert.match(region, /userId: req\.user\.id/, 'reads are scoped');
  assert.match(region, /where\.categoryId = categoryId/, 'the filter is applied');
  // A foreign id therefore yields an empty list, not another user rows.
});
