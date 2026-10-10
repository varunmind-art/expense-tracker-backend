'use strict';

/**
 * P0-2 REGRESSION SUITE — authentication token typing
 * ==================================================
 * These are SPEC tests (new behaviour), not characterization tests. They fail
 * against the pre-P0-2 code and must stay green from here on.
 *
 * The one thing they deliberately do NOT prove is atomicity of single-use,
 * because that is a database guarantee (a single conditional UPDATE). It is
 * covered by the DB-backed suite once a non-production database branch is
 * approved; here we prove the shape of the compare-and-swap, not its execution.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const {
  PURPOSE,
  SESSION_TTL,
  RESET_TTL,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  passwordFingerprint,
  fingerprintsMatch,
  signSessionToken,
  signResetToken,
  isSessionPayload,
  isResetPayload,
  validateNewPassword,
  buildResetConsumeArgs,
} = require('../../src/lib/auth-tokens');

const SECRET = 'test-secret-not-a-real-key';
const USER = { id: 'user_1', email: 'a@example.com', password: '$2a$10$storeddigest' };

// ─────────────────────────────────────────────────────────────────────────────
// The original vulnerability: a reset token must not authenticate.
// ─────────────────────────────────────────────────────────────────────────────

test('a password-reset token is REJECTED by session authentication', () => {
  const resetToken = signResetToken(USER, SECRET);
  const decoded = jwt.verify(resetToken, SECRET);
  // Pre-P0-2 this returned true and the token granted full API access.
  assert.equal(isSessionPayload(decoded), false);
});

test('a session token is ACCEPTED by session authentication', () => {
  const sessionToken = signSessionToken(USER, SECRET);
  const decoded = jwt.verify(sessionToken, SECRET);
  assert.equal(isSessionPayload(decoded), true);
});

test('a pre-P0-2 session token without a purpose claim still authenticates', () => {
  // Backward compatibility: deploying P0-2 must not log existing users out.
  const legacy = jwt.sign({ id: USER.id, email: USER.email }, SECRET, { expiresIn: SESSION_TTL });
  assert.equal(isSessionPayload(jwt.verify(legacy, SECRET)), true);
});

test('a token with an unknown purpose is rejected as a session', () => {
  const odd = jwt.sign({ id: USER.id, purpose: 'refresh' }, SECRET);
  assert.equal(isSessionPayload(jwt.verify(odd, SECRET)), false);
});

test('garbage / empty payloads are rejected as sessions', () => {
  for (const bad of [null, undefined, {}, 'string', 42, []]) {
    assert.equal(isSessionPayload(bad), false);
  }
});

test('a session payload without a usable id is rejected (Prisma undefined-filter hazard)', () => {
  // Every handler scopes reads with `userId: req.user.id`. Prisma treats
  // `where: { userId: undefined }` as NO FILTER, which would return every
  // user's rows, so a payload with a missing/blank/non-string id must never
  // be treated as an authenticated session.
  for (const id of [undefined, null, '', 0, 42, {}, []]) {
    assert.equal(
      isSessionPayload({ id, purpose: PURPOSE.SESSION }),
      false,
      `id=${JSON.stringify(id)} must be rejected`
    );
    // Also rejected when the legacy (claim-less) shape omits the purpose.
    assert.equal(isSessionPayload({ id }), false);
  }
  assert.equal(isSessionPayload({ id: 'user_1' }), true);
});

test('a reset payload without a usable id is rejected', () => {
  for (const id of [undefined, null, '', 42, {}]) {
    assert.equal(
      isResetPayload({ id, purpose: PURPOSE.PASSWORD_RESET, pwd: 'fp' }),
      false
    );
  }
});

test('an array payload never passes as a session (typeof [] === "object")', () => {
  assert.equal(isSessionPayload(['session']), false);
  assert.equal(isResetPayload(['password-reset']), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// The reverse direction: a session token must not be usable to reset a password.
// ─────────────────────────────────────────────────────────────────────────────

test('a normal session token is REJECTED as a reset token', () => {
  const sessionToken = signSessionToken(USER, SECRET);
  assert.equal(isResetPayload(jwt.verify(sessionToken, SECRET)), false);
});

test('a reset token is ACCEPTED as a reset token', () => {
  const resetToken = signResetToken(USER, SECRET);
  assert.equal(isResetPayload(jwt.verify(resetToken, SECRET)), true);
});

test('a reset token carrying no fingerprint is rejected', () => {
  const malformed = jwt.sign(
    { id: USER.id, purpose: PURPOSE.PASSWORD_RESET },
    SECRET,
    { expiresIn: RESET_TTL }
  );
  assert.equal(isResetPayload(jwt.verify(malformed, SECRET)), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Expiry
// ─────────────────────────────────────────────────────────────────────────────

test('the reset TTL is short and expiry is enforced by verification', () => {
  assert.equal(RESET_TTL, '15m');
  const expired = signResetToken(USER, SECRET, { expiresIn: '-1s' });
  assert.throws(() => jwt.verify(expired, SECRET), /jwt expired/);
});

test('the session TTL is preserved from the previous behaviour', () => {
  assert.equal(SESSION_TTL, '30d');
});

test('tokens signed with a different secret do not verify', () => {
  const foreign = jwt.sign({ id: USER.id, purpose: PURPOSE.PASSWORD_RESET, pwd: 'x' }, 'other-secret');
  assert.throws(() => jwt.verify(foreign, SECRET));
});

// ─────────────────────────────────────────────────────────────────────────────
// Reset token payload hygiene + password fingerprint binding
// ─────────────────────────────────────────────────────────────────────────────

test('the reset token payload does not leak the email or the bcrypt digest', () => {
  const resetToken = signResetToken(USER, SECRET);
  const decoded = jwt.verify(resetToken, SECRET);
  assert.deepEqual(Object.keys(decoded).sort(), ['exp', 'iat', 'id', 'purpose', 'pwd']);
  assert.equal(decoded.email, undefined);
  // The raw digest must never appear in the token.
  assert.equal(JSON.stringify(decoded).includes(USER.password), false);
  assert.equal(resetToken.includes('$2a$'), false);
});

test('the fingerprint is deterministic, secret-keyed and not the raw digest', () => {
  const fp1 = passwordFingerprint(USER.password, SECRET);
  const fp2 = passwordFingerprint(USER.password, SECRET);
  assert.equal(fp1, fp2);
  assert.notEqual(fp1, USER.password);
  assert.equal(fp1.includes('$2a$'), false);
  // Rotating the secret invalidates every outstanding fingerprint.
  assert.notEqual(fp1, passwordFingerprint(USER.password, 'rotated-secret'));
  // A changed password yields a different fingerprint -> old links stop working.
  assert.notEqual(fp1, passwordFingerprint('$2a$10$newdigest', SECRET));
});

test('passwordFingerprint refuses empty inputs rather than producing a weak value', () => {
  assert.throws(() => passwordFingerprint('', SECRET));
  assert.throws(() => passwordFingerprint(USER.password, ''));
});

test('fingerprintsMatch is true only for an exact equal-length match', () => {
  const fp = passwordFingerprint(USER.password, SECRET);
  assert.equal(fingerprintsMatch(fp, fp), true);
  assert.equal(fingerprintsMatch(fp, passwordFingerprint('other', SECRET)), false);
  assert.equal(fingerprintsMatch(fp, fp.slice(0, -1)), false);
  assert.equal(fingerprintsMatch(fp, null), false);
  assert.equal(fingerprintsMatch(null, fp), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// New-password validation (previously entirely absent)
// ─────────────────────────────────────────────────────────────────────────────

test('validateNewPassword rejects missing/blank/too-short/oversized input', () => {
  assert.equal(validateNewPassword(undefined), 'Password is required.');
  assert.equal(validateNewPassword(''), 'Password is required.');
  assert.equal(validateNewPassword(123), 'Password is required.');
  assert.equal(validateNewPassword('short'), `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  assert.equal(validateNewPassword('a'.repeat(MAX_PASSWORD_BYTES + 1)), `Password must be at most ${MAX_PASSWORD_BYTES} bytes.`);
  // Multi-byte input is measured in bytes, because bcrypt truncates in bytes.
  assert.notEqual(validateNewPassword('é'.repeat(40)), null);
});

test('validateNewPassword accepts a normal password', () => {
  assert.equal(validateNewPassword('correct horse battery'), null);
  assert.equal(validateNewPassword('a'.repeat(MAX_PASSWORD_BYTES)), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Compare-and-swap shape (execution is a DB guarantee, tested separately)
// ─────────────────────────────────────────────────────────────────────────────

test('the consume query pins the stored digest so exactly one writer can win', () => {
  const args = buildResetConsumeArgs('user_1', '$old$digest', '$new$digest');
  assert.deepEqual(args, {
    where: { id: 'user_1', password: '$old$digest' },
    // Phase B adds the revocation marker to the SAME data object, so the
    // password change and the session revocation commit in one statement.
    data: { password: '$new$digest', tokenVersion: { increment: 1 } },
  });
  // The digest in the WHERE clause is what makes consumption atomic: a second
  // concurrent request no longer matches once the first update commits.
  assert.equal(args.where.password, '$old$digest');
  assert.notEqual(args.data.password, args.where.password);
});
