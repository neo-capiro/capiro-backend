import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const fixture = resolve(here, '__fixtures__/email-cta-app-source.txt');
const currentApp = resolve(repoRoot, 'apps/web/src/App.tsx');
const existingSpec = resolve(here, 'email-cta-routes.spec.ts');

// Qualification data only: these preserved variants are not a shared router.
const preservedVariants = Object.freeze([
  {
    ref: 'cleanup-recovery/20261012/deployed-revision/core-api',
    commit: '1e99f0921b207318c6d2abf03927b5c4daa5768b',
    blob: '24d75b1bd4d3e22d4eb0027b9412b33281a84c85',
    bytes: 30256,
  },
  {
    ref: 'cleanup-recovery/20261012/deployed-revision/intel-api',
    commit: '0732f2511796411c2d9a492e6a3b0a4bc33cb225',
    blob: '25c7507c2d8a49ec70a7916ea40e67b0b6bda6e2',
    bytes: 29830,
  },
  {
    ref: 'cleanup-recovery/20261012/deployed-revision/memory-review',
    commit: '32a4320d0386f5608e0bf59af3671c91e665c100',
    blob: '1a1d2d180788762645df5ad832182c57587b8fe7',
    bytes: 26264,
  },
]);
const coreAppSha256 = 'a7b1ff2a7cb9945af55ba58c5849cfe18cf5f89a47c195d99e7edac1fcbfe2cc';
const originalSpecSha256 = '72723557f0ba18f258ab3a6fd083ca93d3fd9b963c9689084c640ae3a2e87d6e';
const originalInput = "const APP_TSX = join(REPO_ROOT, 'apps/web/src/App.tsx');";
const ownedInput =
  "const APP_TSX = join(REPO_ROOT, 'apps/intel-api/src/tracker/__fixtures__/email-cta-app-source.txt');";
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('owned CTA route input retains the declared Core bytes and Git blob', () => {
  const bytes = readFileSync(fixture);
  const core = preservedVariants[0];
  assert.equal(bytes.length, core.bytes);
  assert.equal(sha256(bytes), coreAppSha256);
  assert.equal(
    createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    core.blob,
  );
});

test('owned CTA route input matches the retained current frontend source', () => {
  // The current source must exist and agree. A snapshot alone cannot qualify
  // published routes or authorize frontend removal.
  assert.deepEqual(readFileSync(fixture), readFileSync(currentApp));
});

test('CTA qualification changes only its owned input and retains every case and operand', () => {
  const source = readFileSync(existingSpec, 'utf8');
  assert.equal(source.split(ownedInput).length, 2);
  assert.equal(sha256(source.replace(ownedInput, originalInput)), originalSpecSha256);
});
