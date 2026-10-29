import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';
import { FRONTEND_IMAGE_DIGEST, FRONTEND_SOURCE_COMMIT, NODE_IMAGE, PROJECT, SOURCE_BUCKET,
  USAGE, buildspecFor, createPlan, parseInvocation, startBuildRequest, treeDigest } from '../legacy-consumer-build-request.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER = path.join('scripts', 'legacy-consumer-build-request.mjs');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Hermes', GIT_AUTHOR_EMAIL: 'hermes@example.test',
  GIT_COMMITTER_NAME: 'Hermes', GIT_COMMITTER_EMAIL: 'hermes@example.test' };

/** Decode the gzip+base64 command the job runs, so guards read the real script. */
function decodedScript(service) {
  const command = buildspecFor(service).phases.build.commands[0];
  const encoded = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(command)[1];
  return execFileSync(process.execPath, ['-e',
    `process.stdout.write(require('node:zlib').gunzipSync(Buffer.from('${encoded}','base64')).toString())`],
  { encoding: 'utf8' });
}

function repository() {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-request-'));
  execFileSync('git', ['init', '-q', dir], { env: GIT_ENV });
  writeFileSync(path.join(dir, 'README.md'), 'one\n');
  mkdirSync(path.join(dir, 'marketing'));
  writeFileSync(path.join(dir, 'marketing', 'Dockerfile'), 'FROM scratch\n');
  execFileSync('git', ['-C', dir, 'add', '-A'], { env: GIT_ENV });
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'one'], { env: GIT_ENV });
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { dir, head };
}

describe('legacy consumer build request: invocation', () => {
  test('help exits 0 and no arguments exits 2 without starting anything', () => {
    const help = spawnSync(process.execPath, [OWNER, '--help'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stdout.trim(), USAGE);
    const empty = spawnSync(process.execPath, [OWNER], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(empty.status, 2);
    const payload = JSON.parse(empty.stderr);
    assert.equal(payload.startBuildPerformed, false);
    assert.equal(payload.deployed, false);
  });

  test('explicit flags only: service, absolute paths, exact commit', () => {
    const parsed = parseInvocation(['--service', 'web', '--source-checkout', '/src', '--source-commit', 'a'.repeat(40),
      '--out-dir', '/out']);
    assert.equal(parsed.mode, 'plan');
    assert.equal(parseInvocation(['--service', 'marketing', '--source-checkout', '/src',
      '--source-commit', 'a'.repeat(40), '--out-dir', '/out', '--stage']).mode, 'stage');
    for (const argv of [
      ['--service', 'api', '--source-checkout', '/src', '--source-commit', 'a'.repeat(40), '--out-dir', '/out'],
      ['--service', 'web', '--source-checkout', 'src', '--source-commit', 'a'.repeat(40), '--out-dir', '/out'],
      ['--service', 'web', '--source-checkout', '/src', '--source-commit', 'HEAD', '--out-dir', '/out'],
      ['--service', 'web', '--source-checkout', '/src', '--source-commit', 'a'.repeat(40), '--out-dir', '/out', '--start'],
      ['--service', 'web', '--service', 'web', '--source-checkout', '/src', '--source-commit', 'a'.repeat(40), '--out-dir', '/out'],
    ]) assert.throws(() => parseInvocation(argv), undefined, argv.join(' '));
  });
});

describe('legacy consumer build request: job scripts', () => {
  test('the web job is bounded: qualified digest, no rebuild of the frontend, exact-SHA tag, clean-scan assert', () => {
    const script = decodedScript('web');
    assert.ok(script.includes(`capiro/portfolio-preview@${FRONTEND_IMAGE_DIGEST}`), 'qualified frontend digest pin');
    assert.ok(script.includes(`@${FRONTEND_SOURCE_COMMIT}`) || script.includes(FRONTEND_SOURCE_COMMIT));
    assert.ok(script.includes(`:${'$'}EXPECTED_SHA`), 'exact commit tag only');
    assert.ok(script.includes('docker cp "$container:/app/." work/app'), 'extraction of the /app tree');
    assert.ok(script.includes(NODE_IMAGE), 'gates run in the pinned Linux/Node24.21 musl image');
    assert.ok(script.includes('scripts/ci/legacy-web-release.spec.mjs'));
    assert.ok(script.includes('scripts/ci/newsletter-accepted-source-profile.spec.mjs'));
    assert.ok(script.includes('node scripts/legacy-web-release.mjs artifact'));
    assert.ok(script.includes('apps/web/smoke-8080.sh'));
    assert.ok(script.includes('SCAN_CLEAN_PASS'));
    assert.ok(script.includes('HIGH') && script.includes('CRITICAL'));
    assert.ok(script.includes('test "$(uname -m)" = aarch64'));
    assert.ok(script.includes('EXPECTED_TREE_SHA256'));
    for (const forbidden of [':latest', 'start-build', 'update-service', 'create-project',
      'put-bucket-policy', 'force-new-deployment', '--target', 'npm ci', 'next build'])
      assert.ok(!script.includes(forbidden), forbidden);
  });

  test('the marketing job builds and smokes the static recipe and pushes only the exact commit tag', () => {
    const script = decodedScript('marketing');
    assert.ok(script.includes('docker build --platform linux/arm64 -f marketing/Dockerfile'));
    assert.ok(script.includes('marketing/smoke-8080.sh'));
    assert.ok(script.includes(`:${'$'}EXPECTED_SHA`));
    assert.ok(script.includes('SCAN_CLEAN_PASS'));
    assert.ok(!script.includes('portfolio-preview'));
    assert.ok(!script.includes('deploy.sh'));
    for (const forbidden of [':latest', 'start-build', 'update-service', 'create-project',
      '--push', 'force-new-deployment', '--target'])
      assert.ok(!script.includes(forbidden), forbidden);
  });

  test('the request pins the immutable S3 source override and mutates no stored project', () => {
    assert.equal(PROJECT, 'capiro-build-web-dev');
    const plan = { project: PROJECT, service: 'web',
      source: { bucket: SOURCE_BUCKET, key: 'inputs/web-abc.zip' },
      environmentVariables: [{ name: 'EXPECTED_SHA', value: 'a'.repeat(40), type: 'PLAINTEXT' },
        { name: 'EXPECTED_TREE_SHA256', value: 'b'.repeat(64), type: 'PLAINTEXT' },
        { name: 'EXPECTED_S3_VERSION', value: '<S3_VERSION_ID>', type: 'PLAINTEXT' }] };
    assert.throws(() => startBuildRequest(plan, '', 'token-12345'));
    assert.throws(() => startBuildRequest(plan, '..', 'token-12345'));
    const request = startBuildRequest(plan, '2yHi6FRdT1VBthvkKA9fpJG_SW3fHoHl', 'token-12345');
    assert.equal(request.projectName, PROJECT);
    assert.equal(request.sourceTypeOverride, 'S3');
    assert.equal(request.sourceLocationOverride, `${SOURCE_BUCKET}/inputs/web-abc.zip`);
    assert.equal(request.sourceVersion, '2yHi6FRdT1VBthvkKA9fpJG_SW3fHoHl');
    assert.deepEqual(request.environmentVariablesOverride.map((item) => item.name),
      ['EXPECTED_SHA', 'EXPECTED_TREE_SHA256', 'EXPECTED_S3_VERSION']);
    assert.equal(request.environmentVariablesOverride[2].value, '2yHi6FRdT1VBthvkKA9fpJG_SW3fHoHl');
    for (const forbidden of ['secondarySourcesOverride', 'serviceRole', 'environmentTypeOverride',
      'imageOverride', 'vpcConfigOverride']) assert.ok(!(forbidden in request), forbidden);
  });
});

describe('legacy consumer build request: exact source binding', () => {
  test('the tree digest is deterministic, differs on content change and matches the commit', () => {
    const { dir, head } = repository();
    const first = treeDigest(dir, head);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(treeDigest(dir, head), first);
    writeFileSync(path.join(dir, 'README.md'), 'two\n');
    execFileSync('git', ['-C', dir, 'commit', '-qam', 'two'], { env: GIT_ENV });
    const second = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.notEqual(treeDigest(dir, second), first);
    assert.equal(treeDigest(dir, first === first ? head : head), first);
  });

  test('a dirty checkout or a checkout at another commit is refused before any plan is emitted', () => {
    const { dir, head } = repository();
    const outDir = mkdtempSync(path.join(tmpdir(), 'legacy-request-out-'));
    const base = { service: 'marketing', sourceCheckout: dir, outDir };
    assert.throws(() => createPlan({ ...base, sourceCommit: 'c'.repeat(40) }),
      /source checkout is not at the declared commit/);
    writeFileSync(path.join(dir, 'README.md'), 'dirty\n');
    execFileSync('git', ['-C', dir, 'add', '-A'], { env: GIT_ENV });
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'clean'], { env: GIT_ENV });
    writeFileSync(path.join(dir, 'README.md'), 'uncommitted\n');
    const committed = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.throws(() => createPlan({ ...base, sourceCommit: committed }), /tracked modifications/);
    assert.notEqual(committed, head);
  });

  test('the web plan binds the qualified frontend digest to the reviewed active source', () => {
    const { dir, head } = repository();
    const outDir = mkdtempSync(path.join(tmpdir(), 'legacy-request-out-'));
    const plan = createPlan({ service: 'web', sourceCheckout: dir, sourceCommit: head, outDir });
    assert.equal(plan.frontend.imageDigest, FRONTEND_IMAGE_DIGEST);
    assert.equal(plan.frontend.sourceCommit, FRONTEND_SOURCE_COMMIT);
    assert.equal(plan.frontend.activeAcceptedSource, FRONTEND_SOURCE_COMMIT);
    assert.equal(plan.project, PROJECT);
    assert.equal(plan.consumerRepository, 'capiro/dev/web');
    assert.match(plan.imageTagPolicy, /no latest/);
    assert.equal(plan.startBuildPerformed, false);
    assert.equal(plan.deployed, false);
    const marketing = createPlan({ service: 'marketing', sourceCheckout: dir, sourceCommit: head, outDir });
    assert.equal(marketing.frontend, null);
    assert.equal(marketing.consumerRepository, 'capiro/dev/marketing');
  });
});
