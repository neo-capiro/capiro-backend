import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { restoreReviewedPeManifest, REVIEWED_PE_MANIFEST_SOURCE } from '../lib/reviewed-pe-manifest-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = 'b7aa1d6e6b341f833fa08b2add8f40d5fbee8480';
const before = file => execFileSync('git', ['show', `${BASE}:${file}`], {cwd: ROOT});
const source = file => readFileSync(path.join(ROOT, file));

for (const [kind, file] of [['root', 'package.json'], ['api', 'apps/api/package.json']]) {
  test(`exact reviewed ${kind} manifest reconstructs every prior byte and retains its real entry points`, () => {
    const raw = source(file);
    assert.deepEqual(Buffer.from(restoreReviewedPeManifest(raw, kind)), before(file));
    assert.deepEqual(raw, execFileSync('git', ['show', `${REVIEWED_PE_MANIFEST_SOURCE}:${file}`], {cwd: ROOT}));
    const current = JSON.parse(raw), old = JSON.parse(before(file));
    assert.equal(current.scripts['verify:pe-phase-9'], old.scripts['verify:pe-phase-9']);
    assert.equal(current.scripts['verify:pe-phase-9:full'], old.scripts['verify:pe-phase-9:full']);
    for (const name of ['verify:pe-phase-9:backend', 'verify:pe-phase-9:backend:dry-run']) {
      assert.equal(Object.hasOwn(old.scripts, name), false);
      assert.equal(typeof current.scripts[name], 'string');
    }
    if (kind === 'api') {
      assert.equal(current.scripts['test:pe-trust'].replace(' scripts/lib/pe-phase-9-backend-scope.spec.ts scripts/lib/pe-phase-9-runner.spec.ts', ''), old.scripts['test:pe-trust']);
      for (const file of ['pe-phase-9-backend-scope.spec.ts', 'pe-phase-9-runner.spec.ts'])
        assert.ok(readFileSync(path.join(ROOT, 'apps/api/scripts/lib', file)).length > 0);
    }
  });

  test(`${kind} manifest mutations cannot turn this exact review into a general exemption`, () => {
    const original = JSON.parse(source(file));
    const changes = [
      value => { delete value.scripts['verify:pe-phase-9:backend']; },
      value => { value.scripts['verify:pe-phase-9:backend'] += ' --skip-install'; },
      value => { value.scripts['verify:pe-phase-9:backend:dry-run'] = value.scripts['verify:pe-phase-9:backend']; },
      value => { delete value.scripts['verify:pe-phase-9']; },
      value => { value.scripts['verify:pe-phase-9:full'] += ' --backend-only'; },
      value => { value.scripts.unreviewed = 'node unreviewed.mjs'; },
      value => { value.engines = {node: '>=1'}; },
      value => { value.dependencies = {...value.dependencies, unreviewed: '1.0.0'}; },
    ];
    if (kind === 'api') changes.push(value => {
      value.scripts['test:pe-trust'] = value.scripts['test:pe-trust'].replace(' scripts/lib/pe-phase-9-runner.spec.ts', '');
    });
    for (const change of changes) {
      const value = structuredClone(original); change(value);
      assert.throws(() => restoreReviewedPeManifest(JSON.stringify(value, null, 2) + '\n', kind), /Unreviewed/);
    }
    assert.throws(() => restoreReviewedPeManifest(source(file).toString() + '\n', kind), /Unreviewed/);
    assert.throws(() => restoreReviewedPeManifest(before(file), kind), /Unreviewed/);
  });
}

test('unknown/coercible inputs refuse without executing application or coercion ports', () => {
  const input = {toString() {throw new Error('coercion must not run');}};
  for (const kind of [undefined, 'frontend', '__proto__', input])
    assert.throws(() => restoreReviewedPeManifest(Buffer.from('{}'), kind), /literal kind/);
  assert.throws(() => restoreReviewedPeManifest(input, 'root'), /literal kind/);
});
