import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  backendSourceMode, backendSourcePlan, executeBackendSourcePlan, runBackendSourceQualification,
  readCurrentWorkspaceInputs, validateCurrentWorkspaceInputs,
} from './backend-source-qualification.mjs';
import { historicalReplayMode } from '../tests/support/legacy-web/qualification-owner.mjs';

test('current source catalog accepts only its declared single ownership modes', () => {
  for (const mode of ['--plan', '--run', '--check-workspace', '--help']) assert.equal(backendSourceMode([mode]), mode);
});
test('current source catalog refuses missing intent before executing anything', () => {
  assert.throws(() => backendSourceMode([]), /exactly/);
});
test('current source catalog refuses unknown arguments', () => {
  assert.throws(() => backendSourceMode(['--unknown']), /exactly/);
});
test('current source catalog refuses combined modes', () => {
  assert.throws(() => backendSourceMode(['--plan', '--run']), /exactly/);
});
test('current source catalog refuses duplicated mode flags', () => {
  assert.throws(() => backendSourceMode(['--run', '--run']), /exactly/);
});
test('current source catalog names every historical obligation and its canonical frontend owner', () => {
  const plan = backendSourcePlan();
  const ledger = JSON.parse(readFileSync(new URL('../tests/support/legacy-web/QUALIFICATION-OWNERSHIP.json', import.meta.url)));
  assert.equal(plan.frontendParityOwner, 'capiro-frontend');
  assert(plan.historical.every(row => row.owner === plan.frontendParityOwner));
  assert.deepEqual(plan.historical.map(row => row.path).sort(), ledger.historical.map(row => row.path).sort());
  for (const suite of ledger.current.filter(row => row.caseNames)) assert.equal(suite.caseNames.length, suite.cases);
  const inventory = ledger.historical.find(row => row.path.endsWith('ui-inventory.spec.mjs'));
  assert.equal(inventory.preservedCaseNames.length, 32);
  assert.equal(inventory.priorObservedFailingCases.length, 5);
  assert.equal(inventory.assertionsRemovedOrSkipped, 0);
  const visual = ledger.historical.find(row => row.path.endsWith('web-visual-cli-controls.mjs'));
  assert.equal(visual.scenarios, 27); assert.equal(visual.assertions, 144);
  assert.equal(visual.preservedPackageAssertions.length, 2); assert.equal(visual.assertionsRemovedOrSkipped, 0);
  const current = JSON.stringify(plan.current);
  assert(!current.includes('engagement-phase3-ui-inventory.spec.mjs'));
  assert(!current.includes('web-visual-cli-controls.mjs'));
  assert(!current.includes('engagement-phase3-preview-route-patterns.mjs'));
  assert(current.includes('tests/support/legacy-web/inputs.spec.mjs'));
  for (const args of [[], ['--historical-replay', '--unknown'], ['--historical-replay', '--historical-replay']]) {
    assert.throws(() => historicalReplayMode(args), /historical-replay/);
  }
  assert.equal(historicalReplayMode(['--historical-replay']), 'historical');
});
test('fake executor observes exactly the finite Node argv and no service commands', () => {
  const calls = [];
  const completed = executeBackendSourcePlan((...args) => { calls.push(args); return { status: 0 }; });
  const plan = backendSourcePlan();
  assert.deepEqual(completed, ['Current workspace ownership', ...plan.current.map(([label]) => label)]);
  assert.deepEqual(calls.map(([command, args]) => [command, args]),
    plan.current.map(([, args]) => [process.execPath, ['--max-old-space-size=128', ...args]]));
  assert(calls.every(([, , options]) => options.windowsHide === true && options.timeout === 120_000));
});

test('Meri historical replay is explicit data ownership outside the current source steps', () => {
  const plan = backendSourcePlan();
  const ledger = JSON.parse(readFileSync(new URL('../tests/support/legacy-meri/CASE-OWNERSHIP.json', import.meta.url)));
  assert.equal(plan.historicalMeri.sourceCommit, ledger.sourceCommit);
  assert.equal(plan.historicalMeri.historicalExpandedCases, ledger.totals.historicalExpandedCases);
  assert.equal(plan.historicalMeri.currentRpSafetyIdentities, 22);
  assert.equal(plan.historicalMeri.nativeReplayStatus, 'UNRUN');
  assert.equal(ledger.groups.filter(group => group.classification.startsWith('historical-'))
    .reduce((count, group) => count + group.cases.length, 0), 71);
  const current = JSON.stringify(plan.current);
  assert(current.includes('meri-loop-current-runtime.contract.spec.mjs'));
  assert(current.includes('meri-current-turn-dispatch.contract.spec.mjs'));
  assert(current.includes('legacy-meri/replay-plan.spec.mjs'));
  assert(!current.includes('legacy-meri/replay-plan.mjs'));
  assert(!current.includes('meriv2-chat.client.spec.ts'));
  assert(!current.includes('ResearchPortfolioMeriTurnBinding.spec.ts'));
});
test('a failed current source step stops later work and cannot emit completion', () => {
  let calls = 0;
  const output = [];
  assert.throws(() => runBackendSourceQualification(['--run'], {
    execute: () => { calls++; return { status: 3 }; }, output: line => output.push(line),
  }), /failed with exit 3/);
  assert.equal(calls, 1); assert.deepEqual(output, []);
});
test('uncertain child results and empty or unowned source plans fail closed', () => {
  for (const result of [undefined, { status: null }, { status: 0, signal: 'SIGTERM' },
    { status: 0, error: new Error('spawn failed') }]) {
    assert.throws(() => executeBackendSourcePlan(() => result), /failed/);
  }
  for (const current of [[], [['Unowned', ['-e', 'throw Error("probe")']]]]) {
    assert.throws(() => executeBackendSourcePlan(() => { throw new Error('must not execute'); }, { current }),
      /empty, incomplete or outside fixed argv ownership/);
  }
});
test('plan and help inspect ownership without invoking any child process', () => {
  for (const mode of ['--plan', '--help']) {
    const output = [];
    runBackendSourceQualification([mode], {
      execute: () => { throw new Error('must not execute'); }, output: line => output.push(line),
    });
    assert.equal(output.length, 1);
    assert(output[0].includes('capiro-frontend'));
    assert(!output[0].includes('CURRENT_BACKEND_SOURCE_QUALIFICATION_COMPLETE'));
  }
});

const workspace = readCurrentWorkspaceInputs();
const copyWorkspace = () => JSON.parse(JSON.stringify(workspace));
test('current workspace fields and real delegated Turbo filters validate', () => {
  const result = validateCurrentWorkspaceInputs(workspace);
  assert.deepEqual(result.issues, []);
  assert.equal(result.scope, 'current-workspace-ownership-fields-only');
  for (const task of ['build', 'dev', 'lint', 'test', 'typecheck']) {
    assert.equal(result.tasks[task].task, task);
    assert(result.tasks[task].filters.includes('!@capiro/onboard-web'));
    assert(result.tasks[task].filters.includes('!@capiro/e2e'));
  }
});
test('unrelated versions dependencies and backend importers remain free to evolve', () => {
  const copy = copyWorkspace();
  copy.manifest.version = '999.1.2';
  copy.manifest.dependencies = { ...copy.manifest.dependencies, '@probe/backend-new': '^9.0.0' };
  copy.manifest.scripts['unrelated:developer-command'] = 'echo independent ; echo allowed-outside-defaults';
  copy.lock = copy.lock.replace('importers:', 'importers:\n  apps/new-backend:\n    dependencies:\n      unrelated-library:\n        version: 9.0.0');
  copy.workspace += '\n  - "apps/new-backend"\n';
  assert.deepEqual(validateCurrentWorkspaceInputs(copy).issues, []);
});
test('retired Web source package workspace and importer regressions each fail', () => {
  for (const mutate of [
    copy => { copy.presence['apps/web/package.json'] = true; },
    copy => { copy.presence['apps/web/src'] = true; },
    copy => { copy.workspace = copy.workspace.replace('!apps/web', 'apps/web'); },
    copy => { copy.lock = copy.lock.replace('importers:', 'importers:\n  apps/web:\n    dependencies: {}'); },
  ]) {
    const copy = copyWorkspace(); mutate(copy);
    assert(validateCurrentWorkspaceInputs(copy).issues.some(issue => /Web|!apps\/web/.test(issue)));
  }
});
test('Onboard and E2E retain their package workspace importer and identity support', () => {
  for (const mutate of [
    copy => { copy.presence['apps/onboard-web/package.json'] = false; },
    copy => { copy.presence['apps/e2e/package.json'] = false; },
    copy => { copy.presence['apps/e2e/lib/source-identity.mjs'] = false; },
    copy => { copy.workspace += '\n  - "!apps/e2e"\n'; },
    copy => { copy.lock = copy.lock.replace(/^  apps\/onboard-web:/m, '  apps/retired-onboard-probe:'); },
  ]) {
    const copy = copyWorkspace(); mutate(copy);
    assert(validateCurrentWorkspaceInputs(copy).issues.some(issue => /retained .*support/.test(issue)));
  }
});
test('fake filter substrings shell controls and forwarded flags cannot satisfy current defaults', () => {
  for (const command of [
    'echo turbo run build --filter="!@capiro/onboard-web" --filter="!@capiro/e2e"',
    'turbo run build ; echo --filter="!@capiro/onboard-web" --filter="!@capiro/e2e"',
    'turbo run build # --filter="!@capiro/onboard-web" --filter="!@capiro/e2e"',
    'turbo run build -- --filter="!@capiro/onboard-web" --filter="!@capiro/e2e"',
    'turbo run build --filter="!@capiro/onboard-web" --filter="!@capiro/e2e" --cwd=another-checkout',
    'turbo run build "--filter=!@capiro/onboard-web --filter=!@capiro/e2e',
  ]) {
    const copy = copyWorkspace(); copy.manifest.scripts.build = command;
    assert(validateCurrentWorkspaceInputs(copy).issues.some(issue => issue.startsWith('default build ownership:')));
  }
});
test('typecheck delegation follows actual tokens supports equivalent quoting and rejects cycles or missing filters', () => {
  const good = copyWorkspace();
  good.manifest.scripts.typecheck = 'pnpm run future:backend-types';
  good.manifest.scripts['future:backend-types'] = "turbo run typecheck --concurrency=2 --filter '!@capiro/onboard-web' --filter '!@capiro/e2e'";
  assert.deepEqual(validateCurrentWorkspaceInputs(good).issues, []);
  for (const command of ['pnpm typecheck', 'turbo run typecheck --filter="!@capiro/e2e"',
    'turbo run typecheck && echo --filter="!@capiro/onboard-web" --filter="!@capiro/e2e"']) {
    const copy = copyWorkspace(); copy.manifest.scripts.typecheck = command;
    assert(validateCurrentWorkspaceInputs(copy).issues.some(issue => issue.startsWith('default typecheck ownership:')));
  }
});
test('dry-run graph help and version flags cannot replace executing current default tasks', () => {
  for (const option of ['--dry-run', '--dry-run=json', '--graph', '--graph=probe.svg', '--help', '--version']) {
    const copy = copyWorkspace(); copy.manifest.scripts.build += ` ${option}`;
    assert(validateCurrentWorkspaceInputs(copy).issues.some(issue => /non-executing Turbo option/.test(issue)));
  }
  const good = copyWorkspace(); good.manifest.scripts.build += ' --force --output-logs=errors-only';
  assert.deepEqual(validateCurrentWorkspaceInputs(good).issues, []);
});
test('extra positive broad negative and duplicated default selectors cannot narrow the current task set to zero', () => {
  for (const selector of ['@capiro/onboard-web', '@capiro/nonexistent-boundary-probe', '!*', '!@capiro/e2e']) {
    const copy = copyWorkspace(); copy.manifest.scripts.build += ` --filter="${selector}"`;
    assert(validateCurrentWorkspaceInputs(copy).issues.some(issue => /exactly the two reviewed exclusion filters/.test(issue)));
  }
});
