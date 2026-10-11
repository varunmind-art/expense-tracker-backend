'use strict';

/**
 * P0-5B — the scheduling core must not depend on the host machine's timezone.
 *
 * Before P0-5B, computeNextExecution/listDuePeriods used setHours, getDate,
 * setDate and setMonth, i.e. host-local operations, so the same rule could
 * resolve to a different calendar date on a developer machine (Asia/Kolkata) than
 * on Render (UTC), and a DST-transition zone could shift a civil day.
 *
 * The matrix below is evaluated in this process AND in child processes running
 * under several host timezones, including two with daylight-saving transitions
 * (one of them a 30-minute-DST zone). If any host-local getter ever returns, the
 * child outputs diverge and this test fails.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const S = require('../../src/lib/schedule');

const key = (date) => (date ? S.periodKey(date) : 'null');

/** The calendar-date matrix, computed with no reference to the host timezone. */
const matrix = () => {
  const out = [
    // MONTHLY on the 28th, 29th, 30th and 31st from a month end
    key(S.computeNextExecution('MONTHLY', 28, null, new Date('2026-01-31T00:00:00.000Z'))),
    key(S.computeNextExecution('MONTHLY', 29, null, new Date('2026-01-31T00:00:00.000Z'))),
    key(S.computeNextExecution('MONTHLY', 30, null, new Date('2026-01-31T00:00:00.000Z'))),
    key(S.computeNextExecution('MONTHLY', 31, null, new Date('2026-01-31T00:00:00.000Z'))),
    // February and leap-year transitions
    key(S.computeNextExecution('MONTHLY', 31, null, new Date('2024-01-31T00:00:00.000Z'))),
    key(S.computeNextExecution('MONTHLY', 29, null, new Date('2024-02-29T00:00:00.000Z'))),
    // WEEKLY for all seven weekdays from a Sunday
    ...[0, 1, 2, 3, 4, 5, 6].map((dow) =>
      key(S.computeNextExecution('WEEKLY', null, dow, new Date('2026-03-15T00:00:00.000Z')))
    ),
    // YEARLY spanning a leap day
    key(S.computeNextExecution('YEARLY', null, null, new Date('2024-02-29T00:00:00.000Z'))),
    // near midnight: the instant is late on 31 March UTC but 1 April in IST
    key(S.computeNextExecution('DAILY', null, null, new Date('2026-03-31T23:59:59.000Z'))),
    key(S.computeNextExecution('DAILY', null, null, new Date('2026-03-31T18:29:59.000Z'))),
    // several overdue occurrences, and the 12-per-run cap
    'due:' + S.listDuePeriods('MONTHLY', 15, null, new Date('2026-01-15T00:00:00.000Z'), new Date('2026-04-10T12:00:00.000Z')).periods.map(key).join(','),
    'none:' + S.listDuePeriods('MONTHLY', 15, null, new Date('2026-06-15T00:00:00.000Z'), new Date('2026-04-10T00:00:00.000Z')).periods.length,
    'cap:' + S.listDuePeriods('DAILY', null, null, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-03-01T00:00:00.000Z'), 12).periods.length,
  ];
  return out.join('|');
};

test('the scheduling matrix is stable across host timezones', () => {
  const inProcess = matrix();

  const script = `const S=require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'lib', 'schedule.js'))});
    const k=d=>d?S.periodKey(d):'null';
    const out=[
      k(S.computeNextExecution('MONTHLY',28,null,new Date('2026-01-31T00:00:00.000Z'))),
      k(S.computeNextExecution('MONTHLY',29,null,new Date('2026-01-31T00:00:00.000Z'))),
      k(S.computeNextExecution('MONTHLY',30,null,new Date('2026-01-31T00:00:00.000Z'))),
      k(S.computeNextExecution('MONTHLY',31,null,new Date('2026-01-31T00:00:00.000Z'))),
      k(S.computeNextExecution('MONTHLY',31,null,new Date('2024-01-31T00:00:00.000Z'))),
      k(S.computeNextExecution('MONTHLY',29,null,new Date('2024-02-29T00:00:00.000Z'))),
      ...[0,1,2,3,4,5,6].map(d=>k(S.computeNextExecution('WEEKLY',null,d,new Date('2026-03-15T00:00:00.000Z')))),
      k(S.computeNextExecution('YEARLY',null,null,new Date('2024-02-29T00:00:00.000Z'))),
      k(S.computeNextExecution('DAILY',null,null,new Date('2026-03-31T23:59:59.000Z'))),
      k(S.computeNextExecution('DAILY',null,null,new Date('2026-03-31T18:29:59.000Z'))),
      'due:'+S.listDuePeriods('MONTHLY',15,null,new Date('2026-01-15T00:00:00.000Z'),new Date('2026-04-10T12:00:00.000Z')).periods.map(k).join(','),
      'none:'+S.listDuePeriods('MONTHLY',15,null,new Date('2026-06-15T00:00:00.000Z'),new Date('2026-04-10T00:00:00.000Z')).periods.length,
      'cap:'+S.listDuePeriods('DAILY',null,null,new Date('2026-01-01T00:00:00.000Z'),new Date('2026-03-01T00:00:00.000Z'),12).periods.length,
    ];
    process.stdout.write(out.join('|'));`;

  // Two DST zones included: America/New_York (1h) and Australia/Lord_Howe (30m).
  for (const tz of ['UTC', 'Asia/Kolkata', 'America/New_York', 'Australia/Lord_Howe', 'Pacific/Chatham']) {
    const childOut = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    }).trim();
    assert.equal(childOut, inProcess, `scheduling must be identical under TZ=${tz}`);
  }
});

test('the application scheduling timezone is documented and fixed', () => {
  assert.equal(S.APP_UTC_OFFSET_MINUTES, 330, 'IST (UTC+05:30), matching src/lib/dateRange.js');
  assert.equal(typeof S.toCivil, 'function');
  assert.equal(typeof S.fromCivil, 'function');
});

test('no host-local time getter or setter is used in the scheduling core', () => {
  // Strip comments first: the module's own documentation explains the old
  // host-local calls (setHours, getDate, setDate, setMonth) by name, and that
  // prose must not be mistaken for live code.
  const source = require('node:fs')
    .readFileSync(path.join(__dirname, '..', '..', 'src', 'lib', 'schedule.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  for (const forbidden of ['setHours', 'getHours', 'setMinutes', 'getTimezoneOffset']) {
    assert.equal(source.includes(forbidden), false, `must not use ${forbidden}`);
  }
  // setDate/getDate/setMonth are only acceptable as UTC variants.
  assert.equal(/\.setDate\(/.test(source), false, 'must not use local setDate');
  assert.equal(/\.getDate\(/.test(source), false, 'must not use local getDate');
  assert.equal(/\.setMonth\(/.test(source), false, 'must not use local setMonth');
  assert.equal(/Date\.UTC\(/.test(source), true, 'civil arithmetic must go through Date.UTC');
});

test('near-midnight instants resolve to the intended application-local day', () => {
  // 2026-03-31T18:29:59Z is 2026-03-31 23:59:59 IST -> the next day is 1 April.
  assert.equal(key(S.computeNextExecution('DAILY', null, null, new Date('2026-03-31T18:29:59.000Z'))), '2026-04-01');
  // 2026-03-31T18:30:00Z is already 2026-04-01 00:00 IST -> the next day is 2 April.
  assert.equal(key(S.computeNextExecution('DAILY', null, null, new Date('2026-03-31T18:30:00.000Z'))), '2026-04-02');
});
