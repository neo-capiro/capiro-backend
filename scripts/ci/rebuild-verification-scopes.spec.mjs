import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baseline = '5470c6df029c9553dd49e531229c3c91b26275ef';
const proposal = '8ac4c42cc49876ec19808369c0683956e0f2f474';
const before = (path) =>
  execFileSync('git', ['show', `${baseline}:${path}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const proposed = (path) =>
  execFileSync('git', ['show', `${proposal}:${path}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const current = (path) => readFileSync(join(root, path), 'utf8');
const originalPackage = JSON.parse(before('package.json'));
const actualPackage = JSON.parse(current('package.json'));
const aliasKeys = ['typecheck:backend', 'typecheck:frontend'];
for (const [prefix, phases] of [
  ['verify:engagement-phase-', [1, 2, 3]],
  ['verify:outreach-v3-phase-', [1, 3, 4]],
])
  for (const phase of phases)
    for (const scope of ['backend', 'frontend']) {
      aliasKeys.push(`${prefix}${phase}:${scope}`);
    }
const guardAlias = 'gate:cleanup4:verification-scopes';
const webStart = before('.github/workflows/ci-pr.yml').indexOf('      # CleanUp1 §5.3.2');
const webEnd = before('.github/workflows/ci-pr.yml').indexOf('      # CleanUp1 §5.3.3', webStart);
const webStep = before('.github/workflows/ci-pr.yml').slice(webStart, webEnd);

function assertPackagePreserved(pkg) {
  const inverse = structuredClone(pkg);
  for (const key of [...aliasKeys, guardAlias]) {
    assert.equal(Object.hasOwn(originalPackage.scripts, key), false);
    assert.equal(typeof inverse.scripts[key], 'string');
    delete inverse.scripts[key];
  }
  assert.deepEqual(inverse, originalPackage);
}

function assertWorkflowPreserved(source) {
  const frontIndex = source.indexOf('\n  frontend:\n');
  assert.ok(frontIndex > 0, 'retained frontend needs an independent job');
  let inverse = source.slice(0, frontIndex).trimEnd() + '\n';
  const mappings = [
    [
      '      - name: Guard rebuild verification scope composition\n        run: pnpm gate:cleanup4:verification-scopes\n\n',
      '',
    ],
    [
      '      - name: Typecheck backend workspaces (turbo)\n        run: pnpm typecheck:backend',
      '      - name: Typecheck (turbo)\n        run: pnpm turbo run typecheck --concurrency=1',
    ],
    [
      '        run: pnpm verify:engagement-phase-1:backend\n',
      '        run: pnpm verify:engagement-phase-1\n',
    ],
    [
      '        run: pnpm verify:engagement-phase-2:backend\n',
      '        run: pnpm verify:engagement-phase-2\n',
    ],
  ];
  for (const [from, to] of mappings) {
    assert.equal(inverse.split(from).length, 2, `one declared CI hunk: ${from}`);
    inverse = inverse.replace(from, to);
  }
  const anchor = '      # CleanUp1 §5.3.3';
  assert.equal(inverse.split(anchor).length, 2);
  inverse = inverse.replace(anchor, webStep + anchor);
  assert.equal(
    inverse,
    before('.github/workflows/ci-pr.yml'),
    'all prior backend/trigger/condition/guard bytes retained',
  );
  const expectedFrontend = proposed('.github/workflows/ci-pr.yml')
    .slice(proposed('.github/workflows/ci-pr.yml').indexOf('\n  frontend:\n'))
    .replace(
      '      - name: Engagement Phase1 retained frontend regression and routing contract',
      webStep + '      - name: Engagement Phase1 retained frontend regression and routing contract',
    );
  assert.equal(
    source.slice(frontIndex),
    expectedFrontend,
    'exact prerequisite, independent frontend and original Web test union',
  );
}

test('destination package preserves all 107 existing aliases and all metadata', () => {
  assert.equal(Object.keys(originalPackage.scripts).length, 107);
  assert.equal(aliasKeys.length, 14);
  assertPackagePreserved(actualPackage);
  assert.equal(
    actualPackage.scripts[guardAlias],
    'node --test scripts/ci/rebuild-verification-scopes.spec.mjs',
  );
});

test('Phase1 scoped operands retain one explicit run and every current syntax check', () => {
  const full = originalPackage.scripts['verify:engagement-phase-1'].split(' && ');
  assert.equal(full.length, 7);
  assert.equal((full[0].match(/(?:^|\s)--run(?:\s|$)/g) ?? []).length, 1);
  assert.equal(
    actualPackage.scripts['verify:engagement-phase-1:backend'],
    [full[0] + ' --backend-only', ...full.slice(1, 5)].join(' && '),
  );
  assert.equal(
    actualPackage.scripts['verify:engagement-phase-1:frontend'],
    [full[0] + ' --frontend-only', ...full.slice(5)].join(' && '),
  );
});

test('all twelve scoped verification aliases bind one run and exactly one declared scope', () => {
  for (const key of aliasKeys.filter((key) => key.startsWith('verify:'))) {
    const first = actualPackage.scripts[key].split(' && ')[0];
    assert.equal((first.match(/(?:^|\s)--run(?:\s|$)/g) ?? []).length, 1, key);
    const scope = key.endsWith(':backend') ? '--backend-only' : '--frontend-only';
    assert.equal(first.trim().endsWith(scope), true, key);
    assert.equal((first.match(/--(?:backend|frontend)-only/g) ?? []).length, 1, key);
  }
  for (const scope of ['backend', 'frontend']) {
    assert.equal(
      actualPackage.scripts[`verify:engagement-phase-2:${scope}`],
      `bash scripts/verify-engagement-phase2-code.sh --run --${scope}-only`,
    );
  }
});

test('current 19 typed workspaces remain partitioned 17 backend plus retained Web/Onboard', () => {
  const names = [];
  for (const group of ['apps', 'packages', 'infra'])
    for (const directory of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      let data;
      try {
        data = JSON.parse(current(`${group}/${directory.name}/package.json`));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (data.scripts?.typecheck) names.push(data.name);
    }
  assert.equal(names.length, 19);
  assert.ok(names.includes('@capiro/api') && names.includes('@capiro/onboard-api'));
  for (const name of ['@capiro/web', '@capiro/onboard-web']) assert.ok(names.includes(name));
  assert.equal(
    actualPackage.scripts['typecheck:backend'],
    "turbo run typecheck --concurrency=1 --filter='!@capiro/web' --filter='!@capiro/onboard-web'",
  );
  assert.equal(
    actualPackage.scripts['typecheck:frontend'],
    'turbo run typecheck --concurrency=1 --filter=@capiro/web --filter=@capiro/onboard-web',
  );
  assert.equal(current('pnpm-workspace.yaml'), before('pnpm-workspace.yaml'));
});

test('CI is exactly the destination scope hunk union and retains every old guard/test/condition', () => {
  assertWorkflowPreserved(current('.github/workflows/ci-pr.yml'));
});

test('source contract refuses dropping any old gate or metadata, narrowing a backend test, or coupling frontend status', () => {
  for (const key of [
    'gate:cleanup4:tango-page-leaves',
    'gate:cleanup4:strategy-template-metadata',
    'gate:cleanup4:workspace-product-metadata',
    'gate:cleanup4:meri-local-dispatch',
    'verify:engagement-phase-1',
  ]) {
    const mutated = structuredClone(actualPackage);
    delete mutated.scripts[key];
    assert.throws(() => assertPackagePreserved(mutated));
  }
  const mutatedPackage = structuredClone(actualPackage);
  mutatedPackage.packageManager = 'pnpm@99';
  assert.throws(() => assertPackagePreserved(mutatedPackage));
  const workflow = current('.github/workflows/ci-pr.yml');
  for (const mutate of [
    (text) => text.replace('run: pnpm gate:cleanup4:meri-local-dispatch', 'run: true'),
    (text) =>
      text.replace(
        'run: pnpm --filter @capiro/api test',
        'run: pnpm --filter @capiro/api test --only',
      ),
    (text) => text.replace("${{ toJSON(github.event.pull_request.draft) == 'false' }}", 'false'),
    (text) => text.replace('ready_for_review', 'closed'),
    (text) => text.replace('\n  frontend:\n', '\n  frontend:\n    needs: verify\n'),
    (text) => text.replace('run: pnpm --filter @capiro/web test', 'run: true'),
  ])
    assert.throws(() => assertWorkflowPreserved(mutate(workflow)));
});
