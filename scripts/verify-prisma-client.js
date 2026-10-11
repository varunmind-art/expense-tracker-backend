'use strict';

/**
 * P0-7 Priority 1 — fail the build when the generated Prisma Client does not
 * match the current schema.
 *
 * Background: `prisma/schema.prisma` declares the default generator output, so
 * the client is generated into `node_modules/.prisma/client`. That directory is
 * **git-tracked in this repository**, and there was **no** `postinstall`, `build`
 * or `prisma generate` step anywhere — so the committed artifact silently went
 * stale after `User.tokenVersion` was added to the schema. The result was a 500
 * on every authenticated request, invisible to 205 mocked tests.
 *
 * This script makes that class of drift impossible to ship: it fails loudly, with
 * an actionable message, instead of letting a stale client reach runtime.
 *
 * Two independent checks:
 *   1. Prisma copies the schema it generated from into
 *      `node_modules/.prisma/client/schema.prisma`. If that copy differs from
 *      `prisma/schema.prisma`, the client predates a schema edit.
 *   2. Every scalar field and model name in the schema must appear in the
 *      generated type definitions. This catches a client generated from a
 *      different schema even if the copied file were removed.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA = path.join(ROOT, 'prisma', 'schema.prisma');
const GENERATED_DIR = path.join(ROOT, 'node_modules', '.prisma', 'client');
const GENERATED_SCHEMA = path.join(GENERATED_DIR, 'schema.prisma');
const GENERATED_TYPES = path.join(GENERATED_DIR, 'index.d.ts');

const SCALAR_TYPES = new Set([
  'String', 'Int', 'Boolean', 'DateTime', 'Decimal', 'Float', 'Json', 'BigInt', 'Bytes',
]);

const normalise = (text) => text.replace(/\s+/g, ' ').trim();

const fail = (lines) => {
  console.error('\n✖ Prisma Client verification FAILED\n');
  for (const line of lines) console.error(`  ${line}`);
  console.error('\n  Fix: run `npx prisma generate` before building or starting.');
  console.error('  The generated client is a build artifact and must match prisma/schema.prisma.\n');
  process.exit(1);
};

if (!fs.existsSync(SCHEMA)) {
  fail([`prisma/schema.prisma not found at ${SCHEMA}`]);
}
if (!fs.existsSync(GENERATED_TYPES)) {
  fail([
    'the generated Prisma Client is missing',
    `expected: ${GENERATED_TYPES}`,
    'this usually means dependencies were never installed or generation was skipped',
  ]);
}

const schema = fs.readFileSync(SCHEMA, 'utf8');

// ---- check 1: the schema copy Prisma generated from --------------------------
if (!fs.existsSync(GENERATED_SCHEMA)) {
  fail([
    'Prisma did not record the schema it generated from',
    `expected: ${GENERATED_SCHEMA}`,
  ]);
}

const generatedSchema = fs.readFileSync(GENERATED_SCHEMA, 'utf8');
if (normalise(generatedSchema) !== normalise(schema)) {
  fail([
    'the generated client was built from a DIFFERENT version of schema.prisma',
    'the schema has changed since the client was last generated',
  ]);
}

// ---- check 2: every model and scalar field is present in the client ----------
const models = [...schema.matchAll(/model (\w+) \{([^}]*)\}/g)];
const fields = [];
for (const [, modelName, body] of models) {
  for (const rawLine of body.split('\n')) {
    const line = rawLine.split('//')[0].trim();
    if (!line || line.startsWith('@')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const type = parts[1].replace(/[?[\]]/g, '');
    if (!SCALAR_TYPES.has(type)) continue; // relation field, not a column
    fields.push({ model: modelName, field: parts[0] });
  }
}

const types = fs.readFileSync(GENERATED_TYPES, 'utf8');
const missing = fields.filter(({ field }) => !types.includes(field));
const missingModels = models
  .map(([, name]) => name)
  .filter((name) => !new RegExp(`\\b${name}\\b`).test(types));

if (missing.length > 0 || missingModels.length > 0) {
  fail([
    'the generated client is missing schema members:',
    ...missingModels.map((m) => `model ${m}`),
    ...missing.map((f) => `${f.model}.${f.field}`),
  ]);
}

console.log(
  `✔ Prisma Client matches prisma/schema.prisma (${models.length} models, ${fields.length} scalar fields verified)`
);
