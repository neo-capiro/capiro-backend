import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  BACKEND_WORKSPACE_TRANSITION_SOURCE,
  BACKEND_WORKSPACE_TRANSITION_HASHES,
  RETIRED_MAIN_WEB_ALIASES,
  restoreBackendWorkspaceSource,
  mainWebRetirementResult,
} from './backend-workspace-retirement.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const current = file => readFileSync(join(root, file));
const before = file => execFileSync('git', ['show', `${BACKEND_WORKSPACE_TRANSITION_SOURCE}:${file}`], { cwd: root });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const packageBefore = JSON.parse(before('package.json'));
const packageAfter = JSON.parse(current('package.json'));
const refusalScript = 'scripts/lib/backend-workspace-retirement.mjs';
const exclusions = '--filter="!@capiro/onboard-web" --filter="!@capiro/e2e"';

for (const file of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
  test(`exact ${file} retirement reconstructs every prior canonical byte from its admitted representations`, () => {
    const raw = current(file);
    const canonical = Buffer.from(raw.toString().replace(/\r\n/g, '\n'));
    assert.equal(sha(canonical), BACKEND_WORKSPACE_TRANSITION_HASHES[file].after);
    assert.deepEqual(Buffer.from(restoreBackendWorkspaceSource(raw, file)), before(file));
    assert.deepEqual(Buffer.from(restoreBackendWorkspaceSource(canonical, file)), before(file));
    assert.equal(sha(before(file)), BACKEND_WORKSPACE_TRANSITION_HASHES[file].before);
    if (file === 'pnpm-lock.yaml') {
      const old = before(file).toString();
      const start = old.indexOf('  apps/web:\n');
      const end = old.indexOf('  apps/workspace:\n', start);
      assert.ok(start > 0 && end > start);
      assert.equal(canonical.toString(), old.slice(0, start) + old.slice(end));
      assert.equal(canonical.toString().slice(canonical.toString().indexOf('\npackages:\n')),
        old.slice(old.indexOf('\npackages:\n')), 'every package resolution and snapshot byte retained');
      for (const importer of ['  apps/e2e:\n', '  apps/onboard-web:\n', '  apps/api:\n'])
        assert.equal(canonical.toString().split(importer).length, 2);
    }
  });
}

test('backend defaults exclude Web, retained Onboard SPA and retained E2E while metadata and alias identities remain', () => {
  for (const task of ['build', 'dev', 'lint', 'test'])
    assert.equal(packageAfter.scripts[task], `turbo run ${task} ${exclusions}`);
  assert.equal(packageAfter.scripts.typecheck, 'pnpm typecheck:backend');
  assert.equal(packageAfter.scripts['typecheck:backend'], `turbo run typecheck --concurrency=1 ${exclusions}`);
  assert.equal(packageAfter.scripts['typecheck:frontend'], 'turbo run typecheck --concurrency=1 --filter=@capiro/onboard-web');
  assert.deepEqual(Object.keys(packageAfter.scripts), Object.keys(packageBefore.scripts));
  assert.deepEqual({ ...packageAfter, scripts: null }, { ...packageBefore, scripts: null });
  assert.equal(current('pnpm-workspace.yaml').toString().replace(/\r\n/g, '\n'),
    'packages:\n  - "apps/*"\n  - "!apps/web"\n  - "packages/*"\n  - "infra/*"\n');
  assert.equal(JSON.parse(current('apps/e2e/package.json')).name, '@capiro/e2e');
  assert.equal(JSON.parse(current('apps/onboard-web/package.json')).name, '@capiro/onboard-web');
  assert.equal(existsSync(join(root, 'apps/web/package.json')), false);
});

test('mixed default verifiers retain the complete existing backend operand union and explicit historical local entrypoints', () => {
  for (const alias of [
    'verify:engagement-phase-1', 'verify:engagement-phase-2', 'verify:engagement-phase-3',
    'verify:outreach-v3-phase-1', 'verify:outreach-v3-phase-3', 'verify:outreach-v3-phase-4',
  ]) {
    assert.equal(packageAfter.scripts[alias], `pnpm ${alias}:backend`);
    assert.equal(packageAfter.scripts[`${alias}:backend`], packageBefore.scripts[`${alias}:backend`]);
  }
  for (const phase of [2, 5, 6]) {
    const alias = `verify:outreach-v3-phase-${phase}`;
    assert.equal(packageAfter.scripts[alias], packageBefore.scripts[alias] + ' --backend-only');
  }
  assert.equal(packageAfter.scripts['validate:knowledge-plane:phase26'], packageBefore.scripts['validate:knowledge-plane:phase26:backend']);
  assert.equal(packageAfter.scripts['validate:knowledge-plane:phase26:fast'], packageBefore.scripts['validate:knowledge-plane:phase26:backend:typing']);
  assert.equal(packageAfter.scripts['verify:research-portfolios-phases0-4'], packageBefore.scripts['verify:research-portfolios-phases0-4'] + ' --backend-only');
  for (const alias of Object.keys(packageBefore.scripts).filter(key => key.endsWith(':local') || key.endsWith(':browser')))
    assert.equal(packageAfter.scripts[alias], packageBefore.scripts[alias], alias);
});

test('all seven retired main-Web frontend aliases explicitly fail through the real finite CLI', () => {
  assert.equal(RETIRED_MAIN_WEB_ALIASES.length, 7);
  for (const alias of RETIRED_MAIN_WEB_ALIASES) {
    assert.equal(packageAfter.scripts[alias], `node ${refusalScript} --refuse-main-web ${alias}`);
    const result = spawnSync(process.execPath, ['--max-old-space-size=64', refusalScript, '--refuse-main-web', alias], { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2, alias);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(alias));
    assert.match(result.stderr, /Main Web source is retired/);
    assert.match(result.stderr, /pinned source checkpoint/);
  }
});

test('retirement CLI refuses unknown or widened requests and help performs no verification', () => {
  for (const args of [[], ['--refuse-main-web'], ['--refuse-main-web', 'unreviewed'],
    ['--refuse-main-web', RETIRED_MAIN_WEB_ALIASES[0], '--skip-tests'], ['--help', '--run']])
    assert.equal(mainWebRetirementResult(args).status, 2);
  for (const option of ['--help', '-h']) {
    const result = mainWebRetirementResult([option]);
    assert.equal(result.status, 0);
    assert.match(result.message, /^Usage:/);
  }
  assert.equal(mainWebRetirementResult(null).status, 2);
});

for (const [file, mutations] of [
  ['package.json', [
    text => text.replace('--filter=\\"!@capiro/e2e\\"', ''),
    text => text.replace('pnpm verify:engagement-phase-1:backend', 'true'),
    text => text.replace('--refuse-main-web verify:engagement-phase-1:frontend', '--help'),
    text => text.replace('pnpm@9.12.0', 'pnpm@99'),
    text => text.replace('"prettier": "^3.9.9"', '"prettier": "^3.9.10"'),
    text => text.replace('"private": true', '"private": false'),
  ]],
  ['pnpm-workspace.yaml', [
    text => text.replace('!apps/web', '!apps/*'),
    text => text.replace('!apps/web', '!apps/e2e'),
    text => text.replace('"packages/*"', '"packages/shared"'),
  ]],
  ['pnpm-lock.yaml', [
    text => text.replace('  apps/e2e:', '  retired/e2e:'),
    text => text.replace('  apps/onboard-web:', '  retired/onboard-web:'),
    text => text.replace('    specifier: 22.19.21', '    specifier: 22.19.22'),
    text => text.replace('\npackages:\n', '\npackages: {}\n'),
    text => text.replace('\nsnapshots:\n', '\nsnapshots: {}\n'),
  ]],
]) {
  test(`${file} inverse rejects scope, metadata, importer and resolution mutations instead of granting a general waiver`, () => {
    const source = current(file).toString().replace(/\r\n/g, '\n');
    for (const mutate of mutations) {
      const changed = mutate(source);
      assert.notEqual(changed, source, 'negative control must mutate a real operand');
      assert.throws(() => restoreBackendWorkspaceSource(changed, file), /Unreviewed/);
    }
    assert.throws(() => restoreBackendWorkspaceSource(source + '\n', file), /Unreviewed/);
    assert.throws(() => restoreBackendWorkspaceSource(before(file), file), /Unreviewed/);
  });
}

test('finite inverse refuses foreign paths and coercion ports and its hash profiles are immutable', () => {
  const input = { toString() { throw new Error('coercion must not run'); } };
  for (const file of [undefined, 'apps/api/package.json', '__proto__', input])
    assert.throws(() => restoreBackendWorkspaceSource(Buffer.from('{}'), file), /literal finite path/);
  assert.throws(() => restoreBackendWorkspaceSource(input, 'package.json'), /literal finite path/);
  assert.equal(Object.isFrozen(BACKEND_WORKSPACE_TRANSITION_HASHES), true);
  for (const profile of Object.values(BACKEND_WORKSPACE_TRANSITION_HASHES))
    assert.equal(Object.isFrozen(profile), true);
});
