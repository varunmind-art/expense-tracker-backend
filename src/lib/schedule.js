'use strict';

/**
 * P0-5 — recurring schedule arithmetic (single source of truth).
 *
 * Before this module the same calculation existed twice: `computeNextExecution`
 * in src/server.js and an inline copy inside the recurring cron. They disagreed
 * (the cron's WEEKLY branch ignored `dayOfWeek` entirely, and its YEARLY branch
 * ignored the day fields), and the MONTHLY branch called setMonth() before
 * setDate(), so an overflowing day was normalised first and the target month was
 * lost.
 *
 * Every function here takes an explicit `from` date. Nothing reads the clock
 * implicitly, which is what makes the tests deterministic and what lets the cron
 * advance from a rule's own `nextExecution` instead of from "today".
 */

/** Supported recurrence frequencies. Any other value is invalid, not a default. */
const FREQUENCIES = Object.freeze(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

/**
 * Upper bound on how many missed periods a single run will materialise.
 * Documented catch-up policy: see docs/P0-5_SCHEDULE_CHANGE_REPORT.md.
 * Change this one constant to switch the policy.
 */
const MAX_CATCH_UP_PERIODS = 12;

const isSupportedFrequency = (frequency) => FREQUENCIES.includes(frequency);

/** Days in a month, 1-indexed month via a Date-style month index. */
const daysInMonth = (year, monthIndex) => new Date(year, monthIndex + 1, 0).getDate();

const startOfDay = (value) => {
  const copy = new Date(value);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

/** @returns {number|null} a valid 1..31 day, or null when absent/out of range. */
const normaliseDayOfMonth = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 31 ? parsed : null;
};

/** @returns {number|null} a valid 0..6 weekday (0 = Sunday), or null. */
const normaliseDayOfWeek = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 6 ? parsed : null;
};

/**
 * The next execution strictly after `from`.
 *
 * @param {string} frequency one of FREQUENCIES
 * @param {number|string|null} dayOfMonth
 * @param {number|string|null} dayOfWeek
 * @param {Date} from  the instant to advance from (a rule's own nextExecution)
 * @returns {Date|null} null when the frequency is unsupported or the input date
 *   is invalid. Callers MUST treat null as a rejection, never as "now" — the old
 *   code returned the input unchanged, which made the cron re-fire forever.
 */
const computeNextExecution = (frequency, dayOfMonth, dayOfWeek, from) => {
  if (!isSupportedFrequency(frequency)) {
    return null;
  }

  const base = startOfDay(from === undefined ? new Date() : from);
  if (Number.isNaN(base.getTime())) {
    return null;
  }

  if (frequency === 'DAILY') {
    const next = new Date(base);
    next.setDate(base.getDate() + 1);
    return next;
  }

  if (frequency === 'WEEKLY') {
    // `dayOfWeek` is honoured here; the old cron branch ignored it and always
    // advanced by exactly 7 days from the run date.
    const target = normaliseDayOfWeek(dayOfWeek);
    const weekday = target === null ? base.getDay() : target;
    const delta = (weekday - base.getDay() + 7) % 7;
    const next = new Date(base);
    next.setDate(base.getDate() + (delta === 0 ? 7 : delta));
    return next;
  }

  if (frequency === 'MONTHLY') {
    const requested = normaliseDayOfMonth(dayOfMonth);
    const targetDay = requested === null ? base.getDate() : requested;

    // Resolve the TARGET MONTH first, then clamp the day inside it. Doing this
    // in the other order is the original bug: setMonth() normalises an
    // overflowing day (Jan 31 -> "Feb 31" -> Mar 3) before setDate() runs, so
    // the clamp lands in the wrong month and a whole period is skipped.
    const firstOfTarget = new Date(base.getFullYear(), base.getMonth() + 1, 1);
    const lastDay = daysInMonth(firstOfTarget.getFullYear(), firstOfTarget.getMonth());
    return new Date(firstOfTarget.getFullYear(), firstOfTarget.getMonth(), Math.min(targetDay, lastDay));
  }

  // YEARLY — clamp for 29 February.
  const targetMonth = base.getMonth();
  const year = base.getFullYear() + 1;
  const lastDay = daysInMonth(year, targetMonth);
  return new Date(year, targetMonth, Math.min(base.getDate(), lastDay));
};

/**
 * Every period that has come due for a rule, oldest first, capped.
 *
 * Catch-up policy: materialise each missed period individually, up to
 * MAX_CATCH_UP_PERIODS, and report `hasMore` so the caller can flag a rule that
 * is further behind than the cap rather than silently skipping it.
 *
 * @returns {{ periods: Date[], hasMore: boolean, invalid: boolean }}
 */
const listDuePeriods = (frequency, dayOfMonth, dayOfWeek, nextExecution, today, maxPeriods) => {
  const cap = Number.isInteger(maxPeriods) && maxPeriods > 0 ? maxPeriods : MAX_CATCH_UP_PERIODS;
  const limit = startOfDay(today === undefined ? new Date() : today);
  const periods = [];

  if (!isSupportedFrequency(frequency)) {
    return { periods, hasMore: false, invalid: true };
  }

  let cursor = startOfDay(nextExecution);
  if (Number.isNaN(cursor.getTime())) {
    return { periods, hasMore: false, invalid: true };
  }

  while (cursor <= limit) {
    if (periods.length >= cap) {
      return { periods, hasMore: true, invalid: false };
    }
    periods.push(new Date(cursor));
    const next = computeNextExecution(frequency, dayOfMonth, dayOfWeek, cursor);
    // Defensive: never loop forever on a rule that cannot advance.
    if (!next || next <= cursor) {
      return { periods, hasMore: false, invalid: true };
    }
    cursor = next;
  }

  return { periods, hasMore: false, invalid: false };
};

/**
 * Stable idempotency key for one expected occurrence ("2026-02-28").
 * Used by the prepared unique-constraint design documented in
 * docs/P0-5_SCHEDULE_CHANGE_REPORT.md; not yet persisted.
 */
const periodKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

module.exports = {
  FREQUENCIES,
  MAX_CATCH_UP_PERIODS,
  isSupportedFrequency,
  daysInMonth,
  normaliseDayOfMonth,
  normaliseDayOfWeek,
  computeNextExecution,
  listDuePeriods,
  periodKey,
};
