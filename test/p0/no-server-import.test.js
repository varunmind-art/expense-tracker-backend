'use strict';

/**
 * SAFETY GUARD (added after a real incident).
 *
 * Requiring src/server.js with the repository's .env loads the PRODUCTION
 * configuration and arms the real cron plus a 10-second boot-time scheduler run.
 * An offline test did exactly that, with no preflight, which meant production
 * business logic executed against the production database.
 *
 * Only the test/db suite may import src/server, because runPreflight() there sets
 * DISABLE_SCHEDULERS and repoints DATABASE_URL at the development database before
 * the import happens. This guard enforces that boundary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const OFFLINE_DIRS = ['baseline', 'p0'];

const filesIn = (dir) => {
  const full = path.join(__dirname, '..', dir);
  return fs.existsSync(full)
    ? fs.readdirSync(full).filter((f) => f.endsWith('.js')).map((f) => path.join(full, f))
    : [];
};

test('no offline test imports src/server (which would arm production schedulers)', () => {
  const offenders = [];
  for (const dir of OFFLINE_DIRS) {
    for (const file of filesIn(dir)) {
      const src = fs.readFileSync(file, 'utf8');
      if (/require\([^)]*src\/server/.test(src) || /require\([^)]*\.\.\/\.\.\/src\/server/.test(src)) {
        offenders.push(path.relative(path.join(__dirname, '..', '..'), file));
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these offline tests must not import src/server (move them to test/db so the preflight guards them): ${offenders.join(', ')}`
  );
});

test('every database-backed test file calls the preflight before importing src/server', () => {
  const dir = path.join(__dirname, '..', 'db');
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.test.js'))) {
    const full = path.join(dir, file);
    const src = fs.readFileSync(full, 'utf8');
    if (!/src\/server/.test(src)) continue; // does not import the app
    const preflightAt = src.indexOf('runPreflight()');
    const importAt = src.search(/require\([^)]*src\/server/);
    if (preflightAt === -1 || preflightAt > importAt) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `preflight must run before requiring src/server: ${offenders.join(', ')}`);
});
