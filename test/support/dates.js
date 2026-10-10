'use strict';

/**
 * Local-calendar date helpers.
 *
 * All assertions in this suite use LOCAL calendar getters, never toISOString(),
 * so results are hardware-timezone independent for local-calendar arithmetic.
 * The one place timezone genuinely matters (the API's echoed `month` label) is
 * asserted against a computed expectation and documented explicitly.
 */

const pad = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" using local calendar fields. */
const ymd = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "YYYY-MM-DDTHH:mm:ss.mmm" using local calendar fields. */
const stamp = (d) =>
  `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(
    d.getSeconds()
  )}.${String(d.getMilliseconds()).padStart(3, '0')}`;

/** True if the Date is a valid instant. */
const isValid = (d) => d instanceof Date && !Number.isNaN(d.getTime());

module.exports = { ymd, stamp, isValid };
