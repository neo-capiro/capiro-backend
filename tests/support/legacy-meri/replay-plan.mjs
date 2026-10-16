import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Historical data preflight and manual argv only. This module never launches a
// process, restores source, installs dependencies or imports application TS.
// Inputs must have the exact recorded Git bytes/LF representation. A clean
// Windows CRLF checkout is not equivalent here; no line-ending normalization occurs.
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_COMMIT = 'f3ede4fe8d88ba686a81c59f71e44319c0f45fd1';
export const SOURCE_TREE = '1bc72c2b95867d997d4d5063096822fd41892205';
export const SOURCE_INPUTS = JSON.parse(readFileSync(path.join(HERE, 'SOURCE-INPUTS.json'), 'utf8'));
export const CASE_OWNERSHIP = JSON.parse(readFileSync(path.join(HERE, 'CASE-OWNERSHIP.json'), 'utf8'));
const REQUIRED_PATHS = SOURCE_INPUTS.requiredFiles.map(row => row.path);
const COUNTS = Object.freeze({ 'raw-lifecycle': 8, 'current-archive': 3, 'v2-client': 4,
  'v2-helper': 5, 'v2-matrix': 32, 'raw-rp': 22, 'current-runtime-proxy': 5,
  'current-phase19': 8, 'current-runtime-coverage': 6 });
const SUITE_GROUPS = Object.freeze({ 'raw-lifecycle': ['raw-lifecycle'], 'v2-client': ['v2-client'],
  'v2-routing': ['v2-helper', 'v2-matrix'], 'raw-rp': ['raw-rp'],
  all: ['raw-lifecycle', 'v2-client', 'v2-helper', 'v2-matrix', 'raw-rp'] });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const exactKeys = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
};
const safeRelative = value => typeof value === 'string' && value.length > 0 &&
  !value.includes('\\') && !value.includes(':') && !value.startsWith('/') &&
  value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');

export function validateOwnership(ledger) {
  if (ledger?.schemaVersion !== 1 || ledger.sourceCommit !== SOURCE_COMMIT || ledger.sourceTree !== SOURCE_TREE)
    fail('Historical case ownership has the wrong schema or immutable source pin');
  if (ledger.historicalExecution?.status !== 'UNRUN' || ledger.historicalExecution.passClaim !== false)
    fail('A case ownership ledger cannot manufacture a historical native pass');
  if (!Array.isArray(ledger.groups) || !exactKeys(ledger.groups.map(group => group.key), Object.keys(COUNTS)))
    fail('Historical/current case groups are missing, duplicated or unowned');
  const ids = new Set();
  for (const group of ledger.groups) {
    if (group.expandedCases !== COUNTS[group.key] || !Array.isArray(group.cases) || group.cases.length !== COUNTS[group.key])
      fail('Expanded case ownership count mismatch: ' + group.key);
    if (!safeRelative(group.sourcePath) || !/^[a-f0-9]{40}$/.test(group.sourceBlob ?? '') || !group.owner)
      fail('Case source/owner metadata missing: ' + group.key);
    for (const item of group.cases) {
      if (typeof item.id !== 'string' || !item.id || ids.has(item.id) || !item.suite || !Number.isInteger(item.declarationLine))
        fail('Case identity is missing or duplicated: ' + group.key);
      ids.add(item.id);
    }
  }
  if (ledger.totals?.historicalExpandedCases !== 71 || ledger.totals.existingCurrentExpandedCases !== 22 ||
      ledger.totals.currentRpMappedIdentities !== 22) fail('Case totals must preserve historical71/current22/mappedRP22');
  const rpIds = ledger.groups.find(group => group.key === 'raw-rp').cases.map(item => item.id);
  if (!Array.isArray(ledger.currentRpMappings) || ledger.currentRpMappings.length !== 22 ||
      !exactKeys(ledger.currentRpMappings.map(item => item.oldCaseId), rpIds) ||
      ledger.currentRpMappings.some(item => item.status !== 'source-landed-native-UNRUN' ||
        !item.newNativeCaseId || !item.newBuiltinCaseId || !item.nativePath || !item.builtinPath))
    fail('Every historical RP identity needs one deliberate current-seam mapping');
  return ledger;
}

export function validateSourceManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.sourceCommit !== SOURCE_COMMIT || manifest.sourceTree !== SOURCE_TREE)
    fail('Historical source manifest has the wrong schema or immutable source pin');
  if (!Array.isArray(manifest.requiredFiles) || !exactKeys(manifest.requiredFiles.map(row => row.path), REQUIRED_PATHS))
    fail('Finite historical source inputs are incomplete, duplicated or unowned');
  for (const row of manifest.requiredFiles) {
    if (!safeRelative(row.path) || row.mode !== '100644' || !/^[a-f0-9]{64}$/.test(row.sha256 ?? '') ||
        !/^[a-f0-9]{40}$/.test(row.gitBlobSha1 ?? '') || !Number.isSafeInteger(row.bytes) || row.bytes < 0)
      fail('Invalid historical byte operand: ' + row.path);
  }
  return manifest;
}

export function parseReplayArguments(argv) {
  let plan = false, sourceRoot, suite;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--plan' && !plan) { plan = true; continue; }
    if (token === '--source-root' && sourceRoot === undefined || token === '--suite' && suite === undefined) {
      const value = argv[++index];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) fail('Missing value for ' + token);
      if (token === '--source-root') sourceRoot = value; else suite = value;
      continue;
    }
    fail('Unknown, duplicate or executing argument: ' + token + '. This command supports --plan only; reserve the shared queue for manual native execution.');
  }
  if (!plan || !sourceRoot || !suite || !Object.hasOwn(SUITE_GROUPS, suite))
    fail('Use exactly --plan --source-root <existing absolute pinned full-source root> --suite <raw-lifecycle|v2-client|v2-routing|raw-rp|all>');
  if (!path.isAbsolute(sourceRoot)) fail('An explicit absolute existing full-source root is required');
  return { sourceRoot, suite };
}

// The optional manifest parameter is a pure fixture seam for the unit controls.
// CLI callers cannot supply a manifest, case ledger, executor or runtime flags.
export function preflightHistoricalSource(sourceRoot, manifest = SOURCE_INPUTS) {
  validateSourceManifest(manifest);
  if (typeof sourceRoot !== 'string' || !sourceRoot.trim() || !path.isAbsolute(sourceRoot))
    fail('An explicit absolute existing full-source root is required; there is no current-checkout fallback');
  let root;
  try {
    if (!lstatSync(sourceRoot).isDirectory()) fail('Historical source root is not a directory');
    root = realpathSync(sourceRoot);
  } catch (error) { fail('Existing pinned historical source root unavailable: ' + error.message); }
  const checked = [];
  for (const row of manifest.requiredFiles) {
    const target = path.resolve(root, row.path);
    if (!inside(root, target)) fail('Historical source input escapes supplied root: ' + row.path);
    let bytes;
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || !inside(root, realpathSync(target)))
        fail('Historical source input is not an owned regular file: ' + row.path);
      if (stat.size !== row.bytes) fail('Historical source bytes differ from exact sealed Git-byte/LF input: ' + row.path);
      bytes = readFileSync(target);
    } catch (error) { fail('Historical source input unavailable: ' + row.path + ': ' + error.message); }
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256 || gitBlob(bytes) !== row.gitBlobSha1)
      fail('Historical source bytes differ from exact sealed Git-byte/LF input: ' + row.path);
    checked.push({ path: row.path, bytes: bytes.length, sha256: row.sha256, gitBlobSha1: row.gitBlobSha1 });
  }
  return { sourceRoot: root, status: 'MATCHED_FINITE_PINNED_INPUTS', checked,
    limit: 'Exact finite Git bytes/LF only; CRLF is rejected, never normalized. Full HEAD/tree/clean-source, dependencies and native execution remain manual prerequisites.' };
}

function nativeStage(key, groups, sourceRoot) {
  const selected = key === 'v2-routing' ? ['v2-helper', 'v2-matrix'] : [key];
  const rows = selected.map(name => groups.find(group => group.key === name));
  const paths = rows.map(group => group.sourcePath.replace(/^apps\/api\//, ''));
  const argv = ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--config', 'jest.config.cjs',
    '--runInBand', '--runTestsByPath', ...paths];
  if (key === 'raw-lifecycle') argv.push('--testNamePattern', '^native Meri lifecycle persistence matches the final stream receipt ');
  return { suite: key, executable: 'node (queue-approved installed absolute path required)',
    argv, cwd: path.join(sourceRoot, 'apps/api'), expectedExpandedCases: rows.reduce((sum, group) => sum + group.expandedCases, 0),
    expectedCaseIds: rows.flatMap(group => group.cases.map(item => item.id)),
    historicalNativeStatus: 'UNRUN', launchAuthority: 'Manual only after the shared local queue owner reserves capacity',
    resourceLimits: 'Queue owner must supply explicit time/memory/process-tree limits; no defaults are invented here' };
}

export function buildHistoricalReplayPlan(options, fixtureInputs = SOURCE_INPUTS, fixtureOwnership = CASE_OWNERSHIP) {
  if (!options || !Object.hasOwn(SUITE_GROUPS, options.suite)) fail('Unknown or missing finite historical suite');
  const ledger = validateOwnership(fixtureOwnership);
  const preflight = preflightHistoricalSource(options.sourceRoot, fixtureInputs);
  const stageKeys = options.suite === 'all' ? ['raw-lifecycle', 'v2-client', 'v2-routing', 'raw-rp'] : [options.suite];
  const stages = stageKeys.map(key => nativeStage(key, ledger.groups, preflight.sourceRoot));
  const expected = stages.reduce((sum, stage) => sum + stage.expectedExpandedCases, 0);
  return { schemaVersion: 1, kind: 'historical-native-replay-plan-data-only', sourceCommit: SOURCE_COMMIT, sourceTree: SOURCE_TREE,
    selectedSuite: options.suite, expectedHistoricalExpandedCases: expected, finiteInputPreflight: preflight,
    nativeExecution: 'UNRUN', currentBackendAcceptance: 'NOT_QUALIFIED_BY_HISTORICAL_REPLAY', stages,
    manualPrerequisites: [
      'Reserve shared local queue capacity with the shipping owner before any native process; no tool here launches one.',
      'Manually verify exact Git HEAD and tree plus clean tracked source across the supplied full checkout; finite input hashes do not replace that check.',
      'Supplied operands must already match exact recorded Git bytes/LF. A clean Windows CRLF checkout is insufficient and is refused; this planner performs no normalization/materialization.',
      'Use already available dependencies/toolchain consistent with the pinned lock/native config. No automatic checkout, extraction, install or services.',
      'Retain current archive3/current V3/current RP protection in separate current-source qualification; historical matches are not their pass.',
    ],
    manualSourceVerificationArgv: [
      ['git', '-C', preflight.sourceRoot, 'rev-parse', 'HEAD'],
      ['git', '-C', preflight.sourceRoot, 'rev-parse', 'HEAD^{tree}'],
      ['git', '-C', preflight.sourceRoot, 'diff', '--exit-code', 'HEAD', '--'],
    ],
    receiptTemplate: { status: 'UNRUN', passClaim: false, sourceCommit: SOURCE_COMMIT, sourceTree: SOURCE_TREE,
      fullHeadTreeCleanVerification: 'UNVERIFIED_MANUAL_PREREQUISITE', queueReservation: null, queueOwner: null,
      nativeExecutableIdentity: null, platformIdentity: null, exactCwdArgv: stages.map(({ cwd, argv }) => ({ cwd, argv })),
      expectedExpandedCases: expected, selectedExpandedCases: null, executedCaseIds: null,
      startedAt: null, endedAt: null, ownedPID: null, observedPeakWorkingSetBytes: null,
      exitCode: null, timedOut: null, stoppedForResourcePressure: null, stdoutSHA256: null, stderrSHA256: null,
      refusalOrMissingInputsOrZeroSelectionArePass: false },
    limits: ['No process or application TS execution occurs in this planner.',
      'No native, framework, database, current router, authorization, startup, image or deployment acceptance is claimed.',
      'Historical RP raw-fragment evidence does not retire canonical current RP authorization protection.'] };
}

export function replayPlanCli(argv, output = value => process.stdout.write(value + '\n')) {
  const plan = buildHistoricalReplayPlan(parseReplayArguments(argv));
  output(JSON.stringify(plan, null, 2));
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { replayPlanCli(process.argv.slice(2)); }
  catch (error) { console.error('HISTORICAL_MERI_REPLAY_PLAN_REFUSED: ' + error.message); process.exitCode = 2; }
}
