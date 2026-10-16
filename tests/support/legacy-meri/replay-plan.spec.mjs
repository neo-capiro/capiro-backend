import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CASE_OWNERSHIP, SOURCE_INPUTS, SOURCE_COMMIT, SOURCE_TREE, buildHistoricalReplayPlan,
  parseReplayArguments, preflightHistoricalSource, replayPlanCli, validateOwnership, validateSourceManifest } from './replay-plan.mjs';

// These tiny temporary bytes are explicitly synthetic operands, never historical
// Meri source. The production CLI has no input-manifest override; only the pure
// preflight/plan functions accept this fixture seam. No application TS executes.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function withInputs(run) {
  const tempParent = realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(tempParent, 'capiro-legacy-meri-plan-'));
  const manifest = structuredClone(SOURCE_INPUTS);
  try {
    for (const row of manifest.requiredFiles) {
      const target = path.join(root, row.path);
      mkdirSync(path.dirname(target), { recursive: true });
      const bytes = Buffer.from('SYNTHETIC PLAN INPUT ONLY: ' + row.path + '\n');
      writeFileSync(target, bytes);
      Object.assign(row, { bytes: bytes.length, sha256: sha(bytes), gitBlobSha1: blob(bytes) });
    }
    return run(root, manifest);
  } finally {
    const resolved = realpathSync(root);
    assert.equal(path.dirname(resolved), tempParent, 'recursive cleanup stays in the named temporary parent');
    assert(path.basename(resolved).startsWith('capiro-legacy-meri-plan-'));
    rmSync(resolved, { recursive: true, force: true });
  }
}

test('case ownership preserves historical71 current22 and mapped22RP without inflating internal loops', () => {
  const ledger = validateOwnership(CASE_OWNERSHIP);
  const count = key => ledger.groups.find(group => group.key === key).cases.length;
  assert.equal(count('raw-lifecycle'), 8); assert.equal(count('current-archive'), 3);
  assert.equal(count('v2-client') + count('v2-helper') + count('v2-matrix'), 41);
  assert.equal(count('v2-matrix'), 32); assert.equal(count('raw-rp'), 22);
  assert.equal(count('current-runtime-proxy') + count('current-runtime-coverage') + count('current-phase19') + count('current-archive'), 22);
  assert.equal(ledger.currentRpMappings.length, 22);
  assert.equal(new Set(ledger.groups.flatMap(group => group.cases.map(item => item.id))).size, 93);
  assert.deepEqual(ledger.groups.find(group => group.key === 'raw-lifecycle').cases.slice(5).map(item => item.title),
    ['keeps provider_failure distinct on stream and reload', 'keeps user_stop distinct on stream and reload',
      'keeps provider_timeout distinct on stream and reload']);
  assert.deepEqual(ledger.groups.find(group => group.key === 'current-archive').cases.slice(1).map(item => item.title),
    ['rejects archive discovery and restore outside the owner ({"tenantId":"other-tenant"})',
      'rejects archive discovery and restore outside the owner ({"userId":"other-user"})']);
  const internal = ledger.groups.find(group => group.key === 'v2-matrix').cases
    .filter(item => item.title.startsWith('containment does not depend'));
  assert.equal(internal.length, 1); assert.equal(internal[0].parameters.internalAssertionsCombinations, 8);
});

test('ownership refuses lost duplicate unowned and repinned case identities', () => {
  for (const mutate of [
    value => value.groups[0].cases.pop(),
    value => { value.groups[0].cases[1].id = value.groups[0].cases[0].id; },
    value => value.groups.push(structuredClone(value.groups[0])),
    value => { value.sourceCommit = '0'.repeat(40); },
  ]) {
    const changed = structuredClone(CASE_OWNERSHIP); mutate(changed);
    assert.throws(() => validateOwnership(changed));
  }
});

test('each original RP identity requires one current seam mapping and no invented historical pass', () => {
  const missing = structuredClone(CASE_OWNERSHIP); missing.currentRpMappings.pop();
  assert.throws(() => validateOwnership(missing), /current-seam mapping/);
  const duplicate = structuredClone(CASE_OWNERSHIP);
  duplicate.currentRpMappings[1].oldCaseId = duplicate.currentRpMappings[0].oldCaseId;
  assert.throws(() => validateOwnership(duplicate), /current-seam mapping/);
  const invented = structuredClone(CASE_OWNERSHIP); invented.historicalExecution.status = 'PASS';
  assert.throws(() => validateOwnership(invented), /manufacture/);
});

test('source manifest binds exact full-source pin and finite safe regular-file operands', () => {
  assert.equal(validateSourceManifest(SOURCE_INPUTS), SOURCE_INPUTS);
  assert.equal(SOURCE_INPUTS.sourceCommit, SOURCE_COMMIT); assert.equal(SOURCE_INPUTS.sourceTree, SOURCE_TREE);
  assert.equal(SOURCE_INPUTS.requiredFiles.length, 23);
  for (const mutate of [
    value => { value.sourceTree = '0'.repeat(40); },
    value => value.requiredFiles.pop(),
    value => { value.requiredFiles[0].path = '../outside'; },
    value => { value.requiredFiles[0].mode = '120000'; },
    value => { value.requiredFiles[0].sha256 = 'not-a-hash'; },
  ]) {
    const changed = structuredClone(SOURCE_INPUTS); mutate(changed);
    assert.throws(() => validateSourceManifest(changed));
  }
});

test('CLI argument admission requires explicit plan absolute root and one finite suite', () => withInputs(root => {
  for (const suite of ['raw-lifecycle', 'v2-client', 'v2-routing', 'raw-rp', 'all']) {
    assert.deepEqual(parseReplayArguments(['--plan', '--source-root', root, '--suite', suite]), { sourceRoot: root, suite });
    assert.deepEqual(parseReplayArguments(['--suite', suite, '--source-root', root, '--plan']), { sourceRoot: root, suite });
  }
}));

test('CLI refuses run unknown duplicate missing and implicit-current-checkout arguments', () => withInputs(root => {
  for (const argv of [[], ['--run'], ['--plan'], ['--plan', '--source-root'],
    ['--plan', '--source-root', root, '--suite', 'all', '--run'],
    ['--plan', '--plan', '--source-root', root, '--suite', 'all'],
    ['--plan', '--source-root', root, '--suite', 'other'],
    ['--plan', '--source-root', '.', '--suite', 'all'],
    ['--plan', '--source-root', root, '--suite', 'all', '--source-root', root],
    ['--plan', '--source-root', root, '--suite', 'all', '--manifest', 'fake.json'],
  ]) assert.throws(() => parseReplayArguments(argv), undefined, JSON.stringify(argv));
}));

test('preflight rejects absent relative and non-directory source roots before claiming inputs', () => withInputs((root, manifest) => {
  assert.throws(() => preflightHistoricalSource(undefined, manifest), /explicit absolute/);
  assert.throws(() => preflightHistoricalSource('.', manifest), /explicit absolute/);
  assert.throws(() => preflightHistoricalSource(path.join(root, 'missing-root'), manifest), /unavailable/);
  assert.throws(() => preflightHistoricalSource(path.join(root, manifest.requiredFiles[0].path), manifest), /directory/);
}));

test('finite byte preflight checks every synthetic operand without calling it historical execution', () => withInputs((root, manifest) => {
  const checked = preflightHistoricalSource(root, manifest);
  assert.equal(checked.status, 'MATCHED_FINITE_PINNED_INPUTS'); assert.equal(checked.checked.length, 23);
  assert.equal(checked.sourceRoot, realpathSync(root));
  assert.match(checked.limit, /manual prerequisites/);
  assert.equal(checked.checked[0].sha256, manifest.requiredFiles[0].sha256);
  assert.equal(checked.checked[0].gitBlobSha1, manifest.requiredFiles[0].gitBlobSha1);
}));

test('same-size byte drift CRLF SHA-only drift and Git-blob drift all fail closed', () => withInputs((root, manifest) => {
  const first = manifest.requiredFiles[0], target = path.join(root, first.path);
  const oldBytes = readFileSync(target), drift = Buffer.from(oldBytes); drift[0] ^= 1;
  writeFileSync(target, drift);
  assert.throws(() => preflightHistoricalSource(root, manifest), /bytes differ/);
  writeFileSync(target, oldBytes.toString('utf8').replace(/\n/g, '\r\n'));
  assert.throws(() => preflightHistoricalSource(root, manifest), /Git-byte\/LF/);
  writeFileSync(target, oldBytes);
  const wrongSha = structuredClone(manifest); wrongSha.requiredFiles[0].sha256 = '0'.repeat(64);
  assert.throws(() => preflightHistoricalSource(root, wrongSha), /bytes differ/);
  const wrongBlob = structuredClone(manifest); wrongBlob.requiredFiles[0].gitBlobSha1 = '0'.repeat(40);
  assert.throws(() => preflightHistoricalSource(root, wrongBlob), /bytes differ/);
}));

test('missing and truncated full-source operands refuse instead of producing a green plan', () => withInputs((root, manifest) => {
  const first = manifest.requiredFiles[0], target = path.join(root, first.path), bytes = readFileSync(target);
  writeFileSync(target, bytes.subarray(1));
  assert.throws(() => buildHistoricalReplayPlan({ sourceRoot: root, suite: 'all' }, manifest), /bytes differ/);
  rmSync(target);
  assert.throws(() => buildHistoricalReplayPlan({ sourceRoot: root, suite: 'all' }, manifest), /input unavailable/);
}));

test('all plan contains four manual stages and historical71 only with no current archive or RP pass claim', () => withInputs((root, manifest) => {
  const plan = buildHistoricalReplayPlan({ sourceRoot: root, suite: 'all' }, manifest);
  assert.equal(plan.stages.length, 4); assert.equal(plan.expectedHistoricalExpandedCases, 71);
  assert.deepEqual(plan.stages.map(stage => stage.expectedExpandedCases), [8, 4, 37, 22]);
  assert.equal(plan.nativeExecution, 'UNRUN'); assert.equal(plan.receiptTemplate.passClaim, false);
  assert.equal(plan.receiptTemplate.exitCode, null); assert.equal(plan.receiptTemplate.selectedExpandedCases, null);
  assert.equal(plan.receiptTemplate.executedCaseIds, null);
  assert.equal(plan.currentBackendAcceptance, 'NOT_QUALIFIED_BY_HISTORICAL_REPLAY');
  assert.equal(plan.stages.flatMap(stage => stage.expectedCaseIds).length, 71);
  assert(plan.stages.flatMap(stage => stage.expectedCaseIds).every(id => !id.startsWith('archived Meri thread')));
}));

test('finite suites retain exact expected counts and raw lifecycle selector without passWithNoTests', () => withInputs((root, manifest) => {
  for (const [suite, expected] of [['raw-lifecycle', 8], ['v2-client', 4], ['v2-routing', 37], ['raw-rp', 22]]) {
    const plan = buildHistoricalReplayPlan({ sourceRoot: root, suite }, manifest);
    assert.equal(plan.stages.length, 1); assert.equal(plan.expectedHistoricalExpandedCases, expected);
    const stage = plan.stages[0]; assert(stage.argv.includes('--runInBand'));
    assert(!stage.argv.includes('--passWithNoTests')); assert.equal(stage.historicalNativeStatus, 'UNRUN');
    if (suite === 'raw-lifecycle') assert.deepEqual(stage.argv.slice(-2),
      ['--testNamePattern', '^native Meri lifecycle persistence matches the final stream receipt ']);
    assert.equal(stage.cwd, path.join(realpathSync(root), 'apps/api'));
  }
}));

test('plan requires manual HEAD tree clean-source dependency platform and shared-queue receipts', () => withInputs((root, manifest) => {
  const plan = buildHistoricalReplayPlan({ sourceRoot: root, suite: 'raw-rp' }, manifest);
  assert.equal(plan.manualSourceVerificationArgv.length, 3);
  assert.deepEqual(plan.manualSourceVerificationArgv[0].slice(-2), ['rev-parse', 'HEAD']);
  assert.deepEqual(plan.manualSourceVerificationArgv[1].slice(-2), ['rev-parse', 'HEAD^{tree}']);
  assert.deepEqual(plan.manualSourceVerificationArgv[2].slice(-4), ['diff', '--exit-code', 'HEAD', '--']);
  assert.match(plan.manualPrerequisites.join(' '), /shared local queue/);
  assert.match(plan.manualPrerequisites.join(' '), /already available dependencies/i);
  assert.equal(plan.receiptTemplate.queueOwner, null); assert.equal(plan.receiptTemplate.platformIdentity, null);
  assert.equal(plan.receiptTemplate.fullHeadTreeCleanVerification, 'UNVERIFIED_MANUAL_PREREQUISITE');
}));

test('unknown suites and changed case ownership fail before returning a replay plan', () => withInputs((root, manifest) => {
  assert.throws(() => buildHistoricalReplayPlan({ sourceRoot: root, suite: 'constructor' }, manifest), /Unknown/);
  const changed = structuredClone(CASE_OWNERSHIP); changed.groups.find(group => group.key === 'raw-rp').cases.pop();
  assert.throws(() => buildHistoricalReplayPlan({ sourceRoot: root, suite: 'all' }, manifest, changed), /count mismatch/);
}));

test('production CLI cannot accept synthetic fixture bytes or a caller manifest override', () => withInputs(root => {
  const output = [];
  assert.throws(() => replayPlanCli(['--plan', '--source-root', root, '--suite', 'all'], value => output.push(value)), /bytes differ/);
  assert.deepEqual(output, []);
  assert.throws(() => replayPlanCli(['--plan', '--source-root', root, '--suite', 'all', '--manifest', 'fixture']), /Unknown/);
}));

test('planner stays data-only and receipt has no implicit executable results', () => withInputs((root, manifest) => {
  let attempted = 0;
  const plan = buildHistoricalReplayPlan({ sourceRoot: root, suite: 'all', execute: () => { attempted += 1; } }, manifest);
  assert.equal(attempted, 0);
  assert.equal(plan.receiptTemplate.startedAt, null); assert.equal(plan.receiptTemplate.ownedPID, null);
  assert.equal(plan.receiptTemplate.stdoutSHA256, null); assert.equal(plan.receiptTemplate.stderrSHA256, null);
  assert.equal(plan.receiptTemplate.refusalOrMissingInputsOrZeroSelectionArePass, false);
  assert.match(plan.limits.join(' '), /No process or application TS execution/);
}));
