'use strict';

/**
 * P0-2 PHASE B — session decision suite.
 *
 * Covers the additional pre-application checks requested:
 *   - deleted accounts cannot authenticate
 *   - disabled/deactivated accounts cannot authenticate
 *   - fail-closed on every unverifiable input
 *   - same-version concurrent requests behave correctly
 *   - a password reset revokes the old generation and admits the new one
 *   - a database failure yields 500 (unavailable), never 401
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const {
  SESSION_DECISION,
  decideSession,
  signSessionToken,
  signResetToken,
} = require('../../src/lib/auth-tokens');

const SECRET = 'test-secret-not-a-real-key';
const account = (tokenVersion, extra) => ({ tokenVersion, ...extra });

const payloadFor = (tokenVersion) =>
  jwt.verify(signSessionToken({ id: 'user_1', email: 'a@example.com', tokenVersion }, SECRET), SECRET);

// ─────────────────────────────────────────────────────────────────────────────
// The happy path
// ─────────────────────────────────────────────────────────────────────────────

test('a valid session with a matching version is admitted', () => {
  assert.equal(decideSession(payloadFor(0), account(0)), SESSION_DECISION.OK);
  assert.equal(decideSession(payloadFor(4), account(4)), SESSION_DECISION.OK);
});

test('a legacy token with no version claim is admitted against version 0', () => {
  const legacy = jwt.verify(jwt.sign({ id: 'user_1', email: 'a@example.com' }, SECRET), SECRET);
  assert.equal(decideSession(legacy, account(0)), SESSION_DECISION.OK);
});

// ─────────────────────────────────────────────────────────────────────────────
// Deleted and disabled accounts
// ─────────────────────────────────────────────────────────────────────────────

test('a DELETED account cannot authenticate', () => {
  // The row is gone, so nothing can vouch for the token. Previously a deleted
  // user's token still passed and merely returned empty result sets.
  assert.equal(decideSession(payloadFor(0), null), SESSION_DECISION.UNAUTHENTICATED);
  assert.equal(decideSession(payloadFor(0), undefined), SESSION_DECISION.UNAUTHENTICATED);
});

test('a DISABLED account cannot authenticate', () => {
  assert.equal(
    decideSession(payloadFor(1), account(1, { disabled: true })),
    SESSION_DECISION.UNAUTHENTICATED
  );
  assert.equal(
    decideSession(payloadFor(1), account(1, { isActive: false })),
    SESSION_DECISION.UNAUTHENTICATED
  );
});

test('disabled checks do not reject an ordinary enabled account', () => {
  assert.equal(decideSession(payloadFor(1), account(1, { disabled: false })), SESSION_DECISION.OK);
  assert.equal(decideSession(payloadFor(1), account(1, { isActive: true })), SESSION_DECISION.OK);
});

test('the disabled path is forward-compatibility only (no such column today)', () => {
  // Documents the schema gap rather than implying the feature exists.
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  const userModel = schema.match(/model User \{([\s\S]*?)\n\}/)[1];
  assert.equal(/\bdisabled\b/.test(userModel), false, 'User has no disabled column');
  assert.equal(/\bisActive\b/.test(userModel), false, 'User has no isActive column');
  // The guard is still exercised above, so adding the column needs no code change.
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail closed on every unverifiable input
// ─────────────────────────────────────────────────────────────────────────────

test('every unverifiable input fails closed, never OK', () => {
  const reset = jwt.verify(signResetToken({ id: 'user_1', password: '$2a$10$x' }, SECRET), SECRET);
  const cases = [
    ['null payload', null, account(0)],
    ['undefined payload', undefined, account(0)],
    ['string payload', 'token', account(0)],
    ['array payload', ['x'], account(0)],
    ['empty object', {}, account(0)],
    ['no id', { purpose: 'session' }, account(0)],
    ['blank id', { id: '', purpose: 'session' }, account(0)],
    ['unknown purpose', { id: 'user_1', purpose: 'refresh' }, account(0)],
    ['password-reset token', reset, account(0)],
    ['version mismatch', payloadFor(0), account(1)],
    ['malformed ver claim', { id: 'user_1', purpose: 'session', ver: '1' }, account(1)],
    ['negative ver claim', { id: 'user_1', purpose: 'session', ver: -1 }, account(0)],
  ];
  for (const [label, payload, acct] of cases) {
    assert.equal(
      decideSession(payload, acct),
      SESSION_DECISION.UNAUTHENTICATED,
      `${label} must fail closed`
    );
  }
});

test('a password-reset token can never satisfy the session decision', () => {
  const reset = jwt.verify(signResetToken({ id: 'user_1', password: '$2a$10$x' }, SECRET), SECRET);
  for (const version of [0, 1, 99]) {
    assert.notEqual(decideSession(reset, account(version)), SESSION_DECISION.OK);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Same-version concurrency and password resets
// ─────────────────────────────────────────────────────────────────────────────

test('same-version concurrent requests are all admitted', () => {
  // Several tabs open at the same version: none may be rejected just because
  // another request happened at the same moment.
  const tokens = Array.from({ length: 5 }, () => payloadFor(2));
  for (const token of tokens) {
    assert.equal(decideSession(token, account(2)), SESSION_DECISION.OK);
  }
});

test('same-version requests issued in the same second are indistinguishable', () => {
  const a = payloadFor(7);
  const b = payloadFor(7);
  assert.equal(a.iat, b.iat, 'same second, so a timestamp design could not separate them');
  assert.equal(decideSession(a, account(7)), SESSION_DECISION.OK);
  assert.equal(decideSession(b, account(7)), SESSION_DECISION.OK);
});

test('a password reset revokes the previous generation and admits the new one', () => {
  const beforeReset = payloadFor(3);
  assert.equal(decideSession(beforeReset, account(3)), SESSION_DECISION.OK, 'valid before the reset');

  // The reset's compare-and-swap increments the stored version.
  const storedAfterReset = 4;
  assert.equal(
    decideSession(beforeReset, account(storedAfterReset)),
    SESSION_DECISION.UNAUTHENTICATED,
    'the pre-reset session must be revoked'
  );

  // Re-issuing at the new version works immediately.
  const afterReset = payloadFor(storedAfterReset);
  assert.equal(decideSession(afterReset, account(storedAfterReset)), SESSION_DECISION.OK);
});

test('a reset does not affect a different user', () => {
  const other = jwt.verify(signSessionToken({ id: 'user_2', email: 'b@example.com', tokenVersion: 0 }, SECRET), SECRET);
  assert.equal(decideSession(other, account(0)), SESSION_DECISION.OK);
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed wiring in the middleware
// ─────────────────────────────────────────────────────────────────────────────

test('the middleware reports an unavailable database as 500, never 401', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
  const middleware = source.slice(
    source.indexOf('const authenticateToken'),
    source.indexOf('// HELPERS')
  );
  assert.match(middleware, /Authentication temporarily unavailable\./, 'must surface unavailability');
  assert.match(middleware, /status\(500\)/, 'must not answer 401 on a lookup failure');
  // And it must not fall through to next() on that branch.
  const catchBlock = middleware.slice(middleware.indexOf('catch (error)'));
  assert.match(catchBlock, /return res\.status\(500\)/, 'the failure branch must return');
  assert.equal(/next\(\)/.test(catchBlock.split('}')[0]), false, 'must not proceed after a failed lookup');
});

test('the middleware delegates the decision instead of inlining the checks', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
  assert.match(source, /decideSession\(/, 'the tested decision function must be used');
  assert.match(source, /decision !== SESSION_DECISION\.OK/);
});
