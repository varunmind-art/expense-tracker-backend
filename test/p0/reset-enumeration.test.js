'use strict';

/**
 * P0 (A-2) — forgot-password account enumeration.
 *
 * These are EXECUTABLE tests of the decision the handler runs, not text searches.
 * They prove that the public response is byte-identical for a registered
 * address, an unknown address, and a mail-delivery failure, while the internal
 * decision to send mail still differs (it just never surfaces).
 *
 * HTTP-level coverage (status code and body over the wire) needs the DB-backed
 * suite; noted rather than implied.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  GENERIC_RESET_MESSAGE,
  genericResetResponse,
  planResetRequest,
  planResetDelivery,
} = require('../../src/lib/auth-responses');

// ─────────────────────────────────────────────────────────────────────────────
// The core guarantee: registered and unknown are indistinguishable
// ─────────────────────────────────────────────────────────────────────────────

test('a registered address and an unknown address yield identical public responses', () => {
  const known = planResetRequest({ userExists: true });
  const unknown = planResetRequest({ userExists: false });

  assert.deepEqual(known.response, unknown.response);
  assert.equal(JSON.stringify(known.response), JSON.stringify(unknown.response));
  assert.equal(known.response.message, GENERIC_RESET_MESSAGE);
});

test('the public response carries no field that could leak account existence', () => {
  const response = planResetRequest({ userExists: true }).response;
  assert.deepEqual(Object.keys(response), ['message']);
  assert.equal('userExists' in response, false);
  assert.equal('sent' in response, false);
  assert.equal('shouldSendMail' in response, false);
});

test('mail is sent only for a registered address, and never leaks into the response', () => {
  assert.equal(planResetRequest({ userExists: true }).shouldSendMail, true);
  assert.equal(planResetRequest({ userExists: false }).shouldSendMail, false);
  // The internal flag differs while the external payload does not:
  assert.equal(
    planResetRequest({ userExists: true }).response.message,
    planResetRequest({ userExists: false }).response.message
  );
});

test('the unknown-address path cannot be told apart even by property order', () => {
  // A naive comparison of JSON strings would catch a differing key order.
  const a = JSON.stringify(planResetRequest({ userExists: true }).response);
  const b = JSON.stringify(planResetRequest({ userExists: false }).response);
  assert.equal(a, b);
});

// ─────────────────────────────────────────────────────────────────────────────
// Delivery failures must not leak existence either
// ─────────────────────────────────────────────────────────────────────────────

test('a mail-delivery failure produces the same response as success', () => {
  const success = planResetDelivery({});
  const failure = planResetDelivery({ mailError: new Error('SMTP unavailable') });

  assert.deepEqual(success.response, failure.response);
  assert.deepEqual(success.response, planResetRequest({ userExists: true }).response);
  // The previous behaviour returned HTTP 500 here, which leaked existence by a
  // different route than the 404 did.
});

test('a delivery failure is recorded for operators without exposing an address', () => {
  assert.equal(planResetDelivery({ mailError: new Error('x') }).logLevel, 'error');
  assert.equal(planResetDelivery({}).logLevel, null);
  const response = planResetDelivery({ mailError: new Error('x') }).response;
  assert.equal(JSON.stringify(response).includes('@'), false, 'no address in the response');
});

// ─────────────────────────────────────────────────────────────────────────────
// Shape and hygiene
// ─────────────────────────────────────────────────────────────────────────────

test('every outcome funnels through the same frozen response object', () => {
  const response = genericResetResponse();
  assert.equal(Object.isFrozen(response), true, 'callers cannot mutate the shared payload');
  assert.deepEqual(response, { message: GENERIC_RESET_MESSAGE });
  assert.equal(planResetRequest({}).response.message, GENERIC_RESET_MESSAGE);
  assert.equal(planResetDelivery({}).response.message, GENERIC_RESET_MESSAGE);
  // getters are irrelevant here; the value must be the same for every path.
  assert.equal(typeof GENERIC_RESET_MESSAGE, 'string');
});

test('a malformed plan input still yields the generic response, never an error', () => {
  for (const bad of [undefined, null, {}, { userExists: 0 }, { userExists: 'yes' }]) {
    const plan = planResetRequest(bad);
    assert.equal(plan.response.message, GENERIC_RESET_MESSAGE);
    assert.equal(typeof plan.shouldSendMail, 'boolean');
  }
});

test('the handler uses the tested planner and no longer contains a 404 for unknown email', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
  const start = source.indexOf("'/api/auth/forgot-password'");
  const region = source.slice(start, source.indexOf("'/api/auth/reset-password'", start));

  assert.match(region, /planResetRequest\(/, 'the tested decision must be used');
  assert.match(region, /planResetDelivery\(/, 'delivery outcome must use the tested decision');
  assert.equal(region.includes('No user found with this email.'), false, 'the enumeration oracle must be gone');
  assert.equal(/status\(404\)/.test(region), false, 'no 404 path remains');
  assert.equal(/status\(500\)/.test(region), false, 'a delivery failure must not return 500');
});
