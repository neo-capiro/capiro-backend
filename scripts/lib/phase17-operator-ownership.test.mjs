import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectPhase17OperatorOwnership } from './phase17-operator-ownership.mjs';

const canonicalPaths = [
  'apps/api/scripts/phase6-stage-cycle.ts',
  'apps/api/scripts/plan-defense-budget-promotion-v1.ts',
  'apps/api/scripts/status-defense-budget-promotion-v1.ts',
];

test('canonical API entrypoints satisfy operator ownership without copied implementations', () => {
  const paths = new Set(canonicalPaths);
  assert.deepEqual(inspectPhase17OperatorOwnership((path) => paths.has(path)), []);
});

for (const missing of canonicalPaths) {
  test(`rejects missing canonical entrypoint ${missing}`, () => {
    const paths = new Set(canonicalPaths.filter((path) => path !== missing));
    assert.deepEqual(inspectPhase17OperatorOwnership((path) => paths.has(path)), [
      `Missing canonical Phase 1-7 operator: ${missing}`,
    ]);
  });
}

test('rejects reintroduced copied operators, including previously unknown filenames', () => {
  const paths = new Set([...canonicalPaths, 'apps/defense-api/runtime-source/operators']);
  assert.deepEqual(inspectPhase17OperatorOwnership((path) => paths.has(path)), [
    'Duplicate Phase 1-7 operator tree: apps/defense-api/runtime-source/operators; use apps/api/scripts',
  ]);
});

test('current checkout retains canonical entrypoints and has no copied operator tree', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  assert.deepEqual(
    inspectPhase17OperatorOwnership((path) => existsSync(resolve(root, path))),
    [],
  );
});
