'use strict';

/**
 * Loan Tracker — pure loan mathematics.
 *
 * This module has NO database, NO Express and NO Prisma dependency, so it can be
 * unit-tested offline and reused as the single source of truth for every number
 * the Loan API reports. Forecasts (amortization schedules, payoff dates,
 * prepayment savings) are computed here on demand and are NEVER persisted; only
 * `LoanPayment` rows are stored, and they are treated as immutable history.
 *
 * Money discipline
 * ----------------
 * Every balance inside a calculation is an INTEGER NUMBER OF PAISE. Rupee inputs
 * are converted once at the boundary and converted back once on the way out, so
 * no rounding error can accumulate across a 240-period schedule the way it would
 * if we float-multiplied a drifting rupee balance. Rounding is half-up to 2dp
 * (the Indian banking convention), and the FINAL INSTALMENT absorbs the rounding
 * remainder so a schedule always closes to exactly zero.
 *
 * Two rules that exist because of the MVP decisions:
 *   - A prepayment shortens the TENURE and keeps the EMI (Decision B). The
 *     "reduce the EMI instead" alternative is an explicit `keepEmi: false` flag,
 *     never stored state.
 *   - A loan payment never reduces the balance by its `totalAmount`. Only
 *     `principalAmount + extraPrincipal` reduce principal; interest does not.
 *     Summing `totalAmount` would double-count interest.
 */

const PAISE_PER_RUPEE = 100;

/** Hard ceiling so a non-amortizing loan can never spin forever. */
const MAX_PERIODS = 1200; // 100 years of monthly instalments

// ---------------------------------------------------------------------------
// scalar helpers
// ---------------------------------------------------------------------------

/** Coerce a Number, a numeric string or a Prisma Decimal into a Number. */
const num = (value) => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber();
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

/** A finite, non-negative money value. */
const isMoney = (value) => {
  const n = num(value);
  return Number.isFinite(n) && n >= 0;
};

/**
 * Half-up rounding to `decimals` places.
 *
 * The `1e-9` nudge is deliberate: binary floats cannot represent most decimal
 * fractions, so `2.675 * 100` is `267.49999999999997` and a naive
 * `floor(x + 0.5)` would round it DOWN. The nudge restores the decimal
 * expectation without ever moving a genuine half-cent in the wrong direction.
 */
const roundHalfUp = (value, decimals = 2) => {
  const n = num(value);
  if (!Number.isFinite(n)) return NaN;
  const factor = 10 ** decimals;
  const scaled = n * factor;
  const sign = scaled < 0 ? -1 : 1;
  const magnitude = Math.abs(scaled);
  return (sign * Math.floor(magnitude + 0.5 + 1e-9)) / factor;
};

/** Rupees -> integer paise (half-up). Same nudge as `roundHalfUp`. */
const toPaise = (rupees) => {
  const n = num(rupees);
  if (!Number.isFinite(n)) return NaN;
  const sign = n < 0 ? -1 : 1;
  return sign * Math.floor(Math.abs(n) * PAISE_PER_RUPEE + 0.5 + 1e-9);
};

/** Integer paise -> rupees, 2dp clean for JSON. */
const fromPaise = (paise) => {
  const n = num(paise);
  if (!Number.isFinite(n)) return NaN;
  return Number((n / PAISE_PER_RUPEE).toFixed(2));
};

/** Never return a negative balance (a paid-off loan owes nothing). */
const clampToZero = (value) => {
  const n = num(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
};

/** Monthly rate as a fraction: 8.5 (%/yr) -> 0.00708333... */
const monthlyRate = (annualRatePercent) => {
  const annual = num(annualRatePercent);
  if (!Number.isFinite(annual) || annual < 0) return NaN;
  return annual / 1200;
};

// ---------------------------------------------------------------------------
// calendar helpers (local calendar, month-end clamped)
// ---------------------------------------------------------------------------

/**
 * Add whole months without the JavaScript rollover bug.
 * `new Date(2026, 0, 31)` + 1 month must be 28 Feb, not 3 March.
 */
const addMonthsClamped = (date, months) => {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
};

/** Whole months from `from` to `to`, floored at 0. */
const monthsBetween = (from, to) => {
  if (!from || !to) return 0;
  const a = new Date(from);
  const b = new Date(to);
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) months -= 1;
  return Math.max(0, months);
};

const asDate = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Midnight of the given date, for day-granularity comparisons. */
const startOfDay = (value) => {
  const d = asDate(value);
  return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null;
};

/** The `day`-th of the month containing `anchor`, clamped to that month's length. */
const dueDateInMonth = (anchor, day) => {
  const a = asDate(anchor);
  if (!a) return null;
  const lastDay = new Date(a.getFullYear(), a.getMonth() + 1, 0).getDate();
  const useDay = Number.isInteger(Number(day)) && Number(day) >= 1
    ? Math.min(Number(day), lastDay)
    : a.getDate();
  return new Date(a.getFullYear(), a.getMonth(), useDay);
};

/**
 * THE repayment timeline — the single anchor for every loan date.
 *
 * Before this existed, three different conventions were in play at once:
 * `nextEmiDate` came from today's date, the dashboard payoff came from
 * `today + remaining months` (using today's day-of-month), and the amortization
 * table came from `startDate + period months` (using the disbursement
 * day-of-month). A real production loan (Rs 55,00,000 @ 7.5%, disbursed
 * 1 Apr 2026, EMI day 5, 179 instalments ending Mar 2041) therefore showed a
 * dashboard payoff of 12 Sep 2041 while its own schedule ended in March 2041.
 *
 * Conventions, all contractually standard:
 *   - the FIRST instalment falls in the month AFTER disbursement;
 *   - the instalment day is `emiDay` when set, otherwise the disbursement day,
 *     clamped to the length of each month;
 *   - `endDate` is the MATURITY date, so the number of instalments is the
 *     inclusive count of due dates from the first due date through it;
 *   - an explicitly supplied `installments` count wins over everything else, so
 *     a term a user typed in is never silently re-derived.
 *
 * @returns {{dueDay:number|null, firstDueDate:Date|null, installments:number|null,
 *            termSource:string|null, finalDueDate:Date|null,
 *            startDate:Date|null, endDate:Date|null}}
 */
const repaymentTimeline = ({
  startDate = null,
  endDate = null,
  emiDay = null,
  installments = null,
  emiAmount = 0,
  interestRate = 0,
  originalPrincipal = 0,
} = {}) => {
  const start = asDate(startDate);
  const end = asDate(endDate);

  const explicitDay = Number(emiDay);
  const dueDay = Number.isInteger(explicitDay) && explicitDay >= 1 && explicitDay <= 31
    ? explicitDay
    : (start ? start.getDate() : null);

  const firstDueDate = start ? dueDateInMonth(addMonthsClamped(start, 1), dueDay) : null;

  let term = null;
  let termSource = null;

  const explicitTerm = Number(installments);
  if (Number.isInteger(explicitTerm) && explicitTerm > 0) {
    term = explicitTerm;
    termSource = 'explicit';
  } else if (firstDueDate && end) {
    term = Math.max(1, monthsBetween(firstDueDate, end) + 1);
    termSource = 'endDate';
  } else if (num(emiAmount) > 0) {
    const fromEmi = remainingTenure(originalPrincipal, interestRate, emiAmount);
    if (fromEmi && fromEmi > 0) {
      term = fromEmi;
      termSource = 'emi';
    }
  } else if (start && end) {
    term = Math.max(1, monthsBetween(start, end));
    termSource = 'startToEnd';
  }

  const finalDueDate = firstDueDate && term ? addMonthsClamped(firstDueDate, term - 1) : null;

  return { dueDay, firstDueDate, installments: term, termSource, finalDueDate, startDate: start, endDate: end };
};

/**
 * How many contractual instalments the ledger has settled.
 *
 * A regular EMI — one that carries an interest component — settles exactly one
 * instalment. A prepayment or a principal-only adjustment does NOT: it reduces
 * the balance and shortens the loan, but the monthly instalments remain due.
 *
 * This distinction matters. Mapping cumulative principal repaid onto the
 * schedule instead makes a single large prepayment appear to settle every
 * instalment whose principal it covers, which wrongly pushes the next due date
 * years into the future for EMIs that were never paid.
 *
 * Known simplification: an interest-bearing payment counts as settling one
 * instalment even if it fell short of the full EMI. Per-period PAID/PARTIAL
 * detail is reported by the schedule annotation.
 */
const settledInstallmentCount = (payments = [], term = null) => {
  let count = 0;
  for (const payment of payments || []) {
    if (!payment) continue;
    if (toPaise(payment.interestAmount) > 0) count += 1;
  }
  return Number.isInteger(term) && term > 0 ? Math.min(term, count) : count;
};

// ---------------------------------------------------------------------------
// 1. EMI
// ---------------------------------------------------------------------------

/**
 * Reducing-balance EMI (equated monthly instalment).
 *
 *   EMI = P * r / (1 - (1 + r)^-n)
 *
 * The reciprocal form is used on purpose: `(1 + r)^-n` underflows to 0 for long
 * tenures, whereas the textbook `(1 + r)^n / ((1 + r)^n - 1)` overflows to
 * Infinity for large n and produces NaN.
 *
 * A zero-interest loan is a plain division, rounded up so the tenure still
 * clears: every instalment is principal.
 *
 * Rounding: half-up to 2dp by default. Pass `{ roundUp: true }` to round the
 * instalment UP to the paise instead — the safe direction for a derived EMI,
 * because a half-up instalment can fall a few paise short per month and leave a
 * residual that pushes the loan into one extra period.
 *
 * @returns {number} EMI in rupees, 2dp, or NaN when the inputs are unusable.
 */
const emiFor = (principal, annualRatePercent, months, { roundUp = false } = {}) => {
  const p = num(principal);
  const n = Number(months);
  const r = monthlyRate(annualRatePercent);

  if (!Number.isFinite(p) || p < 0) return NaN;
  if (!Number.isFinite(r)) return NaN;
  if (!Number.isInteger(n) || n <= 0) return NaN;
  if (p === 0) return 0;

  const round = roundUp
    ? (value) => Math.ceil(value - 1e-9)
    : (value) => Math.round(value);

  // A zero-interest instalment is a plain division, and it is ALWAYS rounded up:
  // rounding down can only under-collect, which would leave a residual stub
  // period at the end of an otherwise exact tenure.
  if (r === 0) return fromPaise(Math.ceil(toPaise(p) / n - 1e-9));

  const discount = 1 - Math.pow(1 + r, -n);
  if (discount <= 0) return NaN;
  return fromPaise(round((toPaise(p) * r) / discount));
};

// ---------------------------------------------------------------------------
// 2. Principal / interest allocation
// ---------------------------------------------------------------------------

/**
 * Split one instalment into its interest and principal parts.
 *
 * Interest is charged on the opening balance for the period, then the rest of
 * the instalment retires principal. The final instalment is the one where the
 * scheduled principal would overshoot the balance: it is capped so the balance
 * lands on exactly zero and the "remainder" is absorbed there.
 *
 * @returns {{interest:number, principal:number, openingBalance:number,
 *            closingBalance:number, emi:number, scheduledEmi:number,
 *            isFinal:boolean, amortizes:boolean}}
 */
const splitEmi = (openingBalance, annualRatePercent, emi) => {
  const openingPaise = Math.max(0, toPaise(openingBalance));
  const scheduledPaise = Math.max(0, toPaise(emi));
  const r = monthlyRate(annualRatePercent);

  if (!Number.isFinite(r)) {
    return {
      interest: NaN,
      principal: NaN,
      openingBalance: fromPaise(openingPaise),
      closingBalance: NaN,
      emi: NaN,
      scheduledEmi: fromPaise(scheduledPaise),
      isFinal: false,
      amortizes: false,
    };
  }

  if (openingPaise === 0) {
    return {
      interest: 0,
      principal: 0,
      openingBalance: 0,
      closingBalance: 0,
      emi: 0,
      scheduledEmi: fromPaise(scheduledPaise),
      isFinal: true,
      amortizes: true,
    };
  }

  const interestPaise = Math.max(0, Math.round(openingPaise * r));
  // An instalment smaller than the interest charged does not amortize at all.
  const amortizes = scheduledPaise > interestPaise;

  let principalPaise = scheduledPaise - interestPaise;
  if (principalPaise < 0) principalPaise = 0;
  if (principalPaise > openingPaise) principalPaise = openingPaise;

  const closingPaise = openingPaise - principalPaise;

  return {
    interest: fromPaise(interestPaise),
    principal: fromPaise(principalPaise),
    openingBalance: fromPaise(openingPaise),
    closingBalance: fromPaise(closingPaise),
    // What is actually paid this period: principal + interest. On the final
    // instalment this is smaller than the scheduled EMI by the remainder.
    emi: fromPaise(principalPaise + interestPaise),
    scheduledEmi: fromPaise(scheduledPaise),
    isFinal: closingPaise === 0,
    amortizes,
  };
};

// ---------------------------------------------------------------------------
// 3. Amortization schedule
// ---------------------------------------------------------------------------

/**
 * Build the full forward-looking amortization schedule.
 *
 * Each period: charge interest on the opening balance, apply the EMI's principal
 * component, then apply any extra principal for that period (a prepayment). The
 * loop stops when the balance reaches exactly zero.
 *
 * A `nonAmortizing` result means the EMI does not even cover the monthly
 * interest, so the loan would never repay; we stop at `MAX_PERIODS` rather than
 * loop forever and say so explicitly.
 *
 * `periods` is the CONTRACTUAL tenure. When supplied, the final period absorbs
 * whatever principal is left, so a 240-month loan produces exactly 240 rows and
 * closes to zero even though the half-up EMI leaves a few paise behind each
 * month. That final instalment is slightly larger (or smaller) than the EMI,
 * which is exactly how a real amortization table ends.
 *
 * @returns {{rows:Array, periods:number, totalInterest:number,
 *            totalPrincipal:number, totalExtra:number, totalPayments:number,
 *            closesToZero:boolean, amortizes:boolean, scheduledEmi:number,
 *            principal:number, annualRatePercent:number}}
 */
const buildAmortizationSchedule = ({
  principal,
  annualRatePercent = 0,
  emi,
  startDate = null,
  extraPrincipal = 0,
  extraPrincipalByPeriod = null,
  periods = null,
  firstDueDate = null,
  maxPeriods = MAX_PERIODS,
} = {}) => {
  const principalPaise = Math.max(0, toPaise(principal));
  const scheduledPaise = Math.max(0, toPaise(emi));
  const baseExtraPaise = Math.max(0, toPaise(extraPrincipal));
  const contractualPeriods =
    Number.isInteger(periods) && periods > 0 ? periods : null;
  const r = monthlyRate(annualRatePercent);
  const start = asDate(startDate);
  // When the caller supplies the contractual first due date, every row is dated
  // from it (period 1 = the first instalment). Otherwise the legacy
  // `startDate + period months` dating is kept for direct callers.
  const dueAnchor = asDate(firstDueDate);

  const rows = [];
  let balance = principalPaise;
  let totalInterest = 0;
  let totalPrincipal = 0;
  let totalExtra = 0;
  let period = 0;
  let amortizes = true;

  const invalidRate = !Number.isFinite(r);
  const horizon = contractualPeriods ? Math.min(contractualPeriods, maxPeriods) : maxPeriods;

  if (!invalidRate && balance > 0 && scheduledPaise === 0 && baseExtraPaise === 0) {
    // No instalment and no extra principal: nothing will ever be repaid.
    amortizes = false;
  }

  while (!invalidRate && balance > 0 && period < horizon) {
    period += 1;

    const opening = balance;
    const isContractualFinal = contractualPeriods !== null && period === contractualPeriods;
    const interestPaise = Math.max(0, Math.round(opening * r));

    let principalPart = scheduledPaise - interestPaise;
    if (principalPart < 0) {
      principalPart = 0;
      if (!isContractualFinal) amortizes = false; // interest exceeds the instalment
    }
    if (principalPart > opening) principalPart = opening;

    const periodExtraPaise =
      extraPrincipalByPeriod && Number.isFinite(num(extraPrincipalByPeriod[period - 1]))
        ? Math.max(0, toPaise(extraPrincipalByPeriod[period - 1]))
        : baseExtraPaise;

    let extraPart = Math.min(periodExtraPaise, opening - principalPart);
    if (extraPart < 0) extraPart = 0;

    let closing = opening - principalPart - extraPart;

    // Final instalment absorbs the rounding remainder: on the contractual last
    // period the balance is cleared exactly, so the schedule always closes.
    if (isContractualFinal && closing > 0) {
      principalPart = opening - extraPart;
      closing = 0;
    }

    // Cap the total reduction at the balance so nothing goes negative.
    if (closing < 0) {
      extraPart = Math.min(periodExtraPaise, opening);
      principalPart = Math.max(0, opening - extraPart);
      closing = opening - principalPart - extraPart;
    }

    totalInterest += interestPaise;
    totalPrincipal += principalPart;
    totalExtra += extraPart;

    rows.push({
      period,
      date: dueAnchor
        ? addMonthsClamped(dueAnchor, period - 1)
        : start
          ? addMonthsClamped(start, period)
          : null,
      openingBalance: fromPaise(opening),
      interest: fromPaise(interestPaise),
      principal: fromPaise(principalPart),
      extraPrincipal: fromPaise(extraPart),
      emi: fromPaise(principalPart + interestPaise),
      scheduledEmi: fromPaise(scheduledPaise),
      totalPayment: fromPaise(principalPart + interestPaise + extraPart),
      closingBalance: fromPaise(closing),
      isFinal: closing === 0,
    });

    balance = closing;

    if (principalPart === 0 && extraPart === 0) {
      // No progress is possible; stop rather than burn MAX_PERIODS iterations.
      amortizes = false;
      break;
    }
  }

  const totalPayments = totalPrincipal + totalInterest + totalExtra;

  return {
    rows,
    periods: rows.length,
    totalInterest: fromPaise(totalInterest),
    totalPrincipal: fromPaise(totalPrincipal),
    totalExtra: fromPaise(totalExtra),
    totalPayments: fromPaise(totalPayments),
    closesToZero: balance === 0 && rows.length > 0,
    amortizes,
    scheduledEmi: fromPaise(scheduledPaise),
    principal: fromPaise(principalPaise),
    annualRatePercent: num(annualRatePercent),
  };
};

// ---------------------------------------------------------------------------
// 4. Recording payments (actual, persisted history)
// ---------------------------------------------------------------------------

/**
 * Allocate a real payment against a real balance.
 *
 * `kind`:
 *   - 'EMI'          a regular instalment: interest is charged, the remainder
 *                    retires principal.
 *   - 'PREPAYMENT'   additional principal only; no interest is charged and the
 *                    EMI is unchanged. This is what shortens the tenure.
 *   - 'PART_PAYMENT' alias of PREPAYMENT kept for user-facing wording.
 *
 * The allocation is capped at the outstanding balance so a payment can never
 * drive principal below zero.
 */
const computePaymentAllocation = ({
  openingBalance,
  annualRatePercent = 0,
  amount,
  kind = 'EMI',
  note = null,
  date = null,
} = {}) => {
  const openingPaise = Math.max(0, toPaise(openingBalance));
  const amountPaise = Math.max(0, toPaise(amount));
  const r = monthlyRate(annualRatePercent);
  const normalisedKind = String(kind || 'EMI').toUpperCase();

  if (!Number.isFinite(r)) {
    return { ok: false, error: 'Invalid interest rate.' };
  }
  if (!Number.isFinite(num(openingBalance)) || openingPaise < 0) {
    return { ok: false, error: 'Invalid opening balance.' };
  }
  if (!Number.isFinite(num(amount)) || amountPaise <= 0) {
    return { ok: false, error: 'Payment amount must be greater than zero.' };
  }
  if (openingPaise === 0) {
    return { ok: false, error: 'This loan is already fully repaid.' };
  }

  let interestPaise = 0;
  let principalPaise = 0;
  let extraPaise = 0;

  if (normalisedKind === 'EMI') {
    interestPaise = Math.max(0, Math.round(openingPaise * r));
    if (amountPaise <= interestPaise) {
      // Interest-only or short payment: nothing reaches principal, but it is a
      // legitimate (if unproductive) payment and must still be recorded.
      principalPaise = 0;
      interestPaise = Math.min(amountPaise, interestPaise);
    } else {
      principalPaise = Math.min(amountPaise - interestPaise, openingPaise);
      // Any excess beyond the closing balance is still principal; it can never
      // exceed the balance, and the balance simply closes.
      const overflow = amountPaise - interestPaise - principalPaise;
      if (overflow > 0) extraPaise = Math.min(overflow, openingPaise - principalPaise);
    }
  } else if (normalisedKind === 'PREPAYMENT' || normalisedKind === 'PART_PAYMENT') {
    extraPaise = Math.min(amountPaise, openingPaise);
  } else {
    return { ok: false, error: `Unsupported payment kind: ${kind}` };
  }

  const closingPaise = openingPaise - principalPaise - extraPaise;
  if (closingPaise < 0) {
    return { ok: false, error: 'Payment would drive the outstanding balance below zero.' };
  }

  const totalPaise = principalPaise + interestPaise + extraPaise;

  return {
    ok: true,
    kind: normalisedKind,
    date: asDate(date),
    note,
    openingBalance: fromPaise(openingPaise),
    interestAmount: fromPaise(interestPaise),
    principalAmount: fromPaise(principalPaise),
    extraPrincipal: fromPaise(extraPaise),
    totalAmount: fromPaise(totalPaise),
    outstandingAfter: fromPaise(closingPaise),
    isFinal: closingPaise === 0,
    // A short payment that does not touch principal is recorded but flagged, so
    // the UI can warn without rejecting the entry.
    principalReduced: principalPaise + extraPaise > 0,
  };
};

/**
 * Recompute the outstanding principal from the immutable payment history.
 *
 * `currentPrincipal` is derived, never incrementally drifted: it is exactly
 * `originalPrincipal - sum(principalAmount + extraPrincipal)`. Payments are
 * de-duplicated by `id` first, so passing the same row twice (a join, a retry)
 * cannot double-count it.
 */
/**
 * Only settled money counts towards a balance.
 *
 * A SCHEDULED row is an assumption that a deduction will happen and a REJECTED
 * row is a booking error. Neither is money that has moved, so neither may reduce
 * principal or pay off an instalment.
 */
const countsTowardBalance = (payment) => {
  const status = String((payment && payment.status) || 'CONFIRMED').toUpperCase();
  return status !== 'SCHEDULED' && status !== 'REJECTED';
};

const sumPrincipalRepaid = (payments = [], asOfDate = null) => {
  const cutoff = asOfDate ? asDate(asOfDate) : null;
  const seen = new Set();
  let repaidPaise = 0;

  for (const payment of payments || []) {
    if (!payment) continue;
    if (!countsTowardBalance(payment)) continue;
    const id = payment.id ?? null;
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    if (cutoff) {
      const when = asDate(payment.date);
      if (!when || when.getTime() > cutoff.getTime()) continue;
    }
    repaidPaise += Math.max(0, toPaise(payment.principalAmount));
    repaidPaise += Math.max(0, toPaise(payment.extraPrincipal));
  }

  return fromPaise(repaidPaise);
};

/**
 * 5. Outstanding principal.
 *
 * Derived from history when history exists. For a loan with no payments yet we
 * honour a stored `currentPrincipal` (a loan imported mid-term starts below its
 * original principal), and we never return a negative number.
 */
const outstandingBalance = (loan = {}, payments = [], asOfDate = null) => {
  const originalPaise = Math.max(0, toPaise(loan.originalPrincipal ?? loan.principal));
  if (!Number.isFinite(originalPaise)) return NaN;

  const relevant = (payments || []).filter((p) => {
    if (!p) return false;
    if (!countsTowardBalance(p)) return false;
    if (!asOfDate) return true;
    const when = asDate(p.date);
    return when && when.getTime() <= asDate(asOfDate).getTime();
  });

  if (relevant.length === 0 && loan.currentPrincipal !== undefined && loan.currentPrincipal !== null) {
    return clampToZero(fromPaise(Math.max(0, toPaise(loan.currentPrincipal))));
  }

  const repaidPaise = toPaise(sumPrincipalRepaid(relevant));
  return clampToZero(fromPaise(originalPaise - repaidPaise));
};

// ---------------------------------------------------------------------------
// 6. Remaining tenure and payoff date
// ---------------------------------------------------------------------------

/**
 * Months still required to clear `balance` at the given EMI and rate.
 *
 * This simulates with the same integer-paise arithmetic as the schedule, so the
 * reported tenure always agrees with the schedule it describes. Returns `null`
 * for a non-amortizing loan (the EMI does not cover the interest), which is a
 * real answer and must not be reported as "0 months".
 */
const remainingTenure = (balance, annualRatePercent, emi, { maxPeriods = MAX_PERIODS } = {}) => {
  const balancePaise = Math.max(0, toPaise(balance));
  const emiPaise = Math.max(0, toPaise(emi));
  const r = monthlyRate(annualRatePercent);

  if (!Number.isFinite(r) || !Number.isFinite(num(balance))) return null;
  if (balancePaise === 0) return 0;
  if (emiPaise === 0) return null;

  let remaining = balancePaise;
  let months = 0;

  while (remaining > 0 && months < maxPeriods) {
    const interest = Math.round(remaining * r);
    const principalPart = emiPaise - interest;
    if (principalPart <= 0) return null; // never amortizes
    months += 1;
    remaining -= Math.min(principalPart, remaining);
  }

  return remaining === 0 ? months : null;
};

/** Calendar date on which the balance reaches zero. */
const payoffDate = (balance, annualRatePercent, emi, fromDate = new Date()) => {
  const months = remainingTenure(balance, annualRatePercent, emi);
  if (months === null) return null;
  const start = asDate(fromDate) || new Date();
  return addMonthsClamped(start, months);
};

// ---------------------------------------------------------------------------
// 7. Prepayment savings
// ---------------------------------------------------------------------------

/**
 * Compare "carry on as-is" against "pay extra", from the current balance
 * forward. Only future interest is affected; past payments are history.
 *
 * Decision B: by default the EMI is retained and the TENURE shortens. Passing
 * `keepEmi: false` recomputes a lower EMI over the original remaining tenure
 * instead — an explicit alternative, never stored state.
 */
const prepaymentSavings = ({
  principal,
  annualRatePercent = 0,
  emi,
  startDate = null,
  currentBalance = null,
  extraAmount = 0,
  monthlyExtra = 0,
  keepEmi = true,
  fromDate = null,
  // Contractual remaining tenure. When the API knows it (a loan with an
  // endDate) the baseline closes in exactly that many periods, which keeps the
  // simulator's "current payoff date" identical to the summary endpoint's.
  periods = null,
  // The contractual due date of the first remaining instalment. Supplying it
  // makes the baseline's final date identical to the dashboard's payoff date.
  firstDueDate = null,
} = {}) => {
  const rate = num(annualRatePercent);
  const balance =
    currentBalance === null || currentBalance === undefined
      ? num(principal)
      : num(currentBalance);
  const extra = Math.max(0, num(extraAmount));
  const recurring = Math.max(0, num(monthlyExtra));
  const start = asDate(fromDate) || asDate(startDate);
  const anchor = asDate(firstDueDate);
  // Only applied when the caller supplies it, so direct callers keep the legacy
  // `start + period months` dating.
  const anchorOption = anchor ? { firstDueDate: anchor } : {};

  const baseline = buildAmortizationSchedule({
    principal: balance,
    annualRatePercent: rate,
    emi,
    startDate: start,
    periods,
    ...anchorOption,
  });

  if (extra <= 0 && recurring <= 0) {
    return {
      baseline: {
        totalInterest: baseline.totalInterest,
        months: baseline.periods,
        payoffDate: lastScheduleDate(baseline) || start,
      },
      scenario: {
        totalInterest: baseline.totalInterest,
        months: baseline.periods,
        payoffDate: lastScheduleDate(baseline) || start,
      },
      interestSaved: 0,
      monthsSaved: 0,
      newPayoffDate: lastScheduleDate(baseline) || start,
      principalReducedImmediately: 0,
      emiAfter: num(emi),
      keepEmi: true,
      closesToZero: baseline.closesToZero,
      amortizes: baseline.amortizes,
    };
  }

  const reducedStart = clampToZero(balance - extra);
  const baselineMonths = baseline.periods;

  // "Reduce the EMI" keeps the original remaining tenure and lowers the
  // instalment; "reduce the tenure" keeps the EMI (the default).
  let scenarioEmi = num(emi);
  if (!keepEmi) {
    const remainingMonths = baselineMonths || remainingTenure(reducedStart, rate, emi) || 0;
    if (remainingMonths > 0) {
      scenarioEmi = emiFor(reducedStart, rate, remainingMonths, { roundUp: true });
    }
  }

  const scenario = buildAmortizationSchedule({
    principal: reducedStart,
    annualRatePercent: rate,
    emi: scenarioEmi,
    startDate: start,
    extraPrincipal: recurring,
    ...anchorOption,
  });

  const scenarioPayoff = lastScheduleDate(scenario) || start;
  const baselinePayoff = lastScheduleDate(baseline) || start;

  return {
    baseline: {
      totalInterest: baseline.totalInterest,
      months: baseline.periods,
      payoffDate: baselinePayoff,
    },
    scenario: {
      totalInterest: scenario.totalInterest,
      months: scenario.periods,
      payoffDate: scenarioPayoff,
    },
    interestSaved: fromPaise(
      Math.max(0, toPaise(baseline.totalInterest) - toPaise(scenario.totalInterest))
    ),
    monthsSaved: Math.max(0, baseline.periods - scenario.periods),
    newPayoffDate: scenarioPayoff,
    // A prepayment larger than the balance can only clear it, never overpay it.
    principalReducedImmediately: Math.min(extra, Math.max(0, balance)),
    emiAfter: scenarioEmi,
    keepEmi,
    closesToZero: scenario.closesToZero,
    amortizes: scenario.amortizes,
  };
};

const lastScheduleDate = (schedule) => {
  const rows = (schedule && schedule.rows) || [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].date) return rows[i].date;
  }
  return null;
};

// ---------------------------------------------------------------------------
// 9. Interest-rate changes (forward-looking only)
// ---------------------------------------------------------------------------

/**
 * Re-price the REMAINING schedule at a new rate. Periods before `fromPeriod` are
 * copied unchanged from the original schedule — they are already-accrued history
 * — and the balance at that point is re-amortized at the new rate.
 *
 * @returns {{rows:Array, changedFrom:number, unaffectedPeriods:number,
 *            baseline:object, newTotalInterest:number, totalInterestDelta:number,
 *            newPayoffDate:Date|null, monthsDelta:number,
 *            emiForSameTenure:number, balanceAtChange:number}}
 */
const rateChangeImpact = ({
  originalPrincipal,
  annualRatePercent = 0,
  emi,
  startDate = null,
  extraPrincipal = 0,
  newRatePercent,
  fromPeriod = 1,
} = {}) => {
  const baseline = buildAmortizationSchedule({
    principal: originalPrincipal,
    annualRatePercent,
    emi,
    startDate,
    extraPrincipal,
  });

  const changeAt = Math.max(1, Math.floor(num(fromPeriod)) || 1);
  const historyRows = baseline.rows.slice(0, changeAt - 1);
  const balanceAtChange =
    historyRows.length > 0
      ? historyRows[historyRows.length - 1].closingBalance
      : fromPaise(Math.max(0, toPaise(originalPrincipal)));

  const changeDate =
    historyRows.length > 0 && historyRows[historyRows.length - 1].date
      ? addMonthsClamped(historyRows[historyRows.length - 1].date, 1)
      : asDate(startDate);

  const remainingMonthsAtChange = Math.max(0, baseline.periods - historyRows.length);

  const tail = buildAmortizationSchedule({
    principal: balanceAtChange,
    annualRatePercent: newRatePercent,
    emi,
    startDate: changeDate,
    extraPrincipal,
  });

  const rows = [
    ...historyRows,
    ...tail.rows.map((row) => ({ ...row, period: row.period + historyRows.length })),
  ];

  const historyInterest = historyRows.reduce((sum, row) => sum + toPaise(row.interest), 0);
  const newTotalInterest = fromPaise(historyInterest + toPaise(tail.totalInterest));

  return {
    rows,
    changedFrom: changeAt,
    unaffectedPeriods: historyRows.length,
    balanceAtChange,
    newTotalInterest,
    totalInterestDelta: fromPaise(
      toPaise(newTotalInterest) - toPaise(baseline.totalInterest)
    ),
    newPayoffDate: lastScheduleDate(tail) || lastScheduleDate(baseline),
    monthsDelta: rows.length - baseline.periods,
    // What the instalment would have to become to clear the balance in exactly
    // the originally remaining number of periods.
    emiForSameTenure:
      remainingMonthsAtChange > 0
        ? emiFor(balanceAtChange, newRatePercent, remainingMonthsAtChange, { roundUp: true })
        : 0,
    baseline: {
      totalInterest: baseline.totalInterest,
      months: baseline.periods,
      emi: num(emi),
    },
  };
};

// ---------------------------------------------------------------------------
// summary (used by the API to report one consistent set of numbers)
// ---------------------------------------------------------------------------

/**
 * Everything the dashboard, detail page and schedule endpoint need, computed in
 * one place so no two screens can disagree about the outstanding balance.
 */
const summarizeLoan = (loan = {}, payments = [], { asOf = null } = {}) => {
  const rate = loan.interestRate === null || loan.interestRate === undefined ? 0 : num(loan.interestRate);
  const emi = loan.emiAmount === null || loan.emiAmount === undefined ? 0 : num(loan.emiAmount);
  const original = num(loan.originalPrincipal);
  const outstanding = outstandingBalance(loan, payments);
  const repaid = fromPaise(Math.max(0, toPaise(original) - toPaise(outstanding)));

  const allPayments = [...(payments || [])].filter(Boolean);
  const settledPayments = allPayments.filter(countsTowardBalance);
  const pendingPayments = allPayments.filter((p) => !countsTowardBalance(p));

  const sorted = [...settledPayments].sort(
    (a, b) => new Date(a.date) - new Date(b.date)
  );

  let totalInterestPaid = 0;
  let totalPaid = 0;
  for (const p of sorted) {
    totalInterestPaid += Math.max(0, toPaise(p.interestAmount));
    totalPaid += Math.max(0, toPaise(p.totalAmount));
  }

  const timeline = repaymentTimeline({
    startDate: loan.startDate,
    endDate: loan.endDate,
    emiDay: loan.emiDay,
    installments: loan.installments,
    emiAmount: emi,
    interestRate: rate,
    originalPrincipal: original,
  });

  // The contractual lifetime table. Every date reported below is read off this
  // one table, so the dashboard, the schedule endpoint and the simulator cannot
  // disagree with each other or with the amortization the user can see.
  const lifetime = buildAmortizationSchedule({
    principal: original,
    annualRatePercent: rate,
    emi,
    startDate: loan.startDate,
    firstDueDate: timeline.firstDueDate,
    periods: timeline.installments,
  });

  // A settled instalment advances the pointer; a prepayment does not.
  const settled = settledInstallmentCount(sorted, lifetime.rows.length);
  const nextIndex = settled >= lifetime.rows.length ? null : settled;
  const nextDueRow = nextIndex === null ? null : lifetime.rows[nextIndex];
  const nextDueDate = nextDueRow ? nextDueRow.date : null;

  const monthsLeft =
    outstanding > 0
      ? (emi > 0 ? remainingTenure(outstanding, rate, emi) : null)
      : 0;

  // The payoff is the LAST remaining instalment on the loan's own timeline.
  // "Today + remaining months" was wrong: it ignored the contractual due dates
  // and took the day-of-month from the wall clock.
  const payoff = outstanding <= 0
    ? (sorted.length ? sorted[sorted.length - 1].date : null)
    : nextDueDate && Number.isFinite(monthsLeft) && monthsLeft > 0
      ? addMonthsClamped(nextDueDate, monthsLeft - 1)
      : null;

  const asOfDay = startOfDay(asOf) || startOfDay(new Date());
  const overdueInstallments = lifetime.rows.reduce((count, row, index) => {
    if (nextIndex !== null && index < nextIndex) return count;
    if (!row.date) return count;
    return startOfDay(row.date).getTime() < asOfDay.getTime() ? count + 1 : count;
  }, 0);

  const progressPercent = original > 0 ? roundHalfUp((repaid / original) * 100, 2) : 0;

  return {
    id: loan.id ?? null,
    name: loan.name ?? null,
    lender: loan.lender ?? null,
    loanType: loan.loanType ?? null,
    isActive: loan.isActive ?? true,
    originalPrincipal: fromPaise(toPaise(original)),
    outstandingPrincipal: outstanding,
    principalRepaid: repaid,
    totalAmountPaid: fromPaise(totalPaid),
    totalInterestPaid: fromPaise(totalInterestPaid),
    progressPercent: clampToZero(progressPercent),
    interestRate: rate,
    emiAmount: emi,
    paymentAccountId: loan.paymentAccountId ?? null,

    // ---- the one repayment timeline ----
    startDate: loan.startDate ?? null,
    emiDay: loan.emiDay ?? null,
    dueDay: timeline.dueDay,
    firstDueDate: timeline.firstDueDate,
    installments: timeline.installments,
    termSource: timeline.termSource,
    finalScheduledDate: timeline.finalDueDate,
    storedEndDate: loan.endDate ?? null,

    // ---- where the borrower actually is on it ----
    nextDueDate,
    settledInstallments: settled,
    overdueInstallments,
    remainingInstallments: nextIndex === null ? 0 : lifetime.rows.length - nextIndex,
    balanceAsOfDate: sorted.length ? sorted[sorted.length - 1].date : null,

    paymentCount: sorted.length,
    pendingPaymentCount: pendingPayments.length,
    lastPaymentDate: sorted.length ? sorted[sorted.length - 1].date : null,
    remainingMonths: Number.isFinite(monthsLeft) ? monthsLeft : null,
    estimatedPayoffDate: payoff,
    isClosed: outstanding <= 0,
  };
};

// ---------------------------------------------------------------------------
// validation (keeps the routes thin and the rules testable offline)
// ---------------------------------------------------------------------------

const LOAN_TYPES = [
  'HOME_LOAN',
  'PERSONAL_LOAN',
  'CAR_LOAN',
  'EDUCATION_LOAN',
  'GOLD_LOAN',
  'BUSINESS_LOAN',
  'CREDIT_CARD_LOAN',
  'OTHER',
];

const MAX_PRINCIPAL = 1e12; // 100,000 crore — Decimal(14,2) cannot hold more

/**
 * Validate and normalise a loan create/update body.
 * Returns `{ ok, errors, value }` — never throws, so a route can answer 400.
 */
const validateLoanInput = (body = {}, { requireAll = true } = {}) => {
  const errors = [];
  const value = {};
  const has = (key) => body[key] !== undefined && body[key] !== null && body[key] !== '';

  if (requireAll || has('name')) {
    if (!has('name') || String(body.name).trim().length === 0) {
      errors.push('Loan name is required.');
    } else if (String(body.name).trim().length > 120) {
      errors.push('Loan name must be 120 characters or fewer.');
    } else {
      value.name = String(body.name).trim();
    }
  }

  if (has('lender')) {
    if (String(body.lender).trim().length > 120) {
      errors.push('Lender must be 120 characters or fewer.');
    } else {
      value.lender = String(body.lender).trim() || null;
    }
  } else if (requireAll) {
    value.lender = null;
  }

  if (has('loanType')) {
    const type = String(body.loanType).trim().toUpperCase();
    if (!LOAN_TYPES.includes(type)) {
      errors.push(`Invalid loan type. Expected one of: ${LOAN_TYPES.join(', ')}.`);
    } else {
      value.loanType = type;
    }
  } else if (requireAll) {
    value.loanType = 'HOME_LOAN';
  }

  const principalGiven = requireAll || has('originalPrincipal');
  if (principalGiven) {
    const principal = num(body.originalPrincipal);
    if (!Number.isFinite(principal) || principal <= 0) {
      errors.push('Original principal must be a positive number.');
    } else if (principal > MAX_PRINCIPAL) {
      errors.push('Original principal is out of range.');
    } else {
      value.originalPrincipal = roundHalfUp(principal, 2);
    }
  }

  if (has('sanctionedLimit')) {
    const limit = num(body.sanctionedLimit);
    if (!Number.isFinite(limit) || limit < 0) {
      errors.push('Sanctioned limit must be a non-negative number.');
    } else if (limit > MAX_PRINCIPAL) {
      errors.push('Sanctioned limit is out of range.');
    } else {
      value.sanctionedLimit = roundHalfUp(limit, 2);
    }
  }

  if (has('currentPrincipal')) {
    const current = num(body.currentPrincipal);
    if (!Number.isFinite(current) || current < 0) {
      errors.push('Current principal must be a non-negative number.');
    } else {
      value.currentPrincipal = roundHalfUp(current, 2);
    }
  }

  if (has('interestRate')) {
    const rate = num(body.interestRate);
    if (!Number.isFinite(rate) || rate < 0) {
      errors.push('Interest rate must be a non-negative number.');
    } else if (rate > 100) {
      errors.push('Interest rate is out of range.');
    } else {
      value.interestRate = roundHalfUp(rate, 3);
    }
  } else if (requireAll) {
    value.interestRate = 0;
  }

  if (has('emiAmount')) {
    const emi = num(body.emiAmount);
    if (!Number.isFinite(emi) || emi < 0) {
      errors.push('EMI amount must be a non-negative number.');
    } else {
      value.emiAmount = roundHalfUp(emi, 2);
    }
  } else if (requireAll) {
    value.emiAmount = null;
  }

  for (const field of ['startDate', 'endDate']) {
    if (has(field)) {
      const parsed = asDate(body[field]);
      if (!parsed) errors.push(`${field === 'startDate' ? 'Start' : 'End'} date is not a valid date.`);
      else value[field] = parsed;
    } else if (requireAll) {
      value[field] = null;
    }
  }

  if (value.startDate && value.endDate && value.endDate < value.startDate) {
    errors.push('End date cannot be before the start date.');
  }

  if (has('emiDay')) {
    const day = Number(body.emiDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      errors.push('EMI day must be a whole number between 1 and 31.');
    } else {
      value.emiDay = day;
    }
  } else if (requireAll) {
    value.emiDay = null;
  }

  if (has('paymentAccountId')) {
    value.paymentAccountId = String(body.paymentAccountId);
  } else if (requireAll) {
    value.paymentAccountId = null;
  }

  if (has('isActive')) {
    value.isActive = Boolean(body.isActive);
  }

  // An explicit instalment count is accepted as an input convenience and is
  // mapped onto an end date by the routes. It is NOT a stored column, so it is
  // always stripped before a Prisma write.
  if (has('installments')) {
    const count = Number(body.installments);
    if (!Number.isInteger(count) || count < 1 || count > MAX_PERIODS) {
      errors.push(`Installments must be a whole number between 1 and ${MAX_PERIODS}.`);
    } else {
      value.installments = count;
    }
  }

  return { ok: errors.length === 0, errors, value };
};

/**
 * Fill in a missing EMI from the principal, rate and tenure. The dashboard and
 * the create route both need this: a user who knows their tenure but not the
 * instalment should still get correct numbers.
 */
const deriveEmiIfMissing = (loan = {}) => {
  if (loan.emiAmount !== null && loan.emiAmount !== undefined && num(loan.emiAmount) > 0) {
    return num(loan.emiAmount);
  }
  // The instalment must be derived over the SAME number of instalments the
  // schedule will use, otherwise the table cannot close on the stated term.
  const timeline = repaymentTimeline({
    startDate: loan.startDate,
    endDate: loan.endDate,
    emiDay: loan.emiDay,
    installments: loan.installments,
    emiAmount: 0,
    interestRate: loan.interestRate ?? 0,
    originalPrincipal: loan.originalPrincipal,
  });
  const months = timeline.installments || 0;
  if (months > 0) {
    // roundUp: a derived EMI must actually clear the stated tenure, otherwise a
    // few paise per month accumulate into an extra period.
    const computed = emiFor(loan.originalPrincipal, loan.interestRate ?? 0, months, {
      roundUp: true,
    });
    return Number.isFinite(computed) ? computed : null;
  }
  return null;
};

module.exports = {
  // constants
  PAISE_PER_RUPEE,
  MAX_PERIODS,
  LOAN_TYPES,
  // scalars
  num,
  isMoney,
  roundHalfUp,
  toPaise,
  fromPaise,
  clampToZero,
  monthlyRate,
  // calendar
  addMonthsClamped,
  monthsBetween,
  startOfDay,
  dueDateInMonth,
  repaymentTimeline,
  settledInstallmentCount,
  // engine
  emiFor,
  splitEmi,
  buildAmortizationSchedule,
  computePaymentAllocation,
  countsTowardBalance,
  sumPrincipalRepaid,
  outstandingBalance,
  remainingTenure,
  payoffDate,
  prepaymentSavings,
  rateChangeImpact,
  summarizeLoan,
  deriveEmiIfMissing,
  // validation
  validateLoanInput,
};
