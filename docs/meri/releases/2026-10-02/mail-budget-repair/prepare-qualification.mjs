import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const ROOT = 'C:/dev/cap-meri-foundation-evidence/oct02-mail-budget-repair';
export const REPO = 'C:/dev/cap-meri-outcomes-validation';
export const RELATIVE = 'docs/meri/releases/2026-10-02/mail-budget-repair/';
export const TESTED = '991b5b15fa134d64579c96853dc92e9a00fa8520';
export const BASE = '3d2ba9d844bc71830fc02fdda6e002f48fb96c2b';
export const RECIPE = 'da170b85cff8f9a86753f414e1348dd9a07b18d36edbb88382eb8c305d106c96';
export const MARKERS = ['OFFLINE_RUNTIME_IMPORT_PASS', 'OFFLINE_CASE01_FIXTURE_PACKAGE_IMPORT_PASS', 'OFFLINE_CASE01_CONTINUATION_IMPORT_PASS', 'EXACT_449_IMAGE_MIGRATION_HASHES_PASS'];
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = bytes => JSON.parse(bytes.toString('utf8'));
// Exact planned archive bytes from validated actual991b receipts; not caller-supplied.
export const ARCHIVE_HASHES = {
  "browser-api501-observation.json": "0982c5187cd0e1d774a9bd133d6688d9609545cb35441073075d2700edc7a880",
  "independent-kimi-exit.json": "8e91283d15204387973e9f4b7fcd34b4011b7702186227dff048b827992873bc",
  "independent-kimi-review.md": "01535094633cee13bc95dac8ba96a37be618636a575b4e68f291b40e97213df6",
  "independent-kimi-source-hashes.json": "cb04985d7d9719cc9f745be5b1a23997843c0a13da948c631440a880cb61a4b7",
  "independent-kimi-usage.json": "d4bad0c21e096ac43b2422360f57f13ea281c41bdfd2dc54d01363ebfb7cedbd",
  "independent-source-review.json": "a4ae70f42221d50e75b3392ee19c773b71d6b5b01885fec1837e17e317b83591",
  "integrated-bill-postgres.exit.json": "da7ee0aad2b64e768daebb25fbf86438297ec4736fc3229cfbb9efae79b85ea4",
  "integrated-bill-postgres.log": "b85d7c6ddf6c4be076e7d02a83408859009399c67d6722202653484983dea138",
  "integrated-offline26-verifier.exit.json": "7d9da698ee4459a8ff8ae540cdaff76393a00f2932cc8b10dab3091b8d7eb09f",
  "integrated-offline26-verifier.log": "8a6d5048912b38340ce08bb033e31a84974e49c4520475b3c649cb3a4f1808c1",
  "integrated-offline26.exit.json": "47e1963230719c04ac78e7ad7b4045ca16a2eae1d02a7f34e4a6c2fc9ff391f5",
  "integrated-offline26.json": "5cc6705ead5d15008d2cc35798f7035b63cc306997eba7ac97b0c2a1294e8d73",
  "integrated-offline26.log": "20bf400544128f459f5d99e912644d5887b844b98e3e781430b82295ddf2497d",
  "integrated-offline26.summary.json": "4ccaa3ef75adf511f31768d0b2a2cb5b156eb4740215a5c690615bd51850661a",
  "integrated-qualification.json": "3e64e398823120342cc18d4013b93fac98b5f38e6c774be07268078b46391d98",
  "integrated-tests.exit.json": "6394213ae3fcec4ca5e4ec654152ba111751d60e06030edfba3f906d1e2cb1fb",
  "integrated-tests.log": "62d3218f6389cc966ce18a29451889b958daac71c8b534c8461c634da5664ce8",
  "integrated-types.exit.json": "dd67f4364f9d54c3518139282bf9b611f38699f8f83bff9bfc5d134fd0936d60",
  "integrated-types.log": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "qualification.json": "d5b66420ef70c17eb7507a383d65b5eecfdbe357361e55bb581e9d721cf983a1",
  "source-git-blob-hashes.json": "2cd7325574a22faaf531b7f7c0b5e3b987ffd3a9dfbb2a7ee96c6a54217ab071",
  "qualification.md": "3d506e97d24390a536f3cee16ff7584e269f15846f3124434ba4365f1387c91f",
  ".gitattributes": "88e9eed76bdd5fc9090a63c4726f8884d76a9166a7055636a16ff237f826f560",
  "artifact-hashes.json": "19197d0b8b39ed5399a55ea976d5c851d67295714782fc5de236b2e0824fbc44"
};
export const SOURCE_HASHES = {
  "apps/api/scripts/test-bill-keyword-deadline.postgres.mjs": "d955734a6b382ae2ecb1d8fdc30109530758e070a5732fb39d61a0124119fca0",
  "apps/api/src/engagement/mail-query-deadline.postgres.spec.ts": "8b986eb4a803f99af837157a9a26794d579aeff95aff57325171f08dba84949f",
  "apps/api/src/engagement/mail-query-deadline.spec.ts": "fa223109aa0cd68c57eaa8d6f800dba8cba8baffa84ced08606d42a84c72bffe",
  "apps/api/src/engagement/mail-query-deadline.ts": "cb90d145a96d006785ad4c0a5a768ddeddf843b351638db199aad360850c138b",
  "apps/api/src/engagement/mail-query.spec.ts": "6fdf20cdba6a1c2cb5d7690439abdb71376331eb22927817aa42f99cb15024da",
  "apps/api/src/engagement/mail-query.ts": "b32e25f106e3a2d9e69ac50e37b6fde8b26cea51a08be24adcdf5cfc69ad34c8",
  "apps/api/src/intelligence/bill-keyword-deadline.spec.ts": "01572884f3f70637830a1b225b4b10efe57cddb4c16bc57c379f333c77d3a66d",
  "apps/api/src/intelligence/bill-keyword-deadline.ts": "2e66c4886c497e278158f58dfaad9534b0c04ee6d8e48f0d426727669f86f59e",
  "apps/api/src/intelligence/intelligence.service.ts": "f7cfe0f3257e2a75c43c7a70ce66de3939d79f0e0fbc336028970b68146b7096"
};
export const BUILD_HELPER_SHA256 = 'bd4f71f1f77007f606f440948d4dfa6330f39f677eade42caedbacbd372a10ea';

export function validateArchive(readArchive, readSource) {
  for (const [file, hash] of Object.entries(ARCHIVE_HASHES)) assert.equal(sha(readArchive(file)), hash, `Archived evidence changed: ${file}`);
  for (const [file, hash] of Object.entries(SOURCE_HASHES)) assert.equal(sha(readSource(file)), hash, `Source changed: ${file}`);
  const q = json(readArchive('qualification.json'));
  assert.equal(q.sourceSha, TESTED); assert.equal(q.baseSha, BASE);
  assert.equal(q.status, 'PASS'); assert.equal(q.schemaChange, false); assert.equal(q.liveAcceptance, 'NOT_RUN');
  assert.equal(q.jestPassed, 66); assert.equal(q.jestSkipped, 0);
  assert.equal(q.actualBillPostgresChecks, 5); assert.equal(q.actualMailPostgresTests, 3);
  assert.equal(q.offlineCases, 26); assert.equal(q.customVerifierExit, 0);
  assert.deepEqual(q.sourceGitBlobSha256, SOURCE_HASHES);
  const names = ['integrated-tests', 'integrated-bill-postgres', 'integrated-types', 'integrated-offline26', 'integrated-offline26-verifier'];
  assert.deepEqual(q.results.map(r => r.name).sort(), [...names].sort());
  for (const r of q.results) {
    assert.equal(r.sourceSha, TESTED); assert.equal(r.exitCode, 0);
    assert.equal(sha(readArchive(`${r.name}.log`)), r.logSha256);
    assert.deepEqual(json(readArchive(`${r.name}.exit.json`)), r);
  }
  const tests = readArchive('integrated-tests.log').toString('utf8');
  assert.match(tests, /Test Suites:\s+8 passed, 8 total/);
  assert.match(tests, /Tests:\s+66 passed, 66 total/);
  const pg = json(readArchive('integrated-bill-postgres.log'));
  assert.equal(pg.status, 'PASS'); assert.equal(pg.passed, 5); assert.equal(pg.skipped, 0);
  assert.equal(pg.sharedDatabaseAccess, false); assert.equal(pg.databaseWrites, 0);
  const offline = json(readArchive('integrated-offline26.summary.json'));
  assert.equal(offline.success, true); assert.equal(offline.exit_code, 0);
  assert.equal(offline.pass_count, 26); assert.equal(offline.fail_count, 0); assert.equal(offline.error_count, 0);
  assert.equal(offline.provenance.sourceGitSha, TESTED); assert.equal(offline.provenance.checkoutGitSha, TESTED);
  assert.equal(offline.report_sha256, sha(readArchive('integrated-offline26.json')));
  assert.ok(Object.values(offline.checks).every(value => value === true));
  const usage = json(readArchive('independent-kimi-usage.json'));
  const exit = json(readArchive('independent-kimi-exit.json'));
  const review = json(readArchive('independent-source-review.json'));
  const reviewed = json(readArchive('independent-kimi-source-hashes.json'));
  assert.equal(exit.exitCode, 0); assert.equal(usage.reportedResultExit, 0);
  assert.equal(usage.provider, 'bedrock'); assert.equal(usage.initializedModel, 'moonshotai.kimi-k2.5');
  assert.equal(usage.sessionId, '20261002_135450_694b53'); assert.equal(usage.toolCalls, 0);
  assert.equal(review.verdict, 'PASS'); assert.equal(review.sourceSha, TESTED);
  assert.equal(review.sourceUnchangedSinceModelReview, true); assert.equal(reviewed.sourceSha, TESTED);
  assert.deepEqual(review.reviewedFiles, reviewed.files);
  for (const [file, hash] of Object.entries(reviewed.files)) assert.equal(sha(readSource(file)), hash);
  const priorFailure = json(readArchive('browser-api501-observation.json'));
  assert.equal(priorFailure.apiTaskDefinition, 'capiro-dev-api:501');
  assert.equal(priorFailure.checks[0].result, 'FAIL');
  return q;
}

export function validateBuild(input, start, result, recipeBytes, helperBytes, now = Date.now()) {
  assert.equal(input.sourceSha, TESTED); assert.equal(input.testedCodeSha, TESTED);
  assert.equal(sha(recipeBytes), RECIPE); assert.equal(sha(helperBytes), BUILD_HELPER_SHA256);
  assert.equal(input.services.api.buildspecSha256, RECIPE);
  assert.deepEqual([...input.services.api.executedMarkers].sort(), [...MARKERS].sort());
  assert.equal(start.sourceSha, input.sourceSha); assert.equal(start.service, 'api'); assert.equal(start.buildspecSha256, RECIPE);
  assert.equal(start.callerArn, 'arn:aws:iam::967807252336:user/hermes-cli');
  assert.equal(start.actionRun.headSha, input.sourceSha); assert.equal(start.actionRun.conclusion, 'startup_failure');
  assert.equal(start.actionRun.workflowName, 'api-image'); assert.deepEqual(start.actionRun.jobs, []);
  assert.equal(start.actionRun.url, `https://github.com/neo-capiro/capirov2/actions/runs/${input.services.api.actionRunId}`);
  assert.match(start.buildId, /^capiro-build-web-dev:[0-9a-f-]{36}$/);
  assert.equal(result.buildId, start.buildId); assert.equal(result.service, 'api');
  assert.equal(result.sourceSha, input.sourceSha); assert.equal(result.resolvedSourceSha, input.sourceSha);
  assert.equal(result.verdict, 'PASS'); assert.equal(result.buildStatus, 'SUCCEEDED'); assert.equal(result.phase, 'COMPLETED');
  assert.equal(result.actualBuildspecSha256, RECIPE); assert.equal(result.externalWrites, 0); assert.equal(result.liveAcceptance, 'NOT_RUN');
  const observed = Date.parse(result.observedAt);
  assert.ok(Number.isFinite(observed) && observed <= now && now - observed <= 4 * 3600000, 'Build readback must be current');
  assert.ok(Number.isFinite(start.startedAtEpoch) && start.startedAtEpoch * 1000 <= observed);
  for (const phase of ['DOWNLOAD_SOURCE', 'PRE_BUILD', 'BUILD', 'POST_BUILD']) {
    assert.deepEqual(result.phases.filter(p => p.phase === phase), [{ phase, status: 'SUCCEEDED' }]);
  }
  assert.match(result.imageDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.image, `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@${result.imageDigest}`);
  const expected = [...MARKERS, 'LOCAL_REPODIGEST_ECR_MATCH_PASS', `CANDIDATE_API_SOURCE_SHA=${input.sourceSha}`, `CANDIDATE_API_IMAGE=${result.image}`];
  assert.deepEqual(result.executedMarkers.map(m => m.line).sort(), expected.sort());
  for (const marker of result.executedMarkers) assert.ok(Number.isFinite(marker.timestamp) && marker.timestamp >= start.startedAtEpoch * 1000 && marker.timestamp <= observed);
  // The exact pinned observer above checks actual ARM_CONTAINER, privileged mode,
  // source override, ECR digest, and native build/log identity before issuing PASS.
  return result;
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ['api']);
  const git = (...args) => execFileSync('git', args, { cwd: REPO, windowsHide: true });
  const textGit = (...args) => git(...args).toString('utf8').trim();
  const input = json(await readFile(`${ROOT}/reviewed-build-input.json`));
  const head = textGit('rev-parse', 'HEAD');
  assert.equal(textGit('branch', '--show-current'), 'main');
  assert.equal(head, textGit('rev-parse', 'origin/main')); assert.equal(textGit('status', '--porcelain'), '');
  git('merge-base', '--is-ancestor', input.sourceSha, head);
  git('merge-base', '--is-ancestor', TESTED, input.sourceSha);
  assert.ok(textGit('diff', '--name-only', TESTED, head).split('\n').every(p => !p || p.startsWith('docs/')));
  assert.deepEqual(textGit('diff', '--name-only', BASE, TESTED).split('\n').filter(p => !p.startsWith('docs/')).sort(), Object.keys(SOURCE_HASHES).sort());
  assert.deepEqual(textGit('diff', '--name-only', '6e829e479b0f1311f6d7e624fbc917ce136d9bb3', TESTED).split('\n').sort(), ['apps/api/src/engagement/mail-query-deadline.postgres.spec.ts', 'apps/api/src/engagement/mail-query-deadline.spec.ts', 'apps/api/src/engagement/mail-query-deadline.ts']);
  const readArchive = file => git('show', `${head}:${RELATIVE}${file}`);
  validateArchive(readArchive, file => git('show', `${head}:${file}`));
  const buildBytes = readArchive('api-build-readback.json');
  assert.equal(sha(buildBytes), sha(await readFile(`${ROOT}/api-build-readback.json`)), 'Archived/local build readback mismatch');
  const result = validateBuild(input, json(await readFile(`${ROOT}/api-build-start.json`)), json(buildBytes), await readFile(`${ROOT}/api.buildspec.yml`), await readFile(`${ROOT}/build-qualified-source.py`));
  const base = `https://github.com/neo-capiro/capirov2/blob/${head}/${RELATIVE}`;
  const buildUrl = base + 'api-build-readback.json';
  const now = Date.now();
  const q = { schemaVersion: 1, service: 'api', sourceSha: input.sourceSha, image: result.image, status: 'qualified',
    reviewer: 'Codex integration owner; new independent actual Hermes/Bedrock Kimi ten-second mail-budget review, 66 integrated Jest tests including 3 real mail PostgreSQL tests, 5 additional real bill PostgreSQL checks, typecheck, and 26 verified offline cases. Source-bound native ARM64 build passed. Image-only incident repair; full original live acceptance remains NOT_RUN.',
    reviewedAt: new Date(now).toISOString(), expiresAt: new Date(now + 4 * 3600000).toISOString(), schemaChange: false,
    evidence: [base + 'qualification.md', base + 'qualification.json', base + 'source-git-blob-hashes.json', buildUrl],
    checks: ['build', 'automated-tests', 'retirement-compatibility'].map(name => ({ name, status: 'passed', sourceSha: input.sourceSha, image: result.image, url: name === 'build' ? buildUrl : base + (name === 'automated-tests' ? 'qualification.json' : 'qualification.md') })) };
  const { validateQualification } = await import(pathToFileURL(`${REPO}/scripts/lib/meri-release-policy.mjs`).href);
  validateQualification(q, 'api', q.image, now);
  await writeFile(`${ROOT}/api-qualification.json`, JSON.stringify(q, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ service: 'api', sourceSha: q.sourceSha, image: q.image, evidenceSha: head, archivedBuildReadbackSha256: sha(buildBytes), qualificationSha256: sha(JSON.stringify(q, null, 2) + '\n') }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
