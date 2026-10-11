'use strict';

/**
 * P0-5 — REGRESSION EVIDENCE FOR THE RECURRING CLAIM MISMATCH
 *
 * This is the "demonstrate the defect first" artifact. It encodes the exact bug
 * that made three database-backed tests fail, and it does so WITHOUT a database
 * so it runs in the offline suite.
 *
 * The defect: `listDuePeriods()` normalises an occurrence to application-local
 * midnight, and the caller used that normalised value as the conditional claim's
 * WHERE key. When the stored `nextExecution` was not already at local midnight
 * (for example a UTC-midnight value written by older code, a seed, or an import),
 * the claim matched zero rows. Nothing was created, the rule never advanced, and
 * the scheduler reported success. On an IST host a stored
 * `2026-03-15T00:00:00.000Z` becomes a claim key of `2026-03-14T18:30:00.000Z`.
 *
 * The assertions below pin CURRENT behaviour. When the fix lands, the
 * "MISMATCH" test must be INVERTED to assert equality and this header updated.
 * The `todo` test states the property the fix must provide.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { listDuePeriods } = require('../../src/lib/schedule');

const iso = (d) => d.toISOString();

test('listDuePeriods returns the occurrence normalised to application-local midnight', () => {
  const stored = new Date('2026-03-15T00:00:00.000Z'); // UTC midnight
  const { periods } = listDuePeriods('MONTHLY', 15, null, stored, new Date('2026-10-11'));

  assert.equal(periods.length > 0, true, 'the rule is due, so a period is returned');
  // The returned instant is a CALENDAR date, not the stored instant.
  assert.notEqual(iso(periods[0]), iso(stored));
  assert.equal(periods[0].getTime() < stored.getTime(), true);
});

test('MISMATCH (current behaviour): the claim key differs from the stored timestamp', () => {
  const stored = new Date('2026-03-15T00:00:00.000Z');
  const { periods } = listDuePeriods('MONTHLY', 15, null, stored, new Date('2026-10-11'));

  // This inequality is the bug: updateMany({ where: { nextExecution: periods[0] } })
  // cannot match a row whose column still holds `stored`, so claim.count === 0.
  // The fix must make the claim key equal the stored value; invert this then.
  assert.notEqual(iso(periods[0]), iso(stored));
  process.stdout.write(`    stored=${iso(stored)} claimKey=${iso(periods[0])} -> claim.count would be 0\n`);
});

test('a local-midnight stored value ALREADY matches, which is why production looked fine', () => {
  // computeNextExecution writes local midnight, so freshly scheduled rules align
  // and the claim succeeds. The defect only bites non-conforming stored values.
  const localMidnight = new Date(2026, 2, 15);
  const { periods } = listDuePeriods('MONTHLY', 15, null, localMidnight, new Date('2026-10-11'));
  assert.equal(iso(periods[0]), iso(localMidnight));
});

test('the mismatch is not limited to MONTHLY', () => {
  for (const [freq, dom, dow] of [['WEEKLY', null, 1], ['YEARLY', null, null], ['DAILY', null, null]]) {
    const stored = new Date('2026-03-15T00:00:00.000Z');
    const { periods } = listDuePeriods(freq, dom, dow, stored, new Date('2026-10-11'));
    if (periods.length > 0) {
      assert.notEqual(iso(periods[0]), iso(stored), `${freq} must exhibit the same mismatch`);
    }
  }
});

test('TODO: the claim key must equal the exact stored timestamp', { todo: 'requires the P0-5 fix: claim against the exact stored nextExecution (and a separate calendar date for the expense), plus an explicit scheduling timezone instead of the host zone' }, () => {
  const stored = new Date('2026-03-15T00:00:00.000Z');
  const { periods } = listDuePeriods('MONTHLY', 15, null, stored, new Date('2026-10-11'));
  assert.equal(iso(periods[0]), iso(stored));
});

test('TODO: an explicit scheduling timezone, not the host machine zone', { todo: 'listDuePeriods/computeNextExecution currently use setHours/getDate, i.e. the host timezone; they must use the documented application offset so results cannot vary by deployment' }, () => {
  assert.equal(process.env.TZ !== undefined || true, true);
});
