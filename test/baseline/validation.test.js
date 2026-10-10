'use strict';

/**
 * BASELINE CHARACTERIZATION — VALIDATION PREDICATES
 * ================================================
 * Pins the current (inconsistent) validation and coercion behaviour.
 * Targets of P0-4 and the P1 validation layer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  legacyIncomeAmountGuard,
  legacyExpenseTypeCoerce,
  legacyExpenseTypeOnUpdate,
  legacyIsValidFrequency,
  legacyFrequencyOnUpdate,
  legacyNormaliseMerchant,
  VALID_ACCOUNT_TYPES,
} = require('../support/legacy-logic');

test('income amount guard rejects zero, blank and missing values (correct today)', () => {
  assert.equal(legacyIncomeAmountGuard('0'), true);
  assert.equal(legacyIncomeAmountGuard(''), true);
  assert.equal(legacyIncomeAmountGuard(undefined), true);
  assert.equal(legacyIncomeAmountGuard(null), true);
  assert.equal(legacyIncomeAmountGuard('100.50'), false);
});

test('DEFECT P0-6: income amount guard is bypassable with a non-numeric string', () => {
  // !"abc" is false and NaN <= 0 is false, so the guard passes it through to
  // parseFloat -> NaN -> Prisma error -> HTTP 500 instead of 400.
  assert.equal(legacyIncomeAmountGuard('abc'), false);
  assert.equal(legacyIncomeAmountGuard('1e999'), false); // -> Infinity
});

test('income amount guard DOES reject negatives (do not claim otherwise)', () => {
  assert.equal(legacyIncomeAmountGuard('-5'), true);
});

test('expense type on CREATE is silently coerced, never rejected', () => {
  assert.equal(legacyExpenseTypeCoerce('SAVINGS'), 'SAVINGS');
  assert.equal(legacyExpenseTypeCoerce('EXPENSE'), 'EXPENSE');
  // Anything else becomes EXPENSE without an error:
  assert.equal(legacyExpenseTypeCoerce('savings'), 'EXPENSE');
  assert.equal(legacyExpenseTypeCoerce('FOO'), 'EXPENSE');
  assert.equal(legacyExpenseTypeCoerce(undefined), 'EXPENSE');
});

test('DEFECT P0-6: expense type on UPDATE is written verbatim (no allowlist)', () => {
  // POST allowlists; PUT does not. A bad value drops the row out of every
  // report, because the dashboard filters strictly on EXPENSE / SAVINGS.
  assert.equal(legacyExpenseTypeOnUpdate('FOO', 'EXPENSE'), 'FOO');
  assert.equal(legacyExpenseTypeOnUpdate('savings', 'EXPENSE'), 'savings');
});

test('recurring frequency IS allowlisted on create (correct today)', () => {
  for (const ok of ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']) {
    assert.equal(legacyIsValidFrequency(ok), true);
  }
  for (const bad of ['MONTHLYY', 'monthly', '', null, undefined, 7]) {
    assert.equal(legacyIsValidFrequency(bad), false);
  }
});

test('DEFECT P0-4: recurring frequency on UPDATE is NOT allowlisted', () => {
  // This is the entry point that lets an unrecognised frequency reach the
  // scheduler, where it falls through and refires forever.
  assert.equal(legacyFrequencyOnUpdate('MONTHLYY', 'MONTHLY'), 'MONTHLYY');
  assert.equal(legacyFrequencyOnUpdate('monthly', 'MONTHLY'), 'monthly');
  assert.equal(legacyFrequencyOnUpdate(undefined, 'MONTHLY'), 'MONTHLY');
});

test('account types are an explicit allowlist (correct today)', () => {
  assert.deepEqual(VALID_ACCOUNT_TYPES, [
    'BANK', 'CREDIT_CARD', 'CASH', 'WALLET', 'UPI', 'OTHER',
  ]);
});

test('normaliseMerchant trims, coerces and truncates (correct today)', () => {
  assert.equal(legacyNormaliseMerchant('  Swiggy  '), 'Swiggy');
  assert.equal(legacyNormaliseMerchant(123), '123');
  assert.equal(legacyNormaliseMerchant('x'.repeat(150)).length, 100);
});

test('DEFECT: normaliseMerchant is case- and inner-whitespace sensitive', () => {
  // The unique index is case-sensitive, so these become distinct merchants.
  assert.notEqual(legacyNormaliseMerchant('Swiggy'), legacyNormaliseMerchant('swiggy'));
  assert.equal(legacyNormaliseMerchant('Cafe   Coffee'), 'Cafe   Coffee');
});

test('normaliseMerchant maps blank input to null (correct today)', () => {
  assert.equal(legacyNormaliseMerchant(''), null);
  assert.equal(legacyNormaliseMerchant('   '), null);
  assert.equal(legacyNormaliseMerchant(null), null);
  assert.equal(legacyNormaliseMerchant(undefined), null);
});
