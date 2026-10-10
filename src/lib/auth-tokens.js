'use strict';

/**
 * P0-2 Phase A — authentication token typing.
 *
 * Purpose
 * -------
 * Before this change, `POST /api/auth/forgot-password` signed a JWT with
 * `{ id }` using the same secret and the same verifier as a session token, so a
 * password-reset link was itself a fully valid Bearer token (1 hour of full API
 * access). Separately, `POST /api/auth/reset-password` accepted ANY valid JWT,
 * so an ordinary session token could be replayed as a reset token.
 *
 * This module makes token purpose explicit in both directions and gives reset
 * tokens single-use semantics without any schema change.
 *
 * Phase B (this file, schema approval pending application) adds a monotonic
 * per-user `tokenVersion`. Every session token embeds the version it was issued
 * under; a password change increments the stored version, which invalidates
 * every previously issued session token for that user.
 *
 * Why a version counter rather than comparing the token's `iat` against a
 * `passwordChangedAt` timestamp — the design that was originally approved:
 *   - JWT `iat` has SECOND precision while a DB timestamp has millisecond
 *     precision, so a token issued in the same second as the change can compare
 *     as "older" and be wrongly rejected. A counter has no clock at all.
 *   - It needs no clock-skew tolerance and behaves identically across instances
 *     regardless of their clocks.
 *   - Revocation is exact equality, so there is no grace window in which a
 *     stolen pre-change token still works.
 *   - It also gives "sign out everywhere" for free.
 * Both designs require one user read per authenticated request, so the counter
 * costs nothing extra. See test/p0/session-revocation.test.js.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const PURPOSE = Object.freeze({
  SESSION: 'session',
  PASSWORD_RESET: 'password-reset',
});

/** Preserved from the pre-P0-2 behaviour so existing sessions are unaffected. */
const SESSION_TTL = '30d';

/** P0-2: reduced from 1h. A reset link is a bearer credential in an inbox. */
const RESET_TTL = '15m';

const MIN_PASSWORD_LENGTH = 8;

/** bcrypt silently truncates input beyond 72 bytes; reject instead. */
const MAX_PASSWORD_BYTES = 72;

/**
 * Version stamped into new session tokens when the user row has no usable
 * value, and the value assumed for tokens minted before Phase B (which carry no
 * `ver` claim). Both are 0, which is also the column default, so deploying
 * Phase B does not invalidate any existing session.
 */
const DEFAULT_TOKEN_VERSION = 0;

/**
 * Keyed fingerprint of a stored password hash.
 *
 * The raw bcrypt digest is deliberately NOT placed in the token: a reset link
 * travels by email, and embedding the digest would hand anyone who intercepts
 * it an offline cracking target. An HMAC keyed with JWT_SECRET is useless
 * without the server secret.
 */
const passwordFingerprint = (passwordDigest, secret) => {
  if (!passwordDigest) {
    throw new Error('passwordFingerprint: passwordDigest is required');
  }
  if (!secret) {
    throw new Error('passwordFingerprint: secret is required');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(String(passwordDigest))
    .digest('hex');
};

/** Constant-time comparison of two fingerprint strings. */
const fingerprintsMatch = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
};

/** Session token: carries `email` as before, plus purpose and token version. */
const signSessionToken = (user, secret, options = {}) =>
  jwt.sign(
    {
      id: user.id,
      email: user.email,
      purpose: PURPOSE.SESSION,
      ver: normaliseTokenVersion(user.tokenVersion),
    },
    secret,
    { expiresIn: options.expiresIn || SESSION_TTL }
  );

/**
 * Coerce a stored tokenVersion to a safe integer.
 * Anything missing, negative, fractional or non-numeric becomes 0.
 */
function normaliseTokenVersion(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    // Prisma may hand back a number; guard against undefined for new users.
    return DEFAULT_TOKEN_VERSION;
  }
  return value;
}

/**
 * The version a token was issued under. A token with no `ver` claim predates
 * Phase B and is treated as version 0, matching the column default, so existing
 * sessions keep working across the deploy.
 */
const tokenVersionOf = (payload) => {
  if (!isPlainPayload(payload)) {
    return null;
  }
  if (payload.ver === undefined) {
    return DEFAULT_TOKEN_VERSION;
  }
  if (typeof payload.ver !== 'number' || !Number.isInteger(payload.ver) || payload.ver < 0) {
    return null; // malformed claim: treat as unverifiable, never as current
  }
  return payload.ver;
};

/**
 * True only when the token's version matches the user's current version.
 * Pure integer comparison: no clock, so second-precision and timezone issues
 * cannot cause wrong accept/reject decisions.
 */
const isSessionVersionCurrent = (payload, currentVersion) => {
  const issued = tokenVersionOf(payload);
  if (issued === null) {
    return false;
  }
  return issued === normaliseTokenVersion(currentVersion);
};

/**
 * Reset token: carries ONLY the user id plus a fingerprint of the password hash
 * in force at issue time. No email (it is not an identity credential).
 */
const signResetToken = (user, secret, options = {}) =>
  jwt.sign(
    {
      id: user.id,
      purpose: PURPOSE.PASSWORD_RESET,
      pwd: passwordFingerprint(user.password, secret),
    },
    secret,
    { expiresIn: options.expiresIn || RESET_TTL }
  );

/**
 * True only for a well-formed plain-object payload.
 *
 * Arrays and non-objects are rejected explicitly: `typeof [] === 'object'`, so
 * a naive object check would let an array through.
 */
const isPlainPayload = (payload) =>
  payload !== null &&
  typeof payload === 'object' &&
  !Array.isArray(payload);

/**
 * Accepts a session token. Tokens minted before P0-2 carry no `purpose` claim
 * and are still accepted, so deploying this does not log existing users out —
 * while a reset token (purpose 'password-reset') is rejected.
 *
 * `id` MUST be a non-empty string. This is load-bearing, not cosmetic: every
 * handler scopes queries with `userId: req.user.id`, and Prisma treats
 * `where: { userId: undefined }` as "no filter", which would silently return
 * every user's rows. Requiring `id` here removes that failure mode entirely.
 */
const isSessionPayload = (payload) => {
  if (!isPlainPayload(payload)) {
    return false;
  }
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    return false;
  }
  return (
    payload.purpose === undefined || payload.purpose === PURPOSE.SESSION
  );
};

/** Accepts ONLY a well-formed password-reset token. */
const isResetPayload = (payload) => {
  if (!isPlainPayload(payload)) {
    return false;
  }
  return (
    typeof payload.id === 'string' &&
    payload.id.length > 0 &&
    payload.purpose === PURPOSE.PASSWORD_RESET &&
    typeof payload.pwd === 'string' &&
    payload.pwd.length > 0
  );
};

/** @returns {string|null} an error message, or null when acceptable. */
const validateNewPassword = (password) => {
  if (typeof password !== 'string' || password.length === 0) {
    return 'Password is required.';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `Password must be at most ${MAX_PASSWORD_BYTES} bytes.`;
  }
  return null;
};

/**
 * Arguments for the compare-and-swap that consumes a reset token exactly once
 * AND revokes every previously issued session for the user.
 *
 * `updateMany` (not `update`) is used so the stored digest participates in the
 * WHERE clause: the UPDATE ... WHERE id = ? AND password = ? statement is
 * atomic, so of N concurrent requests with the same valid token exactly one
 * matches and receives count === 1. Every other receives count === 0 and is
 * rejected. This is what makes single-use real rather than best-effort.
 *
 * `tokenVersion: { increment: 1 }` rides in the SAME `data` object, so the
 * password change and the session-revocation marker are written by one
 * statement and cannot diverge — there is no window where the password has
 * changed but old sessions are still valid.
 */
const buildResetConsumeArgs = (userId, currentPasswordDigest, newPasswordHash) => ({
  where: {
    id: userId,
    password: currentPasswordDigest,
  },
  data: {
    password: newPasswordHash,
    tokenVersion: { increment: 1 },
  },
});

module.exports = {
  PURPOSE,
  SESSION_TTL,
  RESET_TTL,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  DEFAULT_TOKEN_VERSION,
  normaliseTokenVersion,
  tokenVersionOf,
  isSessionVersionCurrent,
  passwordFingerprint,
  fingerprintsMatch,
  signSessionToken,
  signResetToken,
  isSessionPayload,
  isResetPayload,
  validateNewPassword,
  buildResetConsumeArgs,
};
