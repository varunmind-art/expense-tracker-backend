'use strict';

/**
 * P0 (A-2) — forgot-password response shaping, kept pure so the
 * indistinguishability guarantee is executable rather than a code review claim.
 *
 * The defect: an unknown address returned `404 "No user found with this email."`
 * while a known one returned `200`, so anyone could enumerate registered
 * accounts. A mail-delivery failure returned `500`, which leaked existence again
 * by a different route.
 *
 * The fix: EVERY outcome maps to one identical public response. Whether mail was
 * actually sent is decided separately and never surfaces to the requester.
 */

/** The single public response for every forgot-password outcome. */
const GENERIC_RESET_MESSAGE =
  'If that email is registered, a password reset link has been sent.';

/** Frozen so a caller cannot mutate the shared response object. */
const genericResetResponse = () =>
  Object.freeze({ message: GENERIC_RESET_MESSAGE });

/**
 * Decide what to do about an incoming reset request.
 *
 * @param {{ userExists: boolean }} input
 * @returns {{ response: {message: string}, shouldSendMail: boolean }}
 *   `response` is identical for both cases; `shouldSendMail` is internal.
 */
const planResetRequest = (input) => ({
  response: genericResetResponse(),
  // A null/undefined/garbage input must not throw: failing here would turn a
  // forgotten-password request into a 500 and, worse, into a distinguishable
  // response. Anything falsy means "no account to mail".
  shouldSendMail: Boolean(input && input.userExists),
});

/**
 * Decide the public outcome after attempting delivery.
 *
 * A delivery failure must not distinguish a registered address from an unknown
 * one, so the response is byte-identical in every case; only the internal log
 * level changes.
 *
 * @param {{ mailError?: unknown }} input
 * @returns {{ response: {message: string}, logLevel: 'error'|null }}
 */
const planResetDelivery = (input) => ({
  response: genericResetResponse(),
  // Same defensive shape as planResetRequest: a null input still yields the
  // generic response rather than throwing.
  logLevel: input && input.mailError ? 'error' : null,
});

module.exports = {
  GENERIC_RESET_MESSAGE,
  genericResetResponse,
  planResetRequest,
  planResetDelivery,
};
