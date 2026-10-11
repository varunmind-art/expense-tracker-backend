'use strict';

/**
 * P0-6B — validation and boundaries for the custom date range accepted by
 * `GET /api/incomes` (`?startDate=&endDate=`).
 *
 * The defect: the branch did `gte: new Date(startDate)` / `lte: new Date(endDate)`
 * with no validation. `new Date('2026-03-10')` is midnight, so an inclusive
 * user-facing end date silently excluded the entire end day, and any malformed
 * value became an Invalid Date that surfaced as a 500.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { rangeFromQueryParams, isWithin, appLocalDateString } = require('../../src/lib/dateRange');

const iso = (d) => d.toISOString();

test('no range parameters means no date filter', () => {
  for (const params of [{}, { startDate: undefined, endDate: undefined }, { startDate: '', endDate: null }]) {
    const result = rangeFromQueryParams(params);
    assert.equal(result.ok, true);
    assert.equal(result.dateFilter, null);
  }
});

test('a calendar start date begins at the start of that day', () => {
  const result = rangeFromQueryParams({ startDate: '2026-03-10' }, 0);
  assert.equal(result.ok, true);
  assert.equal(iso(result.dateFilter.gte), '2026-03-10T00:00:00.000Z');
  assert.equal('lt' in result.dateFilter, false);
});

test('a calendar END date includes the whole end day (the bug being fixed)', () => {
  const result = rangeFromQueryParams({ endDate: '2026-03-10' }, 0);
  assert.equal(result.ok, true);
  // The internal bound is the exclusive start of the NEXT day...
  assert.equal(iso(result.dateFilter.lt), '2026-03-11T00:00:00.000Z');
  assert.equal('lte' in result.dateFilter, false, 'must not use an inclusive bound');

  // ...so a record late on the end day is included rather than dropped.
  const window = { start: new Date('2000-01-01T00:00:00Z'), end: result.dateFilter.lt };
  assert.equal(isWithin(window, new Date('2026-03-10T23:59:59.999Z')), true);
});

test('both calendar bounds produce a half-open window', () => {
  const result = rangeFromQueryParams({ startDate: '2026-03-01', endDate: '2026-03-31' }, 0);
  assert.equal(result.ok, true);
  assert.equal(iso(result.dateFilter.gte), '2026-03-01T00:00:00.000Z');
  assert.equal(iso(result.dateFilter.lt), '2026-04-01T00:00:00.000Z');
});

test('month and year boundaries convert correctly', () => {
  assert.equal(iso(rangeFromQueryParams({ endDate: '2026-01-31' }, 0).dateFilter.lt), '2026-02-01T00:00:00.000Z');
  assert.equal(iso(rangeFromQueryParams({ endDate: '2026-12-31' }, 0).dateFilter.lt), '2027-01-01T00:00:00.000Z');
  assert.equal(iso(rangeFromQueryParams({ endDate: '2026-02-28' }, 0).dateFilter.lt), '2026-03-01T00:00:00.000Z');
});

test('leap years are handled, including 29 February', () => {
  assert.equal(iso(rangeFromQueryParams({ endDate: '2024-02-29' }, 0).dateFilter.lt), '2024-03-01T00:00:00.000Z');
  assert.equal(iso(rangeFromQueryParams({ endDate: '2024-02-28' }, 0).dateFilter.lt), '2024-02-29T00:00:00.000Z');
  // 2026 is not a leap year, so 29 February does not exist.
  assert.equal(rangeFromQueryParams({ endDate: '2026-02-29' }, 0).ok, false);
});

test('timezone-aware: the end day is measured in application-local time', () => {
  // IST end date 2026-03-10 -> exclusive bound is 2026-03-10T18:30:00Z.
  const result = rangeFromQueryParams({ endDate: '2026-03-10' }, 330);
  assert.equal(iso(result.dateFilter.lt), '2026-03-10T18:30:00.000Z');
  // A record at 2026-03-10T18:29:59.999Z (23:59:59.999 IST) is still included.
  const window = { start: new Date('2000-01-01T00:00:00Z'), end: result.dateFilter.lt };
  assert.equal(isWithin(window, new Date('2026-03-10T18:29:59.999Z')), true);
  assert.equal(isWithin(window, new Date('2026-03-10T18:30:00.000Z')), false);
  assert.equal(appLocalDateString(new Date('2026-03-10T18:29:59.999Z')), '2026-03-10');
});

test('malformed and impossible values are rejected rather than becoming a 500', () => {
  for (const bad of ['abc', '2026-13-01', '2026-00-10', '2026-02-30', 'not-a-date', '2026/03/10']) {
    assert.equal(rangeFromQueryParams({ endDate: bad }, 0).ok, false, `endDate ${bad}`);
    assert.equal(rangeFromQueryParams({ startDate: bad }, 0).ok, false, `startDate ${bad}`);
  }
  const result = rangeFromQueryParams({ endDate: 'abc' }, 0);
  assert.match(result.error, /Invalid endDate/);
  assert.match(rangeFromQueryParams({ startDate: 'abc' }, 0).error, /Invalid startDate/);
});

test('an empty or inverted range is rejected', () => {
  assert.equal(rangeFromQueryParams({ startDate: '2026-03-10', endDate: '2026-03-01' }, 0).ok, false);
  assert.equal(rangeFromQueryParams({ startDate: '2026-03-10', endDate: '2026-03-10' }, 0).ok, true, 'a single day is valid');
  const inverted = rangeFromQueryParams({ startDate: '2026-03-10', endDate: '2026-03-01' }, 0);
  assert.match(inverted.error, /must not be before/);
});

test('a full ISO instant keeps its existing inclusive meaning (backward compatible)', () => {
  const result = rangeFromQueryParams({ startDate: '2026-03-01T00:00:00.000Z', endDate: '2026-03-31T23:59:59.000Z' }, 0);
  assert.equal(result.ok, true);
  assert.equal(iso(result.dateFilter.gte), '2026-03-01T00:00:00.000Z');
  // An exact instant is an exact instant, so the bound stays inclusive: this is
  // the documented previous meaning for instant-based callers.
  assert.equal(iso(result.dateFilter.lte), '2026-03-31T23:59:59.000Z');
  assert.equal('lt' in result.dateFilter, false);
});

test('an ISO instant combined with a calendar day is still coherent', () => {
  const result = rangeFromQueryParams({ startDate: '2026-03-01T00:00:00.000Z', endDate: '2026-03-31' }, 0);
  assert.equal(result.ok, true);
  assert.equal(iso(result.dateFilter.gte), '2026-03-01T00:00:00.000Z');
  assert.equal(iso(result.dateFilter.lt), '2026-04-01T00:00:00.000Z');
});
