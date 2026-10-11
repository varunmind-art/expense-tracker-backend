'use strict';

/**
 * P0-7 — fail-closed preflight guard for every database-backed run.
 *
 * Any test or script that may touch a database MUST call runPreflight() first.
 * It throws on the first failed check, so a misconfigured run aborts before a
 * single query instead of pointing at production.
 *
 * It also *isolates the process from production configuration*: because dotenv
 * never overwrites an existing variable, the values set here win over `.env`
 * when `src/server.js` is later required. That is what guarantees a
 * development-only JWT secret, stubbed SMTP credentials and disabled schedulers
 * even though the repository's `.env` is production-configured.
 *
 * No credential is ever printed, logged or returned.
 */

const fs = require('node:fs');
const path = require('node:path');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const ENV_DEV = path.join(BACKEND_ROOT, '.env.dev');
const ENV_PROD = path.join(BACKEND_ROOT, '.env');

/** The verified development endpoint, unpooled host. */
const EXPECTED_DEV_DIRECT_HOST =
  'ep-snowy-base-b3c21vk0.c-4.ap-southeast-1.aws.neon.tech';

const REQUIRED_BRANCH = 'p0-hardening';

const hostOf = (url) =>
  String(url || '')
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^.*@/, '')
    .replace(/[:/?].*$/, '');

const dbNameOf = (url) =>
  String(url || '')
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\?.*$/, '')
    .replace(/^.*\//, '');

const roleOf = (url) =>
  String(url || '')
    .replace(/^[a-z]+:\/\//, '')
    .replace(/:.*@/, '@')
    .replace(/@.*/, '');

/** Minimal .env parser; deliberately does not log values. */
const parseEnvFile = (file) => {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
};

const currentBranch = () => {
  try {
    return require('node:child_process')
      .execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: BACKEND_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
  } catch {
    return null;
  }
};

/**
 * @returns {{host: string, database: string, checks: string[]}}
 * @throws when any check fails
 */
const runPreflight = () => {
  const checks = [];
  const fail = (message) => {
    const error = new Error(`PREFLIGHT FAILED: ${message}`);
    error.preflightChecks = checks;
    throw error;
  };

  const branch = currentBranch();
  if (branch !== REQUIRED_BRANCH) {
    fail(`branch is "${branch}", expected "${REQUIRED_BRANCH}"`);
  }
  checks.push(`branch is ${REQUIRED_BRANCH}`);

  const dev = parseEnvFile(ENV_DEV);
  if (!dev.DATABASE_URL || !dev.DIRECT_URL) {
    fail('.env.dev is missing DATABASE_URL and/or DIRECT_URL');
  }
  checks.push('credentials loaded from .env.dev only');

  const devHost = hostOf(dev.DIRECT_URL);
  if (devHost !== EXPECTED_DEV_DIRECT_HOST) {
    fail('DIRECT_URL host does not match the approved development hostname');
  }
  checks.push('unpooled host matches the approved development hostname');

  const pooledHost = hostOf(dev.DATABASE_URL).replace('-pooler', '');
  if (pooledHost !== devHost) {
    fail('pooled and direct hosts differ once -pooler is normalised');
  }
  if (dbNameOf(dev.DATABASE_URL) !== dbNameOf(dev.DIRECT_URL)) {
    fail('pooled and direct database names differ');
  }
  if (roleOf(dev.DATABASE_URL) !== roleOf(dev.DIRECT_URL)) {
    fail('pooled and direct roles differ');
  }
  checks.push('pooled and direct reference the same development database');

  const prodHost = hostOf(parseEnvFile(ENV_PROD).DATABASE_URL);
  if (prodHost && prodHost === devHost) {
    fail('development target is the same host as .env (production)');
  }
  checks.push('development endpoint differs from production');

  if (String(dev.DIRECT_URL).includes('-pooler')) {
    fail('DIRECT_URL looks pooled; migrations and tests need the unpooled endpoint');
  }
  checks.push('test target is the unpooled endpoint');

  // ---- isolate this process from production configuration ----
  // dotenv does not overwrite existing variables, so these win over .env.
  process.env.DATABASE_URL = dev.DIRECT_URL;
  process.env.DIRECT_URL = dev.DIRECT_URL;
  process.env.JWT_SECRET = 'p07-dev-only-jwt-secret-not-used-anywhere-else';
  // Stubbed SMTP: real credentials are never used in tests.
  process.env.EMAIL_USER = 'p07-stub@example.invalid';
  process.env.EMAIL_APP_PASSWORD = 'p07-stub-password';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  // Automatic schedulers and boot-time financial processing stay off.
  process.env.DISABLE_SCHEDULERS = 'true';
  process.env.NODE_ENV = 'test';
  checks.push('process isolated from production secrets; schedulers disabled');

  return { host: devHost, database: dbNameOf(dev.DIRECT_URL), checks };
};

module.exports = {
  EXPECTED_DEV_DIRECT_HOST,
  REQUIRED_BRANCH,
  BACKEND_ROOT,
  hostOf,
  dbNameOf,
  parseEnvFile,
  runPreflight,
};
