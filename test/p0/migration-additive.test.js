'use strict';

/**
 * P0-2 PHASE B POINT 6 — the migration must be additive and non-destructive.
 *
 * These are STATIC checks over the migration files and the Prisma schema. They
 * require no database, so they run in CI before anything is applied. They do NOT
 * prove the migration applies cleanly to a real database — that is the
 * DB-backed suite plus P0-7, which needs an approved non-production branch.
 *
 * The point is that if anyone later edits this migration into something
 * destructive, or adds a destructive migration, this suite fails loudly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND_ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'prisma', 'migrations');
const SCHEMA_PATH = path.join(BACKEND_ROOT, 'prisma', 'schema.prisma');

const TOKEN_VERSION_MIGRATION = '20261010225757_add_user_token_version';

const readMigration = (folder) =>
  fs.readFileSync(path.join(MIGRATIONS_DIR, folder, 'migration.sql'), 'utf8');

const migrationFolders = () =>
  fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

/** Strip SQL comments so assertions target executable DDL only. */
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

// ─────────────────────────────────────────────────────────────────────────────
// The new migration is additive
// ─────────────────────────────────────────────────────────────────────────────

test('the tokenVersion migration exists and is a single additive ADD COLUMN', () => {
  const sql = stripComments(readMigration(TOKEN_VERSION_MIGRATION));
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  assert.equal(statements.length, 1, `expected exactly 1 statement, got ${statements.length}`);
  assert.match(statements[0], /^ALTER TABLE "User" ADD COLUMN\s+"tokenVersion" INTEGER NOT NULL DEFAULT 0$/);
});

test('the tokenVersion migration has a DEFAULT so existing rows are backfilled', () => {
  const sql = stripComments(readMigration(TOKEN_VERSION_MIGRATION));
  // WITHOUT a default, adding a NOT NULL column to a populated table fails, and
  // WITH a default PostgreSQL 11+ backfills without a table rewrite. The default
  // is also what keeps existing sessions valid (see POINT 1 tests).
  assert.match(sql, /NOT NULL DEFAULT 0/);
});

test('the tokenVersion migration does not alter, rename or drop anything', () => {
  const sql = stripComments(readMigration(TOKEN_VERSION_MIGRATION));
  for (const forbidden of [
    'DROP',
    'DELETE',
    'TRUNCATE',
    'ALTER COLUMN',
    'RENAME',
    'UPDATE ',
    'SET NOT NULL',
  ]) {
    assert.equal(
      sql.toUpperCase().includes(forbidden),
      false,
      `migration must not contain "${forbidden}"`
    );
  }
});

test('the tokenVersion migration name follows the Prisma timestamp convention', () => {
  assert.match(TOKEN_VERSION_MIGRATION, /^\d{14}_[a-z0-9_]+$/);
});

test('migrations sort chronologically and tokenVersion is not the newest', () => {
  const folders = migrationFolders();

  // Every timestamped folder must be in lexicographic === chronological order.
  const stamped = folders.filter((f) => /^\d{14}_/.test(f));
  assert.deepEqual(stamped, [...stamped].sort(), 'timestamped migrations are not in order');

  // tokenVersion is present and older than the newest migration. Asserting it is
  // *last* was only ever true until the next migration shipped; what matters is
  // that it sorts before anything that depends on it.
  const index = folders.indexOf(TOKEN_VERSION_MIGRATION);
  assert.notEqual(index, -1, 'migration folder not found');
  assert.ok(index < folders.length - 1, 'a migration must sort after tokenVersion');

  // The accounts folder uses a non-conforming name and relies on lexicographic
  // luck. It is deliberately NOT renamed until P0-7 reconciles migration state.
  assert.ok(folders.includes('20261004_add_accounts_and_loans'));

  // Everything newer than tokenVersion is part of the staged-disbursement
  // release and must sort after it, so it applies on a database that already has
  // the Loan tables. These are exactly the migrations still pending in production.
  assert.deepEqual(folders.slice(index + 1), [
    '20261018052001_add_loan_disbursements_and_schedules',
    '20261018061000_add_loan_settlement_pending',
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// The schema declares the column with the matching default
// ─────────────────────────────────────────────────────────────────────────────

test('schema.prisma declares tokenVersion with the default the migration assumes', () => {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  assert.match(schema, /tokenVersion\s+Int\s+@default\(0\)/);
});

test('the User model gained no other field in this change', () => {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const userModel = schema.match(/model User \{([\s\S]*?)\n\}/);
  assert.ok(userModel, 'User model not found');
  const scalarFields = userModel[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//') && !line.includes('[]') && !line.startsWith('@@'));
  const fieldNames = scalarFields.map((line) => line.split(/\s+/)[0]);
  assert.deepEqual(fieldNames.sort(), [
    'createdAt',
    'email',
    'gmailRefreshToken',
    'id',
    'name',
    'password',
    'tokenVersion',
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Repo-wide safety net: no migration may destroy financial data
// ─────────────────────────────────────────────────────────────────────────────

test('no migration in the repo drops or truncates tables or deletes rows', () => {
  const offenders = [];
  for (const folder of migrationFolders()) {
    const sql = stripComments(readMigration(folder));
    for (const forbidden of ['DROP TABLE', 'DROP COLUMN', 'DELETE FROM', 'TRUNCATE']) {
      if (sql.toUpperCase().includes(forbidden)) {
        offenders.push(`${folder}: ${forbidden}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `destructive migration statements found: ${offenders.join(', ')}`);
});
