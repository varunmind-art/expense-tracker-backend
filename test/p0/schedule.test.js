'use strict';

/**
 * P0-5 / P0-4 SPEC SUITE — corrected recurring schedule arithmetic.
 *
 * These assert the INTENDED behaviour and are the "after" half of the
 * before/after report. The "before" behaviour is frozen in
 * test/baseline/scheduling.test.js, which still passes because it pins a verbatim
 * copy of the replaced code (test/support/legacy-logic.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  FREQUENCIES,
  MAX_CATCH_UP_PERIODS,
  isSupportedFrequency,
  daysInMonth,
  normaliseDayOfMonth,
  normaliseDayOfWeek,
  computeNextExecution,
  listDuePeriods,
  periodKey,
} = require('../../src/lib/schedule');
const { ymd } = require('../support/dates');

const next = (freq, dom, dow, from) => computeNextExecution(freq, dom, dow, from);

// ─────────────────────────────────────────────────────────────────────────────
// P0-5 — month-end and leap-year correctness
// ─────────────────────────────────────────────────────────────────────────────

test('MONTHLY lands in the NEXT month, never skipping it (the original bug)', () => {
  assert.equal(ymd(next('MONTHLY', 31, null, new Date(2026, 0, 31))), '2026-02-28');
  assert.equal(ymd(next('MONTHLY', 30, null, new Date(2026, 0, 31))), '2026-02-28');
  assert.equal(ymd(next('MONTHLY', 29, null, new Date(2026, 0, 31))), '2026-02-28');
  assert.equal(ymd(next('MONTHLY', 15, null, new Date(2026, 0, 31))), '2026-02-15');
  assert.equal(ymd(next('MONTHLY', 1, null, new Date(2026, 0, 31))), '2026-02-01');
  assert.equal(ymd(next('MONTHLY', 5, null, new Date(2026, 0, 31))), '2026-02-05');
});

test('MONTHLY clamps to the target month and skips no month, for all 31 days', () => {
  const from = new Date(2026, 0, 31);
  const results = [];
  for (let dom = 1; dom <= 31; dom += 1) {
    const got = next('MONTHLY', dom, null, from);
    assert.equal(got.getMonth(), 1, `day ${dom} must land in February`);
    assert.equal(got.getFullYear(), 2026);
    results.push(ymd(got));
  }
  // Days 29,30,31 all clamp to the last day of February.
  assert.equal(results[28], '2026-02-28');
  assert.equal(results[29], '2026-02-28');
  assert.equal(results[30], '2026-02-28');
  assert.equal(results[0], '2026-02-01');
});

test('MONTHLY is leap-year aware', () => {
  assert.equal(ymd(next('MONTHLY', 31, null, new Date(2024, 0, 31))), '2024-02-29');
  assert.equal(ymd(next('MONTHLY', 31, null, new Date(2028, 0, 31))), '2028-02-29');
  assert.equal(ymd(next('MONTHLY', 29, null, new Date(2024, 1, 29))), '2024-03-29');
});

test('MONTHLY across 30-day and 31-day boundaries', () => {
  assert.equal(ymd(next('MONTHLY', 31, null, new Date(2026, 2, 31))), '2026-04-30');
  assert.equal(ymd(next('MONTHLY', 31, null, new Date(2026, 3, 30))), '2026-05-31');
  assert.equal(ymd(next('MONTHLY', 31, null, new Date(2026, 10, 30))), '2026-12-31');
  assert.equal(ymd(next('MONTHLY', 15, null, new Date(2026, 11, 15))), '2027-01-15');
});

test('MONTHLY without a dayOfMonth uses the current day, clamped', () => {
  assert.equal(ymd(next('MONTHLY', null, null, new Date(2026, 0, 31))), '2026-02-28');
  assert.equal(ymd(next('MONTHLY', undefined, null, new Date(2026, 0, 15))), '2026-02-15');
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-5 — weekly weekday calculations
// ─────────────────────────────────────────────────────────────────────────────

test('WEEKLY honours dayOfWeek (the cron used to ignore it entirely)', () => {
  const wed = new Date(2026, 0, 7);
  assert.equal(wed.getDay(), 3, 'fixture sanity');
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((dow) => ymd(next('WEEKLY', null, dow, wed))),
    ['2026-01-11', '2026-01-12', '2026-01-13', '2026-01-14', '2026-01-08', '2026-01-09', '2026-01-10']
  );
});

test('WEEKLY advances to the same weekday, always strictly in the future', () => {
  // From the target weekday itself, move a full week rather than staying put.
  const sunday = new Date(2026, 0, 11);
  assert.equal(sunday.getDay(), 0);
  assert.equal(ymd(next('WEEKLY', null, 0, sunday)), '2026-01-18');

  // Repeated advancement always moves forward by 7 days.
  let cursor = new Date(2026, 0, 5); // Monday
  for (let i = 0; i < 5; i += 1) {
    const advanced = next('WEEKLY', null, 1, cursor);
    assert.equal(advanced.getDay(), 1, 'must stay on Monday');
    assert.equal(Math.round((advanced - cursor) / 86400000), 7);
    cursor = advanced;
  }
});

test('DAILY and YEARLY advance by exactly one period', () => {
  assert.equal(ymd(next('DAILY', null, null, new Date(2026, 0, 31))), '2026-02-01');
  assert.equal(ymd(next('YEARLY', null, null, new Date(2026, 0, 31))), '2027-01-31');
  assert.equal(ymd(next('YEARLY', null, null, new Date(2024, 2, 15))), '2025-03-15');
});

test('YEARLY clamps 29 February in a non-leap target year', () => {
  assert.equal(ymd(next('YEARLY', null, null, new Date(2024, 1, 29))), '2025-02-28');
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-4 — unsupported frequency is REJECTED, never treated as "now"
// ─────────────────────────────────────────────────────────────────────────────

test('an unsupported frequency returns null, not the input date', () => {
  // The old fall-through returned `now`, so nextExecution stayed <= today and
  // the cron re-selected the rule on every run, duplicating the expense forever.
  for (const bad of ['MONTHLYY', 'monthly', 'Monthly', '', ' ', null, undefined, 0, 7, {}, []]) {
    assert.equal(next(bad, 15, null, new Date(2026, 6, 15)), null, `frequency ${JSON.stringify(bad)}`);
  }
});

test('isSupportedFrequency accepts exactly the four documented values', () => {
  assert.deepEqual(FREQUENCIES, ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
  for (const ok of FREQUENCIES) assert.equal(isSupportedFrequency(ok), true);
  for (const bad of ['monthly', 'Monthly', 'MONTHLY ', ' MONTHLY', 'WEEKLYY', 'BIWEEKLY', '', null, undefined, 1, {}]) {
    assert.equal(isSupportedFrequency(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('an invalid input date is rejected rather than silently advancing', () => {
  assert.equal(next('MONTHLY', 15, null, new Date('nonsense')), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-5 — catch-up policy
// ─────────────────────────────────────────────────────────────────────────────

test('catch-up materialises every missed period, oldest first', () => {
  // Due 2026-01-15; the job did not run until 2026-04-10.
  const result = listDuePeriods('MONTHLY', 15, null, new Date(2026, 0, 15), new Date(2026, 3, 10));
  assert.deepEqual(result.periods.map(ymd), ['2026-01-15', '2026-02-15', '2026-03-15']);
  assert.equal(result.hasMore, false);
  assert.equal(result.invalid, false);
});

test('catch-up is capped and reports that more periods remain', () => {
  const result = listDuePeriods('DAILY', null, null, new Date(2026, 0, 1), new Date(2026, 2, 1), 5);
  assert.equal(result.periods.length, 5);
  assert.equal(ymd(result.periods[0]), '2026-01-01');
  assert.equal(ymd(result.periods[4]), '2026-01-05');
  assert.equal(result.hasMore, true, 'the caller must be told the rule is further behind than the cap');
});

test('catch-up does nothing when the rule is not yet due', () => {
  const result = listDuePeriods('MONTHLY', 15, null, new Date(2026, 5, 15), new Date(2026, 4, 1));
  assert.deepEqual(result.periods, []);
  assert.equal(result.hasMore, false);
  assert.equal(result.invalid, false);
});

test('catch-up includes a period due exactly today, and stops there', () => {
  const result = listDuePeriods('MONTHLY', 10, null, new Date(2026, 0, 10), new Date(2026, 1, 10));
  assert.deepEqual(result.periods.map(ymd), ['2026-01-10', '2026-02-10']);
});

test('catch-up flags an unsupported frequency instead of generating rows', () => {
  const result = listDuePeriods('MONTHLYY', 15, null, new Date(2026, 0, 15), new Date(2026, 3, 10));
  assert.deepEqual(result.periods, []);
  assert.equal(result.invalid, true);
});

test('the cap defaults to the documented policy constant', () => {
  assert.equal(MAX_CATCH_UP_PERIODS, 12);
  const result = listDuePeriods('DAILY', null, null, new Date(2026, 0, 1), new Date(2026, 5, 1));
  assert.equal(result.periods.length, MAX_CATCH_UP_PERIODS);
  assert.equal(result.hasMore, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency key + input normalisation
// ─────────────────────────────────────────────────────────────────────────────

test('periodKey is a stable, zero-padded, collision-free key', () => {
  assert.equal(periodKey(new Date(2026, 1, 8)), '2026-02-08');
  assert.equal(periodKey(new Date(2026, 10, 30)), '2026-11-30');
  assert.notEqual(periodKey(new Date(2026, 1, 8)), periodKey(new Date(2026, 1, 9)));
  assert.notEqual(periodKey(new Date(2026, 1, 8)), periodKey(new Date(2027, 1, 8)));
});

test('day-of-month and weekday normalisation reject out-of-range input', () => {
  assert.equal(normaliseDayOfMonth(15), 15);
  assert.equal(normaliseDayOfMonth('31'), 31);
  for (const bad of [0, 32, 99, -1, 'abc', null, undefined, '']) {
    assert.equal(normaliseDayOfMonth(bad), null, `dayOfMonth ${JSON.stringify(bad)}`);
  }
  assert.equal(normaliseDayOfWeek(0), 0);
  assert.equal(normaliseDayOfWeek('6'), 6);
  for (const bad of [7, -1, 42, 'abc', null, undefined, '']) {
    assert.equal(normaliseDayOfWeek(bad), null, `dayOfWeek ${JSON.stringify(bad)}`);
  }
});

test('daysInMonth is correct including leap years', () => {
  assert.equal(daysInMonth(2026, 0), 31);
  assert.equal(daysInMonth(2026, 1), 28);
  assert.equal(daysInMonth(2024, 1), 29);
  assert.equal(daysInMonth(2026, 3), 30);
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-5 — the duplicate implementation must be gone
// ─────────────────────────────────────────────────────────────────────────────

test('src/server.js no longer contains its own scheduling implementation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
  // The inline copy used to live in the cron and disagreed with the helper.
  assert.equal(
    /nextExec\.(setDate|setMonth|setFullYear)\(/.test(source),
    false,
    'the cron must delegate to src/lib/schedule.js, not reschedule inline'
  );
  assert.equal(/const computeNextExecution =/.test(source), false, 'the local copy must be removed');
  assert.match(source, /require\('\.\/lib\/schedule'\)/, 'server.js must import the shared module');
});

test('both recurring-rule write paths validate the frequency against the same allowlist', () => {
  // P0-4: POST validated while PUT did not, which is how an unsupported value
  // reached the scheduler. A source-level guard keeps the two in step.
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
  const occurrences = (source.match(/isSupportedFrequency\(/g) || []).length;
  assert.ok(occurrences >= 2, `expected the allowlist in both POST and PUT, found ${occurrences}`);
  assert.match(source, /error:\s*'Invalid frequency\.'/, 'the rejection message must be consistent');
});
