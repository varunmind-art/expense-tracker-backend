'use strict';

/**
 * P0-5 — recurring schedule arithmetic (single source of truth).
 *
 * P0-5B: all scheduling now uses ONE explicit, documented application timezone
 * instead of the host machine's local timezone.
 *
 * The defect this removes: the previous implementation used `setHours(0,0,0,0)`,
 * `getDate()`, `setDate()` and `setMonth()` — all host-local operations. The same
 * rule could therefore resolve to a different calendar date depending on the
 * server's TZ (for example a developer machine in Asia/Kolkata versus Render in
 * UTC), and a DST-transition zone could shift a date by an hour and change the
 * civil day. The P0-5A claim fix stopped that from causing a *missed*
 * occurrence, but the computed dates themselves were still deployment-dependent.
 *
 * The policy: schedule in **Asia/Kolkata (UTC+05:30)**, a fixed offset with no
 * daylight saving, matching the application's existing date policy in
 * `src/lib/dateRange.js` (APP_UTC_OFFSET_MINUTES = 330). Civil-date arithmetic is
 * performed in UTC space and converted back to the corresponding instant, so no
 * host-local getter or setter is used anywhere in this module. A full IANA
 * library would be needed to support a zone with DST; that is deliberately not
 * introduced here, and the fixed offset is documented rather than implied.
 *
 * Database concurrency control stays separate: `listDuePeriods` returns business
 * calendar dates, while the caller claims on the exact stored `nextExecution`
 * value (P0-5A).
 */

/** Supported recurrence frequencies. Any other value is invalid, not a default. */
const FREQUENCIES = Object.freeze(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

/**
 * Upper bound on how many missed periods a single run will materialise.
 * Documented catch-up policy: see docs/P0-5_SCHEDULE_CHANGE_REPORT.md.
 */
const MAX_CATCH_UP_PERIODS = 12;

/** The application scheduling timezone: IST (UTC+05:30), fixed, no DST. */
const APP_UTC_OFFSET_MINUTES = 330;

const isSupportedFrequency = (frequency) => FREQUENCIES.includes(frequency);

const isUsableDate = (value) =>
  value instanceof Date && !Number.isNaN(value.getTime());

/** Days in a month, using a Date-style month index. Pure UTC, no local getters. */
const daysInMonth = (year, monthIndex) =>
  new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

/**
 * The application-local civil date of an instant, as plain numbers.
 * Shifting by the offset and reading UTC parts is equivalent to reading local
 * parts in that zone, and is independent of the host timezone.
 */
const toCivil = (instant) => {
  const shifted = new Date(instant.getTime() + APP_UTC_OFFSET_MINUTES * 60000);
  return {
    year: shifted.getUTCFullYear(),
    monthIndex: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
};

/**
 * The instant at application-local midnight for a civil date.
 * This is the inverse of `toCivil` for midnight values.
 */
const fromCivil = (year, monthIndex, day) =>
  new Date(Date.UTC(year, monthIndex, day) - APP_UTC_OFFSET_MINUTES * 60000);

/** Weekday (0 = Sunday) of a civil date. Pure UTC arithmetic. */
const weekdayOf = (year, monthIndex, day) =>
  new Date(Date.UTC(year, monthIndex, day)).getUTCDay();

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
 * The next execution strictly after `from`, at application-local midnight.
 *
 * @param {string} frequency one of FREQUENCIES
 * @param {number|string|null} dayOfMonth
 * @param {number|string|null} dayOfWeek
 * @param {Date} from the instant to advance from (a rule's own nextExecution)
 * @returns {Date|null} null when the frequency is unsupported or the input date
 *   is invalid. Callers MUST treat null as a rejection, never as "now".
 */
const computeNextExecution = (frequency, dayOfMonth, dayOfWeek, from) => {
  if (!isSupportedFrequency(frequency)) {
    return null;
  }

  const base = from === undefined ? new Date() : new Date(from);
  if (!isUsableDate(base)) {
    return null;
  }

  const { year, monthIndex, day } = toCivil(base);

  if (frequency === 'DAILY') {
    return fromCivil(year, monthIndex, day + 1);
  }

  if (frequency === 'WEEKLY') {
    // Always strictly in the future: landing on the configured weekday counts as
    // a full week ahead rather than "today".
    const target = normaliseDayOfWeek(dayOfWeek);
    const weekday = target === null ? weekdayOf(year, monthIndex, day) : target;
    const delta = (weekday - weekdayOf(year, monthIndex, day) + 7) % 7;
    return fromCivil(year, monthIndex, day + (delta === 0 ? 7 : delta));
  }

  if (frequency === 'MONTHLY') {
    const requested = normaliseDayOfMonth(dayOfMonth);
    const targetDay = requested === null ? day : requested;

    // Resolve the TARGET month first, then clamp the day inside it. Doing this in
    // the other order is the original month-skip bug.
    const target = new Date(Date.UTC(year, monthIndex + 1, 1));
    const targetYear = target.getUTCFullYear();
    const targetMonth = target.getUTCMonth();
    const lastDay = daysInMonth(targetYear, targetMonth);
    return fromCivil(targetYear, targetMonth, Math.min(targetDay, lastDay));
  }

  // YEARLY — clamp for 29 February.
  const targetYear = year + 1;
  const lastDay = daysInMonth(targetYear, monthIndex);
  return fromCivil(targetYear, monthIndex, Math.min(day, lastDay));
};

/**
 * Every period that has come due for a rule, oldest first, capped.
 *
 * `today` is compared as an application-local civil date, so the result does not
 * depend on the host timezone.
 *
 * @returns {{ periods: Date[], hasMore: boolean, invalid: boolean }}
 */
const listDuePeriods = (frequency, dayOfMonth, dayOfWeek, nextExecution, today, maxPeriods) => {
  const cap = Number.isInteger(maxPeriods) && maxPeriods > 0 ? maxPeriods : MAX_CATCH_UP_PERIODS;
  const periods = [];

  if (!isSupportedFrequency(frequency)) {
    return { periods, hasMore: false, invalid: true };
  }

  const start = new Date(nextExecution);
  if (!isUsableDate(start)) {
    return { periods, hasMore: false, invalid: true };
  }

  const limitInstant = today === undefined ? new Date() : new Date(today);
  if (!isUsableDate(limitInstant)) {
    return { periods, hasMore: false, invalid: true };
  }

  const startCivil = toCivil(start);
  const limitCivil = toCivil(limitInstant);
  const limitKey =
    limitCivil.year * 10000 + (limitCivil.monthIndex + 1) * 100 + limitCivil.day;

  let cursor = fromCivil(startCivil.year, startCivil.monthIndex, startCivil.day);

  for (;;) {
    const civil = toCivil(cursor);
    const cursorKey = civil.year * 10000 + (civil.monthIndex + 1) * 100 + civil.day;
    if (cursorKey > limitKey) {
      return { periods, hasMore: false, invalid: false };
    }

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
};

/**
 * Stable idempotency key for one expected occurrence ("2026-02-28"), in the
 * application timezone so the same occurrence always yields the same key.
 */
const periodKey = (date) => {
  const civil = toCivil(new Date(date));
  return `${civil.year}-${String(civil.monthIndex + 1).padStart(2, '0')}-${String(civil.day).padStart(2, '0')}`;
};

module.exports = {
  FREQUENCIES,
  MAX_CATCH_UP_PERIODS,
  APP_UTC_OFFSET_MINUTES,
  isSupportedFrequency,
  daysInMonth,
  toCivil,
  fromCivil,
  weekdayOf,
  normaliseDayOfMonth,
  normaliseDayOfWeek,
  computeNextExecution,
  listDuePeriods,
  periodKey,
};
