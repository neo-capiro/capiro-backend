import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
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
const qualified = '83f54f5ac0107822833adbbfef2b453e0240bc56';
const historical = '7c87678730538958ace9762f824dc3e588bf445b';
// Preserve the earlier pending-policy controls as an explicit labelled model;
// this data is never injected through the CLI or treated as current approval.
const PENDING_PROFILE = Object.freeze({ ...PROFILE, activeCommit: null, acceptedSources: Object.freeze([]) });
const pendingFixture = () => ({ sourceAdmissionFixture: { kind: 'newsletter-source-admission-fixture',
  label: 'historical pending policy fixture', profile: PENDING_PROFILE } });
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

describe('Historical pending-policy fixture controls (original nineteen control IDs)', () => {
test('current checked-in policy remains pending and immutable with the exact pinned runtime', () => {
  assert.equal(PENDING_PROFILE.activeCommit, null); assert.deepEqual(PENDING_PROFILE.acceptedSources, []);
  assert.equal(PENDING_PROFILE.runtimeProfile.nodeVersion, '24.21.0'); assert.equal(PENDING_PROFILE.runtimeProfile.libc, 'musl');
  assert.match(PENDING_PROFILE.runtimeProfile.nodeImage, /^node:24\.21\.0-alpine3\.23@sha256:9ec4/);
  assert.throws(() => { PENDING_PROFILE.activeCommit = current; }, TypeError);
  assert.throws(() => PENDING_PROFILE.acceptedSources.push(entry(current)), TypeError);
});
for (const commit of [historical, current, 'c'.repeat(40)]) test(`production admission refuses ${commit} before artifact callbacks`, async () => {
  let calls = 0;
  const port = async () => { calls++; throw new Error('artifact access'); };
  assert.throws(() => assertAcceptedNewsletterArtifactSource(pins(commit), pendingFixture()), /final accepted frontend source/);
  await assert.rejects(readAcceptedFrontendStandaloneArtifact({ pins: pins(commit), artifactDir: '/synthetic/artifact',
    ...pendingFixture(), ports: { lstat: port, readdir: port, realpath: port, readFile: port, readlink: port } }), /final accepted frontend source/);
  await assert.rejects(assembleNewsletterReleaseArtifact(options(commit), { io: { lstat: port },
    fixtureLabel: 'synthetic must not access filesystem', ...pendingFixture() }), /final accepted frontend source/);
  assert.equal(calls, 0);
});
test('plan validates syntax and describes pending approval without promoting a declared source', () => {
  const invocation = parseNewsletterBuildInvocation(buildArgs('--plan'));
  const plan = createNewsletterArtifactPackagingPlan(invocation.options, pendingFixture());
  assert.equal(plan.sourceAdmission.status, 'pending'); assert.equal(plan.sourceAdmission.assemblyAdmissionAllowed, false);
  assert.equal(plan.sourceAdmission.sourceAcceptedByReviewedPolicy, false); assert.equal(plan.assemblyPerformed, false);
  assert.throws(() => assertAcceptedNewsletterArtifactSource(pins(current), pendingFixture()), /final accepted frontend source/);
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
test('architecture elements are exact primitive strings and refuse objects, proxies, symbols and numbers without coercion', () => {
  let coercions = 0;
  const object = { toString() { coercions++; return 'amd64'; } };
  const proxy = new Proxy(object, { get() { coercions++; throw new Error('architecture proxy access'); } });
  for (const value of [object, proxy, Symbol('amd64'), 64]) {
    const testPort = fixture(profile => { profile.runtimeProfile.architectures = [value, 'arm64']; return profile; });
    const supplied = pins(current); supplied.runtimeTarget.arch = 'arm64';
    assert.throws(() => assertAcceptedNewsletterArtifactSource(supplied, testPort), /source policy pinned runtime/);
    assert.equal(coercions, 0);
  }
  const legitimate = assertAcceptedNewsletterArtifactSource(pins(current), fixture());
  assert.deepEqual(legitimate.requiredRuntimeProfile.architectures, ['amd64', 'arm64']);
  assert.equal(Object.isFrozen(legitimate.requiredRuntimeProfile.architectures), true);
});
test('shipping CLI keeps all seven flags, refuses pending pins and exposes no profile injection', () => {
  const shipping = parseFrontendStandaloneInvocation(shippingArgs());
  assert.equal(shipping.pins.sourceCommit, current);
  assert.throws(() => assertAcceptedNewsletterArtifactSource(shipping.pins, pendingFixture()), /final accepted frontend source/);
  const build = parseNewsletterBuildInvocation(buildArgs('--run'));
  assert.throws(() => assertAcceptedNewsletterArtifactSource(pins(build.options.sourceCommit), pendingFixture()), /final accepted frontend source/);
  for (const flag of ['--source-profile', '--source-admission-fixture']) {
    assert.throws(() => parseFrontendStandaloneInvocation([...shippingArgs(), flag, '{}']));
    assert.throws(() => parseNewsletterBuildInvocation([...buildArgs('--run'), flag, '{}']));
  }
});
});

test('current production policy admits only the qualified runtime with its exact published receipt pin', () => {
  assert.equal(PROFILE.activeCommit, qualified); assert.equal(PROFILE.acceptedSources.length, 2);
  assert.deepEqual(PROFILE.acceptedSources[0], { commit: current, tree: '9d11bfbd7121887bc06f5cb793e8a4c4e6e682b4',
    qualificationReceipt: { repository: 'neo-capiro/capiro-frontend', commit: '46ebdd448ef55e88c7a4083fb4586322757a14f8',
      path: 'docs/newsletter-receiving-final-20261013/QUALIFICATION.md',
      sha256: 'cf99a4f3a9799f94f80b73ab283d5538c14fb41d9fa403a6af1bd72295c9cf33' } });
  assert.deepEqual(PROFILE.acceptedSources[1], { commit: qualified, tree: '760b05a7a7feacee16815da2767cb83dbb600d95',
    qualificationReceipt: { repository: 'neo-capiro/capiro-frontend', commit: '3ee5655bf50350e3814b17170ce6f0a93b060dc0',
      path: 'docs/unified-20261013/qualification-83f54f5a/README.md',
      sha256: 'd8f2f93ac3887e760aad27ed9cf18ecf17b0e51575e4c2e0dc8c4f6d5658ea00' } });
  const admitted = assertAcceptedNewsletterArtifactSource(pins(qualified));
  assert.equal(admitted.status, 'accepted'); assert.equal(admitted.sourceAcceptedByReviewedPolicy, true);
  assert.equal(admitted.syntheticSourceApprovalModel, false);
  for (const key of ['sourceApprovalProofVerified', 'independentFrontendQualificationVerified',
    'buildUsedSourceVerified', 'nativeRuntimeCompatibilityVerified']) assert.equal(admitted[key], false, key);
  const plan = createNewsletterArtifactPackagingPlan(options(qualified));
  assert.equal(plan.sourceAdmission.status, 'accepted'); assert.equal(plan.assemblyPerformed, false);
  assert.equal(parseNewsletterBuildInvocation(buildArgs('--run', qualified)).mode, 'run');
});

test('current production policy refuses stale, arbitrary and wrong runtime declarations before artifact callbacks', async () => {
  for (const supplied of [pins(historical), pins(current), pins('c'.repeat(40)), { ...pins(qualified), sourceRepository: 'other/repository' },
    { ...pins(qualified), runtimeTarget: { os: 'linux', arch: 'amd64', libc: 'glibc', nodeMajor: 24 } },
    { ...pins(qualified), runtimeTarget: { os: 'linux', arch: 'amd64', libc: 'musl', nodeMajor: 22 } }]) {
    let calls = 0; const before = structuredClone(supplied);
    await assert.rejects(readAcceptedFrontendStandaloneArtifact({ artifactDir: '/synthetic/artifact', pins: supplied,
      ports: { lstat: async () => { calls++; throw new Error('must not touch artifact'); } } }));
    assert.equal(calls, 0); assert.deepEqual(supplied, before);
  }
});

function interceptedCli(file, args, ambientSource = historical) {
  const fullPath = ROOT + '/scripts/lib/' + file;
  const host = `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    const label='labelled inert artifact-filesystem refusal';
    for(const method of ['lstat','readdir','realpath','readFile','readlink','open','mkdir','rename']) fs[method]=async(...args)=>{
      console.log(JSON.stringify({fixtureLabel:label,artifactPortReached:method,artifactFilesystemEffectsPerformed:false}));
      throw Error('INERT_ARTIFACT_REFUSAL'); };
    syncBuiltinESMExports(); process.argv=['node',${JSON.stringify(fullPath)},...${JSON.stringify(args)}];
    await import(${JSON.stringify('file://' + fullPath)});`;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', host], {
    env: { PATH: '/usr/bin:/bin', NEWSLETTER_ACCEPTED_SOURCE: ambientSource }, encoding: 'utf8' });
}

test('actual current CLI reaches only labelled inert artifact ports for qualified 83 and cannot override approval through flags or environment', () => {
  for (const [file, args, code] of [['frontend-standalone-artifact-contract.mjs', shippingArgs(qualified), 1],
    ['newsletter-artifact-packaging-plan.mjs', buildArgs('--run', qualified), 2]]) {
    const result = interceptedCli(file, args);
    assert.equal(result.status, code, result.stderr); assert.match(result.stderr, /INERT_ARTIFACT_REFUSAL/);
    const marker = JSON.parse(result.stdout);
    assert.equal(marker.fixtureLabel, 'labelled inert artifact-filesystem refusal');
    assert.equal(marker.artifactFilesystemEffectsPerformed, false); assert.equal(marker.artifactPortReached, 'lstat');
    assert.doesNotMatch(result.stdout, /newsletter-release-assembly|"status":"PASS"/);
    if (code === 2) assert.equal(JSON.parse(result.stderr).assemblyCompleted, false);
  }
  for (const commit of [historical, current, 'c'.repeat(40)]) {
    for (const [file, args, code] of [['frontend-standalone-artifact-contract.mjs', shippingArgs(commit), 1],
      ['newsletter-artifact-packaging-plan.mjs', buildArgs('--run', commit), 2]]) {
      const result = interceptedCli(file, args, qualified);
      assert.equal(result.status, code); assert.match(result.stderr, /active accepted frontend source/);
      assert.equal(result.stdout, '', 'source refusal before artifact ports despite ambient accepted source');
      for (const flag of ['--source-profile', '--source-admission-fixture']) {
        const injected = interceptedCli(file, [...args, flag, '{}'], qualified);
        assert.equal(injected.status, code); assert.equal(injected.stdout, '');
      }
    }
  }
});

test('retained c8 receipt is historical and cannot admit an artifact or become active through environment', () => {
  assert.equal(inspectNewsletterSourceAdmission(pins(current)).status, 'refused');
  assert.equal(inspectNewsletterSourceAdmission(pins(current)).activeSource.commit, qualified);
  assert.throws(() => assertAcceptedNewsletterArtifactSource(pins(current)), /active accepted/);
  const result = interceptedCli('newsletter-artifact-packaging-plan.mjs', buildArgs('--run', current), current);
  assert.equal(result.status, 2); assert.equal(result.stdout, '');
  assert.match(result.stderr, /active accepted frontend source/);
});

test('qualified source permits arm64 declarations while retaining every native and receipt-byte proof gate', () => {
  const supplied = pins(qualified); supplied.runtimeTarget.arch = 'arm64';
  const admitted = assertAcceptedNewsletterArtifactSource(supplied);
  assert.equal(admitted.sourceAcceptedByReviewedPolicy, true);
  for (const key of ['sourceApprovalProofVerified', 'independentFrontendQualificationVerified',
    'buildUsedSourceVerified', 'nativeRuntimeCompatibilityVerified']) assert.equal(admitted[key], false, key);
  assert.equal(admitted.activeSource.tree, '760b05a7a7feacee16815da2767cb83dbb600d95');
  assert.notEqual(admitted.activeSource.tree, '67f821a13c8470ceeb5222eb89d43cea58b1a8c8');
});
