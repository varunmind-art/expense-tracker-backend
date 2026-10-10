/**
 * BASELINE CHARACTERIZATION COPY — DO NOT "FIX" THIS FILE.
 * ========================================================
 * This module is a deliberate, faithful copy of the pure logic that currently
 * lives inside `src/server.js`. It exists so the baseline regression suite can
 * pin down TODAY'S behaviour (including its known defects) without importing
 * `src/server.js`, which has side effects on import (opens a port, connects to
 * Prisma, schedules a cron job and a 10s timer).
 *
 * Source of truth: expense-tracker-backend @ commit 5d1525f (branch main)
 *                   src/server.js, plus the uncommitted Accounts/Loans work
 *                   which does NOT touch any of the logic copied below
 *                   (verified: zero string literals removed, Prisma call sites
 *                    identical apart from prisma.account.*).
 *
 * The ONLY intentional deviation from the original is that the clock is
 * injectable (`nowIn`), so tests are deterministic. The algorithms themselves
 * are unchanged, defects included. Every defect is annotated with its planned
 * fix milestone (P0-4 / P0-5 / P0-6).
 *
 * When a milestone lands, the corresponding tests in test/baseline/ must be
 * updated deliberately — that diff IS the evidence that behaviour changed.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULING
// src/server.js:167-207  (computeNextExecution)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} frequency DAILY | WEEKLY | MONTHLY | YEARLY
 * @param {number|string|null} dayOfMonth
 * @param {number|string|null} dayOfWeek
 * @param {Date} nowIn test-only clock seam (defaults to the real clock)
 */
const legacyComputeNextExecution = (frequency, dayOfMonth, dayOfWeek, nowIn) => {
  const now = new Date(nowIn === undefined ? Date.now() : nowIn);
  now.setHours(0, 0, 0, 0);

  const next = new Date(now);

  if (frequency === 'DAILY') {
    next.setDate(now.getDate() + 1);
  } else if (frequency === 'WEEKLY') {
    const target =
      dayOfWeek !== null && dayOfWeek !== undefined
        ? parseInt(dayOfWeek)
        : now.getDay();

    const diff = (target - now.getDay() + 7) % 7;

    next.setDate(
      now.getDate() + (diff === 0 ? 7 : diff)
    );
  } else if (frequency === 'MONTHLY') {
    const targetDate = dayOfMonth
      ? parseInt(dayOfMonth)
      : now.getDate();

    // DEFECT P0-5: setMonth() normalises an overflowing day (e.g. Jan 31 ->
    // "Feb 31" -> Mar 3) BEFORE setDate() runs, so the target month is lost and
    // the guard below can never fire.
    next.setMonth(now.getMonth() + 1);
    next.setDate(targetDate);

    if (next.getDate() !== targetDate) {
      next.setDate(0);
    }
  } else if (frequency === 'YEARLY') {
    next.setFullYear(now.getFullYear() + 1);
  }
  // NOTE: no `else` — an unrecognised frequency returns `now` unchanged, which
  // leaves nextExecution <= today and makes the cron re-fire forever.
  // DEFECT P0-4.

  return next;
};

/**
 * The cron's own inline advance, which duplicates computeNextExecution with
 * different rules.
 * src/server.js:3797-3844 (inside processRecurringExpenses)
 */
const legacyCronAdvance = (today, frequency, dayOfMonth) => {
  const nextExec = new Date(today);

  if (frequency === 'DAILY') {
    nextExec.setDate(today.getDate() + 1);
  } else if (frequency === 'WEEKLY') {
    // Divergence P0-5: dayOfWeek is ignored here entirely.
    nextExec.setDate(today.getDate() + 7);
  } else if (frequency === 'MONTHLY') {
    nextExec.setMonth(today.getMonth() + 1);

    if (dayOfMonth) {
      nextExec.setDate(dayOfMonth);

      if (nextExec.getDate() !== dayOfMonth) {
        nextExec.setDate(0);
      }
    }
  } else if (frequency === 'YEARLY') {
    // Divergence P0-5: day/month fields ignored here entirely.
    nextExec.setFullYear(today.getFullYear() + 1);
  }

  return nextExec;
};

// ─────────────────────────────────────────────────────────────────────────────
// DATE RANGES
// src/server.js:2680-2717 (dashboard/summary) — the identical shape is
// duplicated at 1012-1046 (merchants/stats) and 2497-2531 (incomes).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string|undefined} month "YYYY-MM"
 * @param {Date} nowIn test-only clock seam
 */
const legacyMonthRange = (month, nowIn) => {
  let startDate;
  let endDate;

  if (month) {
    // DEFECT P0-6: no validation. "abc" -> NaN; "2024-13" silently rolls over.
    const [year, monthNumber] = month.split('-').map(Number);

    startDate = new Date(year, monthNumber - 1, 1);

    endDate = new Date(
      year,
      monthNumber,
      0,
      23,
      59,
      59
    );
  } else {
    const now = new Date(nowIn === undefined ? Date.now() : nowIn);

    startDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      1
    );

    endDate = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0,
      23,
      59,
      59
    );
  }

  return { startDate, endDate };
};

/** The month label echoed back to clients. src/server.js:2829-2832 */
const legacyMonthLabel = (startDate) =>
  startDate.toISOString().slice(0, 7);

// ─────────────────────────────────────────────────────────────────────────────
// CSV EXPORT
// src/server.js:882-906 (/api/export/csv)
// ─────────────────────────────────────────────────────────────────────────────

const legacyCsvForExpenses = (expenses, header) => {
  let csv =
    header === undefined
      ? 'Date,Type,Category,Merchant,Amount,Note,Receipt\n'
      : header;

  expenses.forEach((expense) => {
    // DEFECT P0-6/P1: only commas are sanitised. Quotes, newlines and leading
    // =/+/-/@ pass through untouched (CSV injection + broken rows).
    const merchant = (expense.merchant || '').replace(/,/g, ';');
    const note = (expense.note || '').replace(/,/g, ';');

    csv +=
      `${expense.date.toISOString().split('T')[0]},` +
      `${expense.type || 'EXPENSE'},` +
      // category is not sanitised at all, and would throw if category were null.
      `${expense.category.name},` +
      `${merchant},` +
      `${expense.amount},` +
      `${note},` +
      `${expense.receiptUrl || ''}\n`;
  });

  return csv;
};

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION PREDICATES / COERCIONS
// ─────────────────────────────────────────────────────────────────────────────

/** src/server.js:2573-2581 (POST /api/incomes) */
const legacyIncomeAmountGuard = (amount) =>
  !amount || parseFloat(amount) <= 0;

/** src/server.js:716-719 (POST /api/expenses) — coercion, not validation */
const legacyExpenseTypeCoerce = (type) =>
  type === 'SAVINGS' ? 'SAVINGS' : 'EXPENSE';

/** src/server.js:806-808 (PUT /api/expenses/:id) — no validation at all */
const legacyExpenseTypeOnUpdate = (type, current) =>
  type ? type : current;

/** src/server.js:3428-3440 (POST /api/recurring-rules) */
const legacyIsValidFrequency = (frequency) =>
  ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(frequency);

/** src/server.js:3583-3585 (PUT /api/recurring-rules/:id) — no allowlist */
const legacyFrequencyOnUpdate = (frequency, current) =>
  frequency || current;

/** src/server.js:298-305 */
const VALID_ACCOUNT_TYPES = [
  'BANK',
  'CREDIT_CARD',
  'CASH',
  'WALLET',
  'UPI',
  'OTHER',
];

/** src/server.js:209-221 */
const legacyNormaliseMerchant = (merchant) => {
  if (merchant === null || merchant === undefined) {
    return null;
  }

  const trimmed = String(merchant).trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, 100);
};

module.exports = {
  legacyComputeNextExecution,
  legacyCronAdvance,
  legacyMonthRange,
  legacyMonthLabel,
  legacyCsvForExpenses,
  legacyIncomeAmountGuard,
  legacyExpenseTypeCoerce,
  legacyExpenseTypeOnUpdate,
  legacyIsValidFrequency,
  legacyFrequencyOnUpdate,
  legacyNormaliseMerchant,
  VALID_ACCOUNT_TYPES,
};
