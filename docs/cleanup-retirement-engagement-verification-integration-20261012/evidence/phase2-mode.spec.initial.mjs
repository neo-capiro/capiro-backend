import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const shell = readFileSync(new URL('./verify-engagement-phase2-code.sh', import.meta.url), 'utf8');

function markedBlock(name) {
  const begin = `# ${name}_BEGIN\n`;
  const end = `# ${name}_END`;
  const start = shell.indexOf(begin);
  const finish = shell.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start, `${name} must remain independently inspectable`);
  return shell.slice(start + begin.length, finish);
}

const modeBlock = markedBlock('PHASE2_MODE_PLAN');
const frontendHeaderBlock = markedBlock('PHASE2_FRONTEND_HEADER');
const frontendCommandBlock = markedBlock('PHASE2_FRONTEND_COMMAND');
const phase1Start = shell.indexOf('phase1_gate() {');
const phase1End = shell.indexOf('\n}\n\ngate() {', phase1Start);
assert.ok(phase1Start >= 0 && phase1End > phase1Start);
const phase1Gate = shell.slice(phase1Start, phase1End + '\n}'.length);

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'engagement-phase2-mode-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runBlock(t, code, args = [], environment = {}) {
  const directory = fixture(t);
  // Execute only extracted mode/gate planning blocks, never the Phase2 CLI.
  // No shell startup files or operator environment are inherited.
  const result = spawnSync('/bin/bash', [
    '--noprofile', '--norc', '-c', `set -uo pipefail\n${code}`, 'isolated-mode-fixture', ...args,
  ], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 5_000,
    env: { PATH: '/usr/bin:/bin', ...environment, FIXTURE_LOG: path.join(directory, 'phase1.log') },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { ...result, directory };
}

function plan(t, args = []) {
  if (args.some(arg => ['--backend-only','--frontend-only'].includes(arg))) args = ['--run', ...args];
  const result = runBlock(t, modeBlock, [...args, '--print-plan'], {
    // Successful planning with no external executable available proves it does
    // not inspect Git, run mkdir/timeout/pnpm, or start a verifier.
    PATH: '/no-operator-executables',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(readdirSync(result.directory), [], 'planning creates no logs or artifacts');
  return JSON.parse(result.stdout);
}

test('default plan retains the complete Phase1 command, markers and frontend header gate', (t) => {
  assert.deepEqual(plan(t), {
    scope: 'full',
    fast: 0,
    phase1Command: ['pnpm', 'verify:engagement-phase-1'],
    phase1CompleteMarker: 'ENGAGEMENT_PHASE1_DB_FREE_COMPLETE',
    phase1FailedMarker: 'ENGAGEMENT_PHASE1_DB_FREE_FAILED',
    frontendHeaderGuard: 1,
    completeMarker: 'ENGAGEMENT_PHASE2_CODE_COMPLETE',
    skipsMarker: 'ENGAGEMENT_PHASE2_CODE_COMPLETE_WITH_SKIPS',
    failedMarker: 'ENGAGEMENT_PHASE2_CODE_INCOMPLETE',
  });
});

test('explicit backend plan selects the root backend command and distinct result protocol', (t) => {
  assert.deepEqual(plan(t, ['--backend-only']), {
    scope: 'backend',
    fast: 0,
    phase1Command: ['pnpm', 'verify:engagement-phase-1:backend'],
    phase1CompleteMarker: '[engagement-phase1] BACKEND COMPLETE',
    phase1FailedMarker: '[engagement-phase1] BACKEND FAILED',
    frontendHeaderGuard: 0,
    completeMarker: 'ENGAGEMENT_PHASE2_BACKEND_CODE_COMPLETE',
    skipsMarker: 'ENGAGEMENT_PHASE2_BACKEND_CODE_COMPLETE_WITH_SKIPS',
    failedMarker: 'ENGAGEMENT_PHASE2_BACKEND_CODE_INCOMPLETE',
  });
});

test('explicit frontend plan contains only the original header scan and no Phase1 command', (t) => {
  assert.deepEqual(plan(t, ['--frontend-only']), {
    scope: 'frontend',
    phase1Command: null,
    frontendCommand: ['node', 'scripts/verify-engagement-web-no-preview-header.mjs'],
    frontendHeaderGuard: 1,
    completeMarker: 'ENGAGEMENT_PHASE2_FRONTEND_CODE_COMPLETE',
    failedMarker: 'ENGAGEMENT_PHASE2_FRONTEND_CODE_INCOMPLETE',
  });
});

test('conflicting explicit scopes refuse before startup or artifact writes', async (t) => {
  for (const args of [
    ['--backend-only', '--frontend-only', '--print-plan'],
    ['--frontend-only', '--backend-only'],
  ]) {
    await t.test(args.join(' '), (child) => {
      const result = runBlock(child, modeBlock, args, { PATH: '/no-operator-executables' });
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /either --backend-only or --frontend-only/);
      assert.deepEqual(readdirSync(result.directory), []);
    });
  }
});

test('legacy first-argument fast mode retains full scope and frontend qualification', (t) => {
  const result = plan(t, ['--fast']);
  assert.equal(result.fast, 1);
  assert.equal(result.scope, 'full');
  assert.deepEqual(result.phase1Command, ['pnpm', 'verify:engagement-phase-1']);
  assert.equal(result.frontendHeaderGuard, 1);
});

test('legacy full ignored-argument and first-argument fast policy stays unchanged', (t) => {
  const result = plan(t, ['legacy-ignored-argument', '--fast']);
  assert.equal(result.scope, 'full');
  assert.equal(result.fast, 0);
  assert.equal(result.frontendHeaderGuard, 1);
});

test('backend mode supports an explicit fast flag in either supported order', async (t) => {
  for (const args of [['--fast', '--backend-only'], ['--backend-only', '--fast']]) {
    await t.test(args.join(' '), (child) => {
      const result = plan(child, args);
      assert.equal(result.scope, 'backend');
      assert.equal(result.fast, 1);
      assert.deepEqual(result.phase1Command, ['pnpm', 'verify:engagement-phase-1:backend']);
    });
  }
});

test('plan exits before repository, log directory, timeout and qualification startup', () => {
  const finish = shell.indexOf('# PHASE2_MODE_PLAN_END');
  assert.ok(finish < shell.indexOf('cd "$(dirname "$0")/.."'));
  assert.ok(finish < shell.indexOf('mkdir -p "$LOG_DIR"'));
  assert.ok(finish < shell.indexOf('TIMEOUT_BIN="timeout"'));
  assert.ok(finish < shell.indexOf('phase1_gate() {'));
  const frontendExit = shell.indexOf('  phase2_frontend_only\n  exit $?');
  assert.ok(frontendExit > finish);
  assert.ok(frontendExit < shell.indexOf('mkdir -p "$LOG_DIR"'));
  assert.ok(frontendExit < shell.indexOf('TIMEOUT_BIN="timeout"'));
  assert.ok(frontendExit < shell.indexOf('PASSED=0'));
  assert.doesNotMatch(modeBlock, /\$\(|`/);
  assert.doesNotMatch(modeBlock, /^\s*(?:source\s|\.\s|eval\s|exec\s|cd\s|mkdir\s|timeout\s|git\s|pnpm\s|aws\s|docker\s)/m);
  assert.match(shell, /phase1_gate "\$p1_log" 2700 pnpm "\$PHASE1_COMMAND"/);
});

function checkPhase1(t, { backend = false, output, status = 0, teeFailure = false }) {
  const stub = `
fixture_timeout() { shift 3; "$@"; }
fixture_phase1() { printf '%s\\n' "$FIXTURE_OUTPUT"; return "$FIXTURE_STATUS"; }
TIMEOUT_BIN=fixture_timeout
${teeFailure ? "tee() { cat >/dev/null; return 9; }" : ''}
if phase1_gate "$FIXTURE_LOG" 2700 fixture_phase1; then exit 0; else exit 1; fi
`;
  return runBlock(t, `${modeBlock}\n${phase1Gate}\n${stub}`, backend ? ['--run','--backend-only'] : [], {
    FIXTURE_OUTPUT: output,
    FIXTURE_STATUS: String(status),
  }).status;
}

test('full strict marker gate still accepts a successful complete full verifier', (t) => {
  assert.equal(checkPhase1(t, { output: 'ENGAGEMENT_PHASE1_DB_FREE_COMPLETE' }), 0);
});

test('backend strict marker gate accepts its exact bracketed marker as literal text', (t) => {
  assert.equal(checkPhase1(t, { backend: true, output: '[engagement-phase1] BACKEND COMPLETE' }), 0);
});

test('full and backend gates reject the opposite qualification marker', async (t) => {
  for (const backend of [false, true]) {
    await t.test(backend ? 'backend rejects full receipt' : 'full rejects backend receipt', (child) => {
      const output = backend
        ? 'ENGAGEMENT_PHASE1_DB_FREE_COMPLETE'
        : '[engagement-phase1] BACKEND COMPLETE';
      assert.equal(checkPhase1(child, { backend, output }), 1);
    });
  }
});

test('both modes reject COMPLETE followed by FAILED even when the process exits zero', async (t) => {
  for (const backend of [false, true]) {
    await t.test(backend ? 'backend' : 'full', (child) => {
      const output = backend
        ? '[engagement-phase1] BACKEND COMPLETE\n[engagement-phase1] BACKEND FAILED'
        : 'ENGAGEMENT_PHASE1_DB_FREE_COMPLETE\nENGAGEMENT_PHASE1_DB_FREE_FAILED';
      assert.equal(checkPhase1(child, { backend, output }), 1);
    });
  }
});

test('both modes reject a completion marker followed by a failing process exit', async (t) => {
  for (const backend of [false, true]) {
    await t.test(backend ? 'backend' : 'full', (child) => {
      const output = backend
        ? '[engagement-phase1] BACKEND COMPLETE'
        : 'ENGAGEMENT_PHASE1_DB_FREE_COMPLETE';
      assert.equal(checkPhase1(child, { backend, output, status: 7 }), 1);
    });
  }
});

test('backend strict marker matching rejects a decorated completion line', (t) => {
  assert.equal(checkPhase1(t, { backend: true, output: 'prefix [engagement-phase1] BACKEND COMPLETE suffix' }), 1);
});

test('a failed evidence tee cannot become a passing completion receipt', (t) => {
  assert.equal(checkPhase1(t, {
    backend: true,
    output: '[engagement-phase1] BACKEND COMPLETE',
    teeFailure: true,
  }), 1);
});

test('only backend mode skips the frontend header scan; default retains its exact command', async (t) => {
  const commandPlanning = `
gate() { printf 'gate|%s\\n' "$*"; }
skip() { printf 'skip|%s\\n' "$*"; }
`;
  for (const backend of [false, true]) {
    await t.test(backend ? 'backend' : 'full', (child) => {
      const result = runBlock(child, `${modeBlock}\n${commandPlanning}\n${frontendHeaderBlock}`, backend ? ['--run','--backend-only'] : [], {
        PATH: '/no-operator-executables',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), backend
        ? 'skip|preview header remains confined to the reviewed web module --backend-only'
        : 'gate|preview header remains confined to the reviewed web module phase2_frontend_guard');
    });
  }
});

test('frontend-only qualification executes exactly the original scan through a stubbed node', async (t) => {
  for (const status of [0, 7]) {
    await t.test(status === 0 ? 'success' : 'scan failure', (child) => {
      const commands = `
node() { printf 'node|%s\\n' "$*"; return "$FIXTURE_NODE_STATUS"; }
phase2_frontend_only
`;
      const result = runBlock(child, `${modeBlock}\n${frontendCommandBlock}\n${commands}`, ['--run','--frontend-only'], {
        PATH: '/no-operator-executables',
        FIXTURE_NODE_STATUS: String(status),
      });
      assert.equal(result.status, status === 0 ? 0 : 1);
      const lines = result.stdout.trim().split('\n');
      assert.equal(lines[0], 'node|scripts/verify-engagement-web-no-preview-header.mjs');
      if (status === 0) {
        assert.deepEqual(lines.slice(1), ['ENGAGEMENT_PHASE2_FRONTEND_CODE_COMPLETE']);
        assert.equal(result.stderr, '');
      } else {
        assert.equal(lines.length, 1);
        assert.equal(result.stderr.trim(), 'ENGAGEMENT_PHASE2_FRONTEND_CODE_INCOMPLETE');
      }
      assert.deepEqual(readdirSync(result.directory), []);
    });
  }
});

for (const args of [
  ['--backend-only'], ['--frontend-only'], ['--run','--run','--backend-only'],
  ['--run','--backend-only','--backend-only'], ['--run','--backend-only','--frontend-only'],
  ['--run','--backend-only','unknown'], ['--run','--backend-only','--fast','--fast'],
  ['--run','--frontend-only','--print-plan','--print-plan'],
]) test(`scoped strict argv refuses before work ${JSON.stringify(args)}`, t => {
  const result = runBlock(t, modeBlock, args, {PATH:'/no-operator-executables'});
  assert.equal(result.status,2); assert.equal(result.stdout,'');
  assert.deepEqual(readdirSync(result.directory),[]);
});
