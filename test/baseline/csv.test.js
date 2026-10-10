'use strict';

/**
 * BASELINE CHARACTERIZATION — CSV EXPORT
 * ======================================
 * Pins the current /api/export/csv line builder. Targets of P0-6 / P1.
 * Assertions marked DEFECT must be inverted when the escaping is fixed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { legacyCsvForExpenses } = require('../support/legacy-logic');

const row = (over = {}) => ({
  date: new Date(2026, 2, 15),
  type: 'EXPENSE',
  category: { name: 'Food & Dining' },
  merchant: 'Swiggy',
  amount: '450.00',
  note: 'lunch',
  receiptUrl: '',
  ...over,
});

const dataLines = (csv) => csv.trimEnd().split('\n').slice(1);

test('header is emitted and a clean row produces exactly 7 columns (correct today)', () => {
  const csv = legacyCsvForExpenses([row()]);
  assert.ok(csv.startsWith('Date,Type,Category,Merchant,Amount,Note,Receipt\n'));
  assert.equal(dataLines(csv).length, 1);
  assert.equal(dataLines(csv)[0].split(',').length, 7);
});

test('DEFECT: commas are silently rewritten to semicolons, mutating user data', () => {
  const csv = legacyCsvForExpenses([row({ note: 'lunch, with team' })]);
  assert.ok(csv.includes('lunch; with team'));
  assert.ok(!csv.includes('lunch, with team'), 'the user original comma is destroyed');
});

test('DEFECT: a comma in the CATEGORY name injects an extra column (8 fields)', () => {
  const csv = legacyCsvForExpenses([row({ category: { name: 'Food, Dining' }, merchant: 'X' })]);
  const line = dataLines(csv)[0];
  // category is not sanitised at all, so the row gains a field and every
  // following column shifts.
  assert.equal(line.split(',').length, 8);
  assert.ok(line.includes('EXPENSE,Food, Dining,X'));
});

test('DEFECT: a newline in a note splits one expense into two CSV rows', () => {
  const csv = legacyCsvForExpenses([row({ note: 'multi\nline note' })]);
  assert.equal(dataLines(csv).length, 2, 'one expense became two rows');
});

test('DEFECT: a double quote in a note is not escaped', () => {
  const csv = legacyCsvForExpenses([row({ note: 'quote " inside' })]);
  assert.ok(csv.includes('quote " inside'), 'quote passes through untouched');
});

test('DEFECT: CSV formula injection — leading = / + / - / @ are not neutralised', () => {
  for (const payload of ["=cmd|'/c calc'!A1", '+1+1', '-2+3', '@SUM(1)']) {
    const csv = legacyCsvForExpenses([row({ merchant: payload })]);
    assert.ok(
      csv.includes(payload),
      `payload ${payload} must be neutralised but passes through verbatim`
    );
  }
});

test('DEFECT: a null category throws instead of degrading gracefully', () => {
  assert.throws(
    () => legacyCsvForExpenses([row({ category: null })]),
    TypeError,
    'orphaned rows would 500 the whole export'
  );
});

test('DEFECT (TZ): dates of locally-stored rows can be exported one day early', () => {
  // The cron stores `today` at local midnight (server.js:3717-3724) and the
  // export formats with toISOString(). East of UTC that shifts the date back.
  const localMidnight = new Date(2026, 2, 15);
  const offsetMin = localMidnight.getTimezoneOffset();
  const expected = offsetMin < 0 ? '2026-03-14' : '2026-03-15';
  const csv = legacyCsvForExpenses([row({ date: localMidnight })]);
  assert.equal(dataLines(csv)[0].split(',')[0], expected);
  if (offsetMin < 0) {
    assert.equal(dataLines(csv)[0].split(',')[0], '2026-03-14');
  }
});

test('a UTC-midnight row (the normal create path) exports the correct date', () => {
  // The UI sends "YYYY-MM-DD", which parses as UTC midnight.
  const utcMidnight = new Date('2026-03-15');
  const csv = legacyCsvForExpenses([row({ date: utcMidnight })]);
  assert.equal(dataLines(csv)[0].split(',')[0], '2026-03-15');
});
