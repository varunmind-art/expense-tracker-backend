'use strict';

/**
 * P0-6 — CSV export safety.
 *
 * The previous builder replaced commas with semicolons and nothing else, which
 * caused three separate defects:
 *   1. Formula injection: a note or merchant beginning with = + - @ was written
 *      verbatim, so opening the export in Excel/Sheets executed it. Reachable
 *      through the Gmail import path, where the merchant string comes from an
 *      attacker-influenced email.
 *   2. Malformed rows: a newline split one expense into two rows; a quote
 *      shifted every following column. `category.name` was not sanitised at all.
 *   3. Silent data mutation: replacing "," with ";" destroyed the user's text.
 *
 * Proper RFC 4180 quoting plus a formula guard fixes all three, and the user's
 * data is preserved exactly.
 */

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Escape one CSV field.
 *
 * - null/undefined become an empty field
 * - a leading formula character is neutralised with a single quote, which
 *   spreadsheets display as part of the text rather than executing
 * - the field is quoted when it contains a quote, comma, CR or LF, and inner
 *   quotes are doubled (RFC 4180)
 */
const escapeCsvField = (value) => {
  if (value === null || value === undefined) {
    return '';
  }

  let text = String(value);

  if (FORMULA_PREFIX.test(text)) {
    text = `'${text}`;
  }

  if (/[",\r\n]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }

  return text;
};

/** One CSV record. */
const toCsvRow = (fields) => fields.map(escapeCsvField).join(',');

/** Header plus one row per record, CRLF terminated as RFC 4180 prefers. */
const toCsv = (header, rows) =>
  [toCsvRow(header), ...rows.map(toCsvRow)].join('\r\n') + '\r\n';

const EXPENSE_CSV_HEADER = ['Date', 'Type', 'Category', 'Merchant', 'Amount', 'Note', 'Receipt'];

/**
 * Build the expense export.
 *
 * `dateOf(expense)` must supply the calendar date string for a row; the caller
 * passes a timezone-aware formatter so auto-created rows (which are stored at
 * application-local midnight) no longer export one day early.
 */
const buildExpenseCsv = (expenses, dateOf) =>
  toCsv(
    EXPENSE_CSV_HEADER,
    expenses.map((expense) => [
      dateOf(expense),
      expense.type || 'EXPENSE',
      // Previously unsanitised: a comma in a category name injected a column.
      expense.category ? expense.category.name : 'Uncategorized',
      expense.merchant || '',
      expense.amount,
      expense.note || '',
      expense.receiptUrl || '',
    ])
  );

module.exports = {
  FORMULA_PREFIX,
  escapeCsvField,
  toCsvRow,
  toCsv,
  EXPENSE_CSV_HEADER,
  buildExpenseCsv,
};
