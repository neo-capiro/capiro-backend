// Local operator qualification only. No auth, network, process launch or writes on import.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = dirname(fileURLToPath(import.meta.url));
export const REPO = 'C:/dev/cap-meri-outcomes-validation';
export const TESTED_CODE = '7a03305030b734a39cce321a5b5aff36f6d19609';
export const RELEASE_SOURCE = 'c22d059e4fc8fd73f93e6928f7db3a1a4338f7f8';
export const WEB_SOURCE = '78ad5805679a3045b1fc10fb19beafa7f76e4e64';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const need = (ok, code) => { if (!ok) { const error = new Error(code); error.safeCode = code; throw error; } };
export const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
const HASH = /^[a-f0-9]{64}$/u, SHA = /^[a-f0-9]{40}$/u;
function pinned(path, expected) {
  need(HASH.test(expected ?? ''), 'PIN_REQUIRED');
  const bytes = readFileSync(path);
  need(sha256(bytes) === expected, 'PINNED_FILE_CHANGED');
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
}
export function inspectBuildReadback(row, service, sourceSha, specSha, markers = []) {
  need(row?.service === service && row.verdict === 'PASS' && row.buildStatus === 'SUCCEEDED' &&
    row.sourceSha === sourceSha && row.resolvedSourceSha === sourceSha && SHA.test(sourceSha) &&
    row.actualBuildspecSha256 === specSha && HASH.test(specSha ?? '') &&
    /^capiro-build-[a-z0-9-]+:[a-f0-9-]{36}$/u.test(row.buildId ?? '') &&
    /^sha256:[a-f0-9]{64}$/u.test(row.imageDigest ?? '') &&
    row.image === `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/${service}@${row.imageDigest}` &&
    Number.isFinite(Date.parse(row.observedAt)), 'BUILD_READBACK_INVALID');
  for (const phase of ['PRE_BUILD', 'BUILD', 'POST_BUILD'])
    need(row.phases?.filter(value => value.phase === phase && value.status === 'SUCCEEDED').length === 1, 'BUILD_PHASE_MISSING');
  for (const marker of markers)
    need(row.executedMarkers?.some(value => value.line === marker), 'BUILD_MARKER_MISSING');
  return { service, sourceSha, buildId: row.buildId, buildspecSha256: specSha, imageDigest: row.imageDigest };
}
export function assertDocsOnly(paths) {
  need(paths.every(path => !path || (path.startsWith('docs/') && !path.includes('\\'))), 'OPERATOR_CODE_DRIFT');
}
/** Pins are sealed only from the actual completed release/readback files. Missing
 * files intentionally block execution. Source-owned collectors independently
 * re-read actual CodeBuild/ECR/ECS/ALB immediately before their live capture. */
export function loadRelease(driverName) {
  need(['run-case17-authenticated-v4.mjs', 'run-case01-authenticated-v2.mjs'].includes(driverName), 'FIXED_DRIVER_REQUIRED');
  const pinsBytes = readFileSync(join(BASE, 'live-operator-release-pins.json'));
  const pins = JSON.parse(pinsBytes.toString('utf8').replace(/^\uFEFF/u, ''));
  need(pins?.schemaVersion === 1 && pins.kind === 'meri-live-repair-operator-pins' &&
    pins.target === 'https://os.capiro.ai' && pins.testedCodeSha === TESTED_CODE &&
    pins.sourceSha === RELEASE_SOURCE && pins.webSourceSha === WEB_SOURCE, 'RELEASE_PINS_INVALID');
  need(sha256(readFileSync(fileURLToPath(import.meta.url))) === pins.gatesSha256 &&
    sha256(readFileSync(join(BASE, driverName))) === pins.driverSha256?.[driverName], 'OPERATOR_HASH_CHANGED');
  const reviewed = pinned(join(BASE, 'reviewed-build-input.json'), pins.reviewedBuildInputSha256);
  need(reviewed.sourceSha === pins.sourceSha && reviewed.testedCodeSha === TESTED_CODE, 'REVIEWED_SOURCE_CHANGED');
  const builds = {};
  for (const service of ['api', 'meriv2-orchestrator']) {
    const row = pinned(join(BASE, `${service}-build-readback.json`), pins.buildReadbackSha256?.[service]);
    const expected = reviewed.services?.[service];
    need(expected && Array.isArray(expected.executedMarkers), 'REVIEWED_BUILD_REQUIRED');
    builds[service] = inspectBuildReadback(row, service, pins.sourceSha, expected.buildspecSha256, expected.executedMarkers);
  }
  const web = pinned(join(REPO, 'docs/meri/releases/2026-10-02/composed-release/web-vnext-build-readback.json'),
    '5c792c3a56a50ccc5601a90b7f2903d10581919dca6e73679c421b168913270d');
  builds['web-vnext'] = inspectBuildReadback(web, 'web-vnext', WEB_SOURCE, web.actualBuildspecSha256);
  const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true }).trim();
  need(git('branch', '--show-current') === 'main' && git('rev-parse', 'HEAD') === git('rev-parse', 'origin/main') &&
    git('status', '--porcelain') === '', 'CLEAN_CURRENT_MAIN_REQUIRED');
  git('merge-base', '--is-ancestor', TESTED_CODE, pins.sourceSha);
  assertDocsOnly(git('diff', '--name-only', '--no-renames', '-z', TESTED_CODE, pins.sourceSha).split('\0'));
  git('merge-base', '--is-ancestor', pins.sourceSha, 'HEAD');
  assertDocsOnly(git('diff', '--name-only', '--no-renames', '-z', pins.sourceSha, 'HEAD').split('\0'));
  return { sourceSha: pins.sourceSha, webSourceSha: WEB_SOURCE, operatorHead: git('rev-parse', 'HEAD'),
    builds, pinsSha256: sha256(pinsBytes) };
}
export function assertSameRelease(first, next) {
  need(JSON.stringify(first) === JSON.stringify(next), 'RELEASE_CHANGED_DURING_OPERATION');
}

const PRIOR = 'C:/dev/cap-meri-foundation-evidence/oct02-case17-live';
export function readPriorCase17() {
  const rows = [
    ['live-execution.json', '91af3b3ae751cf0965aea6f197cafb4e76debc1458a49de7e67e79d19ca98f77', false],
    ['live-execution-v2.json', 'b7a5700baff310ee82f86ce70c4095f43430a8a14f4d3a118da8b2d94fe56ef1', true],
    ['live-execution-v3.json', '793eaad76079664ed5de425e3e9c14a24bcb321d8e3c60178649a182db60ce8f', true],
  ];
  for (const [file, digest, created] of rows) {
    const row = pinned(join(PRIOR, file), digest);
    need(row.status === 'BLOCKED' && row.caseId === '17' && row.sourceSha === WEB_SOURCE &&
      row.sessionCreated === created && (!created || row.sessionRevoked === true) &&
      row.synthesisSubmissionCount === 0 && row.applicationWrites === 0, 'PRIOR_CASE17_OUTCOME_UNSAFE');
  }
  const recipe = pinned(join(PRIOR, 'setup-plan-input.json'), '9d707ab9027aebcbe797639b174db1e4df2537351970316664f20a339f5a0f88').recipe;
  const setup = pinned(join(PRIOR, 'setup-execute-execution.json'), 'b7240a5bf3a0de1d9f91e698901002f0f66a87a47ee2d464911ab951133e129b');
  need(setup.status === 'VERIFIED' && setup.mode === 'pending-execute' && setup.sourceSha === WEB_SOURCE &&
    setup.containerExitCode === 0 && setup.ownerReceipts?.at(-1)?.receipt?.status === 'SETUP_COMPLETE', 'ACTUAL_CASE17_SETUP_REQUIRED');
  return recipe;
}

const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
export const stableHash = value => sha256(canonical(value));
export function inspectCase01Inputs({ config, recovery, budget, release, now = Date.now() }) {
  need(recovery?.status === 'VERIFIED' && recovery.mode === 'setup-recovery-execute' &&
    recovery.sourceSha === release.sourceSha && recovery.containerExitCode === 0 &&
    budget?.status === 'VERIFIED' && budget.mode === 'budget-install' &&
    budget.sourceSha === release.sourceSha && budget.containerExitCode === 0, 'CASE01_ACTUAL_SETUP_REQUIRED');
  const complete = recovery.ownerReceipts?.filter(row => row.stage === 'COMPLETE' && row.phase === 'VERIFIED');
  need(complete?.length === 1 && budget.ownerReceipts?.length === 1, 'CASE01_OWNER_RECEIPTS_REQUIRED');
  const setup = complete[0].receipt, installed = budget.ownerReceipts[0];
  need(setup?.kind === 'meri-case01-execution-setup-receipt' && setup.schemaVersion === 1 &&
    setup.status === 'SETUP_COMPLETE' && setup.synthesisSubmissionCount === 0 &&
    installed?.status === 'PROVIDER_QUALIFICATION_INSTALLED', 'CASE01_OWNER_NOT_READY');
  need(config?.caseId === '01' && config.provenance === 'LIVE_CAPTURE' &&
    config.captureRunId === setup.captureRunId && config.conversationId === setup.conversationId &&
    config.scope?.actors?.PAT?.userId === setup.ctx?.userId && setup.ctx?.role === 'standard_user' &&
    config.scope?.tenants?.T1?.physicalId === setup.ctx?.tenantId &&
    config.scope?.clients?.ASTER?.physicalId === setup.clientId &&
    stableHash(config.scope?.sources) === stableHash(setup.sourceMap) &&
    Object.keys(setup.sourceMap ?? {}).join('|') === 'MA1-v2', 'CASE01_SCOPE_OWNER_MISMATCH');
  need(setup.bindingSha256 === stableHash(setup.binding) &&
    setup.binding?.caseId === '01' && setup.binding.captureRunId === setup.captureRunId &&
    setup.binding.physicalMapSha256 === stableHash(setup.sourceMap) &&
    setup.binding.currentVerifySha256 === setup.currentVerifySha256 &&
    config.fixture?.mappingSha256 === setup.binding.physicalMapSha256 &&
    config.fixture.seedReceiptId === setup.seedReceiptId && config.fixture.resetReceiptId === setup.resetReceiptId &&
    installed.tenantId === setup.ctx.tenantId && installed.clientId === setup.clientId &&
    installed.captureRunId === setup.captureRunId && installed.currentVerifySha256 === setup.currentVerifySha256 &&
    installed.captureBindingSha256 === setup.bindingSha256 && HASH.test(installed.qualificationSha256 ?? '') &&
    HASH.test(installed.rateEvidenceSha256 ?? ''), 'CASE01_INSTALLED_BINDING_MISMATCH');
  const micros = config.limits?.maxSpendUsd * 1000000;
  need(Number.isSafeInteger(micros) && micros > 0 && micros <= 3000000 &&
    Number.isSafeInteger(installed.maxCostMicros) && installed.maxCostMicros >= micros && installed.maxCostMicros <= 3000000 &&
    Date.parse(installed.rateEvidenceExpiresAt) >= now + 1800000, 'CASE01_BUDGET_OR_RATE_EXPIRED');
  need(config.deployment?.apiSha === release.sourceSha && config.deployment.orchestratorSha === release.sourceSha &&
    stableHash(config.deployment.builds) === stableHash({api:release.builds.api,'meriv2-orchestrator':release.builds['meriv2-orchestrator']}), 'CASE01_DEPLOYMENT_MISMATCH');
  return { config, owner: { captureRunId: setup.captureRunId, conversationId: setup.conversationId,
    currentVerifySha256: setup.currentVerifySha256, bindingSha256: setup.bindingSha256,
    qualificationSha256: installed.qualificationSha256, maxCostMicros: installed.maxCostMicros } };
}
export function readCase01Inputs(release) {
  const pinBytes = readFileSync(join(BASE, 'case01-operator-input-pins.json'));
  const pins = JSON.parse(pinBytes.toString('utf8').replace(/^\uFEFF/u, ''));
  need(pins?.schemaVersion === 1 && pins.kind === 'meri-case01-recovered-capture-inputs' &&
    pins.sourceSha === release.sourceSha, 'CASE01_INPUT_PINS_INVALID');
  const config = pinned(join(BASE, 'case01-live-scope.json'), pins.scopeSha256);
  const recovery = pinned(join(BASE, 'recovery-execute-execution.json'), pins.recoveryExecutionSha256);
  const budget = pinned(join(BASE, 'budget-install-execution.json'), pins.budgetExecutionSha256);
  return { ...inspectCase01Inputs({config,recovery,budget,release}), inputPinsSha256: sha256(pinBytes) };
}
