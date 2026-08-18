import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Phase17RuntimeCoordinator } from './phase1-7-runtime.contract.js';
import {
  PHASE17_FY27_FIXTURE_SLICES,
  createPhase17RuntimeAdapters,
  defaultFy27InspectInput,
} from './phase1-7-runtime.adapters.js';

// pnpm --filter @capiro/defense-api test runs with cwd = apps/defense-api
const repoRoot = path.resolve(process.cwd(), '../..');

function sourceShaFromManifest(): string {
  const p = path.join(
    repoRoot,
    'apps/defense-api/runtime-source/defense-budget/contracts/__fixtures__/cycle-manifest-minimal.json',
  );
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

test('retained and moved adapters produce identical inspect lineages for FY27 fixtures', async () => {
  const sourceSha = sourceShaFromManifest();
  const input = defaultFy27InspectInput(sourceSha);
  const retained = await new Phase17RuntimeCoordinator(
    createPhase17RuntimeAdapters({ root: 'retained', repoRoot }),
  ).inspect(input);
  const moved = await new Phase17RuntimeCoordinator(
    createPhase17RuntimeAdapters({ root: 'moved', repoRoot }),
  ).inspect(input);

  assert.equal(retained.mode, 'inspect_only');
  assert.equal(moved.mode, 'inspect_only');
  assert.equal(retained.canonicalMutationAttempted, false);
  assert.equal(moved.canonicalMutationAttempted, false);
  assert.equal(retained.lineageSha256, moved.lineageSha256);
  assert.equal(retained.artifacts.length, 9);
  assert.deepEqual(
    retained.artifacts.map((a) => a.sha256),
    moved.artifacts.map((a) => a.sha256),
  );
});

test('every FY27 fixture slice exists on both trees with identical bytes', () => {
  for (const rel of Object.values(PHASE17_FY27_FIXTURE_SLICES)) {
    const a = path.join(repoRoot, 'apps/api/src', rel);
    const b = path.join(repoRoot, 'apps/defense-api/runtime-source', rel);
    assert.equal(fs.existsSync(a), true, `missing retained ${a}`);
    assert.equal(fs.existsSync(b), true, `missing moved ${b}`);
    assert.equal(fs.readFileSync(a).equals(fs.readFileSync(b)), true, `byte drift ${rel}`);
  }
});

test('adapters refuse a missing fixture root', async () => {
  const ports = createPhase17RuntimeAdapters({
    root: 'moved',
    repoRoot: path.join(repoRoot, 'does-not-exist'),
  });
  await assert.rejects(
    ports.resolveSourceProfile(defaultFy27InspectInput('a'.repeat(64))),
    /fixture missing/,
  );
});
