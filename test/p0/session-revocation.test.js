'use strict';

/**
 * P0-2 PHASE B REGRESSION SUITE — session revocation by token version
 * ==================================================================
 * SPEC tests for the new behaviour. They cover the specific verification points
 * requested before the migration may be applied:
 *
 *   1. users with a default/NULL-equivalent marker keep authenticating
 *   2. session tokens issued before a password change are rejected
 *   3. sessions created after a password change authenticate
 *   4. same-second issuance / timestamp precision cannot cause a wrong decision
 *   5. the password change and the revocation marker are written atomically
 *   6. (separately, see migration-additive.test.js) the migration is additive
 *
 * What these tests CANNOT prove: that a real UPDATE is atomic, and that the
 * migration applies cleanly to a real database. Both are database guarantees
 * and belong to the DB-backed suite, which requires an approved non-production
 * database branch. Noted so nobody mistakes these for end-to-end proof.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const {
  DEFAULT_TOKEN_VERSION,
  normaliseTokenVersion,
  tokenVersionOf,
  isSessionVersionCurrent,
  signSessionToken,
  signResetToken,
  isSessionPayload,
  buildResetConsumeArgs,
} = require('../../src/lib/auth-tokens');

const SECRET = 'test-secret-not-a-real-key';
const user = (tokenVersion) => ({
  id: 'user_1',
  email: 'a@example.com',
  password: '$2a$10$storeddigest',
  tokenVersion,
});

// ─────────────────────────────────────────────────────────────────────────────
// POINT 1 — existing users are unaffected by the migration
// ─────────────────────────────────────────────────────────────────────────────

test('POINT 1: a token with no version claim authenticates against version 0', () => {
  // This is exactly what an existing user's token looks like after deploy:
  // issued before Phase B, so it has no `ver` claim, while the new column
  // defaulted to 0. It must keep working.
  const legacy = jwt.sign(
    { id: 'user_1', email: 'a@example.com' },
    SECRET,
    { expiresIn: '30d' }
  );
  const payload = jwt.verify(legacy, SECRET);
  assert.equal(isSessionPayload(payload), true);
  assert.equal(isSessionVersionCurrent(payload, DEFAULT_TOKEN_VERSION), true);
  assert.equal(isSessionVersionCurrent(payload, 0), true);
});

test('POINT 1: the column default equals the assumed legacy version', () => {
  // If these ever diverge, deploying Phase B silently logs every user out.
  assert.equal(DEFAULT_TOKEN_VERSION, 0);
});

test('POINT 1: null/undefined/missing stored versions normalise to 0, not NaN', () => {
  for (const v of [undefined, null, NaN, -1, 1.5, '1', {}, []]) {
    assert.equal(normaliseTokenVersion(v), 0, `normaliseTokenVersion(${String(v)})`);
  }
  assert.equal(normaliseTokenVersion(0), 0);
  assert.equal(normaliseTokenVersion(7), 7);
});

// ─────────────────────────────────────────────────────────────────────────────
// POINTS 2 and 3 — revocation and re-issue
// ─────────────────────────────────────────────────────────────────────────────

test('POINT 2: a token issued before the password change is rejected', () => {
  const before = jwt.verify(signSessionToken(user(0), SECRET), SECRET);
  assert.equal(isSessionVersionCurrent(before, 0), true, 'valid before the change');
  // A password change increments the stored version:
  assert.equal(isSessionVersionCurrent(before, 1), false, 'revoked after the change');
  assert.equal(isSessionVersionCurrent(before, 99), false);
});

test('POINT 3: a session created after the password change authenticates', () => {
  const after = jwt.verify(signSessionToken(user(1), SECRET), SECRET);
  assert.equal(after.ver, 1, 'the token carries the new version');
  assert.equal(isSessionVersionCurrent(after, 1), true);
});

test('POINT 2/3: repeated changes keep revoking the previous generation', () => {
  let stored = 0;
  const revoked = [];

  // Three password changes, each revoking the sessions issued before it.
  for (let i = 0; i < 3; i += 1) {
    revoked.push(jwt.verify(signSessionToken(user(stored), SECRET), SECRET));
    stored += 1; // the password change itself
  }

  // A session created after the final change is the only live one.
  const current = jwt.verify(signSessionToken(user(stored), SECRET), SECRET);

  for (const token of revoked) {
    assert.equal(
      isSessionVersionCurrent(token, stored),
      false,
      `token issued under version ${token.ver} must be revoked`
    );
  }
  assert.equal(isSessionVersionCurrent(current, stored), true);
  assert.equal(current.ver, stored);
});

test('a new user with no tokenVersion field signs under version 0', () => {
  const fresh = jwt.verify(signSessionToken({ id: 'u2', email: 'b@example.com' }, SECRET), SECRET);
  assert.equal(fresh.ver, 0);
  assert.equal(isSessionVersionCurrent(fresh, 0), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// POINT 4 — precision. The version counter removes the clock from the decision.
// ─────────────────────────────────────────────────────────────────────────────

test('POINT 4: the decision never consults a clock — no second/millisecond skew', () => {
  // Two tokens minted in the same millisecond with the same version are both
  // current. Under a `iat` vs `passwordChangedAt` comparison these could differ.
  const a = jwt.verify(signSessionToken(user(3), SECRET), SECRET);
  const b = jwt.verify(signSessionToken(user(3), SECRET), SECRET);
  assert.equal(a.iat, b.iat, 'same second, so a timestamp comparison could not tell them apart');
  assert.equal(isSessionVersionCurrent(a, 3), true);
  assert.equal(isSessionVersionCurrent(b, 3), true);
});

test('POINT 4: the check is pure integer equality (no Date, no tolerance window)', () => {
  // Passing identical versions always accepts, and any difference always
  // rejects, regardless of when the call happens.
  const payload = jwt.verify(signSessionToken(user(5), SECRET), SECRET);
  assert.equal(isSessionVersionCurrent(payload, 5), true);
  assert.equal(isSessionVersionCurrent(payload, 6), false);
  assert.equal(isSessionVersionCurrent(payload, 4), false);
});

test('POINT 4 (documented hazard): a second-truncated iat vs an ms timestamp can wrongly reject', () => {
  // This test documents WHY the timestamp design was not chosen. It asserts the
  // hazard exists in that design, using the same arithmetic the design implies.
  const passwordChangedAt = new Date('2026-10-10T12:00:00.500Z'); // ms precision
  // A JWT `iat` is a NumericDate in whole SECONDS. A token issued in the same
  // second, immediately after the change, has iat = 12:00:00.
  const iatSeconds = Math.floor(new Date('2026-10-10T12:00:00.900Z').getTime() / 1000);
  const iatMs = iatSeconds * 1000;
  // Naive comparison rejects a brand-new, legitimate session:
  assert.equal(iatMs < passwordChangedAt.getTime(), true, 'naive compare wrongly rejects');
  // The fix would have required truncating the stored timestamp to whole
  // seconds, which in turn grants a 1-second grace window in which a stolen
  // pre-change token still works. The version counter has neither problem.
  const truncatedMs = Math.floor(passwordChangedAt.getTime() / 1000) * 1000;
  assert.equal(iatMs < truncatedMs, false, 'truncation fixes it but admits a grace window');
  assert.equal(iatMs === truncatedMs, true, 'and that grace window is exactly 1 second');
});

test('POINT 4: a malformed version claim fails closed', () => {
  const base = { id: 'user_1', purpose: 'session' };
  assert.equal(tokenVersionOf({ ...base, ver: '1' }), null, 'string is not accepted');
  assert.equal(tokenVersionOf({ ...base, ver: 1.5 }), null);
  assert.equal(tokenVersionOf({ ...base, ver: -1 }), null);
  assert.equal(tokenVersionOf({ ...base, ver: null }), null);
  assert.equal(isSessionVersionCurrent({ ...base, ver: '1' }, 1), false);
  assert.equal(isSessionVersionCurrent(null, 0), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Defence in depth: call order matters
// ─────────────────────────────────────────────────────────────────────────────

test('the purpose check must run BEFORE the version check', () => {
  // A reset token carries no `ver`, so it looks like version 0 and the version
  // check alone would pass it. `isSessionPayload` is what rejects it, which is
  // why authenticateToken calls it first.
  const reset = jwt.verify(signResetToken(user(0), SECRET), SECRET);
  assert.equal(isSessionVersionCurrent(reset, 0), true, 'version check alone would accept it');
  assert.equal(isSessionPayload(reset), false, 'the purpose check is what rejects it');
});

// ─────────────────────────────────────────────────────────────────────────────
// POINT 5 — atomicity of password change + revocation marker
// ─────────────────────────────────────────────────────────────────────────────

test('POINT 5: password and revocation marker are written by ONE statement', () => {
  const args = buildResetConsumeArgs('user_1', '$old$digest', '$new$hash');
  // A single data object means a single UPDATE: there is no window in which the
  // password has changed but old sessions are still accepted.
  assert.deepEqual(args.data, {
    password: '$new$hash',
    tokenVersion: { increment: 1 },
  });
  assert.equal(Object.keys(args.data).length, 2);
  assert.deepEqual(args.where, { id: 'user_1', password: '$old$digest' });
});

test('POINT 5: the increment is relative, not absolute (concurrent-safe)', () => {
  // `increment` composes under concurrency; writing an absolute value would let
  // one request clobber another's bump.
  const args = buildResetConsumeArgs('user_1', '$old', '$new');
  assert.deepEqual(args.data.tokenVersion, { increment: 1 });
  assert.equal(typeof args.data.tokenVersion, 'object');
});
