'use strict';

/**
 * P0-5C.1 criteria 7 and 8 — transaction interruption and rollback, on real
 * PostgreSQL.
 *
 * Fault injection is done at the CLIENT boundary, not by faking a rollback: the
 * injected wrapper delegates to a real PrismaClient, and its tx.expense.create
 * throws. PostgreSQL therefore performs the real rollback of the real
 * transaction that already executed the real conditional claim. The claim's
 * updateMany and the insert share that transaction, so the rollback must undo
 * BOTH - which is the property under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runPreflight } = require('./preflight');
runPreflight(); // must precede requiring src/server: disables schedulers, points at dev

const { PrismaClient } = require('@prisma/client');
const { processRecurringExpenses } = require('../../src/server');

const RUN = `p05c1c-${Date.now()}`;
const USER = `${RUN}-user`;
const CAT = `${RUN}-cat`;
const NOW = new Date('2026-10-11T00:00:00.000Z');
const DUE = new Date('2026-10-11T00:00:00.000+05:30');
const EXPECTED_NEXT = new Date('2026-11-11T00:00:00.000+05:30');

const db = new PrismaClient();

/** Delegating wrapper; optionally interrupts the insert inside the transaction. */
const wrap = (client, { failOnCreate = false, log = [] } = {}) => ({
  recurringRule: {
    findMany: (a) => client.recurringRule.findMany(a),
    findUnique: (a) => client.recurringRule.findUnique(a),
  },
  merchant: {
    findFirst: (a) => client.merchant.findFirst(a),
    create: (a) => client.merchant.create(a),
    update: (a) => client.merchant.update(a),
  },
  $transaction: (fn, opts) =>
    client.$transaction(
      (tx) =>
        fn({
          recurringRule: {
            updateMany: async (a) => {
              const r = await tx.recurringRule.updateMany(a);
              log.push({ ruleId: a && a.where && a.where.id, claimedRows: r.count });
              return r;
            },
          },
          expense: {
            create: async (a) => {
              if (failOnCreate) {
                const err = new Error('injected interruption after the claim, before commit');
                err.code = 'P05C1C_INJECTED';
                throw err;
              }
              return tx.expense.create(a);
            },
          },
        }),
      opts
    ),
});

const newRule = (id) =>
  db.recurringRule.create({
    data: {
      id, description: id, amount: '240.00', frequency: 'MONTHLY', dayOfMonth: 11,
      nextExecution: DUE, isActive: true, userId: USER, categoryId: CAT,
    },
  });

const expensesFor = (id) =>
  db.expense.findMany({ where: { userId: USER, note: { contains: id } }, select: { date: true, amount: true, categoryId: true } });
const ruleOf = (id) => db.recurringRule.findUnique({ where: { id } });

test.before(async () => {
  await db.expense.deleteMany({ where: { userId: USER } });
  await db.recurringRule.deleteMany({ where: { userId: USER } });
  await db.category.deleteMany({ where: { userId: USER } });
  await db.user.deleteMany({ where: { id: USER } });
  await db.user.create({ data: { id: USER, email: `${USER}@example.invalid`, password: 'x' } });
  await db.category.create({ data: { id: CAT, name: `${RUN} cat`, type: 'EXPENSE', userId: USER } });
});

test.after(async () => {
  await db.expense.deleteMany({ where: { userId: USER } });
  await db.recurringRule.deleteMany({ where: { userId: USER } });
  await db.category.deleteMany({ where: { userId: USER } });
  await db.user.deleteMany({ where: { id: USER } });
  await db.$disconnect();
});

test('criterion 7: interruption before commit rolls back the claim and leaves no partial expense', async () => {
  const id = `${RUN}-a`;
  await newRule(id);
  const before = await ruleOf(id);
  const log = [];
  let propagated = null;

  try {
    await processRecurringExpenses({ prisma: wrap(db, { failOnCreate: true, log }), now: NOW });
  } catch (err) {
    propagated = err.code || err.message;
  }

  // The claim DID execute against PostgreSQL before the interruption...
  const claims = log.filter((l) => l.ruleId === id && l.claimedRows === 1).length;
  assert.equal(claims, 1, 'the claim must have executed inside the interrupted transaction');

  // ...and must have been rolled back together with the failed insert.
  assert.equal((await expensesFor(id)).length, 0, 'no partial expense may survive the rollback');
  const after = await ruleOf(id);
  assert.equal(
    after.nextExecution.getTime(),
    before.nextExecution.getTime(),
    'the claim must be rolled back too, so the occurrence stays eligible rather than being lost'
  );
  process.stdout.write(`    interruption: claims=${claims} expenses=0 advanced=false propagated=${propagated || 'swallowed'}\n`);
});

test('criterion 7b: a second interrupted attempt still leaves no partial state', async () => {
  const id = `${RUN}-a`; // same rule, still due
  const before = await ruleOf(id);
  await processRecurringExpenses({ prisma: wrap(db, { failOnCreate: true }), now: NOW });
  assert.equal((await expensesFor(id)).length, 0, 'repeated interruption must not accumulate partial rows');
  assert.equal((await ruleOf(id)).nextExecution.getTime(), before.nextExecution.getTime(), 'still eligible');
});

test('criterion 8: retry after rollback completes the occurrence exactly once', async () => {
  const id = `${RUN}-a`;
  await processRecurringExpenses({ prisma: wrap(db), now: NOW });

  const rows = await expensesFor(id);
  assert.equal(rows.length, 1, `the retry must create the occurrence exactly once, got ${rows.length}`);
  assert.equal(rows[0].amount.toString(), '240');
  assert.equal(rows[0].date.toISOString(), DUE.toISOString(), 'the original scheduled date is preserved');
  assert.equal(rows[0].categoryId, CAT);

  const rule = await ruleOf(id);
  assert.equal(rule.nextExecution.toISOString(), EXPECTED_NEXT.toISOString(), 'advanced exactly one period');
});

test('criterion 8b: retry after a successful commit does not duplicate', async () => {
  const id = `${RUN}-a`;
  await processRecurringExpenses({ prisma: wrap(db), now: NOW });
  await processRecurringExpenses({ prisma: wrap(db), now: NOW });
  assert.equal((await expensesFor(id)).length, 1, 'a post-commit retry must not duplicate');
  assert.equal((await ruleOf(id)).nextExecution.toISOString(), EXPECTED_NEXT.toISOString());
});

test('interruption mid-backlog does not half-commit a multi-period catch-up', async () => {
  const id = `${RUN}-backlog`;
  // 2026-10-02 through 2026-10-11 inclusive is TEN daily periods (both ends
  // count). An earlier version of this test said 9 and was wrong.
  await db.recurringRule.create({
    data: {
      id, description: id, amount: '15.00', frequency: 'DAILY',
      nextExecution: new Date('2026-10-02T00:00:00.000+05:30'), isActive: true,
      userId: USER, categoryId: CAT,
    },
  });
  const before = await ruleOf(id);

  await processRecurringExpenses({ prisma: wrap(db, { failOnCreate: true }), now: NOW });

  // Every period shares the same transaction-and-claim shape, so an interruption
  // must roll back that period's claim: no rows at all, and the rule unmoved.
  assert.equal((await expensesFor(id)).length, 0, 'no period may be partially committed');
  assert.equal(
    (await ruleOf(id)).nextExecution.getTime(),
    before.nextExecution.getTime(),
    'the interrupted period must not advance the rule'
  );

  // And the backlog is still fully recoverable.
  await processRecurringExpenses({ prisma: wrap(db), now: NOW });
  const rows = await expensesFor(id);
  const keys = rows.map((r) => r.date.toISOString().slice(0, 10));
  assert.equal(new Set(keys).size, keys.length, 'recovered occurrences must be unique');
  assert.equal(rows.length, 10, `the whole backlog must be recoverable, got ${rows.length}`);
  process.stdout.write(`    backlog recovery: ${rows.length} unique occurrences after interruption\n`);
});
