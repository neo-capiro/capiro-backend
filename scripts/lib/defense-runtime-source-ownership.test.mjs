import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateDefenseRuntimeSourceOwnership } from './defense-runtime-source-ownership.mjs';

const original = JSON.parse(readFileSync(new URL('./defense-runtime-source-retirement.json', import.meta.url), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function scenario() {
  const manifest = structuredClone(original);
  const bytes = new Map();
  const retained = [...manifest.retainedDataFiles, ...manifest.retainedDocumentationFiles];
  for (const [index, entry] of retained.entries()) {
    const content = Buffer.from(`fixture-control-${index}`);
    entry.sha256 = sha256(content);
    bytes.set(entry.mirrorPath, content);
    bytes.set(entry.canonicalPath, content);
  }
  const sources = new Set(manifest.retiredCodeFiles.map((entry) => entry.canonicalPath));
  const ports = {
    baselineEntries: [...manifest.retiredCodeFiles, ...retained].map((entry) => ({ path: entry.canonicalPath, mode: entry.mode, blob: entry.blob })),
    baselineTrees: new Map(manifest.baseline.sourceTrees.map((entry) => [entry.canonicalPath, entry.baselineTree])),
    sourceExists: (relative) => sources.has(relative),
    mirroredPaths: ['apps/defense-api/runtime-source/README.md', ...retained.map((entry) => entry.mirrorPath)],
    readBytes: (relative) => {
      if (!bytes.has(relative)) throw new Error(`missing ${relative}`);
      return bytes.get(relative);
    },
  };
  return { manifest, ports, sources, bytes };
}

test('one canonical code owner preserves all original test twins and retained data', () => {
  const { manifest, ports } = scenario();
  assert.deepEqual(validateDefenseRuntimeSourceOwnership(manifest, ports), []);
});

test('missing canonical runtime source fails ownership', () => {
  const { manifest, ports, sources } = scenario();
  const entry = manifest.retiredCodeFiles.find((row) => !row.test);
  sources.delete(entry.canonicalPath);
  assert.ok(validateDefenseRuntimeSourceOwnership(manifest, ports).includes(`Missing canonical runtime source: ${entry.canonicalPath}`));
});

test('missing canonical regression spec fails instead of dropping its twin', () => {
  const { manifest, ports, sources } = scenario();
  const entry = manifest.retiredCodeFiles.find((row) => row.test);
  sources.delete(entry.canonicalPath);
  assert.ok(validateDefenseRuntimeSourceOwnership(manifest, ports).includes(`Missing canonical runtime source: ${entry.canonicalPath}`));
});

test('reintroduced TypeScript or Python implementations fail the retained-data boundary', () => {
  const { manifest, ports } = scenario();
  for (const suffix of ['unexpected.ts', 'unexpected.spec.ts', 'unexpected.py']) {
    ports.mirroredPaths.push(`apps/defense-api/runtime-source/${suffix}`);
  }
  const errors = validateDefenseRuntimeSourceOwnership(manifest, ports);
  assert.equal(errors.filter((error) => error.startsWith('Duplicate executable runtime source:')).length, 3);
});

test('changed retained fixture bytes fail their immutable digest', () => {
  const { manifest, ports, bytes } = scenario();
  const fixture = manifest.retainedDataFiles.find((entry) => entry.replayFixture);
  bytes.set(fixture.mirrorPath, Buffer.from('changed'));
  assert.ok(validateDefenseRuntimeSourceOwnership(manifest, ports).includes(`Retained runtime data changed: ${fixture.mirrorPath}`));
});

test('canonical fixture drift fails parity even when retained bytes are intact', () => {
  const { manifest, ports, bytes } = scenario();
  const fixture = manifest.retainedDataFiles.find((entry) => entry.replayFixture);
  bytes.set(fixture.canonicalPath, Buffer.from('changed'));
  assert.ok(validateDefenseRuntimeSourceOwnership(manifest, ports).includes(`Canonical/retained runtime data drift: ${fixture.canonicalPath}`));
});

test('missing retained fixture is reported without removing its acceptance row', () => {
  const { manifest, ports } = scenario();
  const fixture = manifest.retainedDataFiles.find((entry) => entry.replayFixture);
  ports.mirroredPaths = ports.mirroredPaths.filter((relative) => relative !== fixture.mirrorPath);
  assert.ok(validateDefenseRuntimeSourceOwnership(manifest, ports).includes(`Missing retained runtime data: ${fixture.mirrorPath}`));
});

test('an unavailable canonical data file fails closed', () => {
  const { manifest, ports, bytes } = scenario();
  const retained = manifest.retainedDataFiles[0];
  bytes.delete(retained.canonicalPath);
  assert.ok(validateDefenseRuntimeSourceOwnership(manifest, ports).some((error) => error.startsWith(`Unable to read retained runtime data ${retained.mirrorPath}:`)));
});

test('a self-consistent manifest cannot omit a regression twin from the independent baseline', () => {
  const { manifest, ports } = scenario();
  const index = manifest.retiredCodeFiles.findIndex((entry) => entry.test);
  manifest.retiredCodeFiles.splice(index, 1);
  manifest.counts.retiredCodeFiles -= 1;
  manifest.counts.retainedCanonicalTests -= 1;
  assert.ok(validateDefenseRuntimeSourceOwnership(manifest, ports).includes('Retired code/test inventory does not cover the immutable canonical baseline'));
});

test('changing a retired blob cannot rewrite its immutable canonical proof', () => {
  const { manifest, ports } = scenario();
  manifest.retiredCodeFiles[0].blob = '0'.repeat(40);
  assert.ok(validateDefenseRuntimeSourceOwnership(manifest, ports).includes(`Retired twin differs from immutable canonical baseline: ${manifest.retiredCodeFiles[0].retiredPath}`));
});

test('a different implementation owner cannot replace a canonical mapping', () => {
  const { manifest, ports } = scenario();
  manifest.retiredCodeFiles[0].canonicalPath = 'apps/defense-api/src/unrelated.ts';
  assert.ok(validateDefenseRuntimeSourceOwnership(manifest, ports).includes(`Invalid canonical code mapping: ${manifest.retiredCodeFiles[0].retiredPath}`));
});

test('historical source tree hashes must match their immutable Git objects', () => {
  const { manifest, ports } = scenario();
  const source = manifest.baseline.sourceTrees[0];
  ports.baselineTrees.set(source.canonicalPath, '0'.repeat(40));
  assert.ok(validateDefenseRuntimeSourceOwnership(manifest, ports).includes(`Canonical runtime baseline tree mismatch: ${source.canonicalPath}`));
});

test('removing a replay identity or non-replay data cannot shrink retained scope', () => {
  const { manifest, ports } = scenario();
  const fixture = manifest.retainedDataFiles.find((entry) => entry.replayFixture);
  fixture.replayFixture = false;
  const extra = manifest.retainedDataFiles.findIndex((entry) => !entry.replayFixture && entry !== fixture);
  manifest.retainedDataFiles.splice(extra, 1);
  manifest.counts.retainedDataFiles -= 1;
  const errors = validateDefenseRuntimeSourceOwnership(manifest, ports);
  assert.ok(errors.includes('All nine original FY27 replay fixture paths must remain retained'));
  assert.ok(errors.includes('Retained data/documentation inventory does not cover the immutable canonical baseline'));
});
