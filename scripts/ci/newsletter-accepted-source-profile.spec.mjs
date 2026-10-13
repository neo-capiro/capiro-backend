import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NEWSLETTER_ACCEPTED_SOURCE_PROFILE as PROFILE, inspectNewsletterSourceAdmission,
  assertAcceptedNewsletterArtifactSource, readAcceptedFrontendStandaloneArtifact,
  parseFrontendStandaloneInvocation } from '../lib/frontend-standalone-artifact-contract.mjs';
import { assembleNewsletterReleaseArtifact, createNewsletterArtifactPackagingPlan,
  parseNewsletterBuildInvocation } from '../lib/newsletter-artifact-packaging-plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const current = 'c8aa693e884de86001d2fc04fbb60d48db09341c';
const historical = '7c87678730538958ace9762f824dc3e588bf445b';
const pins = commit => ({ sourceRepository: PROFILE.repository, sourceCommit: commit, manifestSha256: 'a'.repeat(64),
  runtimeTarget: { os: 'linux', arch: 'amd64', libc: 'musl', nodeMajor: 24 } });
const options = commit => ({ standaloneDir: '/synthetic/standalone', publicDir: '/synthetic/public',
  staticDir: '/synthetic/static', manifestPath: '/synthetic/manifest.json', manifestSha256: 'a'.repeat(64),
  sourceRepository: PROFILE.repository, sourceCommit: commit, targetPlatform: 'linux/amd64',
  targetLibc: 'musl', targetNodeMajor: '24', backendSourceCommit: 'b'.repeat(40), outputDir: '/synthetic/output' });
const entry = commit => ({ commit, tree: 'd'.repeat(40), qualificationReceipt: {
  repository: PROFILE.repository, commit: 'e'.repeat(40), path: 'docs/synthetic/RECEIPT.json', sha256: 'f'.repeat(64) } });
function fixture(change = value => value) {
  const profile = structuredClone(PROFILE);
  profile.activeCommit = current; profile.acceptedSources = [entry(current), entry(historical)];
  return { sourceAdmissionFixture: { kind: 'newsletter-source-admission-fixture',
    label: 'synthetic source approval data', profile: change(profile) } };
}
function buildArgs(mode, commit = current) {
  const values = options(commit);
  const names = ['standalone-dir', 'public-dir', 'static-dir', 'manifest', 'manifest-sha256', 'source-repository',
    'source-commit', 'target-platform', 'target-libc', 'target-node-major', 'backend-source-commit', 'output-dir'];
  return [mode, ...names.flatMap((name, index) => ['--' + name, Object.values(values)[index]])];
}
function shippingArgs(commit = current) {
  return ['--artifact-dir', '/synthetic/artifact', '--manifest-sha256', 'a'.repeat(64),
    '--source-repository', PROFILE.repository, '--source-commit', commit,
    '--target-platform', 'linux/amd64', '--target-libc', 'musl', '--target-node-major', '24'];
}

test('current checked-in policy remains pending and immutable with the exact pinned runtime', () => {
  assert.equal(PROFILE.activeCommit, null); assert.deepEqual(PROFILE.acceptedSources, []);
  assert.equal(PROFILE.runtimeProfile.nodeVersion, '24.21.0'); assert.equal(PROFILE.runtimeProfile.libc, 'musl');
  assert.match(PROFILE.runtimeProfile.nodeImage, /^node:24\.21\.0-alpine3\.23@sha256:9ec4/);
  assert.throws(() => { PROFILE.activeCommit = current; }, TypeError);
  assert.throws(() => PROFILE.acceptedSources.push(entry(current)), TypeError);
});
for (const commit of [historical, current, 'c'.repeat(40)]) test(`production admission refuses ${commit} before artifact callbacks`, async () => {
  let calls = 0;
  const port = async () => { calls++; throw new Error('artifact access'); };
  assert.throws(() => assertAcceptedNewsletterArtifactSource(pins(commit)), /final accepted frontend source/);
  await assert.rejects(readAcceptedFrontendStandaloneArtifact({ pins: pins(commit), artifactDir: '/synthetic/artifact',
    ports: { lstat: port, readdir: port, realpath: port, readFile: port, readlink: port } }), /final accepted frontend source/);
  await assert.rejects(assembleNewsletterReleaseArtifact(options(commit), { io: { lstat: port },
    fixtureLabel: 'synthetic must not access filesystem' }), /final accepted frontend source/);
  assert.equal(calls, 0);
});
test('plan validates syntax and describes pending approval without promoting a declared source', () => {
  const invocation = parseNewsletterBuildInvocation(buildArgs('--plan'));
  const plan = createNewsletterArtifactPackagingPlan(invocation.options);
  assert.equal(plan.sourceAdmission.status, 'pending'); assert.equal(plan.sourceAdmission.assemblyAdmissionAllowed, false);
  assert.equal(plan.sourceAdmission.sourceAcceptedByReviewedPolicy, false); assert.equal(plan.assemblyPerformed, false);
  assert.throws(() => parseNewsletterBuildInvocation(buildArgs('--run')), /final accepted frontend source/);
  for (const change of [{ sourceCommit: 'latest' }, { manifestSha256: 'bad' }, { outputDir: '/tmp/.aws/output' },
    { targetLibc: 'glibc' }, { sourceRepository: 'other/repository' }])
    assert.throws(() => createNewsletterArtifactPackagingPlan({ ...options(current), ...change }));
});
test('only an explicit labelled test profile models the active entry and cannot attest source approval', () => {
  const testPort = fixture();
  const admission = assertAcceptedNewsletterArtifactSource(pins(current), testPort);
  assert.equal(admission.status, 'fixture-accepted'); assert.equal(admission.syntheticSourceApprovalModel, true);
  for (const key of ['sourceAcceptedByReviewedPolicy', 'sourceApprovalProofVerified', 'independentFrontendQualificationVerified',
    'buildUsedSourceVerified', 'nativeRuntimeCompatibilityVerified']) assert.equal(admission[key], false, key);
  assert.throws(() => assertAcceptedNewsletterArtifactSource(pins(historical), testPort), /active accepted/);
  assert.throws(() => assertAcceptedNewsletterArtifactSource(pins('c'.repeat(40)), testPort), /active accepted/);
  const plan = createNewsletterArtifactPackagingPlan(options(current), testPort);
  assert.equal(plan.sourceAdmission.syntheticSourceApprovalModel, true); assert.equal(plan.sourceAdmission.sourceApprovalProofVerified, false);
});
for (const [name, mutate] of [
  ['missing accepted entry', value => { value.acceptedSources = []; }],
  ['duplicate accepted entry', value => { value.acceptedSources.push(entry(current)); }],
  ['missing receipt pin', value => { delete value.acceptedSources[0].qualificationReceipt.sha256; }],
  ['invalid source tree', value => { value.acceptedSources[0].tree = 'main'; }],
  ['invalid receipt identity', value => { value.acceptedSources[0].qualificationReceipt.sha256 = 'bad'; }],
  ['foreign receipt owner', value => { value.acceptedSources[0].qualificationReceipt.repository = 'other/repository'; }],
  ['credential receipt path', value => { value.acceptedSources[0].qualificationReceipt.path = 'docs/.envrc/proof'; }],
  ['unreviewed runtime', value => { value.runtimeProfile.libc = 'glibc'; }],
  ['relabelled Node image', value => { value.runtimeProfile.nodeImage = 'node:24-alpine'; }],
]) test(`invalid fixture policy refuses ${name} before filesystem`, async () => {
  let calls = 0;
  const testPort = fixture(value => { mutate(value); return value; });
  assert.throws(() => assertAcceptedNewsletterArtifactSource(pins(current), testPort));
  await assert.rejects(readAcceptedFrontendStandaloneArtifact({ pins: pins(current), artifactDir: '/synthetic/artifact',
    ...testPort, ports: { lstat: () => { calls++; } } }));
  assert.equal(calls, 0);
});
test('unlabelled, accessor and proxy fixture policy inputs refuse without invoking callbacks', () => {
  const valid = fixture().sourceAdmissionFixture;
  for (const value of [valid.profile, { ...valid, label: '' }, { ...valid, kind: 'production' },
    { ...valid, extra: true }, new Proxy(valid, {})])
    assert.throws(() => assertAcceptedNewsletterArtifactSource(pins(current), { sourceAdmissionFixture: value }));
  let getters = 0;
  const accessor = { ...valid };
  Object.defineProperty(accessor, 'profile', { get() { getters++; return valid.profile; }, enumerable: true });
  assert.throws(() => assertAcceptedNewsletterArtifactSource(pins(current), { sourceAdmissionFixture: accessor }));
  assert.equal(getters, 0);
});
test('runtime mismatch cannot be rewritten by accepted model source equality', () => {
  const testPort = fixture();
  for (const [name, value] of [['libc', 'glibc'], ['nodeMajor', 22], ['arch', 'unknown']]) {
    const supplied = pins(current); supplied.runtimeTarget[name] = value;
    assert.throws(() => assertAcceptedNewsletterArtifactSource(supplied, testPort));
    assert.equal(supplied.runtimeTarget[name], value);
  }
});
test('shipping CLI keeps all seven flags, refuses pending pins and exposes no profile injection', () => {
  assert.equal(parseFrontendStandaloneInvocation(shippingArgs()).pins.sourceCommit, current);
  const run = (file, args) => spawnSync(process.execPath, [ROOT + '/scripts/lib/' + file, ...args], {
    env: { PATH: '/usr/bin:/bin', NEWSLETTER_ACCEPTED_SOURCE: current }, encoding: 'utf8' });
  const shipping = run('frontend-standalone-artifact-contract.mjs', shippingArgs());
  assert.equal(shipping.status, 1); assert.match(shipping.stderr, /final accepted frontend source/);
  assert.equal(shipping.stdout, '');
  const build = run('newsletter-artifact-packaging-plan.mjs', buildArgs('--run'));
  assert.equal(build.status, 2); assert.match(build.stderr, /final accepted frontend source/);
  assert.equal(JSON.parse(build.stderr).assemblyCompleted, false);
  for (const flag of ['--source-profile', '--source-admission-fixture']) {
    assert.equal(run('frontend-standalone-artifact-contract.mjs', [...shippingArgs(), flag, '{}']).status, 1);
    assert.equal(run('newsletter-artifact-packaging-plan.mjs', [...buildArgs('--run'), flag, '{}']).status, 2);
  }
});
