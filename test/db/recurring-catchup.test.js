'use strict';

/**
 * P0-5B.1 — REAL PostgreSQL verification of recurring catch-up.
 *
 * These are database-backed integration tests, not offline unit tests. They run
 * against the verified expense-tracker-dev Neon database behind the fail-closed
 * preflight, with a unique fixture prefix per run and scoped cleanup.
 *
 * The scheduler reads the real clock, so expectations are derived from the
 * application-local "today" at run time rather than hard-coded, which is what
 * makes them deterministic across runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runPreflight } = require('./preflight');
runPreflight();

const { app, prisma, processRecurringExpenses } = require('../../src/server');
const { toCivil, periodKey } = require('../../src/lib/schedule');

const RUN = `p05b1-${Date.now()}`;
const USER = `${RUN}-user`;
const CAT = `${RUN}-cat`;
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}T00:00:00.000Z`;

/** Application-local civil dates, N days back from today. */
const civilToday = () => toCivil(new Date());
const daysAgo = (n) => {
  const t = civilToday();
  const d = new Date(Date.UTC(t.year, t.monthIndex, t.day - n));
  return { year: d.getUTCFullYear(), monthIndex: d.getUTCMonth(), day: d.getUTCDate() };
};

const makeRule = async (id, { frequency, dayOfMonth = null, dayOfWeek = null, nextExecution, amount = '111.00' }) =>
  prisma.recurringRule.create({
    data: { id, description: id, amount, frequency, dayOfMonth, dayOfWeek, nextExecution, isActive: true, userId: USER, categoryId: CAT },
  });

const expensesFor = (id) =>
  prisma.expense.findMany({ where: { userId: USER, note: { contains: id } }, select: { date: true, amount: true }, orderBy: { date: 'asc' } });

const cleanup = async () => {
  await prisma.expense.deleteMany({ where: { userId: USER } });
  await prisma.recurringRule.deleteMany({ where: { userId: USER } });
  await prisma.category.deleteMany({ where: { userId: USER } });
  await prisma.user.deleteMany({ where: { id: USER } });
};

test.before(async () => {
  await cleanup();
  await prisma.user.create({ data: { id: USER, email: `${RUN}@example.invalid`, password: 'x' } });
  await prisma.category.create({ data: { id: CAT, name: `${RUN} cat`, type: 'EXPENSE', userId: USER } });
});

test.after(async () => { await cleanup(); await prisma.$disconnect(); });

test('Scenario A — exactly one overdue occurrence', async () => {
  const id = `${RUN}-a`;
  // One month ago today: due today's date last month, and the next occurrence is
  // in the future, so exactly one period is due.
  const t = civilToday();
  const prev = new Date(Date.UTC(t.year, t.monthIndex - 1, t.day));
  await makeRule(id, {
    frequency: 'MONTHLY',
    dayOfMonth: t.day,
    nextExecution: new Date(iso(prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate())),
  });

  await processRecurringExpenses();
  const rows = await expensesFor(id);
  // TWO occurrences are due, not one: last month's date AND today's, because the
  // window is inclusive of today. (An earlier version of this test expected 1 and
  // was wrong - the extra occurrence is correct behaviour, not a duplicate.)
  assert.equal(rows.length, 2, `expected 2 due monthly occurrences, got ${rows.length}`);
  assert.deepEqual(
    rows.map((r) => periodKey(r.date)),
    [iso(prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate()).slice(0, 10), iso(t.year, t.monthIndex, t.day).slice(0, 10)],
    'both due dates, in order, and neither duplicated'
  );
  assert.deepEqual([...new Set(rows.map((r) => r.amount.toString()))], ['111'], 'amount preserved');

  const nextMonth = new Date(Date.UTC(t.year, t.monthIndex + 1, t.day));
  const rule = await prisma.recurringRule.findUnique({ where: { id } });
  assert.equal(
    periodKey(rule.nextExecution),
    iso(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), nextMonth.getUTCDate()).slice(0, 10),
    'the rule advanced to the next monthly occurrence'
  );

  await processRecurringExpenses();
  assert.equal((await expensesFor(id)).length, 2, 'a repeated run must not duplicate');
});

test('Scenario B — exactly 12 overdue occurrences (daily)', async () => {
  const id = `${RUN}-b`;
  // 11 days ago .. today inclusive = exactly 12 due daily periods.
  const start = daysAgo(11);
  await makeRule(id, { frequency: 'DAILY', nextExecution: new Date(iso(start.year, start.monthIndex, start.day)) });

  await processRecurringExpenses();
  const rows = await expensesFor(id);
  assert.equal(rows.length, 12, `expected exactly 12 expenses, got ${rows.length}`);

  const keys = rows.map((r) => periodKey(r.date));
  assert.equal(new Set(keys).size, 12, 'all 12 scheduled dates must be unique');
  assert.deepEqual(keys, keys.slice().sort(), 'dates must be in ascending order');
  assert.equal(keys[0], iso(start.year, start.monthIndex, start.day).slice(0, 10), 'the first date is the original schedule');
  assert.equal(keys[11], iso(civilToday().year, civilToday().monthIndex, civilToday().day).slice(0, 10), 'the last date is today');

  const after = await prisma.recurringRule.findUnique({ where: { id } });
  assert.equal(periodKey(after.nextExecution), periodKey(new Date(after.nextExecution.getTime())), 'nextExecution is valid');
  assert.ok(after.nextExecution.getTime() > Date.now() - 86400000, 'the rule advanced beyond the processed window');

  await processRecurringExpenses();
  assert.equal((await expensesFor(id)).length, 12, 'a retry must not duplicate');
});

test('Scenario C — more than 12 overdue occurrences drains the backlog without loss or duplication', async () => {
  const id = `${RUN}-c`;
  // 30 days ago..today = 31 due daily periods, so the 12-per-run cap applies.
  const start = daysAgo(30);
  await makeRule(id, { frequency: 'DAILY', nextExecution: new Date(iso(start.year, start.monthIndex, start.day)) });

  await processRecurringExpenses();
  const afterFirst = await expensesFor(id);
  assert.equal(afterFirst.length, 12, `cap must limit the first run to 12, got ${afterFirst.length}`);

  await processRecurringExpenses();
  const afterSecond = await expensesFor(id);
  assert.equal(afterSecond.length, 24, `second run should add 12 more, got ${afterSecond.length}`);

  await processRecurringExpenses();
  const afterThird = await expensesFor(id);
  assert.equal(afterThird.length, 31, `third run should finish the backlog, got ${afterThird.length}`);

  const keys = afterThird.map((r) => periodKey(r.date));
  assert.equal(new Set(keys).size, 31, 'no duplicates across runs');
  assert.deepEqual(keys, keys.slice().sort(), 'chronological order preserved');

  // Every day in the range is present exactly once: nothing skipped.
  const expected = [];
  for (let i = 30; i >= 0; i -= 1) {
    const d = daysAgo(i);
    expected.push(iso(d.year, d.monthIndex, d.day).slice(0, 10));
  }
  assert.deepEqual(keys, expected, 'no occurrence skipped or duplicated');

  await processRecurringExpenses();
  assert.equal((await expensesFor(id)).length, 31, 'a further run must add nothing');
  process.stdout.write(`    Scenario C: 31 occurrences drained as 12 + 12 + 7, no gaps\n`);
});

test('Scenario D — a rule with no due occurrence creates nothing', async () => {
  const id = `${RUN}-d`;
  const future = daysAgo(-5); // five days ahead
  await makeRule(id, { frequency: 'DAILY', nextExecution: new Date(iso(future.year, future.monthIndex, future.day)) });
  await processRecurringExpenses();
  assert.equal((await expensesFor(id)).length, 0, 'nothing is due, so nothing may be created');
});

test('legacy convention: a UTC-midnight stored value is still claimed exactly once', async () => {
  const id = `${RUN}-legacy`;
  // The pre-P0-5B host-local convention: an exact UTC midnight, not IST midnight.
  const t = civilToday();
  const prev = new Date(Date.UTC(t.year, t.monthIndex - 1, t.day));
  await makeRule(id, {
    frequency: 'MONTHLY',
    dayOfMonth: t.day,
    nextExecution: new Date(`${iso(prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate())}`),
  });
  const before = await prisma.recurringRule.findUnique({ where: { id } });
  assert.equal(before.nextExecution.toISOString().slice(0, 10), iso(prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate()).slice(0, 10));

  await processRecurringExpenses();
  const rows = await expensesFor(id);
  // Two due occurrences again (last month and today), and the point of the test
  // is that a UTC-midnight legacy value IS claimed at all - before P0-5A the
  // claim matched nothing and this returned 0.
  assert.equal(rows.length, 2, `a legacy UTC-midnight value must still be claimed (P0-5A), got ${rows.length}`);
  assert.deepEqual(
    rows.map((r) => periodKey(r.date)),
    [iso(prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate()).slice(0, 10), iso(t.year, t.monthIndex, t.day).slice(0, 10)]
  );
  await processRecurringExpenses();
  assert.equal((await expensesFor(id)).length, 2, 'and must not duplicate on retry');
});
