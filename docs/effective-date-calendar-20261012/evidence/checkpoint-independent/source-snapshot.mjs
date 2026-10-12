import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const reviewedHead = '35abc148e301b5b0b0baa4f5b284757079d9d91d';
const reviewedTree = '38c8529eb308631922bee8d1c3f4d920bc4a0bf3';
const previousPublishedHead = 'f5a043c2558c1073b46bbeab81e60c403830d299';
const previousRuntimeHead = 'f2b4cf3d733bf3cbb84dd8c453c037848d82ea82';
const base = '4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace';
const scriptPath = 'apps/api/scripts/sync-federal-register.ts';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const blob = (head, path) => execFileSync('git', ['show', `${head}:${path}`], { cwd: root });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(git('rev-parse', `${reviewedHead}^{tree}`), reviewedTree);
assert.deepEqual(git('diff', '--name-only', previousPublishedHead, reviewedHead).split('\n'), [scriptPath]);
const paths = git('diff', '--name-only', base, reviewedHead, '--', 'apps', 'packages', 'scripts').split('\n');
const hashes = paths.map(path => {
  const bytes = readFileSync(resolve(root, path));
  assert.deepEqual(bytes, blob(reviewedHead, path), `Frozen source differs: ${path}`);
  if (path !== scriptPath && !path.endsWith('.spec.ts')) {
    assert.deepEqual(bytes, blob(previousRuntimeHead, path), `Unrelated runtime source changed: ${path}`);
  }
  return { path, sha256: sha(bytes) };
});
const redSnapshot = readFileSync(resolve(root, 'docs/effective-date-calendar-20261012/evidence/checkpoint-independent/previous-sync-source.txt'));
assert.deepEqual(redSnapshot, blob(previousPublishedHead, scriptPath));
const code = readFileSync(resolve(root, scriptPath), 'utf8');
assert.ok(!/orderBy:\s*\{\s*publicationDate: 'desc'/.test(code));
for (const required of ["status: 'success'", "path: ['schemaVersion'], equals: 1",
  "path: ['scope'], equals: 'publication_window'", "path: ['incrementalCheckpointEligible'], equals: true"]) {
  assert.ok(code.includes(required), `Missing qualified checkpoint predicate: ${required}`);
}
assert.ok(code.includes('!SINCE_OVERRIDE && complete && observedNumbers.size === totalDocs && errored === 0'));
console.log(JSON.stringify({ reviewedHead, reviewedTree, previousPublishedHead, previousRuntimeHead, base,
  onlyRuntimeChangeSincePublished: scriptPath,
  unrelatedRuntimeSourceMatchesPreviousAcceptedHead: true,
  allFrozenCodeAndRetainedTestsMatch: true,
  originalRedSnapshot: { path: 'docs/effective-date-calendar-20261012/evidence/checkpoint-independent/previous-sync-source.txt', sha256: sha(redSnapshot) },
  sourceOnly: true, migrationExecuted: false, databaseOrProviderRequestsPerformed: false,
  hashes,
}, null, 2));
