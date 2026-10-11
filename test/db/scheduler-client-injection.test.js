'use strict';

/**
 * P0-5C.1a — the recurring scheduler must use an injected Prisma client.
 *
 * SAFETY: this file lives in test/db, and runPreflight() is called BEFORE
 * src/server is required. That is not incidental. Requiring src/server with the
 * repository's .env loads the PRODUCTION configuration and arms the real cron
 * plus a 10-second boot-time scheduler run. runPreflight() sets
 * DISABLE_SCHEDULERS and repoints DATABASE_URL at the development database, so
 * importing the app here is safe by construction.
 *
 * The tests themselves use spy clients and never query a database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runPreflight } = require('./preflight');
runPreflight();

const { processRecurringExpenses, prisma } = require('../../src/server');

test.after(async () => {
  await prisma.$disconnect();
});

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
const schedulerBody = () =>
  SOURCE.slice(SOURCE.indexOf('const processRecurringExpenses ='), SOURCE.indexOf('cron.schedule('));

test('schedulers stay disabled while the app is imported for testing', () => {
  assert.equal(process.env.DISABLE_SCHEDULERS, 'true', 'the preflight must disable schedulers');
  assert.equal(
    process.env.DATABASE_URL.includes('ep-snowy-base-b3c21vk0'),
    true,
    'DATABASE_URL must point at the development database, never production'
  );
});

test('an injected client is used for the rule query, and a fallback would fail loudly', async () => {
  const calls = [];
  const spy = {
    recurringRule: {
      findMany: async (args) => {
        calls.push({ method: 'recurringRule.findMany', where: args && args.where });
        return [];
      },
    },
    $transaction: async () => {
      calls.push({ method: '$transaction' });
      throw new Error('the injected client must be the only one used');
    },
  };

  await processRecurringExpenses({ prisma: spy });

  assert.equal(calls.length, 1, `expected exactly the rule query, got ${JSON.stringify(calls)}`);
  assert.equal(calls[0].method, 'recurringRule.findMany');
});

test('every database operation of the invocation flows through the injected client', async () => {
  const txCalls = [];
  const outerCalls = [];
  const tx = {
    recurringRule: { updateMany: async () => { txCalls.push('tx.recurringRule.updateMany'); return { count: 1 }; } },
    expense: { create: async () => { txCalls.push('tx.expense.create'); return { id: 'spy-expense' }; } },
  };
  const spy = {
    recurringRule: {
      findMany: async () => {
        outerCalls.push('recurringRule.findMany');
        return [{
          id: 'spy-rule', description: 'spy rule', amount: 10, frequency: 'MONTHLY', dayOfMonth: 1,
          nextExecution: new Date('2020-01-01T00:00:00.000Z'), isActive: true,
          userId: 'spy-user', categoryId: 'spy-cat', category: { type: 'EXPENSE' },
        }];
      },
      findUnique: async () => {
        outerCalls.push('recurringRule.findUnique');
        return { nextExecution: new Date('2020-01-01T00:00:00.000Z') };
      },
    },
    merchant: { findFirst: async () => null, create: async () => ({}), update: async () => ({}) },
    $transaction: async (fn) => { outerCalls.push('$transaction'); return fn(tx); },
  };

  await processRecurringExpenses({ prisma: spy });

  assert.ok(outerCalls.includes('recurringRule.findMany'), 'rule query used the injected client');
  assert.ok(outerCalls.includes('$transaction'), 'transaction opened on the injected client');
  assert.ok(txCalls.includes('tx.recurringRule.updateMany'), 'CAS claim ran on the injected transaction');
  assert.ok(txCalls.includes('tx.expense.create'), 'expense insert ran on the injected transaction');
  assert.equal(outerCalls.includes('recurringRule.findUnique'), false, 'no diagnostic when the claim succeeds');
});

test('an injected clock is honoured', async () => {
  const calls = [];
  const spy = {
    recurringRule: { findMany: async () => { calls.push('findMany'); return []; } },
    $transaction: async () => { throw new Error('nothing should be claimed'); },
  };
  await processRecurringExpenses({ prisma: spy, now: '2030-01-01T00:00:00.000Z' });
  assert.deepEqual(calls, ['findMany']);
});

test('the default remains the module client, scoped to the scheduler body', () => {
  const body = schedulerBody();
  assert.match(body, /const db = options\.prisma \|\| prisma;/, 'default is the module client');
  assert.match(body, /const today = options\.now \? new Date\(options\.now\) : new Date\(\);/, 'default clock preserved');
  const globalCalls = body.match(/\bprisma\.[A-Za-z$]/g) || [];
  assert.deepEqual(globalCalls, [], `no global prisma.* call may remain: ${globalCalls.join(', ')}`);
  assert.match(body, /await db\.recurringRule\.findMany\(/, 'queries use the selected client');
  assert.match(body, /await db\.\$transaction\(/, 'the transaction uses the selected client');
});

test('the CAS comparison is untouched', () => {
  const body = schedulerBody();
  assert.match(body, /nextExecution: expectedStored,/, 'claim still compares the exact stored timestamp');
  assert.match(body, /let expectedStored = rule\.nextExecution;/, 'chained from the stored value');
  assert.equal(/nextExecution: period,/.test(body), false, 'the calendar date must never be the claim key');
});
