'use strict';

/**
 * Loan Tracker (P0-9) — pure loan mathematics, offline.
 *
 * No database, no Prisma, no Express: this file must never import src/server,
 * because requiring it with this repository's .env would arm production
 * schedulers (see test/p0/no-server-import.test.js and the P0-5C.1a incident).
 *
 * The assertions below deliberately mix three kinds of evidence:
 *   1. closed-form values for the EMI formula, so a silent formula change fails;
 *   2. INVARIANTS (the schedule closes to exactly zero, principal repaid equals
 *      principal borrowed, nothing is ever negative) which hold for any input;
 *   3. cross-checks between two independent code paths that must agree.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  emiFor,
  splitEmi,
  buildAmortizationSchedule,
  computePaymentAllocation,
  sumPrincipalRepaid,
  outstandingBalance,
  remainingTenure,
  payoffDate,
  prepaymentSavings,
  rateChangeImpact,
  summarizeLoan,
  deriveEmiIfMissing,
  validateLoanInput,
  roundHalfUp,
  toPaise,
  fromPaise,
  clampToZero,
  monthlyRate,
  addMonthsClamped,
} = require('../../src/lib/loans');

const START = new Date(2026, 0, 1); // 1 Jan 2026, local calendar
const rupees = (n) => Math.round(n * 100); // paise, for exact integer compares

// ---------------------------------------------------------------------------
// 1. Reducing-balance EMI
// ---------------------------------------------------------------------------

test('EMI: the canonical 10,00,000 @ 8.5% over 240 months is 8,678.23', () => {
  // Independently recomputed from EMI = P*r / (1 - (1+r)^-n):
  //   r = 0.085/12 = 0.00708333...
  //   (1+r)^-240 = 0.1837779...
  //   EMI = 1000000 * 0.00708333... / 0.8162220... = 8678.22...
  assert.equal(emiFor(1000000, 8.5, 240), 8678.23);
});

test('EMI: a second closed-form case matches, at a different rate and tenure', () => {
  // 5,00,000 @ 10% over 60 months.
  assert.equal(emiFor(500000, 10, 60), 10623.52);
});

test('EMI: scales linearly with principal at a fixed rate and tenure', () => {
  const single = emiFor(100000, 8.5, 240);
  const double = emiFor(200000, 8.5, 240);
  // Linear up to the 2dp rounding of each EMI (<= 2 paise of drift).
  assert.ok(Math.abs(double - 2 * single) <= 0.02, `${double} vs ${2 * single}`);
});

test('EMI: is monotonic in the interest rate', () => {
  const rates = [0, 1, 5, 8.5, 12, 18, 24];
  const emis = rates.map((r) => emiFor(1000000, r, 240));
  for (let i = 1; i < emis.length; i += 1) {
    assert.ok(emis[i] > emis[i - 1], `EMI fell from ${rates[i - 1]}% to ${rates[i]}%`);
  }
});

test('EMI: is monotonic in the tenure (a longer loan instalment is smaller)', () => {
  const emis = [12, 60, 120, 240, 360].map((n) => emiFor(1000000, 8.5, n));
  for (let i = 1; i < emis.length; i += 1) {
    assert.ok(emis[i] < emis[i - 1], `EMI rose from tenure ${i}`);
  }
});

test('EMI: a long tenure does not overflow to Infinity or NaN', () => {
  // The textbook (1+r)^n form overflows here; the reciprocal form must not.
  const emi = emiFor(5000000, 12, 600);
  assert.ok(Number.isFinite(emi) && emi > 0, `got ${emi}`);
});

test('EMI: rejects unusable inputs rather than returning a number', () => {
  assert.ok(Number.isNaN(emiFor(100000, 8.5, 0)));
  assert.ok(Number.isNaN(emiFor(100000, 8.5, -12)));
  assert.ok(Number.isNaN(emiFor(100000, 8.5, 12.5)));
  assert.ok(Number.isNaN(emiFor(-100000, 8.5, 12)));
  assert.ok(Number.isNaN(emiFor(100000, -1, 12)));
  assert.ok(Number.isNaN(emiFor('abc', 8.5, 12)));
});

// ---------------------------------------------------------------------------
// 8. Zero-interest loans
// ---------------------------------------------------------------------------

test('zero-interest: the EMI is principal divided by tenure', () => {
  assert.equal(emiFor(120000, 0, 12), 10000);
  assert.equal(emiFor(100000, 0, 12), 8333.34); // 8333.333... rounded up
});

test('zero-interest: every rupee of every instalment is principal', () => {
  const emi = emiFor(120000, 0, 12);
  const schedule = buildAmortizationSchedule({
    principal: 120000,
    annualRatePercent: 0,
    emi,
    startDate: START,
  });

  assert.equal(schedule.totalInterest, 0);
  assert.equal(schedule.totalPrincipal, 120000);
  assert.equal(schedule.closesToZero, true);
  for (const row of schedule.rows) {
    assert.equal(row.interest, 0);
    assert.equal(row.principal + row.extraPrincipal, row.totalPayment);
  }
});

test('zero-interest: a principal that does not divide evenly still closes exactly', () => {
  const schedule = buildAmortizationSchedule({
    principal: 10,
    annualRatePercent: 0,
    emi: emiFor(10, 0, 3), // 3.34 -> 3.34*3 = 10.02, an overpay of 2 paise
    startDate: START,
  });
  assert.equal(schedule.closesToZero, true);
  assert.equal(schedule.totalPrincipal, 10);
  assert.equal(schedule.totalInterest, 0);
  assert.equal(rupees(schedule.rows[schedule.rows.length - 1].closingBalance), 0);
});

// ---------------------------------------------------------------------------
// 2. Principal and interest allocation
// ---------------------------------------------------------------------------

test('splitEmi: period 1 of the canonical loan charges interest and retires principal', () => {
  const split = splitEmi(1000000, 8.5, 8678.23);
  assert.equal(split.openingBalance, 1000000);
  assert.equal(split.interest, 7083.33); // 1000000 * 0.085/12 = 7083.333...
  assert.equal(split.principal, 1594.9); // 8678.23 - 7083.33
  assert.equal(split.closingBalance, 998405.1);
  assert.equal(split.isFinal, false);
  assert.equal(split.amortizes, true);
});

test('splitEmi: interest + principal always equals the instalment paid', () => {
  for (const balance of [1000000, 500000.55, 99999.99, 1]) {
    const split = splitEmi(balance, 8.5, 8678.23);
    assert.equal(
      rupees(split.interest + split.principal),
      rupees(split.emi),
      `split does not add up at balance ${balance}`
    );
  }
});

test('splitEmi: a zero balance is already final and costs nothing', () => {
  const split = splitEmi(0, 8.5, 8678.23);
  assert.equal(split.interest, 0);
  assert.equal(split.principal, 0);
  assert.equal(split.closingBalance, 0);
  assert.equal(split.isFinal, true);
});

test('splitEmi: an instalment below the monthly interest does not amortize', () => {
  const split = splitEmi(100000, 24, 100); // interest alone is 2000/month
  assert.equal(split.amortizes, false);
  assert.equal(split.principal, 0);
  assert.equal(split.closingBalance, 100000);
});

test('splitEmi: interest is never charged on more than the outstanding balance', () => {
  // A balance of 1 rupee at 8.5% owes well under 1 paise of interest, so the
  // rounded interest is 1 paise; the principal is then capped at the 1 rupee
  // that is actually owed, and the surplus instalment is simply not taken.
  const split = splitEmi(1, 8.5, 100);
  assert.equal(split.interest, 0.01);
  assert.equal(split.principal, 1);
  assert.equal(split.emi, 1.01); // principal + interest, not the 100 tendered
  assert.equal(split.scheduledEmi, 100);
  assert.equal(split.closingBalance, 0);
  assert.equal(split.isFinal, true);
});

// ---------------------------------------------------------------------------
// 3. Amortization schedules
// ---------------------------------------------------------------------------

test('schedule: a 240-month loan produces 240 periods and closes to exactly zero', () => {
  const schedule = buildAmortizationSchedule({
    principal: 1000000,
    annualRatePercent: 8.5,
    emi: 8678.23,
    startDate: START,
    periods: 240,
  });

  assert.equal(schedule.periods, 240);
  assert.equal(schedule.closesToZero, true);
  assert.equal(schedule.amortizes, true);
  assert.equal(rupees(schedule.rows[239].closingBalance), 0);
  assert.equal(schedule.rows[239].isFinal, true);
});

test('schedule: the final instalment absorbs the rounding remainder', () => {
  const schedule = buildAmortizationSchedule({
    principal: 1000000,
    annualRatePercent: 8.5,
    emi: 8678.23,
    startDate: START,
    periods: 240,
  });

  const final = schedule.rows[239];
  // The last instalment is not the contractual EMI: it carries the remainder.
  assert.notEqual(final.emi, final.scheduledEmi);
  assert.equal(rupees(final.scheduledEmi), 867823);
  assert.equal(rupees(final.emi), 867966);
  // ... and it clears the balance exactly.
  assert.equal(rupees(final.openingBalance) - rupees(final.principal + final.extraPrincipal), 0);
});

test('schedule: principal repaid plus extra principal equals principal borrowed, exactly', () => {
  for (const [principal, rate, months] of [
    [1000000, 8.5, 240],
    [250000, 11.25, 60],
    [999999.99, 7.375, 180],
    [45000, 0, 24],
  ]) {
    const schedule = buildAmortizationSchedule({
      principal,
      annualRatePercent: rate,
      emi: emiFor(principal, rate, months),
      startDate: START,
      periods: months,
    });
    assert.equal(
      rupees(schedule.totalPrincipal + schedule.totalExtra),
      rupees(principal),
      `principal does not balance for ${principal} @ ${rate}% / ${months}`
    );
    assert.equal(schedule.closesToZero, true, `does not close for ${principal} @ ${rate}%`);
  }
});

test('schedule: the balance never goes negative and never increases', () => {
  const schedule = buildAmortizationSchedule({
    principal: 750000,
    annualRatePercent: 9.4,
    emi: emiFor(750000, 9.4, 180),
    startDate: START,
    periods: 180,
  });

  let previous = Infinity;
  for (const row of schedule.rows) {
    assert.ok(row.closingBalance >= 0, `negative closing balance at period ${row.period}`);
    assert.ok(row.interest >= 0 && row.principal >= 0 && row.extraPrincipal >= 0);
    assert.ok(row.closingBalance < previous, `balance did not fall at period ${row.period}`);
    // opening - principal - extra === closing, in exact paise.
    assert.equal(
      rupees(row.openingBalance) - rupees(row.principal) - rupees(row.extraPrincipal),
      rupees(row.closingBalance),
      `row ${row.period} does not reconcile`
    );
    previous = row.closingBalance;
  }
});

test('schedule: consecutive rows carry the balance forward exactly', () => {
  const schedule = buildAmortizationSchedule({
    principal: 1234567.89,
    annualRatePercent: 8.65,
    emi: emiFor(1234567.89, 8.65, 300, { roundUp: true }),
    startDate: START,
  });

  for (let i = 1; i < schedule.rows.length; i += 1) {
    assert.equal(
      rupees(schedule.rows[i].openingBalance),
      rupees(schedule.rows[i - 1].closingBalance),
      `period ${i + 1} does not open where period ${i} closed`
    );
  }
});

test('schedule: floating-point error does not accumulate over 600 periods', () => {
  const schedule = buildAmortizationSchedule({
    principal: 0.03, // 3 paise, 600 periods: the worst case for drift
    annualRatePercent: 0.1,
    emi: 0.01,
    startDate: START,
    maxPeriods: 600,
  });

  assert.equal(schedule.closesToZero, true);
  assert.equal(rupees(schedule.totalPrincipal + schedule.totalExtra), rupees(0.03));
  assert.equal(rupees(schedule.rows[schedule.rows.length - 1].closingBalance), 0);
});

test('schedule: dates step one calendar month and clamp to month end', () => {
  const schedule = buildAmortizationSchedule({
    principal: 120000,
    annualRatePercent: 0,
    emi: 10000,
    startDate: new Date(2026, 0, 31), // 31 Jan
    periods: 12,
  });

  // 31 Jan + 1 month must be 28 Feb, not 3 March.
  assert.equal(schedule.rows[0].date.getMonth(), 1);
  assert.equal(schedule.rows[0].date.getDate(), 28);
  assert.equal(schedule.rows[11].date.getFullYear(), 2027);
  assert.equal(schedule.rows[11].date.getMonth(), 0);
});

test('schedule: without a start date the rows carry a null date instead of an Invalid Date', () => {
  const schedule = buildAmortizationSchedule({ principal: 120000, annualRatePercent: 0, emi: 10000 });
  assert.equal(schedule.rows[0].date, null);
  assert.equal(schedule.closesToZero, true);
});

test('schedule: a non-amortizing loan is reported, not looped on forever', () => {
  const schedule = buildAmortizationSchedule({
    principal: 100000,
    annualRatePercent: 24, // interest is 2000/month, EMI is 100
    emi: 100,
    startDate: START,
  });

  assert.equal(schedule.amortizes, false);
  assert.equal(schedule.closesToZero, false);
  assert.ok(schedule.periods < 5, 'must bail out early, not iterate 1200 times');
});

test('schedule: extra principal is applied every period and shortens the loan', () => {
  const emi = emiFor(1000000, 8.5, 240);
  const plain = buildAmortizationSchedule({
    principal: 1000000,
    annualRatePercent: 8.5,
    emi,
    startDate: START,
    periods: 240,
  });
  const withExtra = buildAmortizationSchedule({
    principal: 1000000,
    annualRatePercent: 8.5,
    emi,
    startDate: START,
    extraPrincipal: 5000,
  });

  assert.ok(withExtra.periods < plain.periods);
  assert.ok(withExtra.totalInterest < plain.totalInterest);
  assert.equal(withExtra.closesToZero, true);
  assert.equal(rupees(withExtra.totalPrincipal + withExtra.totalExtra), rupees(1000000));
  // Every period pays the full 5,000 extra except the last, where only the
  // residual balance is left to clear.
  const extraRows = withExtra.rows.map((row) => row.extraPrincipal);
  assert.deepEqual(extraRows.slice(0, -1), Array(withExtra.periods - 1).fill(5000));
  assert.ok(extraRows[extraRows.length - 1] < 5000, 'the final extra must be the residual only');
});

// ---------------------------------------------------------------------------
// 4. Recording regular payments and additional principal payments
// ---------------------------------------------------------------------------

test('allocation: a regular EMI is split into interest and principal', () => {
  const allocation = computePaymentAllocation({
    openingBalance: 1000000,
    annualRatePercent: 8.5,
    amount: 8678.23,
    kind: 'EMI',
  });

  assert.equal(allocation.ok, true);
  assert.equal(allocation.interestAmount, 7083.33);
  assert.equal(allocation.principalAmount, 1594.9);
  assert.equal(allocation.extraPrincipal, 0);
  assert.equal(allocation.totalAmount, 8678.23);
  assert.equal(allocation.outstandingAfter, 998405.1);
});

test('allocation: totalAmount is principal + interest + extra, never a double count', () => {
  const allocation = computePaymentAllocation({
    openingBalance: 500000,
    annualRatePercent: 9,
    amount: 50000,
    kind: 'PREPAYMENT',
  });
  assert.equal(allocation.principalAmount, 0);
  assert.equal(allocation.interestAmount, 0);
  assert.equal(allocation.extraPrincipal, 50000);
  assert.equal(allocation.totalAmount, 50000);
  assert.equal(allocation.outstandingAfter, 450000);
  assert.equal(allocation.isFinal, false);
});

test('allocation: a prepayment reduces principal immediately and charges no interest', () => {
  const allocation = computePaymentAllocation({
    openingBalance: 200000,
    annualRatePercent: 12,
    amount: 200000,
    kind: 'PREPAYMENT',
  });
  assert.equal(allocation.interestAmount, 0);
  assert.equal(allocation.extraPrincipal, 200000);
  assert.equal(allocation.outstandingAfter, 0);
  assert.equal(allocation.isFinal, true);
});

test('allocation: a payment can never drive the balance below zero', () => {
  const allocation = computePaymentAllocation({
    openingBalance: 50000,
    annualRatePercent: 8.5,
    amount: 500000,
    kind: 'PREPAYMENT',
  });
  assert.equal(allocation.extraPrincipal, 50000);
  assert.equal(allocation.outstandingAfter, 0);
  assert.equal(allocation.isFinal, true);
});

test('allocation: an over-large EMI is capped at the balance and closes the loan', () => {
  const allocation = computePaymentAllocation({
    openingBalance: 10000,
    annualRatePercent: 8.5,
    amount: 100000,
    kind: 'EMI',
  });
  assert.equal(allocation.principalAmount, 10000);
  assert.equal(allocation.outstandingAfter, 0);
  assert.equal(allocation.isFinal, true);
  // The interest actually charged is one month on the real balance, not on the
  // amount tendered.
  assert.equal(allocation.interestAmount, 70.83);
});

test('allocation: interest-only and short payments are recorded without reducing principal', () => {
  const interestOnly = computePaymentAllocation({
    openingBalance: 100000,
    annualRatePercent: 12,
    amount: 1000, // exactly one month of interest
    kind: 'EMI',
  });
  assert.equal(interestOnly.principalAmount, 0);
  assert.equal(interestOnly.interestAmount, 1000);
  assert.equal(interestOnly.outstandingAfter, 100000);
  assert.equal(interestOnly.principalReduced, false);

  const short = computePaymentAllocation({
    openingBalance: 100000,
    annualRatePercent: 12,
    amount: 400, // less than the interest owed
    kind: 'EMI',
  });
  assert.equal(short.interestAmount, 400);
  assert.equal(short.principalAmount, 0);
  assert.equal(short.totalAmount, 400);
});

test('allocation: rejects negative, zero and unusable payments', () => {
  const base = { openingBalance: 100000, annualRatePercent: 8.5, kind: 'EMI' };
  assert.equal(computePaymentAllocation({ ...base, amount: 0 }).ok, false);
  assert.equal(computePaymentAllocation({ ...base, amount: -100 }).ok, false);
  assert.equal(computePaymentAllocation({ ...base, amount: 'abc' }).ok, false);
  assert.equal(computePaymentAllocation({ ...base, amount: 1000, kind: 'NONSENSE' }).ok, false);
  assert.equal(
    computePaymentAllocation({ ...base, openingBalance: 0, amount: 1000 }).ok,
    false,
    'a fully repaid loan must reject further payments'
  );
});

test('allocation: an unknown payment kind cannot be persisted', () => {
  const result = computePaymentAllocation({
    openingBalance: 100000,
    annualRatePercent: 8.5,
    amount: 1000,
    kind: 'TRANSFER',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unsupported payment kind/);
});

// ---------------------------------------------------------------------------
// 5. Outstanding principal
// ---------------------------------------------------------------------------

test('outstanding: equals originalPrincipal minus the principal components actually paid', () => {
  const payments = [
    { id: 'a', date: new Date(2026, 1, 1), principalAmount: 1594.9, extraPrincipal: 0, totalAmount: 8678.23, interestAmount: 7083.33 },
    { id: 'b', date: new Date(2026, 2, 1), principalAmount: 1606.2, extraPrincipal: 0, totalAmount: 8678.23, interestAmount: 7072.03 },
    { id: 'c', date: new Date(2026, 3, 1), principalAmount: 0, extraPrincipal: 100000, totalAmount: 100000, interestAmount: 0 },
  ];

  const original = 1000000;
  const expected = original - (1594.9 + 1606.2 + 100000);
  const outstanding = outstandingBalance({ originalPrincipal: original }, payments);

  assert.equal(rupees(outstanding), rupees(expected));
});

test('outstanding: interest is never subtracted from principal (no double counting)', () => {
  // Same principal repaid, wildly different interest: the balance must not move.
  const principalOnly = outstandingBalance(
    { originalPrincipal: 1000000 },
    [{ id: 'a', date: START, principalAmount: 1000, extraPrincipal: 0, totalAmount: 1000, interestAmount: 0 }]
  );
  const withInterest = outstandingBalance(
    { originalPrincipal: 1000000 },
    [{ id: 'a', date: START, principalAmount: 1000, extraPrincipal: 0, totalAmount: 9000, interestAmount: 8000 }]
  );
  assert.equal(principalOnly, withInterest);
  assert.equal(principalOnly, 999000);
});

test('outstanding: passing the same payment twice does not double-count it', () => {
  const payment = { id: 'dup-1', date: START, principalAmount: 1000, extraPrincipal: 500 };
  const once = outstandingBalance({ originalPrincipal: 100000 }, [payment]);
  const twice = outstandingBalance({ originalPrincipal: 100000 }, [payment, payment]);
  assert.equal(once, twice);
  assert.equal(once, 98500);
});

test('outstanding: never returns a negative balance', () => {
  const outstanding = outstandingBalance(
    { originalPrincipal: 1000 },
    [
      { id: 'a', date: START, principalAmount: 5000, extraPrincipal: 5000 },
      { id: 'b', date: START, principalAmount: 5000, extraPrincipal: 0 },
    ]
  );
  assert.equal(outstanding, 0);
  assert.equal(clampToZero(-123.45), 0);
  assert.equal(clampToZero(-0.01), 0);
});

test('outstanding: payments dated in the future are excluded when an asOf date is given', () => {
  const payments = [
    { id: 'past', date: new Date(2026, 1, 1), principalAmount: 1000, extraPrincipal: 0 },
    { id: 'future', date: new Date(2027, 1, 1), principalAmount: 400000, extraPrincipal: 0 },
  ];
  assert.equal(outstandingBalance({ originalPrincipal: 1000000 }, payments, new Date(2026, 2, 1)), 999000);
  assert.equal(outstandingBalance({ originalPrincipal: 1000000 }, payments, new Date(2028, 0, 1)), 599000);
});

test('outstanding: a loan imported mid-term honours its stored currentPrincipal', () => {
  assert.equal(outstandingBalance({ originalPrincipal: 1000000, currentPrincipal: 640000 }, []), 640000);
});

test('sumPrincipalRepaid: sums principal and extra principal only', () => {
  const repaid = sumPrincipalRepaid([
    { id: 'a', date: START, principalAmount: 100, extraPrincipal: 25, interestAmount: 900, totalAmount: 1025 },
    { id: 'b', date: START, principalAmount: 200, extraPrincipal: 0, interestAmount: 10, totalAmount: 210 },
  ]);
  assert.equal(rupees(repaid), rupees(325));
});

test('sumPrincipalRepaid: reads Prisma Decimal objects, not just numbers', () => {
  // Prisma returns Decimal, which is an object with toNumber()/toString().
  const decimal = (value) => ({ toNumber: () => value, toString: () => String(value) });
  const repaid = sumPrincipalRepaid([{ id: 'a', date: START, principalAmount: decimal(1594.9), extraPrincipal: decimal(0) }]);
  assert.equal(repaid, 1594.9);
});

// ---------------------------------------------------------------------------
// 6. Remaining tenure and payoff date
// ---------------------------------------------------------------------------

test('tenure: a fresh canonical loan has 240 payments left', () => {
  assert.equal(remainingTenure(1000000, 8.5, 8678.23), 241);
  // With the instalment rounded up so it clears in the contractual tenure:
  assert.equal(remainingTenure(1000000, 8.5, 8678.24), 240);
});

test('tenure: agrees with the schedule it describes', () => {
  for (const [balance, rate, emi] of [
    [500000, 8.5, 8678.23],
    [250000, 11, 5500],
    [99999, 0, 10000],
    [100000, 6.5, 2500],
  ]) {
    const months = remainingTenure(balance, rate, emi);
    const schedule = buildAmortizationSchedule({
      principal: balance,
      annualRatePercent: rate,
      emi,
      startDate: START,
    });
    assert.equal(months, schedule.periods, `tenure disagrees for ${balance} @ ${rate}%`);
  }
});

test('tenure: a repaid loan has no remaining tenure', () => {
  assert.equal(remainingTenure(0, 8.5, 8678.23), 0);
  assert.equal(remainingTenure(-100, 8.5, 8678.23), 0);
});

test('tenure: a non-amortizing loan reports null, never "0 months"', () => {
  assert.equal(remainingTenure(100000, 24, 100), null);
  assert.equal(remainingTenure(100000, 8.5, 0), null);
  assert.equal(remainingTenure(100000, 8.5, 500), null); // 500 < 708.33 interest
});

test('payoff date: the canonical loan pays off 240 months after the start', () => {
  const date = payoffDate(1000000, 8.5, 8678.24, START);
  assert.equal(date.getFullYear(), 2046);
  assert.equal(date.getMonth(), 0); // January
});

test('payoff date: respects month-end clamping and a non-amortizing loan gives null', () => {
  const date = payoffDate(120000, 0, 10000, new Date(2026, 0, 31));
  assert.equal(date.getDate(), 31);
  assert.equal(date.getMonth(), 0); // 12 months on from 31 Jan 2026
  assert.equal(date.getFullYear(), 2027);
  assert.equal(payoffDate(100000, 24, 100, START), null);
});

// ---------------------------------------------------------------------------
// 7. Prepayment — interest saved and tenure reduced
// ---------------------------------------------------------------------------

test('prepayment: Decision B shortens the tenure and keeps the EMI', () => {
  const result = prepaymentSavings({
    principal: 1000000,
    annualRatePercent: 8.5,
    emi: 8678.23,
    startDate: START,
    extraAmount: 200000,
    periods: 240,
  });

  assert.equal(result.keepEmi, true);
  assert.equal(result.emiAfter, 8678.23, 'the EMI must be unchanged');
  assert.equal(result.scenario.months, 150);
  assert.equal(result.baseline.months, 240);
  assert.equal(result.monthsSaved, 90);
  assert.equal(result.interestSaved, 581527.79);
  assert.equal(result.newPayoffDate.getFullYear(), 2038);
  assert.equal(result.closesToZero, true);
});

test('prepayment: interest saved and months saved are both strictly positive and consistent', () => {
  for (const extra of [10000, 50000, 100000, 500000]) {
    const result = prepaymentSavings({
      principal: 1000000,
      annualRatePercent: 8.5,
      emi: 8678.23,
      startDate: START,
      extraAmount: extra,
      periods: 240,
    });
    assert.ok(result.interestSaved > 0, `no interest saved on a ${extra} prepayment`);
    assert.ok(result.monthsSaved > 0, `no tenure saved on a ${extra} prepayment`);
    assert.equal(
      result.monthsSaved,
      result.baseline.months - result.scenario.months,
      'monthsSaved must equal the difference between the two schedules'
    );
    assert.ok(
      result.newPayoffDate.getTime() < result.baseline.payoffDate.getTime(),
      'the new payoff date must be earlier'
    );
  }
});

test('prepayment: a larger prepayment always saves more interest and more time', () => {
  const amounts = [25000, 50000, 125000, 250000, 500000];
  const results = amounts.map((extraAmount) =>
    prepaymentSavings({ principal: 1000000, annualRatePercent: 8.5, emi: 8678.23, startDate: START, extraAmount, periods: 240 })
  );
  for (let i = 1; i < results.length; i += 1) {
    assert.ok(results[i].interestSaved > results[i - 1].interestSaved, 'interestSaved not monotonic');
    assert.ok(results[i].monthsSaved >= results[i - 1].monthsSaved, 'monthsSaved not monotonic');
  }
});

test('prepayment: the principal falls immediately by the full prepaid amount', () => {
  const result = prepaymentSavings({
    principal: 1000000,
    annualRatePercent: 8.5,
    emi: 8678.23,
    startDate: START,
    currentBalance: 600000,
    extraAmount: 100000,
    periods: 81,
  });
  assert.equal(result.principalReducedImmediately, 100000);
});

test('prepayment: no prepayment means no savings and an identical payoff date', () => {
  const result = prepaymentSavings({
    principal: 1000000,
    annualRatePercent: 8.5,
    emi: 8678.23,
    startDate: START,
    extraAmount: 0,
    periods: 240,
  });
  assert.equal(result.interestSaved, 0);
  assert.equal(result.monthsSaved, 0);
  assert.equal(result.scenario.months, result.baseline.months);
  assert.equal(result.newPayoffDate.getTime(), result.baseline.payoffDate.getTime());
});

test('prepayment: savings are never negative, even when the extra exceeds the balance', () => {
  const result = prepaymentSavings({
    principal: 1000000,
    annualRatePercent: 8.5,
    emi: 8678.23,
    startDate: START,
    currentBalance: 50000,
    extraAmount: 500000, // more than is owed
  });
  assert.ok(result.interestSaved >= 0);
  assert.ok(result.monthsSaved >= 0);
  assert.equal(result.scenario.months, 0);
  assert.equal(result.principalReducedImmediately, 50000);
});

test('prepayment: the reduce-EMI alternative keeps the tenure and lowers the instalment', () => {
  const result = prepaymentSavings({
    principal: 1000000,
    annualRatePercent: 8.5,
    emi: 8678.23,
    startDate: START,
    extraAmount: 200000,
    periods: 240,
    keepEmi: false,
  });

  assert.equal(result.keepEmi, false);
  assert.ok(result.emiAfter < 8678.23, 'the EMI should fall');
  assert.equal(result.emiAfter, 6942.59);
  assert.equal(result.monthsSaved, 0, 'the tenure is retained by choice');
  assert.equal(result.baseline.months, result.scenario.months);
  assert.ok(result.interestSaved > 0);
  // Reducing the EMI saves less interest than shortening the tenure.
  const tenure = prepaymentSavings({
    principal: 1000000,
    annualRatePercent: 8.5,
    emi: 8678.23,
    startDate: START,
    extraAmount: 200000,
    periods: 240,
  });
  assert.ok(result.interestSaved < tenure.interestSaved);
});

test('prepayment: a monthly extra is applied every period', () => {
  const result = prepaymentSavings({
    principal: 500000,
    annualRatePercent: 9,
    emi: emiFor(500000, 9, 120),
    startDate: START,
    monthlyExtra: 2000,
  });
  assert.ok(result.monthsSaved > 0);
  assert.ok(result.interestSaved > 0);
  assert.equal(result.closesToZero, true);
});

// ---------------------------------------------------------------------------
// 9. Interest-rate changes — forward-looking projections
// ---------------------------------------------------------------------------

test('rate change: past periods are untouched and only the future is re-priced', () => {
  const result = rateChangeImpact({
    originalPrincipal: 1000000,
    annualRatePercent: 8.5,
    emi: 8678.23,
    startDate: START,
    newRatePercent: 9.5,
    fromPeriod: 25,
  });

  assert.equal(result.changedFrom, 25);
  assert.equal(result.unaffectedPeriods, 24);

  // Period 24's numbers must be byte-identical to the 8.5% schedule.
  const baseline = buildAmortizationSchedule({
    principal: 1000000,
    annualRatePercent: 8.5,
    emi: 8678.23,
    startDate: START,
  });
  for (let i = 0; i < 24; i += 1) {
    assert.deepEqual(
      { ...result.rows[i], date: undefined },
      { ...baseline.rows[i], date: undefined },
      `period ${i + 1} was altered by a forward-looking rate change`
    );
  }
});

test('rate change: a higher rate increases total interest and extends the loan', () => {
  const result = rateChangeImpact({
    originalPrincipal: 1000000,
    annualRatePercent: 8.5,
    emi: 8678.23,
    startDate: START,
    newRatePercent: 9.5,
    fromPeriod: 25,
  });

  assert.ok(result.totalInterestDelta > 0, 'a rate rise must cost more');
  assert.ok(result.monthsDelta > 0, 'a rate rise must extend the tenure at a fixed EMI');
  assert.ok(result.newTotalInterest > result.baseline.totalInterest);
  assert.ok(result.newPayoffDate.getTime() > 0);
});

test('rate change: a lower rate reduces total interest and shortens the loan', () => {
  const result = rateChangeImpact({
    originalPrincipal: 1000000,
    annualRatePercent: 8.5,
    emi: 8678.23,
    startDate: START,
    newRatePercent: 7.25,
    fromPeriod: 25,
  });
  assert.ok(result.totalInterestDelta < 0, 'a rate cut must cost less');
  assert.ok(result.monthsDelta < 0, 'a rate cut must shorten the tenure at a fixed EMI');
});

test('rate change: unchanged rate is a no-op', () => {
  const result = rateChangeImpact({
    originalPrincipal: 1000000,
    annualRatePercent: 8.5,
    emi: 8678.23,
    startDate: START,
    newRatePercent: 8.5,
    fromPeriod: 25,
  });
  assert.equal(result.totalInterestDelta, 0);
  assert.equal(result.monthsDelta, 0);
});

test('rate change: reports the EMI needed to hold the original tenure', () => {
  const result = rateChangeImpact({
    originalPrincipal: 1000000,
    annualRatePercent: 8.5,
    emi: 8678.23,
    startDate: START,
    newRatePercent: 9.5,
    fromPeriod: 25,
  });

  assert.equal(result.balanceAtChange, 958436.29);
  assert.ok(result.emiForSameTenure > 8678.23, 'a rate rise needs a larger EMI to hold tenure');
  // That EMI must genuinely clear the balance in the remaining periods.
  const monthsLeft = result.baseline.months - result.unaffectedPeriods;
  assert.equal(
    remainingTenure(result.balanceAtChange, 9.5, result.emiForSameTenure),
    monthsLeft
  );
});

// ---------------------------------------------------------------------------
// summarizeLoan — one consistent set of numbers for every screen
// ---------------------------------------------------------------------------

test('summary: reports outstanding, progress and payoff from one source', () => {
  const loan = {
    id: 'loan-1',
    name: 'Home loan',
    originalPrincipal: 1000000,
    currentPrincipal: 1000000,
    interestRate: 8.5,
    emiAmount: 8678.23,
  };
  const payments = [
    { id: 'a', date: new Date(2026, 1, 1), principalAmount: 1594.9, extraPrincipal: 0, totalAmount: 8678.23, interestAmount: 7083.33 },
  ];

  const summary = summarizeLoan(loan, payments, { asOf: new Date(2026, 1, 1) });

  assert.equal(summary.originalPrincipal, 1000000);
  assert.equal(summary.outstandingPrincipal, 998405.1);
  assert.equal(summary.principalRepaid, 1594.9);
  assert.equal(summary.totalInterestPaid, 7083.33);
  assert.equal(summary.totalAmountPaid, 8678.23);
  assert.equal(summary.progressPercent, 0.16);
  assert.equal(summary.paymentCount, 1);
  assert.equal(summary.isClosed, false);
  assert.ok(summary.remainingMonths > 0);
  assert.ok(summary.estimatedPayoffDate instanceof Date);
});

test('summary: a fully repaid loan is closed and owes nothing', () => {
  const loan = { originalPrincipal: 100000, interestRate: 10, emiAmount: 5000 };
  const payments = [
    { id: 'a', date: new Date(2026, 1, 1), principalAmount: 100000, extraPrincipal: 0, totalAmount: 100000, interestAmount: 0 },
  ];
  const summary = summarizeLoan(loan, payments);
  assert.equal(summary.outstandingPrincipal, 0);
  assert.equal(summary.progressPercent, 100);
  assert.equal(summary.isClosed, true);
  assert.equal(summary.remainingMonths, 0);
});

test('summary: a loan with no payments reports no progress and cannot divide by zero', () => {
  const summary = summarizeLoan({ originalPrincipal: 0, interestRate: 0, emiAmount: 0 }, []);
  assert.equal(summary.outstandingPrincipal, 0);
  assert.equal(summary.progressPercent, 0);
  assert.equal(Number.isFinite(summary.progressPercent), true);
});

// ---------------------------------------------------------------------------
// derived EMI + validation
// ---------------------------------------------------------------------------

test('deriveEmiIfMissing: computes an EMI that clears the stated tenure', () => {
  const emi = deriveEmiIfMissing({
    originalPrincipal: 1000000,
    interestRate: 8.5,
    startDate: new Date(2026, 0, 1),
    endDate: new Date(2046, 0, 1), // 240 months
    emiAmount: null,
  });
  assert.equal(emi, 8678.24); // rounded UP so the final period is not a stub
  assert.equal(remainingTenure(1000000, 8.5, emi), 240);
});

test('deriveEmiIfMissing: respects an EMI the user already supplied', () => {
  assert.equal(
    deriveEmiIfMissing({ originalPrincipal: 1000000, interestRate: 8.5, emiAmount: 9000 }),
    9000
  );
});

test('deriveEmiIfMissing: returns null rather than guessing without a tenure', () => {
  assert.equal(deriveEmiIfMissing({ originalPrincipal: 1000000, interestRate: 8.5 }), null);
});

test('validateLoanInput: accepts a well-formed loan and normalises it', () => {
  const result = validateLoanInput({
    name: '  Home loan  ',
    lender: 'HDFC',
    loanType: 'home_loan',
    originalPrincipal: '1000000',
    interestRate: '8.5',
    emiAmount: 8678.23,
    startDate: '2026-01-01',
    emiDay: 5,
  });

  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.value.name, 'Home loan');
  assert.equal(result.value.loanType, 'HOME_LOAN');
  assert.equal(result.value.originalPrincipal, 1000000);
  assert.equal(result.value.interestRate, 8.5);
  assert.equal(result.value.emiDay, 5);
  assert.ok(result.value.startDate instanceof Date);
});

test('validateLoanInput: rejects negative, missing and malformed values', () => {
  const missing = validateLoanInput({});
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.length >= 1);

  assert.equal(validateLoanInput({ name: 'x', originalPrincipal: -5 }).ok, false);
  assert.equal(validateLoanInput({ name: 'x', originalPrincipal: 0 }).ok, false);
  assert.equal(validateLoanInput({ name: 'x', originalPrincipal: 'abc' }).ok, false);
  assert.equal(validateLoanInput({ name: 'x', originalPrincipal: 1000, interestRate: -1 }).ok, false);
  assert.equal(validateLoanInput({ name: 'x', originalPrincipal: 1000, interestRate: 'abc' }).ok, false);
  assert.equal(validateLoanInput({ name: 'x', originalPrincipal: 1000, loanType: 'MORTGAGE' }).ok, false);
  assert.equal(validateLoanInput({ name: 'x', originalPrincipal: 1000, emiDay: 32 }).ok, false);
  assert.equal(validateLoanInput({ name: 'x', originalPrincipal: 1000, startDate: 'not-a-date' }).ok, false);
  assert.equal(
    validateLoanInput({ name: 'x', originalPrincipal: 1000, startDate: '2026-05-01', endDate: '2026-01-01' }).ok,
    false
  );
});

test('validateLoanInput: a partial update does not demand every field', () => {
  const result = validateLoanInput({ interestRate: 9.25 }, { requireAll: false });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(Object.keys(result.value), ['interestRate']);
});

// ---------------------------------------------------------------------------
// money primitives
// ---------------------------------------------------------------------------

test('rounding: half-up to 2dp, including the classic float traps', () => {
  assert.equal(roundHalfUp(2.675), 2.68); // naive floor(x+0.5) gives 2.67
  assert.equal(roundHalfUp(1.005), 1.01);
  assert.equal(roundHalfUp(0.125), 0.13);
  assert.equal(roundHalfUp(2.674), 2.67);
  assert.equal(roundHalfUp(-2.675), -2.68);
  assert.equal(roundHalfUp(100), 100);
});

test('money: rupees and paise convert exactly, and back', () => {
  for (const value of [0, 0.01, 0.1, 1, 99.99, 8678.23, 1234567.89, 10000000]) {
    assert.equal(fromPaise(toPaise(value)), value, `round trip failed for ${value}`);
  }
  assert.equal(toPaise(8678.23), 867823);
  assert.equal(toPaise(2.675), 268);
  assert.equal(fromPaise(867823), 8678.23);
});

test('money: an unusable input is NaN, while an absent one is zero', () => {
  // "Absent" means zero: a loan with no lender, no EMI, no end date. This is a
  // deliberate contract, so a missing optional field can never poison a sum.
  assert.equal(toPaise(undefined), 0);
  assert.equal(toPaise(null), 0);
  assert.equal(fromPaise(undefined), 0);

  // "Unusable" must never silently become zero, or a malformed request would be
  // read as a zero-rupee loan.
  assert.ok(Number.isNaN(toPaise('abc')));
  assert.ok(Number.isNaN(toPaise({})));
  assert.ok(Number.isNaN(fromPaise(NaN)));
  assert.ok(Number.isNaN(roundHalfUp(Infinity)));
  assert.ok(Number.isNaN(emiFor('abc', 8.5, 12)));
});

test('money: the monthly rate is the annual percentage divided by 1200', () => {
  assert.equal(monthlyRate(12), 0.01);
  assert.equal(monthlyRate(0), 0);
  assert.ok(Math.abs(monthlyRate(8.5) - 0.00708333333) < 1e-10);
  assert.ok(Number.isNaN(monthlyRate(-1)));
});

test('dates: addMonthsClamped never rolls a month-end date into the next month', () => {
  assert.equal(addMonthsClamped(new Date(2026, 0, 31), 1).getDate(), 28);
  assert.equal(addMonthsClamped(new Date(2026, 0, 31), 1).getMonth(), 1);
  assert.equal(addMonthsClamped(new Date(2024, 0, 31), 1).getDate(), 29); // leap year
  assert.equal(addMonthsClamped(new Date(2026, 0, 15), 12).getFullYear(), 2027);
  assert.equal(addMonthsClamped(new Date(2026, 11, 31), 1).getFullYear(), 2027);
  assert.equal(addMonthsClamped(new Date(2026, 11, 31), 1).getMonth(), 0);
});

// ---------------------------------------------------------------------------
// integration of the pure parts: a full loan life, reconciled
// ---------------------------------------------------------------------------

test('end to end: the payment ledger reconciles with the amortization schedule', () => {
  const original = 1000000;
  const rate = 8.5;
  const emi = emiFor(original, rate, 240, { roundUp: true });
  const start = new Date(2026, 0, 1);

  // Record six regular EMIs one at a time, each against the derived balance.
  const payments = [];
  let balance = original;
  for (let month = 1; month <= 6; month += 1) {
    const allocation = computePaymentAllocation({
      openingBalance: balance,
      annualRatePercent: rate,
      amount: emi,
      kind: 'EMI',
      date: addMonthsClamped(start, month),
    });
    assert.equal(allocation.ok, true);
    balance = allocation.outstandingAfter;
    payments.push({ id: `emi-${month}`, ...allocation });
  }

  // The ledger and the schedule are independent code paths over the same loan;
  // after six periods they must agree to the paise.
  const schedule = buildAmortizationSchedule({
    principal: original,
    annualRatePercent: rate,
    emi,
    startDate: start,
    periods: 240,
  });
  assert.equal(
    rupees(schedule.rows[5].closingBalance),
    rupees(balance),
    'the payment ledger and the amortization schedule disagree after six periods'
  );

  // The ledger's own outstanding balance must agree too.
  assert.equal(rupees(outstandingBalance({ originalPrincipal: original }, payments)), rupees(balance));

  // Now a 2,00,000 prepayment in month 7: principal falls immediately, no
  // interest is charged, and the EMI is untouched.
  const prepayment = computePaymentAllocation({
    openingBalance: balance,
    annualRatePercent: rate,
    amount: 200000,
    kind: 'PREPAYMENT',
    date: addMonthsClamped(start, 7),
  });
  assert.equal(prepayment.interestAmount, 0);
  assert.equal(prepayment.extraPrincipal, 200000);
  assert.equal(rupees(prepayment.outstandingAfter), rupees(balance) - rupees(200000));
  payments.push({ id: 'prepay-1', ...prepayment });

  const reduced = prepayment.outstandingAfter;
  assert.equal(rupees(outstandingBalance({ originalPrincipal: original }, payments)), rupees(reduced));

  // The prepayment must genuinely shorten the loan and save interest.
  const simulator = prepaymentSavings({
    principal: original,
    annualRatePercent: rate,
    emi,
    startDate: addMonthsClamped(start, 7),
    currentBalance: reduced,
    extraAmount: 0,
    periods: 234,
  });
  assert.ok(simulator.baseline.months < 240, 'the loan must be shorter after a prepayment');

  const withExtra = prepaymentSavings({
    principal: original,
    annualRatePercent: rate,
    emi,
    startDate: addMonthsClamped(start, 7),
    currentBalance: reduced,
    extraAmount: 100000,
    periods: 234,
  });
  assert.ok(withExtra.interestSaved > 0);
  assert.ok(withExtra.monthsSaved > 0);
  assert.equal(withExtra.emiAfter, emi, 'Decision B: the EMI is retained');
  assert.ok(withExtra.newPayoffDate.getTime() < simulator.baseline.payoffDate.getTime());
});

test('end to end: replaying every payment reaches a zero balance exactly', () => {
  const original = 250000;
  const rate = 11.25;
  const months = 36;
  const emi = emiFor(original, rate, months, { roundUp: true });
  const start = new Date(2026, 0, 1);
  const schedule = buildAmortizationSchedule({
    principal: original,
    annualRatePercent: rate,
    emi,
    startDate: start,
    periods: months,
  });

  // Replay the schedule as if each row had been recorded through the payments
  // API, and confirm the derived balance tracks the schedule to the paise.
  const payments = [];
  let balance = original;
  for (const row of schedule.rows) {
    const allocation = computePaymentAllocation({
      openingBalance: balance,
      annualRatePercent: rate,
      amount: emi,
      kind: 'EMI',
      date: row.date,
    });
    assert.equal(allocation.ok, true, `allocation failed at period ${row.period}`);
    balance = allocation.outstandingAfter;
    assert.equal(rupees(balance), rupees(row.closingBalance), `drift at period ${row.period}`);
    payments.push({ id: `p-${row.period}`, ...allocation });
  }

  assert.equal(rupees(balance), 0, 'the loan must be fully repaid');
  assert.equal(rupees(outstandingBalance({ originalPrincipal: original }, payments)), 0);
  assert.equal(payments.length, months);
  assert.equal(rupees(sumPrincipalRepaid(payments)), rupees(original));
  // Interest paid over the life of the loan must equal the schedule's total.
  const interestPaid = payments.reduce((sum, p) => sum + rupees(p.interestAmount), 0);
  assert.equal(interestPaid, rupees(schedule.totalInterest));
});

