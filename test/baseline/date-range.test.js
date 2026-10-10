'use strict';

/**
 * BASELINE CHARACTERIZATION — DATE RANGES
 * =======================================
 * Pins the current month-window parsing used by /api/dashboard/summary,
 * /api/merchants/stats and /api/incomes (three duplicated copies).
 *
 * Targets of P0-6. Assertions marked DEFECT must be inverted when P0-6 lands.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { legacyMonthRange, legacyMonthLabel } = require('../support/legacy-logic');
const { ymd, stamp, isValid } = require('../support/dates');

test('month window covers the whole requested month (correct today)', () => {
  const march = legacyMonthRange('2026-03');
  assert.equal(stamp(march.startDate), '2026-03-01T00:00:00.000');
  assert.equal(stamp(march.endDate), '2026-03-31T23:59:59.000');
});

test('month window handles February and leap February (correct today)', () => {
  assert.equal(stamp(legacyMonthRange('2026-02').endDate), '2026-02-28T23:59:59.000');
  assert.equal(stamp(legacyMonthRange('2024-02').endDate), '2024-02-29T23:59:59.000');
});

test('DEFECT P0-6: the last second of the month is only partly included', () => {
  const { endDate } = legacyMonthRange('2026-03');
  // endDate has milliseconds = 0, so [gte, lte] excludes .001-.999
  assert.equal(endDate.getMilliseconds(), 0);
  const inFinalMs = new Date(endDate.getTime() + 500); // 23:59:59.500
  assert.equal(inFinalMs <= endDate, false, 'rows in the final second are excluded');
});

test('DEFECT P0-6: the echoed month label is derived from toISOString and is TIMEZONE DEPENDENT', () => {
  const { startDate } = legacyMonthRange('2026-03');
  // Local midnight 2026-03-01 converted to UTC. East of UTC this lands on the
  // previous day, so slice(0,7) reports the PREVIOUS month.
  const offsetMin = startDate.getTimezoneOffset(); // -330 (IST), 0 (UTC), +300 (US East)
  const expected = offsetMin < 0 ? '2026-02' : '2026-03';
  assert.equal(legacyMonthLabel(startDate), expected);
  // Concretely on an IST host: asking for March returns "2026-02".
  if (offsetMin < 0) {
    assert.equal(legacyMonthLabel(startDate), '2026-02');
  }
});

test('DEFECT P0-6: no validation — a malformed month yields Invalid Date and a 500', () => {
  for (const bad of ['abc', '2026', '']) {
    if (bad === '') continue; // empty string is falsy -> treated as "no month"
    const { startDate } = legacyMonthRange(bad);
    assert.equal(isValid(startDate), false, `${bad} should be rejected with 400, not Invalid Date`);
    assert.throws(() => legacyMonthLabel(startDate), RangeError);
  }
});

test('DEFECT P0-6: out-of-range months silently roll over instead of erroring', () => {
  // "2024-13" does NOT span two months: it resolves to January 2025 and is
  // mislabelled as the previous month. (Corrected by direct execution — an
  // earlier review note claimed a two-month window; that was wrong.)
  const rolled = legacyMonthRange('2024-13');
  assert.equal(ymd(rolled.startDate), '2025-01-01');
  assert.equal(ymd(rolled.endDate), '2025-01-31');
  assert.equal(legacyMonthLabel(rolled.startDate), '2024-12');

  // month 00 rolls backwards to December of the previous year.
  const zero = legacyMonthRange('2026-00');
  assert.equal(ymd(zero.startDate), '2025-12-01');
  assert.equal(ymd(zero.endDate), '2025-12-31');
});

test('DEFECT P0-6: extra/missing segments are silently tolerated', () => {
  assert.equal(ymd(legacyMonthRange('2026-1').startDate), '2026-01-01');
  assert.equal(ymd(legacyMonthRange('2026-06-15').startDate), '2026-06-01');
});

test('no-month path uses the clock month (correct today)', () => {
  const range = legacyMonthRange(undefined, new Date(2026, 2, 15, 10, 30));
  assert.equal(stamp(range.startDate), '2026-03-01T00:00:00.000');
  assert.equal(stamp(range.endDate), '2026-03-31T23:59:59.000');
});
