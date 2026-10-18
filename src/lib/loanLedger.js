'use strict';

/**
 * SBI staged-disbursement and historical-ledger tracking.
 *
 * This module is pure: no database, no Express. It exists because a real
 * construction-linked home loan is not one number. It is:
 *
 *   - a SANCTIONED LIMIT that is approved once and may never be fully drawn;
 *   - a DISBURSEMENT LEDGER of tranches the builder actually claimed;
 *   - INTEREST and CHARGES the bank posts on its own schedule;
 *   - REPAYMENTS, some of which are pre-EMI interest only, some full EMIs;
 *   - a BANK ACCOUNT BALANCE, which is not the same thing as outstanding
 *     principal, because it includes interest the borrower has not yet paid.
 *
 * The reconciliation identity, confirmed against the bank's own figures for the
 * Loan Protect account (1,86,474 + 4,798 - 1,91,271.99 = 0.01), is:
 *
 *   bank balance = disbursed + interest posted + charges - repayments
 *
 * Outstanding principal is a different quantity and is never derived from
 * repayments whose principal/interest split the bank has not provided.
 *
 * Money is integer paise, rounded half-up at the boundary, reusing the helpers
 * from ./loans so there is one money implementation in the codebase.
 */

const {
  toPaise,
  fromPaise,
  num,
  roundHalfUp,
  addMonthsClamped,
  dueDateInMonth,
  startOfDay,
} = require('./loans');

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

/** Ledger entry kinds. A repayment is a `LoanPayment`; the rest are ledger rows. */
const LEDGER_KIND = {
  DISBURSEMENT: 'DISBURSEMENT',
  INTEREST: 'INTEREST',
  CHARGE: 'CHARGE',
  // A fee the bank assessed is sometimes immediately offset ("single sided
  // repayment of CERSAI charges"). Both legs are balance-changing and both must
  // be kept, but the offset is NOT a loan repayment: counting it as one would
  // overstate repayments and understate the balance.
  CHARGE_SETTLEMENT: 'CHARGE_SETTLEMENT',
  REPAYMENT: 'REPAYMENT',
};

/** A schedule row never moves money; it only describes a due deduction. */
const SCHEDULE_STATUS = {
  SCHEDULED: 'SCHEDULED',
  CONFIRMED: 'CONFIRMED',
  STOPPED: 'STOPPED',
  SKIPPED: 'SKIPPED',
};

/**
 * A payment's own status. `CONFIRMED` rows are the ones that count towards the
 * balance; `SCHEDULED` rows are assumptions that a deduction will happen and
 * must never be treated as money that has moved.
 */
const PAYMENT_STATUS = {
  CONFIRMED: 'CONFIRMED',
  SCHEDULED: 'SCHEDULED',
  REJECTED: 'REJECTED',
};

const IMPORT_ROW_STATUS = {
  NEW: 'NEW',
  DUPLICATE: 'DUPLICATE',
  INVALID: 'INVALID',
  CONFLICT: 'CONFLICT',
};

const asDate = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Only settled money counts. Assumed and rejected rows never do. */
const isCountedPayment = (payment) => {
  if (!payment) return false;
  const status = String(payment.status || PAYMENT_STATUS.CONFIRMED).toUpperCase();
  return status !== PAYMENT_STATUS.SCHEDULED && status !== PAYMENT_STATUS.REJECTED;
};

const sumPaise = (rows, pick) => {
  let total = 0;
  for (const row of rows || []) {
    if (!row) continue;
    total += Math.max(0, toPaise(pick(row)));
  }
  return total;
};

// ---------------------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile the loan account as the BANK sees it, separately from outstanding
 * principal.
 *
 * @returns {{
 *   sanctionedLimit:number|null, disbursedPrincipal:number, undrawnLimit:number|null,
 *   disbursementVariance:number, totalInterestPosted:number, totalChargesPosted:number,
 *   totalInterestAndCharges:number, totalRepaid:number, principalRepaid:number,
 *   outstandingPrincipal:number, bankBalance:number, statedBankBalance:number|null,
 *   variance:number|null, reconciled:boolean|null, paymentCount:number,
 *   pendingCount:number, asOf:Date|null
 * }}
 */
const reconcileLoanAccount = ({
  loan = {},
  disbursements = [],
  interestPostings = [],
  payments = [],
  asOf = null,
} = {}) => {
  const cutoff = startOfDay(asOf);
  const inWindow = (row) => {
    if (!cutoff) return true;
    const d = startOfDay(row.date);
    return d ? d.getTime() <= cutoff.getTime() : true;
  };

  const disbursementRows = (disbursements || []).filter(Boolean).filter(inWindow);
  const interestRows = (interestPostings || []).filter(Boolean).filter(inWindow);
  const counted = (payments || []).filter(Boolean).filter(isCountedPayment).filter(inWindow);

  const ledgerDisbursedPaise = sumPaise(disbursementRows, (r) => r.amount);
  const sanctionedPaise = loan.sanctionedLimit === null || loan.sanctionedLimit === undefined
    ? null
    : toPaise(loan.sanctionedLimit);

  // When there is no disbursement ledger the drawn principal is the loan's own
  // principal, which is the pre-existing behaviour and keeps simple loans exact.
  const principalPaise = toPaise(loan.originalPrincipal);
  const disbursedPaise = disbursementRows.length > 0 ? ledgerDisbursedPaise : principalPaise;

  const kindOf = (r) => String(r.kind || 'INTEREST').toUpperCase();

  const interestPaise = sumPaise(interestRows.filter((r) => kindOf(r) === 'INTEREST'), (r) => r.amount);
  const chargeGrossPaise = sumPaise(interestRows.filter((r) => kindOf(r) === 'CHARGE'), (r) => r.amount);
  const chargeSettlementPaise = sumPaise(
    interestRows.filter((r) => kindOf(r) === 'CHARGE_SETTLEMENT'),
    (r) => r.amount
  );
  // Net charges: a fee and its offset cancel, so the balance is unaffected.
  const chargePaise = chargeGrossPaise - chargeSettlementPaise;

  const repaidPaise = sumPaise(counted, (p) => p.totalAmount);
  const principalRepaidPaise =
    sumPaise(counted, (p) => p.principalAmount) + sumPaise(counted, (p) => p.extraPrincipal);

  // The bank's account balance and the borrower's outstanding principal diverge
  // by exactly the interest and charges that have been posted but not yet paid.
  const bankBalancePaise = disbursedPaise + interestPaise + chargePaise - repaidPaise;
  const outstandingPaise = Math.max(0, disbursedPaise - principalRepaidPaise);

  const statedPaise =
    loan.statedBankBalance === null || loan.statedBankBalance === undefined
      ? null
      : toPaise(loan.statedBankBalance);

  const pending = (payments || []).filter(
    (p) => p && String(p.status || '').toUpperCase() === PAYMENT_STATUS.SCHEDULED
  );

  return {
    sanctionedLimit: sanctionedPaise === null ? null : fromPaise(sanctionedPaise),
    disbursedPrincipal: fromPaise(disbursedPaise),
    undrawnLimit:
      sanctionedPaise === null ? null : fromPaise(Math.max(0, sanctionedPaise - disbursedPaise)),

    // Useful guard: the ledger should add up to the principal being repaid.
    disbursementVariance: fromPaise(ledgerDisbursedPaise - principalPaise),

    totalInterestPosted: fromPaise(interestPaise),
    totalChargesPosted: fromPaise(chargePaise),
    totalChargeSettlements: fromPaise(chargeSettlementPaise),
    totalInterestAndCharges: fromPaise(interestPaise + chargePaise),

    totalRepaid: fromPaise(repaidPaise),
    principalRepaid: fromPaise(principalRepaidPaise),
    outstandingPrincipal: fromPaise(outstandingPaise),

    bankBalance: fromPaise(bankBalancePaise),
    statedBankBalance: statedPaise === null ? null : fromPaise(statedPaise),
    variance: statedPaise === null ? null : fromPaise(bankBalancePaise - statedPaise),
    // `null` means "not compared", not "failed".
    reconciled:
      statedPaise === null ? null : Math.abs(bankBalancePaise - statedPaise) <= 1, // <= 1 paise

    paymentCount: counted.length,
    pendingCount: pending.length,
    asOf: cutoff ? new Date(cutoff.getTime()) : null,
  };
};

// ---------------------------------------------------------------------------
// CSV parsing (no dependency; RFC4180 quoting)
// ---------------------------------------------------------------------------

/** Split CSV text into rows of cells, honouring quotes and escaped quotes. */
const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const src = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
};

/** "1,86,474.00" / "₹186474" / "186474" -> 186474 */
const parseAmount = (value) => {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  const cleaned = String(value)
    .replace(/[\u20b9,]/g, '')
    .replace(/[()]/g, '')
    .trim();
  if (cleaned === '') return NaN;
  return Number(cleaned);
};

/**
 * Dates arrive as DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, or an Excel serial.
 * Bank statements are day-first, so `03/04/2026` is 3 April, never 4 March.
 */
const parseBankDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const raw = String(value).trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(raw);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = new Date(year, month - 1, day);
    // Reject rollovers such as 31/02.
    if (d.getDate() !== day || d.getMonth() !== month - 1) return null;
    return d;
  }

  // Excel serial date (days since 1899-12-30).
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (serial > 20000 && serial < 80000) {
      const ms = Math.round(serial) * 86400000 + Date.UTC(1899, 11, 30);
      const d = new Date(ms);
      return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
  }

  const parsed = asDate(raw);
  return parsed;
};

const HEADER_ALIASES = {
  date: ['date', 'txn date', 'transaction date', 'value date', 'posting date', 'tran date'],
  amount: ['amount', 'txn amount', 'transaction amount', 'debit', 'credit', 'amount (inr)', 'amount inr'],
  kind: ['type', 'kind', 'txn type', 'transaction type', 'entry type', 'entrytype', 'entry_type'],
  reference: ['reference', 'ref', 'cheque no', 'chq no', 'utr', 'transaction id', 'txn id', 'ref no', 'sourcerowkey', 'source row key', 'sourcekey'],
  note: ['note', 'description', 'narration', 'particulars', 'remarks'],
  principal: ['principal', 'principal amount', 'principal (inr)'],
  interest: ['interest', 'interest amount', 'interest (inr)'],
  extraPrincipal: ['extra principal', 'prepayment', 'extra'],
};

const normaliseHeader = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

/** Map a header row to our field names, or null when it is not a header. */
const mapHeaders = (cells) => {
  const mapping = {};
  let matched = 0;

  cells.forEach((cell, index) => {
    const key = normaliseHeader(cell);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (mapping[field] !== undefined) continue;
      if (aliases.includes(key)) {
        mapping[field] = index;
        matched += 1;
        break;
      }
    }
  });

  // A usable header needs at least a date and an amount.
  if (mapping.date === undefined || mapping.amount === undefined) return null;
  return { mapping, matched };
};

/** Infer DISBURSEMENT / INTEREST / CHARGE / REPAYMENT from the row's own words. */
const EXPLICIT_KIND_ALIASES = {
  DISBURSEMENT: LEDGER_KIND.DISBURSEMENT,
  DISBURSE: LEDGER_KIND.DISBURSEMENT,
  INTEREST: LEDGER_KIND.INTEREST,
  INTEREST_POSTED: LEDGER_KIND.INTEREST,
  CHARGE: LEDGER_KIND.CHARGE,
  FEE: LEDGER_KIND.CHARGE,
  CHARGE_SETTLEMENT: LEDGER_KIND.CHARGE_SETTLEMENT,
  FEE_SETTLEMENT: LEDGER_KIND.CHARGE_SETTLEMENT,
  REPAYMENT: LEDGER_KIND.REPAYMENT,
  REPAYMENT_UNALLOCATED: LEDGER_KIND.REPAYMENT,
  PAYMENT: LEDGER_KIND.REPAYMENT,
};

const inferKind = (rawKind, note, amount) => {
  // A ledger exported by the bank already says what each row is. Trust that
  // column first; only guess from the narration when it is absent or unknown.
  const explicitKey = String(rawKind || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (explicitKey && EXPLICIT_KIND_ALIASES[explicitKey]) return EXPLICIT_KIND_ALIASES[explicitKey];

  const text = `${rawKind || ''} ${note || ''}`.toLowerCase();

  // Word stems, not whole words: bank narrations say "Repayment", "Disbursement",
  // "Installment". A trailing \b after a stem silently fails to match those.
  const isRepayment = /\b(repay\w*|emi\b|instal\w*|prepay\w*|payment\w*|pre-?emi)/.test(text);
  const isInterest = /\binterest\b/.test(text);
  const isCharge = /\b(charge\w*|fee\w*|penalt\w*|gst\b|premium\w*)/.test(text);
  const isDisbursement = /\b(disburs\w*|tranche\w*|draw ?down\w*|release\w*)/.test(text);

  if (isDisbursement) return LEDGER_KIND.DISBURSEMENT;
  // "Interest charged" is interest; a bare "Charge"/"Fee" is a charge. A fee
  // described as already settled is a charge settlement, not a repayment.
  if (isInterest && !isRepayment) return LEDGER_KIND.INTEREST;
  if (isCharge && /\b(settle\w*|recover\w*|reimburse\w*|offset\w*|single.?sided)/.test(text)) {
    return LEDGER_KIND.CHARGE_SETTLEMENT;
  }
  if (isCharge && !isRepayment) return LEDGER_KIND.CHARGE;
  if (isRepayment) return LEDGER_KIND.REPAYMENT;

  const explicit = String(rawKind || '').toUpperCase();
  if (Object.prototype.hasOwnProperty.call(LEDGER_KIND, explicit)) return LEDGER_KIND[explicit];
  // Fall back on direction: a negative amount is money leaving the borrower.
  return amount < 0 ? LEDGER_KIND.REPAYMENT : LEDGER_KIND.DISBURSEMENT;
};

const fingerprint = ({ kind, date, amount }) => {
  const d = asDate(date);
  const stamp = d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : 'no-date';
  return `${kind}|${stamp}|${Math.abs(toPaise(amount))}`;
};

/**
 * Normalise imported rows into ledger candidates.
 *
 * Accepts either CSV/XLSX text (first non-empty row is the header) or an array
 * of already-parsed row objects. Nothing is written; this only parses.
 *
 * @returns {{rows:Array, errors:Array, usedHeader:boolean}}
 */
const normaliseImportRows = (input) => {
  let records = [];
  let usedHeader = false;

  if (typeof input === 'string') {
    const grid = parseCsv(input);
    if (grid.length === 0) return { rows: [], errors: [{ index: 0, reason: 'The file is empty.' }], usedHeader: false };

    const header = mapHeaders(grid[0]);
    if (!header) {
      // No recognisable header: assume date, amount, kind/note order.
      records = grid.map((cells) => ({ date: cells[0], amount: cells[1], note: cells[2] }));
    } else {
      usedHeader = true;
      records = grid.slice(1).map((cells) => {
        const obj = {};
        for (const [field, index] of Object.entries(header.mapping)) obj[field] = cells[index];
        return obj;
      });
    }
  } else if (Array.isArray(input)) {
    records = input;
  } else {
    return { rows: [], errors: [{ index: 0, reason: 'Provide CSV text or an array of rows.' }], usedHeader: false };
  }

  const rows = [];
  const errors = [];

  records.forEach((record, index) => {
    if (!record || typeof record !== 'object') {
      errors.push({ index, reason: 'Row is not an object.' });
      return;
    }

    // Accept already-normalised headers too.
    const pick = (...names) => {
      for (const name of names) {
        const direct = record[name];
        if (direct !== undefined && direct !== null && direct !== '') return direct;
        const found = Object.keys(record).find((k) => normaliseHeader(k) === normaliseHeader(name));
        if (found !== undefined && record[found] !== undefined && record[found] !== '') return record[found];
      }
      return undefined;
    };

    const rawDate = pick('date', 'valueDate', 'txnDate');
    const rawAmount = pick('amount');
    const date = parseBankDate(rawDate);
    const signed = parseAmount(rawAmount);
    const explicitKind = pick('kind', 'type');

    if (!date) {
      errors.push({ index, reason: `Unreadable date: ${JSON.stringify(rawDate ?? '')}` });
      return;
    }
    if (!Number.isFinite(signed) || signed === 0) {
      errors.push({ index, reason: `Unreadable amount: ${JSON.stringify(rawAmount ?? '')}` });
      return;
    }

    const note = pick('note', 'description', 'narration') ?? null;
    const reference = pick('reference', 'ref', 'utr', 'txnId') ?? null;
    const kind = inferKind(explicitKind, note, signed);

    const principal = parseAmount(pick('principal'));
    const interest = parseAmount(pick('interest'));
    const extraPrincipal = parseAmount(pick('extraPrincipal'));

    const hasSplit =
      Number.isFinite(principal) || Number.isFinite(interest) || Number.isFinite(extraPrincipal);

    rows.push({
      index,
      kind,
      date,
      amount: fromPaise(Math.abs(toPaise(signed))),
      reference: reference === null ? null : String(reference).trim() || null,
      note: note === null ? null : String(note).slice(0, 500),
      // A bank-verified split is used only when the file actually provides one.
      allocation: hasSplit
        ? {
            principalAmount: Number.isFinite(principal) ? fromPaise(toPaise(Math.abs(principal))) : 0,
            interestAmount: Number.isFinite(interest) ? fromPaise(toPaise(Math.abs(interest))) : 0,
            extraPrincipal: Number.isFinite(extraPrincipal) ? fromPaise(toPaise(Math.abs(extraPrincipal))) : 0,
          }
        : null,
      allocationVerified: hasSplit,
      fingerprint: fingerprint({ kind, date, amount: signed }),
    });
  });

  return { rows, errors, usedHeader };
};

// ---------------------------------------------------------------------------
// dry-run preview
// ---------------------------------------------------------------------------

/**
 * Classify each candidate row against what is already stored, WITHOUT writing.
 *
 * Duplicates are detected three ways: a matching bank reference, a matching
 * (kind, date, amount) fingerprint, and repetition inside the file itself.
 *
 * @returns {{
 *   rows:Array, summary:object, reconciliation:object|null,
 *   blocking:boolean, duplicates:number, invalid:number, new:number
 * }}
 */
const previewImport = ({
  input,
  loan = {},
  disbursements = [],
  interestPostings = [],
  payments = [],
  duplicateStrategy = 'SKIP',
} = {}) => {
  const parsed = normaliseImportRows(input);

  const existingRefs = new Set();
  const existingFingerprints = new Set();

  const addExisting = (kind, date, amount, reference) => {
    if (reference) existingRefs.add(String(reference));
    existingFingerprints.add(fingerprint({ kind, date, amount }));
  };
  for (const d of disbursements || []) addExisting(LEDGER_KIND.DISBURSEMENT, d.date, d.amount, d.reference);
  for (const i of interestPostings || []) {
    addExisting(String(i.kind || 'INTEREST').toUpperCase(), i.date, i.amount, i.reference);
  }
  for (const p of payments || []) {
    if (!isCountedPayment(p)) continue;
    addExisting(LEDGER_KIND.REPAYMENT, p.date, p.totalAmount, p.externalRef);
  }

  const seenRefs = new Set();
  const seenFingerprints = new Set();

  const rows = parsed.rows.map((row) => {
    const base = { ...row, status: IMPORT_ROW_STATUS.NEW, reason: null };

    if (row.reference && existingRefs.has(row.reference)) {
      return { ...base, status: IMPORT_ROW_STATUS.DUPLICATE, reason: 'This bank reference is already recorded.' };
    }
    if (row.reference && seenRefs.has(row.reference)) {
      return { ...base, status: IMPORT_ROW_STATUS.DUPLICATE, reason: 'The same bank reference appears twice in this file.' };
    }
    if (existingFingerprints.has(row.fingerprint)) {
      return { ...base, status: IMPORT_ROW_STATUS.DUPLICATE, reason: 'A row with the same date, amount and type is already recorded.' };
    }
    if (seenFingerprints.has(row.fingerprint)) {
      return { ...base, status: IMPORT_ROW_STATUS.DUPLICATE, reason: 'The same date, amount and type appears twice in this file.' };
    }

    if (row.reference) seenRefs.add(row.reference);
    seenFingerprints.add(row.fingerprint);

    // A repayment whose split the bank did not give us is importable, but it is
    // flagged so nothing downstream pretends the principal/interest split is known.
    if (row.kind === LEDGER_KIND.REPAYMENT && !row.allocationVerified) {
      return {
        ...base,
        status: IMPORT_ROW_STATUS.NEW,
        reason: 'No bank-verified principal/interest split; the row imports with allocationVerified = false.',
      };
    }

    return base;
  });

  const errors = parsed.errors.map((e) => ({
    ...e,
    kind: null,
    status: IMPORT_ROW_STATUS.INVALID,
    reason: e.reason,
  }));

  const accepted = rows.filter((r) => r.status === IMPORT_ROW_STATUS.NEW || duplicateStrategy === 'OVERWRITE_ALL');
  const duplicates = rows.filter((r) => r.status === IMPORT_ROW_STATUS.DUPLICATE).length;
  const invalid = errors.length;

  // Project the reconciliation as it WOULD look after importing the new rows.
  const onlyNew = rows.filter((r) => r.status === IMPORT_ROW_STATUS.NEW);
  const projected = {
    disbursements: [
      ...(disbursements || []),
      ...onlyNew.filter((r) => r.kind === LEDGER_KIND.DISBURSEMENT).map((r) => ({ date: r.date, amount: r.amount, reference: r.reference })),
    ],
    interestPostings: [
      ...(interestPostings || []),
      ...onlyNew
        .filter(
          (r) =>
            r.kind === LEDGER_KIND.INTEREST ||
            r.kind === LEDGER_KIND.CHARGE ||
            r.kind === LEDGER_KIND.CHARGE_SETTLEMENT
        )
        .map((r) => ({ date: r.date, amount: r.amount, kind: r.kind, reference: r.reference })),
    ],
    payments: [
      ...(payments || []),
      ...onlyNew
        .filter((r) => r.kind === LEDGER_KIND.REPAYMENT)
        .map((r) => ({
          date: r.date,
          totalAmount: r.amount,
          principalAmount: r.allocation ? r.allocation.principalAmount : 0,
          interestAmount: r.allocation ? r.allocation.interestAmount : 0,
          extraPrincipal: r.allocation ? r.allocation.extraPrincipal : 0,
          status: PAYMENT_STATUS.CONFIRMED,
        })),
    ],
  };

  const reconciliation = reconcileLoanAccount({
    loan,
    disbursements: projected.disbursements,
    interestPostings: projected.interestPostings,
    payments: projected.payments,
  });

  const totals = onlyNew.reduce(
    (acc, row) => {
      const key = row.kind.toLowerCase();
      acc[key] = fromPaise(toPaise(acc[key] || 0) + toPaise(row.amount));
      acc.count += 1;
      return acc;
    },
    { count: 0, disbursement: 0, interest: 0, charge: 0, repayment: 0 }
  );

  return {
    rows: [...rows, ...errors],
    errors,
    summary: {
      total: rows.length + errors.length,
      new: onlyNew.length,
      duplicates,
      invalid,
      usedHeader: parsed.usedHeader,
      totals,
    },
    reconciliation,
    // A preview with unreadable rows is not committable: a silently skipped row
    // is exactly how a historical import goes wrong.
    blocking: invalid > 0,
  };
};

// ---------------------------------------------------------------------------
// EMI schedules (scheduled / assumed deductions)
// ---------------------------------------------------------------------------

/**
 * Build the deduction schedule rows for a loan.
 *
 * `kind` is PRE_EMI while the loan is in its construction stage (interest only)
 * and EMI after conversion. Neither value ever moves money.
 *
 * @returns {{rows:Array, total:number, count:number}}
 */
const buildEmiSchedule = ({
  firstDueDate,
  installments,
  amount,
  kind = 'EMI',
  dueDay = null,
  note = null,
  startSequence = 1,
} = {}) => {
  const first = asDate(firstDueDate);
  const count = Number(installments);
  const amountPaise = toPaise(amount);

  if (!first || !Number.isInteger(count) || count <= 0 || !Number.isFinite(amountPaise) || amountPaise <= 0) {
    return { rows: [], total: 0, count: 0 };
  }

  const normalisedKind = String(kind || 'EMI').toUpperCase() === 'PRE_EMI' ? 'PRE_EMI' : 'EMI';
  const rows = [];

  for (let i = 0; i < count; i += 1) {
    const base = addMonthsClamped(first, i);
    const dueDate = dueDay ? dueDateInMonth(base, dueDay) : base;
    rows.push({
      sequence: startSequence + i,
      dueDate,
      amount: fromPaise(amountPaise),
      kind: normalisedKind,
      status: SCHEDULE_STATUS.SCHEDULED,
      note,
    });
  }

  return { rows, total: fromPaise(amountPaise * count), count };
};

/**
 * Change the deduction amount from a given instalment onwards WITHOUT rewriting
 * history. Past rows are returned untouched; the tail is re-priced.
 *
 * This is how a real loan behaves: the bank changes the EMI (rate reset, or the
 * end of pre-EMI), and everything already debited stays exactly as it was.
 *
 * @returns {{kept:Array, revised:Array, changedFrom:number}}
 */
const reviseScheduleFrom = ({
  existing = [],
  fromSequence,
  newAmount,
  note = null,
} = {}) => {
  const sorted = [...(existing || [])].filter(Boolean).sort((a, b) => a.sequence - b.sequence);
  const from = Number(fromSequence);
  const amountPaise = toPaise(newAmount);

  if (!Number.isInteger(from) || from < 1 || !Number.isFinite(amountPaise) || amountPaise <= 0) {
    return { kept: sorted, revised: [], changedFrom: null };
  }

  const kept = sorted.filter((row) => row.sequence < from);
  const tail = sorted.filter((row) => row.sequence >= from);

  const revised = tail.map((row) => {
    // A settled row is history: never re-price it.
    if (String(row.status).toUpperCase() === SCHEDULE_STATUS.CONFIRMED) return row;
    return { ...row, amount: fromPaise(amountPaise), note: note ?? row.note };
  });

  return { kept, revised, changedFrom: from };
};

/**
 * Stop future deductions while preserving everything already settled.
 * Confirmed rows are never stopped; only SCHEDULED rows become STOPPED.
 */
const stopSchedule = ({ existing = [], fromDate = null, reason = null } = {}) => {
  const cutoff = startOfDay(fromDate);
  return [...(existing || [])]
    .filter(Boolean)
    .sort((a, b) => a.sequence - b.sequence)
    .map((row) => {
      const status = String(row.status || '').toUpperCase();
      if (status === SCHEDULE_STATUS.CONFIRMED || status === SCHEDULE_STATUS.STOPPED) return row;
      const due = startOfDay(row.dueDate);
      if (cutoff && due && due.getTime() < cutoff.getTime()) return row;
      return { ...row, status: SCHEDULE_STATUS.STOPPED, note: reason ?? row.note };
    });
};

/**
 * The next deduction that is actually still expected: the earliest SCHEDULED
 * row. Never a CONFIRMED one, never a STOPPED one.
 */
const nextScheduledDeduction = (existing = []) => {
  const candidates = (existing || [])
    .filter((row) => row && String(row.status || '').toUpperCase() === SCHEDULE_STATUS.SCHEDULED)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  return candidates.length > 0 ? candidates[0] : null;
};

/**
 * Whether a payment may settle a schedule row. This is the duplicate-posting
 * guard: a row that already has a confirmed payment cannot be confirmed again.
 */
const canConfirmScheduleRow = (row) => {
  if (!row) return { ok: false, reason: 'Schedule row not found.' };
  const status = String(row.status || '').toUpperCase();
  if (status === SCHEDULE_STATUS.CONFIRMED || row.confirmedPaymentId) {
    return { ok: false, reason: 'This instalment is already confirmed.' };
  }
  if (status === SCHEDULE_STATUS.STOPPED) {
    return { ok: false, reason: 'This instalment was stopped and cannot be confirmed.' };
  }
  if (status === SCHEDULE_STATUS.SKIPPED) {
    return { ok: false, reason: 'This instalment was skipped.' };
  }
  return { ok: true, reason: null };
};

module.exports = {
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
  fingerprint,
  previewImport,
  buildEmiSchedule,
  reviseScheduleFrom,
  stopSchedule,
  nextScheduledDeduction,
  canConfirmScheduleRow,
};
