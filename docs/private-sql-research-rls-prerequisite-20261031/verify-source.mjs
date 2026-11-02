// Offline source/custody verification only. Does not load a database library.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = 'e8efcbe83992f1d30d2974e6d2df26ca669cf324';
const prefix = 'docs/private-sql-research-rls-prerequisite-20261031/';
const git = (...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sql = readFileSync(path.join(root, prefix, 'research-tenant-policies-forward.sql'), 'utf8');
const index = JSON.parse(readFileSync(path.join(root, prefix, 'producer-source-index.json'), 'utf8'));
assert.equal(index.sourceCommit, base);
const pins = [
  ...index.producerAndReaderSourcePins,
  ...Object.entries(index.prior36MigrationSourceEvidence.canonicalGitPins).map(([p, pin]) => ({ path: p, ...pin })),
];
for (const pin of pins) {
  const bytes = git('show', `${base}:${pin.path}`);
  assert.equal(sha256(bytes), pin.sha256, `Source SHA256: ${pin.path}`);
  assert.equal(git('rev-parse', `${base}:${pin.path}`).toString().trim(), pin.gitBlob);
}

// Re-derive both existing helper pins from their immutable canonical source.
const init = git('show', `${base}:apps/api/prisma/migrations/20260501000000_init_identity_tenancy/migration.sql`).toString();
const helperPins = {};
for (const name of ['current_tenant_id', 'rls_bypass']) {
  const match = init.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(\\) RETURNS \\w+ AS \\$\\$([\\s\\S]*?)\\$\\$ LANGUAGE plpgsql STABLE;`));
  assert.ok(match, `Canonical helper source: ${name}`);
  helperPins[name] = sha256(match[1]);
  assert.ok(sql.includes(`'${helperPins[name]}'`), `Forward helper pin: ${name}`);
}

// This is byte preservation, not PostgreSQL syntax or behavior qualification.
const oldTree = git('ls-tree', '-r', base).toString().trim().split('\n');
const oldPaths = new Set(oldTree.map(line => line.split('\t')[1]));
const newTree = new Map(git('ls-tree', '-r', 'HEAD').toString().trim().split('\n')
  .map(line => [line.split('\t')[1], line]));
for (const line of oldTree) {
  const p = line.split('\t')[1];
  assert.equal(newTree.get(p), line, `Accepted Git entry changed: ${p}`);
}
const newPaths = [...newTree.keys()].filter(p => !oldPaths.has(p));
assert.ok(newPaths.every(p => p.startsWith(prefix)), 'Only additive prerequisite documentation allowed');
const workingChanged = git('diff', '--name-only', base).toString().trim().split('\n').filter(Boolean);
assert.ok(workingChanged.every(p => p.startsWith(prefix)), 'Accepted working source changed');
const migrationEntries = oldTree.filter(line => line.split('\t')[1].includes('/migrations/'));
assert.equal(migrationEntries.length, 667);
console.log(JSON.stringify({
  kind: 'offline-source-custody-only', base,
  candidate: git('rev-parse', 'HEAD').toString().trim(),
  pinnedSourceFilesVerified: pins.length, producerSourceFiles: index.producerAndReaderSourcePins.length,
  prerequisiteMigrationSourceFiles: Object.keys(index.prior36MigrationSourceEvidence.canonicalGitPins).length,
  preservedAcceptedEntries: oldTree.length, preservedMigrationEntries: migrationEntries.length,
  helperPins, postgresSyntaxOrBehaviorExecuted: false,
}, null, 2));
