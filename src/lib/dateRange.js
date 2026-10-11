'use strict';

/**
 * P0-6 — one date-window calculation for the whole backend.
 *
 * Before this module the same month parser was copy-pasted into
 * /api/dashboard/summary, /api/merchants/stats and /api/incomes. All three:
 *   - accepted garbage (`?month=abc` -> Invalid Date -> a RangeError inside
 *     toISOString -> HTTP 500 instead of 400);
 *   - silently rolled out-of-range months over (`?month=2024-13` became
 *     January 2025) instead of rejecting them;
 *   - ended the window at 23:59:59.000, so rows in the final second
 *     (.001-.999) were excluded;
 *   - echoed the month label via toISOString(), which is UTC-derived and
 *     therefore WRONG on any server east of UTC (`?month=2026-03` reported
 *     "2026-02" on an IST host).
 *
 * This module fixes all four: strict validation, half-open ranges, and a label
 * that is the requested month rather than a re-derived one.
 *
 * TIMEZONE MODEL. Boundaries are computed for a fixed UTC offset so results are
 * identical on every host (the old code used the *server's* local zone, which is
 * why behaviour differed between a dev machine in IST and Render in UTC).
 * India has no daylight saving, so a fixed offset is exact there. A full IANA
 * timezone library is the correct long-term answer for other regions and is
 * noted as a follow-up rather than pretended here.
 */

/** Application timezone: IST (UTC+05:30). Fixed, no DST. */
const APP_UTC_OFFSET_MINUTES = 330;

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** Shift an instant into "application local" time, then read UTC parts. */
const toAppLocal = (instant, offsetMinutes) =>
  new Date(instant.getTime() + offsetMinutes * 60000);

/** Build the instant that corresponds to an application-local calendar date. */
const fromAppLocal = (year, monthIndex, day, offsetMinutes) =>
  new Date(Date.UTC(year, monthIndex, day) - offsetMinutes * 60000);

const daysInMonth = (year, monthIndex) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

/**
 * Strict "YYYY-MM" parser.
 * @returns {{year:number, monthIndex:number}|null} null when malformed or
 *   out of range. Callers must answer 400, never guess.
 */
const parseMonth = (value) => {
  if (typeof value !== 'string') return null;
  const match = MONTH_PATTERN.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  if (year < 1970 || year > 9999) return null;
  return { year, monthIndex: month - 1 };
};

/** Strict "YYYY-MM-DD" parser, including real-calendar day validation. */
const parseDate = (value) => {
  if (typeof value !== 'string') return null;
  const match = DATE_PATTERN.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month - 1)) return null;
  return { year, monthIndex: month - 1, day };
};

/** The application-local calendar date of an instant ("YYYY-MM-DD"). */
const appLocalDateString = (instant, offsetMinutes = APP_UTC_OFFSET_MINUTES) => {
  const local = toAppLocal(new Date(instant), offsetMinutes);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
};

/**
 * Half-open month window: [start, end).
 * Half-open is what removes the "last second is excluded" bug: the end is the
 * first instant of the NEXT month, so a row at 23:59:59.500 belongs to this
 * month and no boundary second is lost or double-counted.
 *
 * @returns {{start:Date, end:Date, label:string}|null} null when invalid.
 */
const monthRange = (month, offsetMinutes = APP_UTC_OFFSET_MINUTES) => {
  const parsed = parseMonth(month);
  if (!parsed) return null;
  const { year, monthIndex } = parsed;
  return {
    start: fromAppLocal(year, monthIndex, 1, offsetMinutes),
    end: fromAppLocal(year, monthIndex + 1, 1, offsetMinutes),
    label: `${year}-${pad(monthIndex + 1)}`,
  };
};

/** The window for the month containing `instant` (application-local). */
const monthRangeForInstant = (instant, offsetMinutes = APP_UTC_OFFSET_MINUTES) => {
  const local = toAppLocal(new Date(instant), offsetMinutes);
  return monthRange(`${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}`, offsetMinutes);
};

/** Monday-based week window containing `date` ("YYYY-MM-DD"), half-open. */
const weekRange = (date, offsetMinutes = APP_UTC_OFFSET_MINUTES) => {
  const parsed = parseDate(date);
  if (!parsed) return null;
  const { year, monthIndex, day } = parsed;
  // Weekday in application-local time: 0 = Sunday.
  const weekday = new Date(Date.UTC(year, monthIndex, day)).getUTCDay();
  const backToMonday = (weekday + 6) % 7;
  const start = fromAppLocal(year, monthIndex, day - backToMonday, offsetMinutes);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { start, end, label: appLocalDateString(start, offsetMinutes) };
};

/**
 * Arbitrary inclusive-date window, half-open at the end.
 * Both bounds must be valid calendar dates and start <= end.
 */
const customRange = (fromDate, toDate, offsetMinutes = APP_UTC_OFFSET_MINUTES) => {
  const from = parseDate(fromDate);
  const to = parseDate(toDate);
  if (!from || !to) return null;
  const start = fromAppLocal(from.year, from.monthIndex, from.day, offsetMinutes);
  // The window covers the whole `to` day, so end is the NEXT day.
  const end = fromAppLocal(to.year, to.monthIndex, to.day + 1, offsetMinutes);
  if (end <= start) return null;
  return { start, end, label: `${fromDate}..${toDate}` };
};

/**
 * The "YYYY-MM" label immediately before `label` (handles the January rollover).
 * @returns {string|null} null when the input is not a valid month
 */
const previousMonthLabel = (label) => {
  const parsed = parseMonth(label);
  if (!parsed) return null;
  const { year, monthIndex } = parsed;
  return monthIndex === 0
    ? `${year - 1}-12`
    : `${year}-${pad(monthIndex)}`;
};

/**
 * Shift an instant by whole months in application-local time, clamping the day
 * to the target month's length.
 *
 * The naive equivalent used by the merchant lookback (`setMonth(getMonth() - 12)`)
 * drifts: run on 29 February it lands on 1 March, silently widening the window.
 */
const shiftMonths = (instant, months, offsetMinutes = APP_UTC_OFFSET_MINUTES) => {
  const local = toAppLocal(new Date(instant), offsetMinutes);
  const year = local.getUTCFullYear();
  const monthIndex = local.getUTCMonth();
  const day = local.getUTCDate();

  const targetMonth = new Date(Date.UTC(year, monthIndex + months, 1));
  const targetYear = targetMonth.getUTCFullYear();
  const targetMonthIndex = targetMonth.getUTCMonth();
  const lastDay = daysInMonth(targetYear, targetMonthIndex);

  return fromAppLocal(
    targetYear,
    targetMonthIndex,
    Math.min(day, lastDay),
    offsetMinutes
  );
};

/**
 * The Prisma `date` filter for a window: half-open, start inclusive, end
 * exclusive.
 *
 * Both the database query AND the in-memory filter must be built from this, so
 * they cannot disagree about a boundary instant.
 */
const dateFilterFor = (window) => ({
  gte: window.start,
  lt: window.end,
});

/** In-memory equivalent of `dateFilterFor`. Same half-open semantics. */
const isWithin = (window, instant) => {
  const time = new Date(instant).getTime();
  return time >= window.start.getTime() && time < window.end.getTime();
};

/**
 * Build a Prisma date filter from optional `startDate` / `endDate` query
 * parameters (P0-6B).
 *
 * Two accepted forms, because both are already in use:
 *   - a calendar day `YYYY-MM-DD` is treated as an INCLUSIVE user-facing day, so
 *     the internal upper bound becomes the exclusive start of the NEXT day.
 *     Previously this used `lte: new Date(endDate)`, which silently excluded the
 *     whole end day, because `new Date('2026-03-10')` is midnight.
 *   - a full ISO instant is treated as an exact instant bound, and the end stays
 *     inclusive so existing instant-based callers keep their meaning.
 *
 * @returns {{ok: true, dateFilter: object|null} | {ok: false, error: string}}
 */
const rangeFromQueryParams = (params, offsetMinutes = APP_UTC_OFFSET_MINUTES) => {
  const start = params ? params.startDate : undefined;
  const end = params ? params.endDate : undefined;

  const hasStart = !(start === undefined || start === null || start === '');
  const hasEnd = !(end === undefined || end === null || end === '');

  if (!hasStart && !hasEnd) {
    return { ok: true, dateFilter: null };
  }

  const dateFilter = {};

  /**
   * Resolve one bound.
   * A calendar day is exact and validated. Anything else must be a FULL ISO
   * instant (it must contain a time component). This matters: V8 silently rolls
   * `new Date('2026-02-29')` forward to 1 March, so a lenient fallback would
   * accept impossible dates.
   */
  const resolveBound = (value, label) => {
    const raw = String(value).trim();

    // A pure calendar day, validated against the real calendar.
    const asDay = parseDate(raw);
    if (asDay) {
      return {
        ok: true,
        kind: 'day',
        year: asDay.year,
        monthIndex: asDay.monthIndex,
        day: asDay.day,
      };
    }

    // Anything else must carry a time component to count as an instant. This
    // ordering matters: an ISO instant also starts with YYYY-MM-DD, so checking
    // "looks like a date" before this would reject valid instants.
    if (!raw.includes('T')) {
      return {
        ok: false,
        error: `Invalid ${label}. Expected YYYY-MM-DD or an ISO date.`,
      };
    }

    const instant = new Date(raw);
    if (Number.isNaN(instant.getTime())) {
      return {
        ok: false,
        error: `Invalid ${label}. Expected YYYY-MM-DD or an ISO date.`,
      };
    }

    return { ok: true, kind: 'instant', instant };
  };

  if (hasStart) {
    const bound = resolveBound(start, 'startDate');
    if (!bound.ok) return bound;
    dateFilter.gte =
      bound.kind === 'day'
        ? fromAppLocal(bound.year, bound.monthIndex, bound.day, offsetMinutes)
        : bound.instant;
  }

  if (hasEnd) {
    const bound = resolveBound(end, 'endDate');
    if (!bound.ok) return bound;

    if (bound.kind === 'day') {
      // The user's end date is an inclusive calendar day, so the internal upper
      // bound is the exclusive start of the following day.
      const exclusive = fromAppLocal(bound.year, bound.monthIndex, bound.day + 1, offsetMinutes);
      if (dateFilter.gte && exclusive <= dateFilter.gte) {
        return { ok: false, error: 'Invalid range. endDate must not be before startDate.' };
      }
      dateFilter.lt = exclusive;
    } else {
      if (dateFilter.gte && bound.instant < dateFilter.gte) {
        return { ok: false, error: 'Invalid range. endDate must not be before startDate.' };
      }
      // An exact instant keeps its previous inclusive meaning.
      dateFilter.lte = bound.instant;
    }
  }

  return { ok: true, dateFilter };
};

module.exports = {
  APP_UTC_OFFSET_MINUTES,
  parseMonth,
  parseDate,
  daysInMonth,
  toAppLocal,
  appLocalDateString,
  monthRange,
  monthRangeForInstant,
  weekRange,
  customRange,
  previousMonthLabel,
  shiftMonths,
  dateFilterFor,
  isWithin,
  rangeFromQueryParams,
};
