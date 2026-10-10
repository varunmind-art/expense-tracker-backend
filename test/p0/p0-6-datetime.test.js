'use strict';

/**
 * P0-6 SPEC SUITE — date windows, timezone stability and CSV safety.
 * Deterministic: every assertion uses explicit instants or a fixed offset, so
 * results do not depend on the host timezone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  APP_UTC_OFFSET_MINUTES,
  parseMonth,
  parseDate,
  monthRange,
  monthRangeForInstant,
  weekRange,
  customRange,
  appLocalDateString,
} = require('../../src/lib/dateRange');
const { escapeCsvField, toCsvRow, buildExpenseCsv, EXPENSE_CSV_HEADER } = require('../../src/lib/csv');

const iso = (d) => d.toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Strict validation — the old code 500'd on garbage and rolled months over
// ─────────────────────────────────────────────────────────────────────────────

test('parseMonth accepts only a real YYYY-MM', () => {
  assert.deepEqual(parseMonth('2026-03'), { year: 2026, monthIndex: 2 });
  assert.deepEqual(parseMonth('2024-02'), { year: 2024, monthIndex: 1 });
  assert.deepEqual(parseMonth(' 2026-03 '), { year: 2026, monthIndex: 2 });
});

test('parseMonth rejects garbage and out-of-range months instead of guessing', () => {
  // Each of these previously produced Invalid Date (-> 500) or a silent
  // rollover into a different month.
  for (const bad of ['abc', '2026', '2026-1', '2026-13', '2026-00', '2026-06-15', '', '  ', null, undefined, 202603, {}, []]) {
    assert.equal(parseMonth(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

test('parseDate rejects impossible calendar dates, including leap handling', () => {
  assert.deepEqual(parseDate('2026-03-15'), { year: 2026, monthIndex: 2, day: 15 });
  assert.deepEqual(parseDate('2024-02-29'), { year: 2024, monthIndex: 1, day: 29 });
  assert.equal(parseDate('2026-02-29'), null, '2026 is not a leap year');
  for (const bad of ['2026-04-31', '2026-13-01', '2026-00-10', '2026-1-1', 'not-a-date', '', null]) {
    assert.equal(parseDate(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Windows are half-open, so no boundary instant is lost or double counted
// ─────────────────────────────────────────────────────────────────────────────

test('monthRange is a half-open window in application-local time', () => {
  const march = monthRange('2026-03');
  // IST midnight = 18:30 UTC on the previous day.
  assert.equal(iso(march.start), '2026-02-28T18:30:00.000Z');
  assert.equal(iso(march.end), '2026-03-31T18:30:00.000Z'); // 1 April 00:00 IST
  assert.equal(march.label, '2026-03');
});

test('the final millisecond of a month is included (the old end-of-month bug)', () => {
  const march = monthRange('2026-03');
  const lastMoment = new Date(march.end.getTime() - 1); // 23:59:59.999 local
  assert.ok(lastMoment >= march.start && lastMoment < march.end, 'last instant belongs to March');
  // The old window ended at 23:59:59.000 and excluded .001-.999.
  const oldEnd = new Date('2026-03-31T23:59:59.000+05:30');
  assert.ok(new Date(oldEnd.getTime() + 500) < march.end, 'and is now captured');
  assert.equal(appLocalDateString(lastMoment), '2026-03-31');
});

test('the month label is the requested month, never a UTC re-derivation', () => {
  // The old code did startDate.toISOString().slice(0,7), which on an IST host
  // reported "2026-02" for ?month=2026-03. The label is now the input.
  for (const month of ['2026-01', '2026-03', '2026-12', '2024-02']) {
    assert.equal(monthRange(month).label, month);
  }
});

test('boundaries are stable regardless of host timezone', () => {
  // The functions take an explicit offset, so the result cannot drift with TZ.
  const ist = monthRange('2026-03', 330);
  const utc = monthRange('2026-03', 0);
  assert.equal(ist.label, utc.label);
  assert.notEqual(iso(ist.start), iso(utc.start), 'a different offset is a different instant');
  assert.equal(iso(utc.start), '2026-03-01T00:00:00.000Z');
});

test('February windows, including a leap year', () => {
  assert.equal(iso(monthRange('2026-02', 0).end), '2026-03-01T00:00:00.000Z');
  assert.equal(appLocalDateString(new Date(monthRange('2026-02', 330).end.getTime() - 1)), '2026-02-28');
  assert.equal(appLocalDateString(new Date(monthRange('2024-02', 330).end.getTime() - 1)), '2024-02-29');
});

test('December rolls to the next January correctly', () => {
  const dec = monthRange('2026-12', 0);
  assert.equal(iso(dec.start), '2026-12-01T00:00:00.000Z');
  assert.equal(iso(dec.end), '2027-01-01T00:00:00.000Z');
});

test('monthRangeForInstant uses the application-local month', () => {
  // 2026-03-31T20:00Z is already 2026-04-01 01:30 IST, so it belongs to April.
  assert.equal(monthRangeForInstant(new Date('2026-03-31T20:00:00Z')).label, '2026-04');
  assert.equal(monthRangeForInstant(new Date('2026-03-31T10:00:00Z')).label, '2026-03');
});

test('an invalid month yields null so the caller can answer 400', () => {
  for (const bad of ['abc', '2026-13', null, undefined]) {
    assert.equal(monthRange(bad), null);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Week and custom ranges
// ─────────────────────────────────────────────────────────────────────────────

test('weekRange is Monday-based and exactly seven days', () => {
  // 2026-03-15 is a Sunday, so its week starts Monday 2026-03-09.
  const week = weekRange('2026-03-15', 0);
  assert.equal(iso(week.start), '2026-03-09T00:00:00.000Z');
  assert.equal(iso(week.end), '2026-03-16T00:00:00.000Z');
  // A Monday starts its own week.
  assert.equal(iso(weekRange('2026-03-09', 0).start), '2026-03-09T00:00:00.000Z');
  // An invalid date is rejected.
  assert.equal(weekRange('2026-02-30'), null);
});

test('customRange spans the whole end day and rejects inverted or invalid input', () => {
  const range = customRange('2026-03-01', '2026-03-10', 0);
  assert.equal(iso(range.start), '2026-03-01T00:00:00.000Z');
  assert.equal(iso(range.end), '2026-03-11T00:00:00.000Z', 'end is exclusive, covering the 10th');
  assert.equal(range.label, '2026-03-01..2026-03-10');
  assert.equal(customRange('2026-03-10', '2026-03-01'), null);
  assert.equal(customRange('bad', '2026-03-01'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// CSV safety
// ─────────────────────────────────────────────────────────────────────────────

test('CSV formula injection is neutralised for every risky prefix', () => {
  for (const payload of ["=cmd|'/c calc'!A1", '+1+1', '-2+3', '@SUM(A1)', '\tTAB', '\rCR']) {
    const escaped = escapeCsvField(payload);
    // The guard prefixes a single quote. A value that also needs quoting (CR,
    // LF, comma, quote) is additionally wrapped, so assert on the neutralising
    // prefix rather than on the first character of the field.
    assert.ok(
      escaped.includes(`'${payload}`),
      `${JSON.stringify(payload)} must be prefixed; got ${JSON.stringify(escaped)}`
    );
    assert.ok(escaped.includes(payload), 'the original text is preserved for the user');
  }
});

test('ordinary values are not quoted or altered', () => {
  assert.equal(escapeCsvField('Swiggy'), 'Swiggy');
  assert.equal(escapeCsvField('lunch, with team'), '"lunch, with team"', 'commas are preserved, not replaced');
  assert.equal(escapeCsvField(null), '');
  assert.equal(escapeCsvField(undefined), '');
  assert.equal(escapeCsvField(0), '0');
});

test('quotes and newlines are escaped per RFC 4180', () => {
  assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvField('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCsvField('crlf\r\nhere'), '"crlf\r\nhere"');
});

/** Count CSV fields the way a parser would: commas outside quotes delimit. */
const countFields = (row) => {
  let fields = 1;
  let inQuotes = false;
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i];
    if (char === '"') {
      if (inQuotes && row[i + 1] === '"') {
        i += 1; // escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields += 1;
    }
  }
  return fields;
};

test('a row always has exactly the header column count', () => {
  const row = toCsvRow(['2026-03-15', 'EXPENSE', 'Food, Dining', 'X', '10.00', 'note\nwith break', '']);
  assert.equal(countFields(row), EXPENSE_CSV_HEADER.length);
  assert.equal(countFields(row), 7);

  // A formula payload must not change the column count either.
  const injected = toCsvRow(['2026-03-15', 'EXPENSE', 'Food', "=cmd|'/c calc'!A1", '1', 'x,y', '']);
  assert.equal(countFields(injected), 7);
});

test('buildExpenseCsv survives a null category instead of throwing', () => {
  const csv = buildExpenseCsv(
    [{ date: new Date('2026-03-15T00:00:00Z'), type: 'EXPENSE', category: null, merchant: null, amount: '1.00', note: null, receiptUrl: null }],
    () => '2026-03-15'
  );
  assert.ok(csv.startsWith(EXPENSE_CSV_HEADER.join(',')));
  assert.ok(csv.includes('Uncategorized'));
  // The old builder threw a TypeError here and 500'd the whole export.
});

test('CSV dates use the application-local calendar day, not a UTC shift', () => {
  // The cron stores "today" at application-local midnight. Under the old
  // toISOString() formatting that exported as the PREVIOUS day on an IST host.
  const localMidnight = new Date(Date.UTC(2026, 2, 15) - APP_UTC_OFFSET_MINUTES * 60000);
  assert.equal(appLocalDateString(localMidnight), '2026-03-15');
  assert.equal(localMidnight.toISOString().slice(0, 10), '2026-03-14', 'this is what the old code emitted');
});

test('the export no longer replaces commas with semicolons', () => {
  const csv = buildExpenseCsv(
    [{ date: new Date('2026-03-15T00:00:00Z'), type: 'EXPENSE', category: { name: 'Food & Dining' }, merchant: 'S', amount: '1', note: 'coffee, tea', receiptUrl: '' }],
    () => '2026-03-15'
  );
  assert.ok(csv.includes('coffee, tea'), 'the user text is preserved');
  assert.equal(csv.includes('coffee; tea'), false, 'and not rewritten');
});

// ─────────────────────────────────────────────────────────────────────────────
// Wiring guards — the fix must actually be used, not merely available
// ─────────────────────────────────────────────────────────────────────────────

test('the CSV endpoint uses the safe builder and the old comma rewrite is gone', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'src', 'server.js'),
    'utf8'
  );
  assert.match(source, /buildExpenseCsv\(/, 'the endpoint must call the safe builder');
  assert.equal(
    /\.replace\(\s*\/,\/g,\s*';'\s*\)/.test(source),
    false,
    'the comma-to-semicolon rewrite must be removed'
  );
  assert.equal(
    /expense\.date\.toISOString\(\)\.split\('T'\)\[0\]/.test(source),
    false,
    'the CSV date must come from the timezone-aware formatter'
  );
});
