import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const head = 'f2b4cf3d733bf3cbb84dd8c453c037848d82ea82';
const tree = '08519d0fa4fc14da9116b3f299d0d9d5c4e0c685';
const base = '4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', `${head}^{tree}`), tree);
const paths = git('diff', '--name-only', base, head).split('\n');
const hashes = paths.map(path => {
  const local = readFileSync(resolve(root, path));
  const published = execFileSync('git', ['show', `${head}:${path}`], { cwd: root });
  assert.deepEqual(local, published, `Source changed since reviewed commit: ${path}`);
  return { path, sha256: createHash('sha256').update(local).digest('hex') };
});
const migrationPath = 'apps/api/prisma/migrations/20281012060000_federal_register_effective_evidence/migration.sql';
const migration = readFileSync(resolve(root, migrationPath), 'utf8');
for (const [key, rhs] of [['schemaVersion', "'1'"], ['dateKind', "'effective'"], ['documentNumber', 'document_number']]) {
  assert.ok(migration.includes(`(effective_date_evidence->>'${key}' = ${rhs}) IS TRUE`), `Nullable CHECK predicate: ${key}`);
}
assert.ok(!/\b(?:CREATE\s+TABLE|GRANT|REVOKE|DISABLE\s+ROW\s+LEVEL|INSERT\s+INTO|UPDATE\s+federal_register_document)\b/i.test(migration));
const schema = readFileSync(resolve(root, 'apps/api/prisma/schema.prisma'), 'utf8');
assert.ok(schema.includes('effectiveDateEvidence Json? @map("effective_date_evidence")'));
assert.ok(schema.includes('@@index([type, effectiveDate])'));
const sync = readFileSync(resolve(root, 'apps/api/scripts/sync-federal-register.ts'), 'utf8');
assert.ok(sync.includes("redirect: 'error'"));
assert.ok(sync.includes('complete: complete && observedNumbers.size === totalDocs'));
assert.ok(sync.includes('separatelyIssuedCorrectionsResolved: false'));
console.log(JSON.stringify({
  reviewedHead: head, reviewedTree: tree, base,
  localSourceMatchesReviewedBlobs: true,
  migrationInspectionOnly: true, migrationExecuted: false,
  providerRequestsPerformed: false, nativeDatabaseQualification: false,
  staticChecks: ['all changed source/test paths match exact reviewed Git blobs',
    'nullable migration evidence predicates require IS TRUE',
    'additive existing-owner migration without data backfill or permissions changes',
    'schema evidence fields/index align with migration source',
    'detail refresh refuses redirects and retains incomplete-correction coverage'],
  hashes,
}, null, 2));
