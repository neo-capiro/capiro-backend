/**
 * CLI-level fixture tests: exercise the real exit codes of both commands.
 *
 * Runner execution is provided by a SIMULATED runner fixture process inside an
 * isolated temp project (never a workspace suite, never a live credential), so
 * the nonzero-exit and zero-test paths are proven end to end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DUMP = path.join(REPO, 'scripts', 'dump-test-names.mjs');
const DIFF = path.join(REPO, 'scripts', 'diff-test-names.mjs');
const FIX = path.join(HERE, 'fixtures');

function runNode(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', ...opts });
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-cli-'));
}

function makeFakeProject({ exitCode, tests }) {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'apps', 'fake-jest'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps', 'fake-jest', 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'apps', 'fake-jest', 'package.json'),
    JSON.stringify({ name: '@fix/fake-jest', scripts: { test: 'node scripts/fake-jest.mjs --json' } }),
  );
  fs.writeFileSync(
    path.join(root, 'apps', 'fake-jest', 'scripts', 'fake-jest.mjs'),
    `import fs from 'node:fs';
const arg = process.argv.find((a) => a.startsWith('--outputFile='));
const out = arg ? arg.slice('--outputFile='.length) : process.argv[process.argv.indexOf('--outputFile') + 1];
fs.writeFileSync(out, JSON.stringify(${JSON.stringify({ testResults: tests })}));
process.exit(${exitCode});
`,
  );
  return root;
}

const oneSuite = [
  {
    name: 'src/a.spec.ts',
    status: 'passed',
    assertionResults: [{ ancestorTitles: ['A'], fullName: 'A works', title: 'works', status: 'passed' }],
  },
];

test('dump --run: simulated runner with a nonzero exit is reported as non-passing scope (exit 2)', () => {
  const root = makeFakeProject({ exitCode: 1, tests: oneSuite });
  const out = path.join(tmp(), 'dump.json');
  try {
    const r = runNode(DUMP, ['--run', '--root', root, '--out', out, '--quiet']);
    assert.equal(r.status, 2, r.stderr);
    const dump = JSON.parse(fs.readFileSync(out, 'utf8'));
    const t = dump.targets[0];
    assert.equal(t.status, 'runner-failed');
    assert.equal(t.tests.length, 1, 'the names are still captured even though the suite failed');
    assert.equal(dump.scope.runnerFailures.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dump --run: a runner that discovers zero tests is non-passing scope (exit 2)', () => {
  const root = makeFakeProject({ exitCode: 0, tests: [] });
  const out = path.join(tmp(), 'dump.json');
  try {
    const r = runNode(DUMP, ['--run', '--root', root, '--out', out, '--quiet']);
    assert.equal(r.status, 2, r.stderr);
    const dump = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(dump.targets[0].status, 'zero-tests');
    assert.equal(dump.scope.zeroTestTargets.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dump --run: unclassifiable runner is explicit scope, not silent (exit 2)', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'apps', 'mystery'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'mystery', 'package.json'), JSON.stringify({ name: '@fix/mystery', scripts: { test: 'mystery-runner --go' } }));
  const out = path.join(tmp(), 'dump.json');
  try {
    const r = runNode(DUMP, ['--run', '--root', root, '--out', out, '--quiet']);
    assert.equal(r.status, 2, r.stderr);
    const dump = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(dump.scope.unsupported.length, 1);
    assert.equal(dump.scope.unsupported[0].package, '@fix/mystery');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dump --import: reads existing PASSING runner reports without re-running anything (exit 0)', () => {
  const work = tmp();
  const manifest = path.join(work, 'manifest.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      runSha: 'deadbeef',
      root: work,
      targets: [{ package: '@capiro/api', packageDir: 'apps/api', runner: 'jest', tier: 'test', reportFile: path.join(FIX, 'jest-report-passing.json'), exitCode: 0 }],
    }),
  );
  const out = path.join(work, 'dump.json');
  try {
    const r = runNode(DUMP, ['--import', manifest, '--out', out, '--quiet']);
    assert.equal(r.status, 0, r.stderr);
    const dump = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(dump.runSha, 'deadbeef');
    assert.equal(dump.targets[0].status, 'imported');
    assert.equal(dump.targets[0].tests.length, 3);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('dump --import: RETAINS report failure semantics — a report with failed tests is non-passing (exit 2)', () => {
  const work = tmp();
  const manifest = path.join(work, 'manifest.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      runSha: 'deadbeef',
      root: work,
      // jest-report.json contains one failed assertion (numFailedTests: 1).
      targets: [{ package: '@capiro/api', packageDir: 'apps/api', runner: 'jest', tier: 'test', reportFile: path.join(FIX, 'jest-report.json'), exitCode: 0 }],
    }),
  );
  const out = path.join(work, 'dump.json');
  try {
    const r = runNode(DUMP, ['--import', manifest, '--out', out, '--quiet']);
    assert.equal(r.status, 2, r.stderr);
    const dump = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(dump.targets[0].status, 'runner-failed');
    assert.equal(dump.targets[0].tests.length, 6, 'names are still captured even though the imported report failed');
    assert.ok(dump.scope.runnerFailures.length === 1, 'the failure is explicit scope, not a silent passing import');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('dump --import: a malformed report is a non-passing error (exit 2), not a crash', () => {
  const work = tmp();
  fs.writeFileSync(path.join(work, 'bad.json'), '{not json');
  fs.writeFileSync(
    path.join(work, 'manifest.json'),
    JSON.stringify({ targets: [{ package: '@capiro/api', packageDir: 'apps/api', runner: 'jest', tier: 'test', reportFile: 'bad.json' }] }),
  );
  const out = path.join(work, 'dump.json');
  try {
    const r = runNode(DUMP, ['--import', path.join(work, 'manifest.json'), '--out', out, '--quiet']);
    assert.equal(r.status, 2, r.stderr);
    const dump = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(dump.targets[0].status, 'error');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('dump: a missing manifest is a fatal error (exit 3)', () => {
  const r = runNode(DUMP, ['--import', 'C:/definitely/not/here.json', '--quiet']);
  assert.equal(r.status, 3);
});

test('diff CLI: no change exits 0; a removal exits 2', () => {
  const work = tmp();
  const before = path.join(work, 'before.json');
  const after = path.join(work, 'after.json');
  const dump = (names) => JSON.stringify({ schema: 'capiro.test-name-dump', schemaVersion: 1, runSha: 'x', scope: {}, targets: [{ package: '@capiro/api', packageDir: 'apps/api', runner: 'jest', tier: 'test', status: 'ok', exitCode: 0, tests: names.map((n) => ({ suite: 'a.spec.ts', fullName: n, status: 'passed' })) }] });
  fs.writeFileSync(before, dump(['one', 'two']));
  fs.writeFileSync(after, dump(['one', 'two']));
  try {
    const same = runNode(DIFF, ['--before', before, '--after', after, '--quiet']);
    assert.equal(same.status, 0, same.stderr);

    fs.writeFileSync(after, dump(['one']));
    const removed = runNode(DIFF, ['--before', before, '--after', after, '--quiet', '--out', path.join(work, 'diff.json')]);
    assert.equal(removed.status, 2, removed.stderr);
    const doc = JSON.parse(fs.readFileSync(path.join(work, 'diff.json'), 'utf8'));
    assert.equal(doc.ok, false);
    assert.equal(doc.totals.removed, 1);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('diff CLI: malformed / noncanonical input is a fatal invalid-input exit (3)', () => {
  const work = tmp();
  const before = path.join(work, 'before.json');
  const after = path.join(work, 'after.json');
  const canonical = JSON.stringify({ schema: 'capiro.test-name-dump', schemaVersion: 1, runSha: 'x', scope: {}, targets: [{ package: '@capiro/api', packageDir: 'apps/api', runner: 'jest', tier: 'test', status: 'ok', exitCode: 0, tests: [{ suite: 'a.spec.ts', fullName: 'one', status: 'passed' }] }] });
  fs.writeFileSync(after, canonical);
  try {
    // `{}` — arbitrary JSON is never an empty passing comparison.
    fs.writeFileSync(before, '{}');
    const empty = runNode(DIFF, ['--before', before, '--after', after, '--quiet', '--out', path.join(work, 'd1.json')]);
    assert.equal(empty.status, 3, empty.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'd1.json'), 'utf8')).ok, false);

    // raw runner JSON (no canonical schema/version/scope)
    fs.writeFileSync(before, JSON.stringify({ numTotalTests: 0, testResults: [] }));
    const raw = runNode(DIFF, ['--before', before, '--after', after, '--quiet']);
    assert.equal(raw.status, 3, raw.stderr);

    // a canonical zero-scope snapshot still passes (not confused with malformed input)
    fs.writeFileSync(before, JSON.stringify({ schema: 'capiro.test-name-dump', schemaVersion: 1, runSha: 'x', scope: {}, targets: [] }));
    fs.writeFileSync(after, JSON.stringify({ schema: 'capiro.test-name-dump', schemaVersion: 1, runSha: 'x', scope: {}, targets: [] }));
    const zero = runNode(DIFF, ['--before', before, '--after', after, '--quiet']);
    assert.equal(zero.status, 0, zero.stderr);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('diff CLI: non-passing evidence / status regression / tier change exit 2; tier ack exits 0', () => {
  const work = tmp();
  const before = path.join(work, 'before.json');
  const after = path.join(work, 'after.json');
  const acks = path.join(work, 'targets.json');
  const mk = (tier, status, testStatus) => JSON.stringify({ schema: 'capiro.test-name-dump', schemaVersion: 1, runSha: 'x', scope: {}, targets: [{ package: '@capiro/api', packageDir: 'apps/api', runner: 'jest', tier, status, exitCode: status === 'runner-failed' ? 1 : 0, tests: [{ suite: 'a.spec.ts', fullName: 'one', status: testStatus }] }] });
  fs.writeFileSync(before, mk('test:unit', 'ok', 'passed'));
  try {
    fs.writeFileSync(after, mk('test:unit', 'runner-failed', 'passed'));
    assert.equal(runNode(DIFF, ['--before', before, '--after', after, '--quiet']).status, 2, 'non-passing evidence blocks');

    fs.writeFileSync(after, mk('test:unit', 'ok', 'skipped'));
    assert.equal(runNode(DIFF, ['--before', before, '--after', after, '--quiet']).status, 2, 'status regression blocks');

    fs.writeFileSync(after, mk('test:integration', 'ok', 'passed'));
    assert.equal(runNode(DIFF, ['--before', before, '--after', after, '--quiet']).status, 2, 'tier change blocks');

    fs.writeFileSync(acks, JSON.stringify({ acknowledgedTargets: [{ package: '@capiro/api', runner: 'jest', tier: 'test:unit', change: 'tier-changed', reason: 'unit tier renamed to integration' }] }));
    assert.equal(runNode(DIFF, ['--before', before, '--after', after, '--quiet', '--acknowledge-targets', acks]).status, 0, 'tier change with a concrete reason is acknowledged');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('diff CLI: missing --before/--after is a usage error (exit 1)', () => {
  const r = runNode(DIFF, ['--before', 'x.json']);
  assert.equal(r.status, 1);
});
