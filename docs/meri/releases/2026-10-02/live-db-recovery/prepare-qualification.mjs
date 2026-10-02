import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const ROOT = 'C:/dev/cap-meri-foundation-evidence/oct02-meri-incident-release';
export const REPO = 'C:/dev/cap-meri-outcomes-validation';
export const RELATIVE = 'docs/meri/releases/2026-10-02/live-db-recovery/';
export const TESTED = 'afada905649b2fb790106466bc481060d6b05793';
export const BASE = '3d2ba9d844bc71830fc02fdda6e002f48fb96c2b';
export const RECIPE = 'da170b85cff8f9a86753f414e1348dd9a07b18d36edbb88382eb8c305d106c96';
export const MARKERS = ['OFFLINE_RUNTIME_IMPORT_PASS', 'OFFLINE_CASE01_FIXTURE_PACKAGE_IMPORT_PASS', 'OFFLINE_CASE01_CONTINUATION_IMPORT_PASS', 'EXACT_449_IMAGE_MIGRATION_HASHES_PASS'];
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = bytes => JSON.parse(bytes.toString('utf8'));
// Exact already-reviewed archive bytes at d77cbe69; this is not a caller-supplied manifest.
export const ARCHIVE_HASHES = {
  "bill-review/bill-keyword-deadline-kimi-exit.json": "4ea6546af802a57bed627c9de18acbdf5c9c1129b8319549a597edc27d730464",
  "bill-review/bill-keyword-deadline-kimi-review.md": "188130550baa8f8bee8b0a7550a6e6afd2a050bf0994b1e292b6f361848a68e9",
  "bill-review/bill-keyword-deadline-kimi-usage.json": "be795bf4ff2e66be0b8b4a8197655c223ffbdadb9037605e3795e75473e43f25",
  "bill-review/post-review-delta.json": "8d9e31a03cc409f447d9ef8f92427c16e07a71397b387017cb73012078de905b",
  "bill-review/qualification.json": "4b8580d693707c1c68f26c72695d584b4ce04bda44b52690dd8e6d80f06aa0cc",
  "bill-review/review-source-hashes.json": "92b5b8b13dd8ea803d73e579f18370cf2d4fe7b08503e33fb9029d47b6471c07",
  "integrated-bill-postgres.exit.json": "2087391e184e0bdebdbae9851f0e36ef8ed01d4f903840abcf8f6351bca85dcb",
  "integrated-bill-postgres.log": "b85d7c6ddf6c4be076e7d02a83408859009399c67d6722202653484983dea138",
  "integrated-offline26-verifier.exit.json": "1faf8c67fbc9ce2b0bee7c8f0c6999e861b1020d0084e25a302f5ef9138773f8",
  "integrated-offline26-verifier.log": "4db05026a837b9ca4aa44f51cc122d4fb093f77734c45751cfa172a04f999403",
  "integrated-offline26.exit.json": "e5c037729f195884f17f262e0c346dabf3d76a4b454ba38480a7de247d46ebb6",
  "integrated-offline26.json": "8c0ab5f5e432a7bbddde94efae1ed2a5fa07769a01fc0790ddbcbc38527e8f07",
  "integrated-offline26.log": "22aee0482813c76c3866cfcaabb7e1efd8b84d6e643c2aa27865ef8ba550f6ea",
  "integrated-offline26.summary.json": "60653f27416dc39e530941aab6fef1b3b56c87d81096673071177991b309cfbb",
  "integrated-qualification.json": "252098d8974a60f562e0925ac5d6df4a87a628a8999fe9ce3600e3eaf67bd7aa",
  "integrated-tests.exit.json": "d20c44a12194cc7a6ceced2f599b7484c18115b532e1b65c9c8d9332c656d706",
  "integrated-tests.log": "53329d63a8650a25beb20c179800fd9e633e1ed908a2fe8079b9150cc9e81a29",
  "integrated-types.exit.json": "ba74b321d8413a5a4f0d7d06878946e280ee31fcaa95396af14a47eea7ecab68",
  "integrated-types.log": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "mail-review/mail-deadline-kimi-exit.json": "f04aeda69b1b58215878612fd404ad5331bebacf362593ed24ddc394e01b4547",
  "mail-review/mail-deadline-kimi-review.md": "b7d5851c16c5b6149b6d78b04fed8195c995f743a42190b5cd7046552e622ed0",
  "mail-review/mail-deadline-kimi-usage.json": "3e657a7ad6e90b21c5284299684c735fda68287f589205ed1eb9a7f4a15ae194",
  "mail-review/mail-deadline-post-review-delta.json": "efaea98414b209966f276b17e78ed62270efb606c8016cc0d2a5bb78ce8d87f9",
  "mail-review/mail-deadline-qualification.json": "5320bcddd4361d00264352b2dbc081054bb5ef706aa74d5cca19df363cefbeab",
  "mail-review/mail-deadline-review-source-hashes.json": "08e959cf8eb61be3f56aa307647c3d9de02a23b53110e59fe35573abe0fc16bc",
  "mail-review/prisma-statement-cancellation.result.json": "3c0b826cc95f72b2e4c96cea49122c8e83f30e7049aedb7d6368e93124061909",
  "qualification.json": "3be3c95ea4cd6a649fe6389c6b098cc559a8eb92c808d9ee71ae600c90f085ac",
  "qualification.md": "06113b467a2469adea40c51f5630969067c5cc61cf87aed71033a3ce7e3be488",
  "source-git-blob-hashes.json": "8b24286232ff24c653d30008e9eeacf17d191ec3d20333cb89872282c4242c20"
};
export const SOURCE_HASHES = {
  "apps/api/scripts/test-bill-keyword-deadline.postgres.mjs": "d955734a6b382ae2ecb1d8fdc30109530758e070a5732fb39d61a0124119fca0",
  "apps/api/src/engagement/mail-query-deadline.postgres.spec.ts": "e0def6976f9a15f921a161f1c21945e7db32d9e35588f11b9ebf21a74352f20c",
  "apps/api/src/engagement/mail-query-deadline.spec.ts": "19b873c44363fbdf170850cd94ab3c4ab072ba0beba2a5ee078d4570e58cf1e7",
  "apps/api/src/engagement/mail-query-deadline.ts": "cc8685381c5e6ef4a4c97fec2c158d0afc66bffc49996d7e2c8eefaada9d0ed7",
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
  assert.equal(q.jestPassed, 65); assert.equal(q.jestSkipped, 0);
  assert.equal(q.actualBillPostgresChecks, 5); assert.equal(q.actualMailPostgresTests, 2);
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
  assert.match(tests, /Tests:\s+65 passed, 65 total/);
  const pg = json(readArchive('integrated-bill-postgres.log'));
  assert.equal(pg.status, 'PASS'); assert.equal(pg.passed, 5); assert.equal(pg.skipped, 0);
  assert.equal(pg.sharedDatabaseAccess, false); assert.equal(pg.databaseWrites, 0);
  const offline = json(readArchive('integrated-offline26.summary.json'));
  assert.equal(offline.success, true); assert.equal(offline.exit_code, 0);
  assert.equal(offline.pass_count, 26); assert.equal(offline.fail_count, 0); assert.equal(offline.error_count, 0);
  assert.equal(offline.provenance.sourceGitSha, TESTED); assert.equal(offline.provenance.checkoutGitSha, TESTED);
  assert.equal(offline.report_sha256, sha(readArchive('integrated-offline26.json')));
  assert.ok(Object.values(offline.checks).every(value => value === true));
  for (const [folder, prefix, session] of [
    ['mail-review', 'mail-deadline', '20261002_131642_dcfe29'],
    ['bill-review', 'bill-keyword-deadline', '20261002_132142_4b8571'],
  ]) {
    const exit = json(readArchive(`${folder}/${prefix}-kimi-exit.json`));
    const usage = json(readArchive(`${folder}/${prefix}-kimi-usage.json`));
    assert.equal(exit.exitCode, 0); assert.equal(usage.reportedResultExit, 0);
    assert.equal(usage.provider, 'bedrock'); assert.equal(usage.initializedModel, 'moonshotai.kimi-k2.5');
    assert.equal(usage.sessionId, session); assert.equal(usage.toolCalls, 0);
  }
  const mailDelta = json(readArchive('mail-review/mail-deadline-post-review-delta.json'));
  assert.equal(mailDelta.productionUnchanged, true); assert.equal(mailDelta.testTypeOnlyErasureEqual, true);
  for (const f of mailDelta.files) assert.equal(f.sha256, SOURCE_HASHES[f.file]);
  const billDelta = json(readArchive('bill-review/post-review-delta.json'));
  assert.equal(billDelta.exactReverseDeltaMatchesEveryReviewedHash, true);
  assert.equal(billDelta.productionRuntimeBehaviorChangedAfterModelReview, false);
  for (const [file, hash] of Object.entries(billDelta.currentSourceHashes)) assert.equal(hash, SOURCE_HASHES[file]);
  return q;
}

export function validateBuild(input, start, result, recipeBytes, helperBytes, now = Date.now()) {
  assert.match(input.sourceSha, /^[0-9a-f]{40}$/); assert.equal(input.testedCodeSha, TESTED);
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
  assert.deepEqual(textGit('diff', '--name-only', BASE, TESTED).split('\n').sort(), Object.keys(SOURCE_HASHES).sort());
  const readArchive = file => git('show', `${head}:${RELATIVE}${file}`);
  validateArchive(readArchive, file => git('show', `${head}:${file}`));
  const buildBytes = readArchive('api-build-readback.json');
  assert.equal(sha(buildBytes), sha(await readFile(`${ROOT}/api-build-readback.json`)), 'Archived/local build readback mismatch');
  const result = validateBuild(input, json(await readFile(`${ROOT}/api-build-start.json`)), json(buildBytes), await readFile(`${ROOT}/api.buildspec.yml`), await readFile(`${ROOT}/build-qualified-source.py`));
  const base = `https://github.com/neo-capiro/capirov2/blob/${head}/${RELATIVE}`;
  const buildUrl = base + 'api-build-readback.json';
  const now = Date.now();
  const q = { schemaVersion: 1, service: 'api', sourceSha: input.sourceSha, image: result.image, status: 'qualified',
    reviewer: 'Codex integration owner; independent actual Hermes/Bedrock Kimi mail and bill reviews, 65 integrated Jest tests including 2 real mail PostgreSQL tests, 5 additional real bill PostgreSQL checks, typecheck, and 26 verified offline cases. Source-bound native ARM64 build passed. Image-only incident repair; full original live acceptance remains NOT_RUN.',
    reviewedAt: new Date(now).toISOString(), expiresAt: new Date(now + 4 * 3600000).toISOString(), schemaChange: false,
    evidence: [base + 'qualification.md', base + 'qualification.json', base + 'source-git-blob-hashes.json', buildUrl],
    checks: ['build', 'automated-tests', 'retirement-compatibility'].map(name => ({ name, status: 'passed', sourceSha: input.sourceSha, image: result.image, url: name === 'build' ? buildUrl : base + (name === 'automated-tests' ? 'qualification.json' : 'qualification.md') })) };
  const { validateQualification } = await import(pathToFileURL(`${REPO}/scripts/lib/meri-release-policy.mjs`).href);
  validateQualification(q, 'api', q.image, now);
  await writeFile(`${ROOT}/api-qualification.json`, JSON.stringify(q, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ service: 'api', sourceSha: q.sourceSha, image: q.image, evidenceSha: head, archivedBuildReadbackSha256: sha(buildBytes), qualificationSha256: sha(JSON.stringify(q, null, 2) + '\n') }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
