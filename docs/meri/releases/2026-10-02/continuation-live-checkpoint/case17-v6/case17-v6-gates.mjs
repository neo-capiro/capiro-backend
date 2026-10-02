// Local v6 qualification. Import/readiness do not authenticate or mutate anything.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectBuildReadback, assertDocsOnly, assertSameRelease,
  readPriorCase17 as readPriorV3,
} from '../oct02-live-repair-release/live-operator-gates.mjs';

export { assertSameRelease };
export const BASE = dirname(fileURLToPath(import.meta.url));
const REPO = 'C:/dev/cap-meri-outcomes-validation';
export const TESTED_CODE = '823edc1110a02082a06a4ff90cbaaa71f83b4e15';
export const RELEASE_SOURCE = '42780caa75fcabe4f83e619ad81c0f36fdda8fad';
export const DRIVER = 'C:/dev/cap-meri-approval-recovery';
export const DRIVER_SHA = 'b673848069d4d63da159177bee4cd436d2328878';
const WEB_SOURCE = '78ad5805679a3045b1fc10fb19beafa7f76e4e64';
const PRIOR = 'C:/dev/cap-meri-foundation-evidence/oct02-live-repair-release';
const hash = value => createHash('sha256').update(value).digest('hex');
const need = (ok, code) => { if (!ok) { const error = new Error(code); error.safeCode = code; throw error; } };
const HASH = /^[a-f0-9]{64}$/u, SHA = /^[a-f0-9]{40}$/u;
function pinned(path, expected) {
  need(HASH.test(expected ?? ''), 'V6_PIN_REQUIRED');
  const bytes = readFileSync(path); need(hash(bytes) === expected, 'V6_PINNED_FILE_CHANGED');
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
}
export function inspectV6Pins(pins) {
  need(pins?.schemaVersion === 1 && pins.kind === 'meri-case17-v6-release-pins' &&
    pins.target === 'https://os.capiro.ai' && pins.testedCodeSha === TESTED_CODE &&
    pins.sourceSha === RELEASE_SOURCE && pins.webSourceSha === WEB_SOURCE && pins.driverSourceSha === DRIVER_SHA, 'V6_RELEASE_PINS_INVALID');
  for (const key of ['gatesSha256', 'driverSha256', 'reviewedBuildInputSha256', 'apiBuildReadbackSha256'])
    need(HASH.test(pins[key] ?? ''), 'V6_PIN_REQUIRED');
  return structuredClone(pins);
}
/** Root seals pins only after the new exact API image is built and deployed.
 * The actual source-owned collector re-reads CodeBuild/ECR/ECS/ALB before capture. */
export const DRIVER_DELTA = Object.freeze([
  'evals/meri/live-v1/case17-memory-ui.mjs',
  'evals/meri/live-v1/tests/case17-memory-ui-query.test.mjs',
]);
export function inspectDriverDelta(paths) {
  const actual = paths.filter(Boolean);
  need(actual.length === DRIVER_DELTA.length && [...actual].sort().join('\n') === [...DRIVER_DELTA].sort().join('\n'), 'V6_DRIVER_DELTA_CHANGED');
}
export function loadRelease(driverName) {
  need(driverName === 'run-case17-authenticated-v6.mjs', 'V6_FIXED_DRIVER_REQUIRED');
  need(hash(readFileSync(PRIOR + '/live-operator-gates.mjs')) ===
    '24fd0aa4650bf8251acda73af0b1d7dece81af5d561e82888cd6f27687f3600f', 'V6_SHARED_GATES_CHANGED');
  const bytes = readFileSync(join(BASE, 'case17-v6-release-pins.json'));
  const pins = inspectV6Pins(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')));
  need(hash(readFileSync(fileURLToPath(import.meta.url))) === pins.gatesSha256 &&
    hash(readFileSync(join(BASE, driverName))) === pins.driverSha256, 'V6_OPERATOR_HASH_CHANGED');
  const reviewed = pinned(join(BASE, 'reviewed-build-input.json'), pins.reviewedBuildInputSha256);
  need(reviewed.sourceSha === pins.sourceSha && reviewed.testedCodeSha === TESTED_CODE, 'V6_REVIEWED_SOURCE_CHANGED');
  const expected = reviewed.services?.api;
  need(expected && Array.isArray(expected.executedMarkers) &&
    ['OFFLINE_RUNTIME_IMPORT_PASS', 'OFFLINE_CASE01_FIXTURE_PACKAGE_IMPORT_PASS', 'EXACT_449_IMAGE_MIGRATION_HASHES_PASS'].every(marker => expected.executedMarkers.includes(marker)), 'V6_BUILD_MARKERS_REQUIRED');
  const api = pinned(join(BASE, 'api-build-readback.json'), pins.apiBuildReadbackSha256);
  need(api.buildId === 'capiro-build-web-dev:5a08bc24-ebee-4088-bf5e-e6e16946924b', 'V6_EXPECTED_BUILD_REQUIRED');
  const builds = { api: inspectBuildReadback(api, 'api', pins.sourceSha, expected.buildspecSha256, expected.executedMarkers) };
  const web = pinned(REPO + '/docs/meri/releases/2026-10-02/composed-release/web-vnext-build-readback.json',
    '5c792c3a56a50ccc5601a90b7f2903d10581919dca6e73679c421b168913270d');
  builds['web-vnext'] = inspectBuildReadback(web, 'web-vnext', WEB_SOURCE, web.actualBuildspecSha256);
  const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true }).trim();
  need(git('branch', '--show-current') === 'main' && git('rev-parse', 'HEAD') === git('rev-parse', 'origin/main') && git('status', '--porcelain') === '', 'V6_CLEAN_CURRENT_MAIN_REQUIRED');
  git('merge-base', '--is-ancestor', TESTED_CODE, pins.sourceSha);
  assertDocsOnly(git('diff', '--name-only', '--no-renames', '-z', TESTED_CODE, pins.sourceSha).split('\0'));
  git('merge-base', '--is-ancestor', pins.sourceSha, 'HEAD');
  assertDocsOnly(git('diff', '--name-only', '--no-renames', '-z', pins.sourceSha, 'HEAD').split('\0'));
  const driverGit = (...args) => execFileSync('git', args, { cwd: DRIVER, encoding: 'utf8', windowsHide: true }).trim();
  need(driverGit('rev-parse', 'HEAD') === DRIVER_SHA && driverGit('status', '--porcelain') === '', 'V6_CLEAN_FIXED_DRIVER_REQUIRED');
  driverGit('merge-base', '--is-ancestor', TESTED_CODE, DRIVER_SHA);
  inspectDriverDelta(driverGit('diff', '--name-only', '--no-renames', '-z', TESTED_CODE, DRIVER_SHA).split('\0'));
  return { sourceSha: pins.sourceSha, driverSourceSha: DRIVER_SHA, webSourceSha: WEB_SOURCE, operatorHead: git('rev-parse', 'HEAD'), builds, pinsSha256: hash(bytes) };
}
export function readPriorCase17() {
  const recipe = readPriorV3();
  for (const [name, digest, status] of [
    ['case17-live-execution-v4.json', 'b85cc57076bffc22543df67d8ebd55adab9611d15109e2b18cdac0bc328f0316', 'BLOCKED'],
    ['case17-ui-diagnostic-v1.json', '2afc0a74afcd443f84b8fb015f572625fa53d5bbaa0cceab3d38dd64fe1b17a7', 'READ_ONLY_DIAGNOSTIC_FAILED'],
  ]) {
    const row = pinned(PRIOR + '/' + name, digest);
    need(row.caseId === '17' && row.status === status && row.sessionCreated === true &&
      row.sessionRevoked === true && row.synthesisSubmissionCount === 0 && row.applicationWrites === 0, 'V6_PRIOR_CLEANUP_REQUIRED');
  }
  const v5 = pinned('C:/dev/cap-meri-foundation-evidence/oct02-case17-v5/case17-live-execution-v5.json',
    '27cae5cd83fbe9bcc0d1e2f6f519dab734b709e824e1e6f4ed1f409d91385457');
  need(v5.caseId === '17' && v5.status === 'BLOCKED' && v5.failureCode === 'CASE17_UI_UNIQUE_CARD' &&
    v5.sessionCreated === true && v5.sessionRevoked === true && v5.synthesisSubmissionCount === 0 && v5.applicationWrites === 0, 'V6_PRIOR_V5_CLEANUP_REQUIRED');
  const diagnostic = pinned('C:/dev/cap-meri-foundation-evidence/oct02-case17-card-diagnostic/case17-card-diagnostic-v1.json',
    '8c5b04df235b287aaedbfd134e669652b1a25d70c44e22c09872717f42c68b75');
  need(diagnostic.caseId === '17' && diagnostic.status === 'READ_ONLY_DIAGNOSTIC_COMPLETE' &&
    diagnostic.sessionCreated === true && diagnostic.sessionRevoked === true && diagnostic.synthesisSubmissionCount === 0 && diagnostic.applicationWrites === 0, 'V6_PRIOR_DIAGNOSTIC_CLEANUP_REQUIRED');
  need(hash(readFileSync('C:/dev/cap-meri-foundation-evidence/oct02-case17-card-diagnostic/case17-card-diagnostic-v1.png')) ===
    '6066bae228d02f7ca10bb4098e142576b95be67425e36dcf512166b628ff4d7b', 'V6_PRIOR_DIAGNOSTIC_IMAGE_CHANGED');
  return recipe;
}
