'use strict';

/**
 * SBI staged-disbursement and historical-ledger tracking (offline).
 *
 * No database, no Express. The acceptance figures supplied for the two SBI loans
 * are used directly as assertions, so the reconciliation identity is checked
 * against the bank's own numbers rather than against this implementation.
 *
 *   Main loan      cumulative disbursement  Rs 44,91,590
 *                  bank balance 30 Sep      Rs 44,78,991
 *   Insurance loan disbursement             Rs 1,86,474
 *                  posted interest           Rs 4,798
 *                  repayments to 14 Oct      Rs 1,91,271.99
 *                  final statement balance   Rs 0.01
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LEDGER_KIND,
  SCHEDULE_STATUS,
  PAYMENT_STATUS,
  IMPORT_ROW_STATUS,
  isCountedPayment,
  reconcileLoanAccount,
  parseCsv,
  parseAmount,
  parseBankDate,
  normaliseImportRows,
  previewImport,
  buildEmiSchedule,
  reviseScheduleFrom,
  stopSchedule,
  nextScheduledDeduction,
  canConfirmScheduleRow,
  summarizeLoanLedger,
  effectiveRateFrom,
} = require('../../src/lib/loanLedger');

const d = (y, m, day) => new Date(y, m - 1, day);

// ---------------------------------------------------------------------------
// The acceptance identity
// ---------------------------------------------------------------------------

const INSURANCE = {
  loan: { originalPrincipal: 186474, sanctionedLimit: 580100, statedBankBalance: 0.01 },
  disbursements: [{ date: d(2026, 5, 20), amount: 186474, reference: 'LP-T1' }],
  interestPostings: [{ date: d(2026, 6, 1), amount: 4798, kind: 'INTEREST', reference: 'LP-INT-1' }],
  payments: [
    {
      date: d(2026, 10, 14),
      totalAmount: 191271.99,
      principalAmount: 186473.99,
      interestAmount: 4798,
      extraPrincipal: 0,
      status: PAYMENT_STATUS.CONFIRMED,
    },
  ],
};

test('ACCEPTANCE: the insurance loan reconciles to a final statement balance of Rs 0.01', () => {
  const r = reconcileLoanAccount(INSURANCE);

  assert.equal(r.disbursedPrincipal, 186474);
  assert.equal(r.totalInterestPosted, 4798);
  assert.equal(r.totalRepaid, 191271.99);

  // 1,86,474 + 4,798 - 1,91,271.99 = 0.01
  assert.equal(r.bankBalance, 0.01);
  assert.equal(r.variance, 0);
  assert.equal(r.reconciled, true);
});

test('ACCEPTANCE: the main loan disbursement and 30 September bank balance', () => {
  const r = reconcileLoanAccount({
    loan: { originalPrincipal: 4491590, sanctionedLimit: 7000000, statedBankBalance: 4478991 },
    disbursements: [
      { date: d(2026, 4, 1), amount: 2000000, reference: 'HL-T1' },
      { date: d(2026, 7, 1), amount: 2491590, reference: 'HL-T2' },
    ],
    interestPostings: [{ date: d(2026, 9, 30), amount: 45000, kind: 'INTEREST' }],
    payments: [
      { date: d(2026, 9, 30), totalAmount: 57599, principalAmount: 0, interestAmount: 45000, status: PAYMENT_STATUS.CONFIRMED },
    ],
    asOf: d(2026, 9, 30),
  });

  assert.equal(r.disbursedPrincipal, 4491590);
  assert.equal(r.bankBalance, 4478991);
  assert.equal(r.variance, 0);
  assert.equal(r.reconciled, true);
});

test('reconciliation: bank balance and outstanding principal are different quantities', () => {
  const r = reconcileLoanAccount(INSURANCE);

  // The bank balance is where the account stood; outstanding principal excludes
  // interest, and neither is a substitute for the other.
  assert.equal(r.bankBalance, 0.01);
  assert.equal(r.outstandingPrincipal, 0.01);
  assert.notEqual(r.totalInterestAndCharges, 0);

  // A loan with unpaid interest must diverge.
  const withUnpaidInterest = reconcileLoanAccount({
    loan: { originalPrincipal: 100000 },
    disbursements: [{ date: d(2026, 1, 1), amount: 100000, reference: 'X' }],
    interestPostings: [{ date: d(2026, 2, 1), amount: 5000, kind: 'INTEREST' }],
    payments: [],
  });
  assert.equal(withUnpaidInterest.bankBalance, 105000);
  assert.equal(withUnpaidInterest.outstandingPrincipal, 100000);
});

test('reconciliation: sanctioned limit is separate from the disbursed principal', () => {
  const r = reconcileLoanAccount({
    loan: { originalPrincipal: 4491590, sanctionedLimit: 7000000 },
    disbursements: [{ date: d(2026, 4, 1), amount: 4491590, reference: 'T1' }],
    interestPostings: [],
    payments: [],
  });

  assert.equal(r.sanctionedLimit, 7000000);
  assert.equal(r.disbursedPrincipal, 4491590);
  assert.equal(r.undrawnLimit, 2508410);
});

test('reconciliation: the disbursement ledger must add up to the principal being repaid', () => {
  const r = reconcileLoanAccount({
    loan: { originalPrincipal: 4491590 },
    disbursements: [{ date: d(2026, 4, 1), amount: 4000000, reference: 'T1' }],
  });
  // Reports the gap instead of silently absorbing it.
  assert.equal(r.disbursementVariance, -491590);
});

test('reconciliation: an as-of date excludes later rows', () => {
  const r = reconcileLoanAccount({
    loan: { originalPrincipal: 100000 },
    disbursements: [
      { date: d(2026, 1, 10), amount: 60000, reference: 'A' },
      { date: d(2026, 5, 10), amount: 40000, reference: 'B' },
    ],
    payments: [],
    asOf: d(2026, 2, 1),
  });
  assert.equal(r.disbursedPrincipal, 60000);
});

test('reconciliation: assumed and rejected payments never move the balance', () => {
  const base = {
    loan: { originalPrincipal: 100000 },
    disbursements: [{ date: d(2026, 1, 1), amount: 100000, reference: 'T1' }],
  };
  const confirmed = reconcileLoanAccount({
    ...base,
    payments: [{ date: d(2026, 2, 1), totalAmount: 10000, principalAmount: 8000, status: PAYMENT_STATUS.CONFIRMED }],
  });
  const assumed = reconcileLoanAccount({
    ...base,
    payments: [{ date: d(2026, 2, 1), totalAmount: 10000, principalAmount: 8000, status: PAYMENT_STATUS.SCHEDULED }],
  });
  const rejected = reconcileLoanAccount({
    ...base,
    payments: [{ date: d(2026, 2, 1), totalAmount: 10000, principalAmount: 8000, status: PAYMENT_STATUS.REJECTED }],
  });

  assert.equal(confirmed.bankBalance, 90000);
  assert.equal(assumed.bankBalance, 100000, 'an assumed deduction is not money that moved');
  assert.equal(rejected.bankBalance, 100000);
  assert.equal(assumed.pendingCount, 1);
  assert.equal(isCountedPayment({ status: 'SCHEDULED' }), false);
  assert.equal(isCountedPayment({ status: 'CONFIRMED' }), true);
  assert.equal(isCountedPayment({}), true, 'legacy rows have no status and are settled');
});

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

test('CSV: quoted fields with commas and escaped quotes survive parsing', () => {
  const rows = parseCsv('a,b\n"1,86,474.00","He said ""paid"""\n');
  assert.deepEqual(rows[1], ['1,86,474.00', 'He said "paid"']);
});

test('CSV: amounts in Indian and rupee formats parse to numbers', () => {
  assert.equal(parseAmount('1,86,474.00'), 186474);
  assert.equal(parseAmount('₹4,798'), 4798);
  assert.equal(parseAmount(' 191271.99 '), 191271.99);
  assert.equal(parseAmount(186474), 186474);
  assert.ok(Number.isNaN(parseAmount('')));
  assert.ok(Number.isNaN(parseAmount('n/a')));
});

test('dates are DAY-FIRST, because bank statements are', () => {
  const march = parseBankDate('03/04/2026');
  assert.equal(march.getDate(), 3);
  assert.equal(march.getMonth(), 3); // April, not March
  assert.equal(march.getFullYear(), 2026);

  assert.equal(parseBankDate('31/12/2026').getMonth(), 11);
  assert.equal(parseBankDate('2026-04-03').getMonth(), 3);
  assert.equal(parseBankDate('3/4/26').getFullYear(), 2026);

  // Impossible dates are rejected, not rolled over into the next month.
  assert.equal(parseBankDate('31/02/2026'), null);
  assert.equal(parseBankDate('not a date'), null);
});

test('an Excel serial date is understood', () => {
  // 46023 = 2026-01-01 in the Excel epoch.
  const serial = parseBankDate('46023');
  assert.equal(serial.getFullYear(), 2026);
  assert.equal(serial.getMonth(), 0);
  assert.equal(serial.getDate(), 1);
});

// ---------------------------------------------------------------------------
// import normalisation and kind inference
// ---------------------------------------------------------------------------

const HEADER_CSV = `Date,Narration,Debit,Reference
20/05/2026,Loan Protect disbursement tranche 1,186474,LP-T1
01/06/2026,Interest charged,4798,LP-INT-1
14/10/2026,Repayment received,191271.99,LP-R1
`;

test('import: rows are normalised and the kind is inferred from the narration', () => {
  const { rows, errors, usedHeader } = normaliseImportRows(HEADER_CSV);
  assert.equal(usedHeader, true);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 3);

  assert.equal(rows[0].kind, LEDGER_KIND.DISBURSEMENT);
  assert.equal(rows[0].amount, 186474);
  assert.equal(rows[0].reference, 'LP-T1');

  assert.equal(rows[1].kind, LEDGER_KIND.INTEREST);
  assert.equal(rows[2].kind, LEDGER_KIND.REPAYMENT);
});

test('import: a repayment without a bank split is flagged, never given an invented split', () => {
  const { rows } = normaliseImportRows(HEADER_CSV);
  const repayment = rows.find((r) => r.kind === LEDGER_KIND.REPAYMENT);
  assert.equal(repayment.allocation, null);
  assert.equal(repayment.allocationVerified, false, 'no split was supplied, so none is claimed');
});

test('import: an explicit bank-verified split is preserved as given', () => {
  const { rows } = normaliseImportRows(`Date,Narration,Amount,Principal,Interest
14/10/2026,Final repayment,191271.99,186473.99,4798
`);
  assert.equal(rows[0].allocation.principalAmount, 186473.99);
  assert.equal(rows[0].allocation.interestAmount, 4798);
  assert.equal(rows[0].allocationVerified, true);
});

test('import: an unreadable date or amount becomes an error, not a dropped row', () => {
  const { rows, errors } = normaliseImportRows(`Date,Narration,Amount
31/02/2026,Bad date,100
01/06/2026,Bad amount,not-a-number
02/06/2026,Good,500
`);
  assert.equal(rows.length, 1);
  assert.equal(errors.length, 2);
  assert.ok(/date/i.test(errors[0].reason));
  assert.ok(/amount/i.test(errors[1].reason));
});

// ---------------------------------------------------------------------------
// dry-run preview: duplicates and blocking
// ---------------------------------------------------------------------------

const EXISTING = {
  loan: { originalPrincipal: 186474 },
  disbursements: [{ date: d(2026, 5, 20), amount: 186474, reference: 'LP-T1' }],
  interestPostings: [{ date: d(2026, 6, 1), amount: 4798, kind: 'INTEREST', reference: 'LP-INT-1' }],
  payments: [
    { date: d(2026, 10, 14), totalAmount: 191271.99, principalAmount: 0, status: PAYMENT_STATUS.CONFIRMED, externalRef: 'LP-R1' },
  ],
};

test('preview: a re-import of the same file is entirely duplicates and writes nothing', () => {
  const preview = previewImport({ input: HEADER_CSV, ...EXISTING });

  assert.equal(preview.summary.new, 0);
  assert.equal(preview.summary.duplicates, 3);
  assert.equal(preview.committed, undefined, 'the preview has no commit field at all');
  for (const row of preview.rows) {
    assert.equal(row.status, IMPORT_ROW_STATUS.DUPLICATE);
  }
});

test('preview: duplicates are caught by reference even when the date differs', () => {
  const preview = previewImport({
    input: `Date,Narration,Amount,Reference
25/05/2026,Disbursement again,186474,LP-T1
`,
    ...EXISTING,
  });
  assert.equal(preview.rows[0].status, IMPORT_ROW_STATUS.DUPLICATE);
  assert.match(preview.rows[0].reason, /reference/i);
});

test('preview: duplicates are caught by date+amount+kind when there is no reference', () => {
  const preview = previewImport({
    input: `Date,Narration,Amount
20/05/2026,Loan disbursement tranche 1,186474
`,
    ...EXISTING,
  });
  assert.equal(preview.rows[0].status, IMPORT_ROW_STATUS.DUPLICATE);
  assert.match(preview.rows[0].reason, /same date, amount and type/i);
});

test('preview: a row repeated inside the same file is caught', () => {
  const preview = previewImport({
    input: `Date,Narration,Amount,Reference
01/01/2027,Disbursement,1000,REF-NEW
01/01/2027,Disbursement,1000,REF-NEW
`,
    ...EXISTING,
  });
  assert.equal(preview.rows[0].status, IMPORT_ROW_STATUS.NEW);
  assert.equal(preview.rows[1].status, IMPORT_ROW_STATUS.DUPLICATE);
  assert.match(preview.rows[1].reason, /twice in this file/i);
});

test('preview: unreadable rows BLOCK the import instead of being skipped', () => {
  const preview = previewImport({
    input: `Date,Narration,Amount
31/02/2026,Bad date,100
01/06/2027,Good,500
`,
    ...EXISTING,
  });
  assert.equal(preview.summary.invalid, 1);
  assert.equal(preview.blocking, true, 'a silently skipped row is how a historical import goes wrong');
});

test('preview: it projects the reconciliation WITHOUT writing anything', () => {
  const empty = { loan: { originalPrincipal: 186474 }, disbursements: [], interestPostings: [], payments: [] };
  const preview = previewImport({ input: HEADER_CSV, ...empty });

  assert.equal(preview.summary.new, 3);
  assert.equal(preview.blocking, false);
  assert.equal(preview.reconciliation.disbursedPrincipal, 186474);
  assert.equal(preview.reconciliation.totalInterestPosted, 4798);
  assert.equal(preview.reconciliation.bankBalance, 0.01);
  // The caller's own arrays are untouched.
  assert.deepEqual(empty.disbursements, [], 'preview must not mutate its inputs');
  assert.deepEqual(empty.payments, []);
});

test('preview: row-by-row totals are reported per ledger kind', () => {
  const preview = previewImport({ input: HEADER_CSV, ...{ loan: { originalPrincipal: 186474 }, disbursements: [], interestPostings: [], payments: [] } });
  assert.equal(preview.summary.totals.disbursement, 186474);
  assert.equal(preview.summary.totals.interest, 4798);
  assert.equal(preview.summary.totals.repayment, 191271.99);
});

// ---------------------------------------------------------------------------
// EMI schedules, pre-EMI, re-pricing and stopping
// ---------------------------------------------------------------------------

test('schedule: rows are generated monthly on the due day, as SCHEDULED only', () => {
  const built = buildEmiSchedule({
    firstDueDate: d(2026, 5, 5),
    installments: 3,
    amount: 51140.13,
    kind: 'EMI',
    dueDay: 5,
  });

  assert.equal(built.count, 3);
  assert.equal(built.total, 153420.39);
  assert.equal(built.rows[0].dueDate.getMonth(), 4);
  assert.equal(built.rows[1].dueDate.getMonth(), 5);
  assert.equal(built.rows[2].dueDate.getMonth(), 6);
  for (const row of built.rows) {
    assert.equal(row.status, SCHEDULE_STATUS.SCHEDULED);
    assert.equal(row.dueDate.getDate(), 5);
  }
});

test('schedule: pre-EMI (construction stage) rows are marked PRE_EMI', () => {
  const built = buildEmiSchedule({ firstDueDate: d(2026, 6, 10), installments: 2, amount: 2800, kind: 'PRE_EMI', dueDay: 10 });
  assert.equal(built.rows[0].kind, 'PRE_EMI');
  assert.equal(built.total, 5600);
  // The default must never be pre-EMI by accident.
  const normal = buildEmiSchedule({ firstDueDate: d(2026, 6, 10), installments: 1, amount: 1000 });
  assert.equal(normal.rows[0].kind, 'EMI');
});

test('schedule: month-end due days clamp', () => {
  const built = buildEmiSchedule({ firstDueDate: d(2026, 2, 28), installments: 2, amount: 100, dueDay: 31 });
  assert.equal(built.rows[0].dueDate.getDate(), 28); // February
  assert.equal(built.rows[1].dueDate.getDate(), 31); // March
});

test('schedule: an invalid request builds nothing rather than a partial schedule', () => {
  for (const bad of [
    { firstDueDate: null, installments: 3, amount: 100 },
    { firstDueDate: d(2026, 1, 1), installments: 0, amount: 100 },
    { firstDueDate: d(2026, 1, 1), installments: 3, amount: 0 },
    { firstDueDate: d(2026, 1, 1), installments: -2, amount: 100 },
  ]) {
    assert.equal(buildEmiSchedule(bad).count, 0);
  }
});

test('re-pricing: changing the deduction amount never rewrites history', () => {
  const existing = [
    { sequence: 1, dueDate: d(2026, 5, 5), amount: 2800, kind: 'PRE_EMI', status: SCHEDULE_STATUS.CONFIRMED },
    { sequence: 2, dueDate: d(2026, 6, 5), amount: 2800, kind: 'PRE_EMI', status: SCHEDULE_STATUS.CONFIRMED },
    { sequence: 3, dueDate: d(2026, 7, 5), amount: 2800, kind: 'PRE_EMI', status: SCHEDULE_STATUS.SCHEDULED },
    { sequence: 4, dueDate: d(2026, 8, 5), amount: 2800, kind: 'PRE_EMI', status: SCHEDULE_STATUS.SCHEDULED },
  ];

  const { kept, revised, changedFrom } = reviseScheduleFrom({ existing, fromSequence: 3, newAmount: 51140.13 });

  assert.equal(changedFrom, 3);
  assert.equal(kept.length, 2);
  assert.equal(revised.length, 2);
  // History is byte-identical.
  assert.deepEqual(kept, existing.slice(0, 2));
  for (const row of revised) assert.equal(row.amount, 51140.13);
});

test('re-pricing: a confirmed row is never re-priced even if selected', () => {
  const existing = [{ sequence: 1, dueDate: d(2026, 5, 5), amount: 2800, status: SCHEDULE_STATUS.CONFIRMED }];
  const { revised } = reviseScheduleFrom({ existing, fromSequence: 1, newAmount: 9999 });
  assert.equal(revised[0].amount, 2800, 'a settled instalment is history');
});

test('stopping: future deductions stop while recorded history survives', () => {
  // The insurance loan: everything is repaid, so nothing more may be deducted.
  const existing = [
    { sequence: 1, dueDate: d(2026, 5, 5), amount: 1402, status: SCHEDULE_STATUS.CONFIRMED },
    { sequence: 2, dueDate: d(2026, 6, 5), amount: 1402, status: SCHEDULE_STATUS.CONFIRMED },
    { sequence: 3, dueDate: d(2026, 7, 5), amount: 1402, status: SCHEDULE_STATUS.SCHEDULED },
    { sequence: 4, dueDate: d(2026, 8, 5), amount: 1402, status: SCHEDULE_STATUS.SCHEDULED },
  ];

  const stopped = stopSchedule({ existing, fromDate: d(2026, 6, 15), reason: 'Loan closed' });

  assert.equal(stopped[0].status, SCHEDULE_STATUS.CONFIRMED);
  assert.equal(stopped[1].status, SCHEDULE_STATUS.CONFIRMED);
  assert.equal(stopped[2].status, SCHEDULE_STATUS.STOPPED);
  assert.equal(stopped[3].status, SCHEDULE_STATUS.STOPPED);
  // Amounts and dates are untouched: only the future intent changed.
  assert.equal(stopped[2].amount, 1402);
  assert.equal(stopped[2].dueDate.getTime(), existing[2].dueDate.getTime());
  // The originals were not mutated.
  assert.equal(existing[2].status, SCHEDULE_STATUS.SCHEDULED);
});

test('stopping: a deduction already in the past is not stopped', () => {
  const existing = [
    { sequence: 1, dueDate: d(2026, 5, 5), amount: 100, status: SCHEDULE_STATUS.SCHEDULED },
    { sequence: 2, dueDate: d(2026, 9, 5), amount: 100, status: SCHEDULE_STATUS.SCHEDULED },
  ];
  const stopped = stopSchedule({ existing, fromDate: d(2026, 6, 1) });
  assert.equal(stopped[0].status, SCHEDULE_STATUS.SCHEDULED);
  assert.equal(stopped[1].status, SCHEDULE_STATUS.STOPPED);
});

test('next deduction: only a SCHEDULED row can be next', () => {
  const rows = [
    { sequence: 1, dueDate: d(2026, 5, 5), status: SCHEDULE_STATUS.CONFIRMED },
    { sequence: 2, dueDate: d(2026, 6, 5), status: SCHEDULE_STATUS.STOPPED },
    { sequence: 3, dueDate: d(2026, 7, 5), status: SCHEDULE_STATUS.SCHEDULED },
    { sequence: 4, dueDate: d(2026, 8, 5), status: SCHEDULE_STATUS.SCHEDULED },
  ];
  assert.equal(nextScheduledDeduction(rows).sequence, 3);
  assert.equal(nextScheduledDeduction([]), null);
  assert.equal(
    nextScheduledDeduction([{ sequence: 1, dueDate: d(2026, 1, 1), status: SCHEDULE_STATUS.STOPPED }]),
    null
  );
});

// ---------------------------------------------------------------------------
// duplicate posting prevention
// ---------------------------------------------------------------------------

test('confirming: a schedule row can be confirmed exactly once', () => {
  assert.equal(canConfirmScheduleRow({ status: SCHEDULE_STATUS.SCHEDULED }).ok, true);
  assert.equal(canConfirmScheduleRow({ status: SCHEDULE_STATUS.CONFIRMED }).ok, false);
  assert.equal(canConfirmScheduleRow({ status: SCHEDULE_STATUS.SCHEDULED, confirmedPaymentId: 'p1' }).ok, false);
  assert.equal(canConfirmScheduleRow({ status: SCHEDULE_STATUS.STOPPED }).ok, false);
  assert.equal(canConfirmScheduleRow({ status: SCHEDULE_STATUS.SKIPPED }).ok, false);
  assert.equal(canConfirmScheduleRow(null).ok, false);

  // The reasons are user-facing, so they must say what happened.
  assert.match(canConfirmScheduleRow({ status: SCHEDULE_STATUS.CONFIRMED }).reason, /already confirmed/i);
  assert.match(canConfirmScheduleRow({ status: SCHEDULE_STATUS.STOPPED }).reason, /stopped/i);
});

// ---------------------------------------------------------------------------
// end to end: a staged-disbursement construction loan
// ---------------------------------------------------------------------------

test('staged disbursement: pre-EMI, conversion, re-pricing and stopping all preserve history', () => {
  // Construction stage: two pre-EMI interest-only deductions, then the loan
  // converts and the full EMI schedule replaces only the SCHEDULED tail.
  const preEmi = buildEmiSchedule({ firstDueDate: d(2026, 5, 5), installments: 3, amount: 2800, kind: 'PRE_EMI', dueDay: 5 });
  const settled = preEmi.rows.map((row) => ({ ...row, status: SCHEDULE_STATUS.CONFIRMED }));
  const scheduled = buildEmiSchedule({ firstDueDate: d(2026, 8, 5), installments: 4, amount: 51140.13, kind: 'EMI', dueDay: 5, startSequence: 4 });

  const combined = [...settled, ...scheduled.rows];

  const { kept, revised } = reviseScheduleFrom({ existing: combined, fromSequence: 4, newAmount: 52000 });
  assert.equal(kept.length, 3, 'settled pre-EMI rows are history');
  assert.equal(revised.length, 4);
  assert.equal(revised[0].amount, 52000);
  for (const row of kept) assert.equal(row.amount, 2800);

  const stopped = stopSchedule({ existing: revised, fromDate: d(2026, 9, 1) });
  assert.equal(stopped.filter((r) => r.status === SCHEDULE_STATUS.STOPPED).length, 3);
});

// ---------------------------------------------------------------------------
// Bank ledger exports: explicit EntryType and charge settlements
// ---------------------------------------------------------------------------

test('an explicit EntryType wins over a misleading narration', () => {
  // "Single sided repayment of CERSAI charges" says "repayment" but the bank
  // classifies it as a charge settlement. The ledger column is authoritative.
  const { rows } = normaliseImportRows(`Date,Narration,Amount,EntryType
04/02/2026,Single sided repayment of CERSAI charges,118,CHARGE_SETTLEMENT
04/02/2026,CERSAI charges recovery,118,CHARGE
10/03/2026,O.S. deposit transfer from linked savings account,20000,REPAYMENT_UNALLOCATED
`);
  assert.equal(rows[0].kind, LEDGER_KIND.CHARGE_SETTLEMENT);
  assert.equal(rows[1].kind, LEDGER_KIND.CHARGE);
  assert.equal(rows[2].kind, LEDGER_KIND.REPAYMENT);
});

test('a fee and its settlement cancel out and neither is a repayment', () => {
  const r = reconcileLoanAccount({
    loan: { originalPrincipal: 2577990 },
    disbursements: [{ date: d(2026, 1, 31), amount: 2577990, reference: 'D1' }],
    interestPostings: [
      { date: d(2026, 1, 31), amount: 9912, kind: 'CHARGE', reference: 'C1' },
      { date: d(2026, 1, 31), amount: 9912, kind: 'CHARGE_SETTLEMENT', reference: 'C2' },
    ],
    payments: [{ date: d(2026, 2, 10), totalAmount: 52000, principalAmount: 0, status: PAYMENT_STATUS.CONFIRMED }],
  });

  assert.equal(r.totalChargesPosted, 0, 'the fee is fully offset');
  assert.equal(r.totalChargeSettlements, 9912);
  assert.equal(r.totalRepaid, 52000, 'the settlement is NOT counted as a repayment');
  // 25,77,990 + 0 + 0 - 52,000
  assert.equal(r.bankBalance, 2525990);
});

test('the insurance loan books one Rs 100 reduction, not two', () => {
  // The bank prints two Rs 100 descriptions on 1 March but only one moves the
  // running balance. Importing both would overstate repayments by Rs 100 and
  // leave the account at -99.99 instead of 0.01.
  const onlyTheRealOne = normaliseImportRows(`Date,Narration,Amount,EntryType,Reference
01/03/2026,Interest repayment GL to loans,100,REPAYMENT_UNALLOCATED,SBI-75022-004
`).rows;
  const bothOfThem = normaliseImportRows(`Date,Narration,Amount,EntryType,Reference
01/03/2026,Interest repayment GL to loans,100,REPAYMENT_UNALLOCATED,SBI-75022-004
01/03/2026,Compound repayment GL to loans,100,REPAYMENT_UNALLOCATED,SBI-75022-005
`).rows;

  const base = {
    loan: { originalPrincipal: 186474 },
    disbursements: [{ date: d(2026, 2, 3), amount: 186474, reference: 'LP-T1' }],
    interestPostings: [{ date: d(2026, 2, 28), amount: 4798, kind: 'INTEREST', reference: 'LP-I1' }],
  };
  const toPayment = (row) => ({ date: row.date, totalAmount: row.amount, principalAmount: 0, status: PAYMENT_STATUS.CONFIRMED });

  const correct = reconcileLoanAccount({ ...base, payments: onlyTheRealOne.map(toPayment) });
  const doubleCounted = reconcileLoanAccount({ ...base, payments: bothOfThem.map(toPayment) });

  // 1,86,474 + 4,798 - 100 = 1,91,172
  assert.equal(correct.bankBalance, 191172);
  assert.equal(doubleCounted.bankBalance, 191072, 'counting both would be 100 too low');
});

test('a zero-amount informational row is rejected rather than imported', () => {
  const { rows, errors } = normaliseImportRows(`Date,Narration,Amount,EntryType
15/10/2026,Rate changed from 7.900 percent to 8.150 percent,0.00,RATE_CHANGE
`);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1, 'a zero amount is not a transaction');
});

// ---------------------------------------------------------------------------
// Dashboard summary: the two SBI loans, reconstructed from their real ledgers
// ---------------------------------------------------------------------------
//
// Schedules use real monthly dates. An earlier hand-built fixture reused one
// date for all twelve rows and made every row look past due, which is exactly
// the class of mistake this suite exists to catch.

const monthlySchedule = (start, count, amount) => {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      sequence: i + 1,
      dueDate: new Date(start.getFullYear(), start.getMonth() + i, start.getDate()),
      amount,
      kind: 'EMI',
      status: SCHEDULE_STATUS.SCHEDULED,
    });
  }
  return rows;
};

/**
 * Split a total into `n` exact paise amounts. Dividing evenly introduces rounding
 * that silently shifts the reconciled balance, which is the opposite of what this
 * suite is for.
 */
const splitTotal = (total, n) => {
  const totalPaise = Math.round(total * 100);
  const base = Math.floor(totalPaise / n);
  const remainder = totalPaise - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i === n - 1 ? remainder : 0)) / 100);
};

const unverifiedPayment = (date, totalAmount) => ({
  date,
  totalAmount,
  principalAmount: 0,
  interestAmount: 0,
  allocationVerified: false,
  status: PAYMENT_STATUS.CONFIRMED,
});

const SBI_MAIN = {
  loan: {
    originalPrincipal: 4491590,
    sanctionedLimit: 7000000,
    interestRate: 7.75,
    emiAmount: 27801,
    startDate: d(2026, 1, 31),
    emiDay: 10,
    statementAsOf: d(2026, 9, 30),
  },
  disbursements: [
    { date: d(2026, 1, 31), amount: 2577990, reference: 'HL-T1' },
    { date: d(2026, 5, 19), amount: 1913600, reference: 'HL-T2' },
  ],
  interestPostings: splitTotal(179401, 9).map((amount) => ({ date: d(2026, 9, 30), amount, kind: 'INTEREST' })),
  payments: splitTotal(192000, 8).map((amount) => unverifiedPayment(d(2026, 9, 10), amount)),
  emiSchedules: monthlySchedule(d(2026, 10, 10), 12, 20000),
  asOf: d(2026, 10, 18),
};

const SBI_INSURANCE = {
  loan: {
    originalPrincipal: 186474,
    sanctionedLimit: 580100,
    interestRate: 8.15,
    startDate: d(2026, 2, 3),
    emiDay: 10,
    settlementPending: true,
    statementAsOf: d(2026, 10, 18),
  },
  disbursements: [{ date: d(2026, 2, 3), amount: 186474, reference: 'LP-T1' }],
  interestPostings: splitTotal(4798, 8).map((amount) => ({ date: d(2026, 9, 30), amount, kind: 'INTEREST' })),
  payments: splitTotal(191271.99, 14).map((amount) => unverifiedPayment(d(2026, 10, 14), amount)),
  emiSchedules: [],
  asOf: d(2026, 10, 18),
};

test('SBI main loan: bank balance is reported with its statement date, principal is not', () => {
  const s = summarizeLoanLedger(SBI_MAIN.loan, SBI_MAIN);

  assert.equal(s.bankBalance, 4478991);
  assert.equal(s.bankBalanceAsOf.getFullYear(), 2026);
  assert.equal(s.bankBalanceAsOf.getMonth(), 8); // September
  assert.equal(s.bankBalanceAsOf.getDate(), 30);

  // The bank never disclosed a principal/interest split, so principal is withheld.
  assert.equal(s.allocationPending, true);
  assert.equal(s.outstandingPrincipal, null);
  assert.equal(s.progressPercent, null);
  assert.equal(s.unverifiedAllocationCount, 8);
  // ...and the bank balance is NOT substituted for it.
  assert.notEqual(s.outstandingPrincipal, s.bankBalance);
});

test('SBI main loan: overdue comes from the real schedule, not a synthetic timeline', () => {
  const s = summarizeLoanLedger(SBI_MAIN.loan, SBI_MAIN);

  // The old logic invented a February 2026 instalment. There is none.
  assert.equal(s.overdueInstallments, 0);
  assert.equal(s.scheduledCount, 12);
  assert.equal(s.confirmedScheduledCount, 0);
  // Exactly one scheduled row (10 Oct) has fallen due and is unconfirmed.
  assert.equal(s.scheduledAwaitingConfirmation, 1);
  assert.equal(s.nextScheduledDueDate.getMonth(), 9); // October
  assert.equal(s.nextScheduledDueDate.getDate(), 10);
  assert.equal(s.nextDueDate.getTime(), s.nextScheduledDueDate.getTime());
});

test('SBI main loan: tenure and payoff are withheld because the arrangement is unknown', () => {
  const s = summarizeLoanLedger(SBI_MAIN.loan, SBI_MAIN);
  assert.equal(s.projectionUnavailable, true);
  assert.equal(s.remainingMonths, null);
  assert.equal(s.estimatedPayoffDate, null);
  assert.ok(s.projectionUnavailableReason && s.projectionUnavailableReason.length > 20);
  // Interest POSTED is separate from interest PAID.
  assert.equal(s.totalInterestPosted, 179401);
  assert.equal(s.totalInterestPaid, 0);
});

test('SBI insurance loan: settlement pending, no overdue and no invented next EMI', () => {
  const s = summarizeLoanLedger(SBI_INSURANCE.loan, SBI_INSURANCE);

  assert.equal(s.status, 'SETTLEMENT_PENDING');
  assert.equal(s.bankBalance, 0.01);
  assert.equal(s.bankBalanceAsOf.getMonth(), 9); // October
  assert.equal(s.bankBalanceAsOf.getDate(), 18);

  assert.equal(s.overdueInstallments, 0);
  assert.equal(s.nextDueDate, null);
  assert.equal(s.nextScheduledDueDate, null);
  assert.equal(s.scheduledAwaitingConfirmation, 0);
  assert.equal(s.hasSchedule, false);
  assert.equal(s.remainingMonths, null);
  assert.equal(s.estimatedPayoffDate, null);
  // History is intact.
  assert.equal(s.paymentCount, 14);
  assert.equal(s.totalRepaid, 191271.99);
});

test('a settlement-pending loan is never treated as an ongoing EMI loan', () => {
  const s = summarizeLoanLedger(SBI_INSURANCE.loan, SBI_INSURANCE);
  assert.equal(s.status, 'SETTLEMENT_PENDING');
  assert.equal(s.isClosed, true);
  assert.notEqual(s.status, 'ACTIVE');

  // Without settlementPending the same ledger would read as closed by balance,
  // never as active.
  const withoutFlag = summarizeLoanLedger({ ...SBI_INSURANCE.loan, settlementPending: false }, SBI_INSURANCE);
  assert.equal(withoutFlag.status, 'CLOSED');
});

test('a verified loan is unaffected by any of this', () => {
  const s = summarizeLoanLedger(
    {
      originalPrincipal: 1000000,
      currentPrincipal: 1000000,
      interestRate: 8.5,
      emiAmount: 8678.24,
      startDate: d(2026, 0, 1),
      emiDay: 5,
    },
    {
      payments: [
        { date: d(2026, 1, 5), totalAmount: 8678.24, principalAmount: 1594.91, interestAmount: 7083.33, allocationVerified: true, status: PAYMENT_STATUS.CONFIRMED },
      ],
      asOf: d(2026, 1, 5),
    }
  );
  assert.equal(s.allocationPending, false);
  assert.equal(s.outstandingPrincipal, 998405.09);
  assert.ok(s.progressPercent > 0);
  assert.equal(s.status, 'ACTIVE');
  // No schedule, so the contractual fallback still supplies a next due date.
  assert.ok(s.nextDueDate instanceof Date);
  assert.equal(s.overdueInstallments, 0);
});
