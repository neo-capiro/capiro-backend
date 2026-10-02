// Local v5 qualification. Import/readiness do not authenticate or mutate anything.
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
const TESTED_CODE = '280828b3256af2e1b69662b0867290239943cb6a';
const WEB_SOURCE = '78ad5805679a3045b1fc10fb19beafa7f76e4e64';
const PRIOR = 'C:/dev/cap-meri-foundation-evidence/oct02-live-repair-release';
const hash = value => createHash('sha256').update(value).digest('hex');
const need = (ok, code) => { if (!ok) { const error = new Error(code); error.safeCode = code; throw error; } };
const HASH = /^[a-f0-9]{64}$/u, SHA = /^[a-f0-9]{40}$/u;
function pinned(path, expected) {
  need(HASH.test(expected ?? ''), 'V5_PIN_REQUIRED');
  const bytes = readFileSync(path); need(hash(bytes) === expected, 'V5_PINNED_FILE_CHANGED');
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
}
export function inspectV5Pins(pins) {
  need(pins?.schemaVersion === 1 && pins.kind === 'meri-case17-v5-release-pins' &&
    pins.target === 'https://os.capiro.ai' && pins.testedCodeSha === TESTED_CODE &&
    SHA.test(pins.sourceSha ?? '') && pins.webSourceSha === WEB_SOURCE, 'V5_RELEASE_PINS_INVALID');
  for (const key of ['gatesSha256', 'driverSha256', 'reviewedBuildInputSha256', 'apiBuildReadbackSha256'])
    need(HASH.test(pins[key] ?? ''), 'V5_PIN_REQUIRED');
  return structuredClone(pins);
}
/** Root seals pins only after the new exact API image is built and deployed.
 * The actual source-owned collector re-reads CodeBuild/ECR/ECS/ALB before capture. */
export function loadRelease(driverName) {
  need(driverName === 'run-case17-authenticated-v5.mjs', 'V5_FIXED_DRIVER_REQUIRED');
  need(hash(readFileSync(PRIOR + '/live-operator-gates.mjs')) ===
    '24fd0aa4650bf8251acda73af0b1d7dece81af5d561e82888cd6f27687f3600f', 'V5_SHARED_GATES_CHANGED');
  const bytes = readFileSync(join(BASE, 'case17-v5-release-pins.json'));
  const pins = inspectV5Pins(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')));
  need(hash(readFileSync(fileURLToPath(import.meta.url))) === pins.gatesSha256 &&
    hash(readFileSync(join(BASE, driverName))) === pins.driverSha256, 'V5_OPERATOR_HASH_CHANGED');
  const reviewed = pinned(join(BASE, 'reviewed-build-input.json'), pins.reviewedBuildInputSha256);
  need(reviewed.sourceSha === pins.sourceSha && reviewed.testedCodeSha === TESTED_CODE, 'V5_REVIEWED_SOURCE_CHANGED');
  const expected = reviewed.services?.api;
  need(expected && Array.isArray(expected.executedMarkers) &&
    ['OFFLINE_RUNTIME_IMPORT_PASS', 'OFFLINE_CASE01_FIXTURE_PACKAGE_IMPORT_PASS', 'EXACT_449_IMAGE_MIGRATION_HASHES_PASS'].every(marker => expected.executedMarkers.includes(marker)), 'V5_BUILD_MARKERS_REQUIRED');
  const api = pinned(join(BASE, 'api-build-readback.json'), pins.apiBuildReadbackSha256);
  const builds = { api: inspectBuildReadback(api, 'api', pins.sourceSha, expected.buildspecSha256, expected.executedMarkers) };
  const web = pinned(REPO + '/docs/meri/releases/2026-10-02/composed-release/web-vnext-build-readback.json',
    '5c792c3a56a50ccc5601a90b7f2903d10581919dca6e73679c421b168913270d');
  builds['web-vnext'] = inspectBuildReadback(web, 'web-vnext', WEB_SOURCE, web.actualBuildspecSha256);
  const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true }).trim();
  need(git('branch', '--show-current') === 'main' && git('rev-parse', 'HEAD') === git('rev-parse', 'origin/main') && git('status', '--porcelain') === '', 'V5_CLEAN_CURRENT_MAIN_REQUIRED');
  git('merge-base', '--is-ancestor', TESTED_CODE, pins.sourceSha);
  assertDocsOnly(git('diff', '--name-only', '--no-renames', '-z', TESTED_CODE, pins.sourceSha).split('\0'));
  git('merge-base', '--is-ancestor', pins.sourceSha, 'HEAD');
  assertDocsOnly(git('diff', '--name-only', '--no-renames', '-z', pins.sourceSha, 'HEAD').split('\0'));
  return { sourceSha: pins.sourceSha, webSourceSha: WEB_SOURCE, operatorHead: git('rev-parse', 'HEAD'), builds, pinsSha256: hash(bytes) };
}
export function readPriorCase17() {
  const recipe = readPriorV3();
  for (const [name, digest, status] of [
    ['case17-live-execution-v4.json', 'b85cc57076bffc22543df67d8ebd55adab9611d15109e2b18cdac0bc328f0316', 'BLOCKED'],
    ['case17-ui-diagnostic-v1.json', '2afc0a74afcd443f84b8fb015f572625fa53d5bbaa0cceab3d38dd64fe1b17a7', 'READ_ONLY_DIAGNOSTIC_FAILED'],
  ]) {
    const row = pinned(PRIOR + '/' + name, digest);
    need(row.caseId === '17' && row.status === status && row.sessionCreated === true &&
      row.sessionRevoked === true && row.synthesisSubmissionCount === 0 && row.applicationWrites === 0, 'V5_PRIOR_CLEANUP_REQUIRED');
  }
  return recipe;
}
