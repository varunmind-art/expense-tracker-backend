'use strict';

/**
 * P0-8 — cross-user financial-resource authorization.
 *
 * The defect: `categoryId` was accepted from the request body and written with
 * only a database foreign-key check, which verifies the row EXISTS but not that
 * it belongs to the caller. A user could therefore attach their records to
 * another user's category, and in five paths the response echoed that category
 * back via `include: { category: true }`, leaking the victim's category name,
 * icon and colour. `accountId` was already checked (getOwnedAccount), which is
 * what made the omission an inconsistency rather than a design choice.
 *
 * Everything here is pure and takes an injected lookup, so the authorization
 * rule is unit testable with two synthetic users and no database. The
 * Prisma-backed lookup lives in src/server.js.
 */

/** One message for a foreign id and a nonexistent one, deliberately. */
const INVALID_RESOURCE_ERROR = 'Invalid category.';

const isUsableId = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Authorize an optional category reference.
 *
 * @param {(args: {id: string, userId: string}) => Promise<object|null>} findOwned
 *   a lookup that MUST filter by userId
 * @param {string} userId taken from the verified token, never from the client
 * @param {unknown} categoryId the caller-supplied reference
 * @returns {Promise<{ok: true, category: object|null} | {ok: false, status: number, error: string}>}
 *   `{ok: true, category: null}` means "no reference supplied", which callers
 *   treat as optional. A present-but-not-yours reference is always a 400.
 */
const authorizeCategory = async (findOwned, userId, categoryId, options = {}) => {
  // `requireValue` (create paths): a category must be supplied at all.
  // `rejectNull`   (update paths): omitting the field means "leave it alone",
  //                but an explicit null is a client error, because Category is
  //                NOT NULL for these models.
  // Neither option (PendingImport): the column is nullable, so null is valid and
  //                falls back to the pending record's own category or default.
  const requireValue = options.requireValue === true;
  const rejectNull = options.rejectNull === true;

  if (categoryId === undefined) {
    if (requireValue) {
      return { ok: false, status: 400, error: INVALID_RESOURCE_ERROR };
    }
    return { ok: true, category: null };
  }

  if (categoryId === null || categoryId === '') {
    if (requireValue || rejectNull) {
      return { ok: false, status: 400, error: INVALID_RESOURCE_ERROR };
    }
    return { ok: true, category: null };
  }

  if (!isUsableId(userId)) {
    // No authenticated tenant: refuse rather than fall through to an
    // unscoped lookup, which would be far worse than a 400.
    return { ok: false, status: 400, error: INVALID_RESOURCE_ERROR };
  }

  if (!isUsableId(categoryId)) {
    return { ok: false, status: 400, error: INVALID_RESOURCE_ERROR };
  }

  const category = await findOwned({ id: categoryId, userId });

  if (!category) {
    // Foreign and nonexistent are indistinguishable on purpose: revealing
    // "that exists but is not yours" would itself leak information.
    return { ok: false, status: 400, error: INVALID_RESOURCE_ERROR };
  }

  return { ok: true, category };
};

/**
 * The same rule for any other owned resource (accounts, budgets, merchants,
 * recurring rules), so the audit can reuse one implementation.
 */
const authorizeResource = async (findOwned, userId, resourceId, errorMessage) => {
  if (resourceId === undefined || resourceId === null || resourceId === '') {
    return { ok: true, resource: null };
  }

  if (!isUsableId(userId) || !isUsableId(resourceId)) {
    return { ok: false, status: 400, error: errorMessage };
  }

  const resource = await findOwned({ id: resourceId, userId });
  if (!resource) {
    return { ok: false, status: 400, error: errorMessage };
  }

  return { ok: true, resource };
};

module.exports = {
  INVALID_RESOURCE_ERROR,
  isUsableId,
  authorizeCategory,
  authorizeResource,
};
