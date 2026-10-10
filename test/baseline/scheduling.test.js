'use strict';

/**
 * BASELINE CHARACTERIZATION — SCHEDULING
 * ======================================
 * These tests pin down what the CURRENT recurring-rule scheduling code does,
 * including its defects. They are intentionally GREEN today.
 *
 * Every value below was produced by running the real logic (see
 * test/support/legacy-logic.js, transcribed verbatim from src/server.js).
 *
 * When P0-4 / P0-5 land, the assertions marked "DEFECT" must be INVERTED to the
 * corrected expectation. That intentional diff is the evidence that scheduling
 * behaviour changed, and it feeds the required before/after report.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  legacyComputeNextExecution,
  legacyCronAdvance,
} = require('../support/legacy-logic');
const { ymd } = require('../support/dates');

const monthly = (dayOfMonth, now) =>
  ymd(legacyComputeNextExecution('MONTHLY', dayOfMonth, null, now));

// ─────────────────────────────────────────────────────────────────────────────
// The correct case: scheduling that already works and must not regress.
// ─────────────────────────────────────────────────────────────────────────────

test('MONTHLY mid-month is scheduled into the next month (correct today)', () => {
  assert.equal(monthly(15, new Date(2026, 0, 15)), '2026-02-15');
  assert.equal(monthly(1, new Date(2026, 5, 1)), '2026-07-01');
  assert.equal(monthly(10, new Date(2026, 2, 9)), '2026-04-10');
});

test('MONTHLY from a month-end that the target month can hold (correct today)', () => {
  // Feb 28 -> Mar 31 exists, so this happens to land correctly.
  assert.equal(monthly(31, new Date(2026, 1, 28)), '2026-03-31');
  // Apr 30 -> May 31 exists.
  assert.equal(monthly(31, new Date(2026, 3, 30)), '2026-05-31');
});

test('DAILY advances exactly one day, YEARLY exactly one year', () => {
  const now = new Date(2026, 0, 31);
  assert.equal(ymd(legacyComputeNextExecution('DAILY', null, null, now)), '2026-02-01');
  assert.equal(ymd(legacyComputeNextExecution('YEARLY', null, null, now)), '2027-01-31');
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT P0-5 — MONTHLY skips an entire month when the current day-of-month
// exceeds the number of days in the target month.
// Expected (fixed): clamp to the last day of the TARGET month.
// ─────────────────────────────────────────────────────────────────────────────

test('DEFECT P0-5: MONTHLY day 31 created on Jan 31 skips February entirely', () => {
  // Fixed behaviour must be 2026-02-28.
  assert.equal(monthly(31, new Date(2026, 0, 31)), '2026-03-31');
});

test('DEFECT P0-5: MONTHLY day 15 created on Jan 31 skips February entirely', () => {
  // Fixed behaviour must be 2026-02-15.
  assert.equal(monthly(15, new Date(2026, 0, 31)), '2026-03-15');
});

test('DEFECT P0-5: MONTHLY day 5 created on Jan 31 skips February entirely', () => {
  // Fixed behaviour must be 2026-02-05.
  assert.equal(monthly(5, new Date(2026, 0, 31)), '2026-03-05');
});

test('DEFECT P0-5: MONTHLY day 31 created on Mar 31 skips April entirely', () => {
  // Fixed behaviour must be 2026-04-30.
  assert.equal(monthly(31, new Date(2026, 2, 31)), '2026-05-31');
});

test('DEFECT P0-5: leap year — Feb 2024 is skipped for a day-31 rule', () => {
  // Fixed behaviour must be 2024-02-29.
  assert.equal(monthly(31, new Date(2024, 0, 31)), '2024-03-31');
});

test('DEFECT P0-5: leap day rule misses the following February', () => {
  // 2024-02-29 + day 29 -> target Mar 29 EXISTS, so this one is correct:
  assert.equal(monthly(29, new Date(2024, 1, 29)), '2024-03-29');
});

test('DEFECT P0-5: the whole month is skipped for EVERY day-of-month 1..31', () => {
  // From Jan 31, a MONTHLY rule should ALWAYS resolve into February.
  const now = new Date(2026, 0, 31);
  const skipped = [];
  for (let dom = 1; dom <= 31; dom += 1) {
    const got = monthly(dom, now);
    if (!got.startsWith('2026-02')) skipped.push(dom);
  }
  // Documents the blast radius: every single day-of-month value is affected.
  assert.equal(skipped.length, 31, `expected all 31 to skip Feb, skipped=${skipped.length}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT P0-4 — an unrecognised frequency falls through and returns `now`,
// leaving nextExecution <= today so the cron re-selects it forever.
// ─────────────────────────────────────────────────────────────────────────────

test('DEFECT P0-4: unknown frequency returns the clock unchanged (infinite refire)', () => {
  const today = new Date(2026, 6, 15);
  assert.equal(ymd(legacyComputeNextExecution('MONTHLYY', 15, null, today)), '2026-07-15');
  assert.equal(ymd(legacyCronAdvance(today, 'MONTHLYY', 15)), '2026-07-15');
  // The cron predicate is nextExecution <= today, so this row is re-selected.
  assert.ok(
    legacyComputeNextExecution('MONTHLYY', 15, null, today) <= today,
    'nextExecution must not remain <= today'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT P0-5 — the two scheduling implementations disagree.
// ─────────────────────────────────────────────────────────────────────────────

test('DEFECT P0-5: cron WEEKLY advance ignores dayOfWeek and diverges from the helper', () => {
  const wed = new Date(2026, 0, 7); // Wednesday
  assert.equal(wed.getDay(), 3, 'fixture sanity: 2026-01-07 is a Wednesday');

  const helperByDow = [0, 1, 2, 3, 4, 5, 6].map((dow) =>
    ymd(legacyComputeNextExecution('WEEKLY', null, dow, wed))
  );
  const cronByDow = [0, 1, 2, 3, 4, 5, 6].map(() =>
    ymd(legacyCronAdvance(wed, 'WEEKLY', null))
  );

  assert.deepEqual(helperByDow, [
    '2026-01-11', '2026-01-12', '2026-01-13', '2026-01-14',
    '2026-01-08', '2026-01-09', '2026-01-10',
  ]);
  // The cron returns the same date no matter which weekday was configured.
  assert.deepEqual(cronByDow, new Array(7).fill('2026-01-14'));
  assert.notDeepEqual(helperByDow, cronByDow);
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT P0-5 — cron advances from `today`, not from `nextExecution`, so a
// missed period is silently dropped rather than caught up.
// ─────────────────────────────────────────────────────────────────────────────

test('DEFECT P0-5: a long-overdue MONTHLY rule loses the missed periods', () => {
  // Rule was due 2026-01-15; the job did not run until 2026-04-10.
  const ranOn = new Date(2026, 3, 10);
  const next = ymd(legacyCronAdvance(ranOn, 'MONTHLY', 15));
  // One row is created, then rescheduled from the run date -> Feb and Mar lost.
  assert.equal(next, '2026-05-15');
});

// ─────────────────────────────────────────────────────────────────────────────
// Before/after evidence table (printed by `npm test`).
// Feeds the P0-5 "before/after report of affected recurring schedules".
// ─────────────────────────────────────────────────────────────────────────────

test('REPORT: MONTHLY before/after matrix (baseline only; "after" lands with P0-5)', (t) => {
  const rows = [];
  for (let dom = 1; dom <= 31; dom += 1) {
    const before = monthly(dom, new Date(2026, 0, 31));
    // Independently computed expectation for the corrected algorithm.
    const targetMonth = 1; // February 2026
    const daysInFeb2026 = new Date(2026, 2, 0).getDate(); // 28
    const after = `2026-02-${String(Math.min(dom, daysInFeb2026)).padStart(2, '0')}`;
    if (before !== after) rows.push({ dayOfMonth: dom, before, after });
  }
  t.diagnostic(`MONTHLY rules created 2026-01-31 that are mis-scheduled: ${rows.length}/31`);
  for (const r of rows.slice(0, 5)) {
    t.diagnostic(`  dayOfMonth=${r.dayOfMonth}  before=${r.before}  after=${r.after}`);
  }
  t.diagnostic('  ... (full matrix available via test/support/report-schedules.js)');
  assert.equal(rows.length, 31);
});
