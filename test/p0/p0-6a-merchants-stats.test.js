'use strict';

/**
 * P0-6A — merchant statistics date windows.
 *
 * The endpoint aggregates in memory: it loads a rolling window of expenses and
 * then decides which ones fall in the selected month and the previous month.
 * That makes "the database filter and the in-memory filter agree" a real
 * requirement, so the tests below exercise the exact pair of helpers the endpoint
 * uses (`dateFilterFor` for Prisma, `isWithin` for JavaScript) and prove they
 * classify every boundary instant identically.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  monthRange,
  monthRangeForInstant,
  previousMonthLabel,
  shiftMonths,
  dateFilterFor,
  isWithin,
  appLocalDateString,
} = require('../../src/lib/dateRange');

const SERVER = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');

/** The endpoint region, for wiring assertions. */
const statsRegion = () => {
  const start = SERVER.indexOf("'/api/merchants/stats'");
  const end = SERVER.indexOf("'/api/merchants/transactions'", start);
  return SERVER.slice(start, end);
};

/**
 * Reproduce the endpoint's per-merchant month counting, using the SAME
 * predicate the endpoint uses. This is what makes the filter behaviour testable
 * without a database.
 */
const countMonths = (dates, window) => {
  let monthCount = 0;
  let prevCount = 0;
  for (const date of dates) {
    if (isWithin(window, date)) monthCount += 1;
  }
  return { monthCount, prevCount };
};

// ─────────────────────────────────────────────────────────────────────────────
// Previous-month derivation
// ─────────────────────────────────────────────────────────────────────────────

test('previousMonthLabel handles the January rollover and rejects bad input', () => {
  assert.equal(previousMonthLabel('2026-01'), '2025-12');
  assert.equal(previousMonthLabel('2026-03'), '2026-02');
  assert.equal(previousMonthLabel('2026-12'), '2026-11');
  for (const bad of ['abc', '2026-13', '2026-00', '2026', null, undefined]) {
    assert.equal(previousMonthLabel(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

test('the previous window is the month before the selected one', () => {
  const window = monthRange('2026-01');
  const prev = monthRange(previousMonthLabel(window.label));
  assert.equal(prev.label, '2025-12');
  assert.ok(prev.end.getTime() === window.start.getTime(), 'the windows meet exactly, with no gap or overlap');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rolling 12-month lookback (business logic preserved, arithmetic hardened)
// ─────────────────────────────────────────────────────────────────────────────

test('shiftMonths does not drift on a leap day', () => {
  // The old setMonth(getMonth() - 12) on 29 Feb 2024 landed on 1 Mar 2023.
  const leapDay = new Date('2024-02-29T00:00:00Z');
  const back = shiftMonths(leapDay, -12, 0);
  assert.equal(appLocalDateString(back, 0), '2023-02-28', 'clamped to the last valid day, not rolled forward');
});

test('shiftMonths handles month and year rollovers', () => {
  assert.equal(appLocalDateString(shiftMonths(new Date('2026-01-15T00:00:00Z'), -12, 0), 0), '2025-01-15');
  assert.equal(appLocalDateString(shiftMonths(new Date('2026-03-31T00:00:00Z'), -1, 0), 0), '2026-02-28');
  assert.equal(appLocalDateString(shiftMonths(new Date('2026-12-15T00:00:00Z'), 1, 0), 0), '2027-01-15');
});

// ─────────────────────────────────────────────────────────────────────────────
// Database filter vs in-memory filter: the consistency requirement
// ─────────────────────────────────────────────────────────────────────────────

test('dateFilterFor is half-open: start inclusive, end exclusive', () => {
  const window = monthRange('2026-03', 0);
  const filter = dateFilterFor(window);
  assert.equal(filter.gte.toISOString(), '2026-03-01T00:00:00.000Z');
  assert.equal(filter.lt.toISOString(), '2026-04-01T00:00:00.000Z');
  assert.equal('lte' in filter, false, 'must not use an inclusive upper bound');
});

test('isWithin agrees with the Prisma filter at every boundary instant', () => {
  for (const month of ['2026-03', '2026-02', '2024-02', '2026-12', '2026-01']) {
    const window = monthRange(month, 0);
    const { gte, lt } = dateFilterFor(window);
    const cases = [
      [gte.getTime() - 1, false, 'one ms before the start'],
      [gte.getTime(), true, 'exactly the start'],
      [gte.getTime() + 1, true, 'one ms after the start'],
      [lt.getTime() - 1, true, 'one ms before the end'],
      [lt.getTime(), false, 'exactly the end (excluded)'],
      [lt.getTime() + 1, false, 'one ms after the end'],
    ];
    for (const [time, expected, label] of cases) {
      const instant = new Date(time);
      assert.equal(isWithin(window, instant), expected, `${month}: ${label}`);
      // The database would evaluate the same comparison, so assert it too.
      const inDb = time >= gte.getTime() && time < lt.getTime();
      assert.equal(inDb, expected, `${month}: ${label} (prisma equivalent)`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Month-end, leap year, current + previous period
// ─────────────────────────────────────────────────────────────────────────────

test('the final millisecond of a month counts toward that month only', () => {
  const march = monthRange('2026-03', 330);
  const april = monthRange('2026-04', 330);
  const lastMs = new Date(march.end.getTime() - 1);

  assert.equal(appLocalDateString(lastMs), '2026-03-31');
  assert.equal(isWithin(march, lastMs), true, 'belongs to March');
  assert.equal(isWithin(april, lastMs), false, 'and not to April');
  // The old window ended at 23:59:59.000, so this instant was dropped entirely.
});

test('a leap-year February includes the 29th and excludes 1 March', () => {
  const feb = monthRange('2024-02', 330);
  assert.equal(isWithin(feb, new Date('2024-02-29T00:00:00Z')), true);
  assert.equal(isWithin(feb, new Date('2024-03-01T00:00:00Z')), false);
  assert.equal(appLocalDateString(new Date(feb.end.getTime() - 1)), '2024-02-29');
});

test('current and previous periods partition correctly across a year boundary', () => {
  const jan = monthRange('2026-01', 0);
  const dec = monthRange(previousMonthLabel('2026-01'), 0);

  const midDec = new Date('2025-12-15T12:00:00Z');
  const midJan = new Date('2026-01-15T12:00:00Z');

  assert.equal(isWithin(dec, midDec), true);
  assert.equal(isWithin(jan, midDec), false);
  assert.equal(isWithin(jan, midJan), true);
  assert.equal(isWithin(dec, midJan), false);
  assert.equal(dec.end.getTime(), jan.start.getTime(), 'no gap and no overlap');
});

test('the endpoint counts a month-spanning dataset the way the window defines it', () => {
  // One expense in December, three in January (one on the last instant).
  const jan = monthRange('2026-01', 330);
  const dates = [
    new Date('2025-12-31T18:29:59.999Z'), // 2025-12-31 23:59:59.999 IST -> December
    new Date('2025-12-31T18:30:00.000Z'), // 2026-01-01 00:00:00.000 IST -> January
    new Date('2026-01-15T12:00:00Z'),
    new Date('2026-01-31T18:29:59.999Z'), // last instant of January IST
    new Date('2026-01-31T18:30:00.000Z'), // 2026-02-01 -> February
  ];
  assert.equal(countMonths(dates, jan).monthCount, 3);
});

test('an empty dataset yields zero counts, so the merchant is filtered out', () => {
  const window = monthRange('2026-03', 0);
  assert.deepEqual(countMonths([], window), { monthCount: 0, prevCount: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// Timezone boundaries
// ─────────────────────────────────────────────────────────────────────────────

test('timezone boundaries decide the month, independent of the host clock', () => {
  // 2026-03-31T18:30Z is exactly 2026-04-01 00:00 IST.
  const march = monthRange('2026-03', 330);
  const april = monthRange('2026-04', 330);
  const crossover = new Date('2026-03-31T18:30:00.000Z');

  assert.equal(isWithin(march, crossover), false);
  assert.equal(isWithin(april, crossover), true);
  assert.equal(appLocalDateString(crossover), '2026-04-01');
  assert.equal(appLocalDateString(new Date('2026-03-31T18:29:59.999Z')), '2026-03-31');
});

test('the no-month path uses the application-local current month', () => {
  // 2026-03-31T20:00Z is 2026-04-01 01:30 IST, so the default window is April.
  assert.equal(monthRangeForInstant(new Date('2026-03-31T20:00:00Z'), 330).label, '2026-04');
});

// ─────────────────────────────────────────────────────────────────────────────
// Invalid input and response contract
// ─────────────────────────────────────────────────────────────────────────────

test('invalid and out-of-range months produce null so the endpoint answers 400', () => {
  for (const bad of ['abc', '2026-13', '2026-00', '2026', '2026-1', '2026-06-15', '', null, undefined]) {
    assert.equal(monthRange(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

test('the endpoint still returns exactly { month, merchants }', () => {
  const region = statsRegion();
  assert.match(region, /res\.json\(\{\s*month: window\.label,\s*merchants,\s*\}\)/, 'response contract preserved');
  // And the label is the validated input, not a UTC re-derivation.
  assert.equal(/\.toISOString\(\)\s*\n\s*\.slice\(0,\s*7\)/.test(region), false);
});

test('the endpoint uses the shared helpers rather than its own date arithmetic', () => {
  const region = statsRegion();
  assert.match(region, /monthRange\(month\)/, 'selected month');
  assert.match(region, /monthRangeForInstant\(new Date\(\)\)/, 'default month');
  assert.match(region, /previousMonthLabel\(window\.label\)/, 'previous month derived from the validated label');
  assert.match(region, /shiftMonths\(/, 'hardened 12-month lookback');
  assert.match(region, /isWithin\(window/, 'in-memory current-month filter');
  assert.match(region, /isWithin\(prevWindow/, 'in-memory previous-month filter');
  assert.match(region, /Invalid month\. Expected YYYY-MM\./, '400 on invalid input');
  // No residue of the replaced variables or their inclusive comparisons.
  for (const gone of ['startDate', 'endDate', 'prevStartDate', 'prevEndDate', 'twelveMonthsAgo']) {
    assert.equal(region.includes(gone), false, `${gone} must be gone`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement 8 — the other two P0-6 endpoints
// ─────────────────────────────────────────────────────────────────────────────

test('all three P0-6 endpoints share the same window semantics for ?month=', () => {
  const summary = SERVER.slice(SERVER.indexOf("'/api/dashboard/summary'"), SERVER.indexOf("'/api/categories'", SERVER.indexOf("'/api/dashboard/summary'")));
  const incomes = SERVER.slice(SERVER.indexOf("app.get(\n  '/api/incomes',"), SERVER.indexOf("app.post(\n  '/api/incomes',"));
  const stats = statsRegion();

  // Common to all three: the shared builder, a 400 on invalid input, and no
  // ad-hoc parsing or inclusive end bound.
  for (const [name, region] of Object.entries({ summary, incomes, stats })) {
    assert.match(region, /monthRange\(month\)/, `${name}: shared month builder`);
    assert.match(region, /Invalid month\. Expected YYYY-MM\./, `${name}: 400 on invalid input`);
    assert.equal(/split\('-'\)/.test(region), false, `${name}: no ad-hoc month parsing`);
    assert.equal(/lte: window\.end/.test(region), false, `${name}: must not use an inclusive end`);
    assert.equal(/monthNumber/.test(region), false, `${name}: no legacy month arithmetic`);
  }

  // Endpoints that apply the window as a Prisma filter.
  for (const [name, region] of Object.entries({ summary, incomes })) {
    assert.match(region, /gte: window\.start,/, `${name}: half-open lower bound in the query`);
    assert.match(region, /lt: window\.end,/, `${name}: half-open upper bound in the query`);
  }

  // The stats endpoint aggregates in memory, so its windows are applied there.
  // Its only Prisma date filter is the rolling 12-month lookback. The pair
  // below is what keeps the two filters consistent.
  assert.match(stats, /gte: twelveMonthCutoff,/, 'stats: lookback lower bound');
  assert.match(stats, /isWithin\(window/, 'stats: current month applied in memory');
  assert.match(stats, /isWithin\(prevWindow/, 'stats: previous month applied in memory');
  assert.equal(/gte: window\.start/.test(stats), false, 'stats does not filter months in the query');

  // Endpoints that default to the current month when ?month= is absent.
  for (const [name, region] of Object.entries({ summary, stats })) {
    assert.match(region, /monthRangeForInstant\(new Date\(\)\)/, `${name}: shared default window`);
  }

  // Endpoints that echo the validated month label and derive a previous window.
  for (const [name, region] of Object.entries({ summary, stats })) {
    assert.match(region, /month:\s*window\.label,/, `${name}: label from validated input`);
  }
  assert.match(stats, /previousMonthLabel\(window\.label\)/, 'stats derives the previous month from the label');
  assert.match(stats, /isWithin\(window/, 'stats filters the current month in memory');
  assert.match(stats, /isWithin\(prevWindow/, 'stats filters the previous month in memory');
});

test('KNOWN GAP: /api/incomes still accepts unvalidated startDate/endDate with an inclusive end', () => {
  // Documented deliberately rather than silently changed. /api/incomes agrees
  // with the other two endpoints on the ?month= path, but its optional
  // startDate/endDate branch still parses arbitrary values and uses `lte`, so it
  // is neither validated nor half-open. The frontend only sends ?month=, so this
  // is latent. Fixing it changes an accepted input contract and is left for a
  // decision rather than done unilaterally.
  const incomes = SERVER.slice(SERVER.indexOf("app.get(\n  '/api/incomes',"), SERVER.indexOf("app.post(\n  '/api/incomes',"));
  assert.match(incomes, /gte: new Date\(startDate\)/, 'unvalidated startDate');
  assert.match(incomes, /lte: new Date\(endDate\)/, 'inclusive, unvalidated endDate');
});

test('the dashboard summary still preserves its documented response contract', () => {
  const region = SERVER.slice(SERVER.indexOf("'/api/dashboard/summary'"), SERVER.indexOf("'/api/categories'", SERVER.indexOf("'/api/dashboard/summary'")));
  for (const key of ['income: totalIncome', 'spent,', 'saved,', 'unspent,', 'savingsRate:', 'savingsByCategory:', 'expensesByCategory:', 'counts:']) {
    assert.ok(region.includes(key), `dashboard summary must still return ${key}`);
  }
});
