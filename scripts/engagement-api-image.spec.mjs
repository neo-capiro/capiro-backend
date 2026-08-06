#!/usr/bin/env node
/**
 * Tests for engagement-api image publication.
 *
 * Fake `docker` and `aws` binaries record every invocation, so "no push
 * happened" is proven by observing the calls rather than by reading the source.
 *
 * Run: node scripts/engagement-api-image.spec.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'engagement-api-image.sh');

const ACCOUNT = '967807252336';
const REGION = 'us-east-1';
const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'bc'.repeat(32)}`;

const healthyImageInspect = () => [
  {
    Architecture: 'arm64',
    Os: 'linux',
    Config: {
      User: 'capiro',
      Cmd: ['serve'],
      Entrypoint: ['/usr/bin/dumb-init', '--', '/usr/local/bin/entrypoint.sh'],
      Env: ['NODE_ENV=production'],
    },
  },
];

const describeImages = () => ({
  imageDetails: [
    {
      imageDigest: DIGEST,
      imageTags: [SHA],
      imagePushedAt: '2026-08-06T00:00:00Z',
      imageManifestMediaType: 'application/vnd.oci.image.manifest.v1+json',
      imageScanStatus: { status: 'COMPLETE' },
    },
  ],
});

const scanFindings = (counts = {}, status = 'COMPLETE') => ({
  imageScanStatus: { status },
  imageScanFindings: { findingSeverityCounts: counts },
});

/**
 * @param opts.inspect          docker image inspect payload
 * @param opts.runExit          exit code the fake docker returns for `run`
 * @param opts.awsResponses     keyed by "<service> <operation>"
 * @param opts.buildExit        exit code for buildx build
 */
function sandbox(opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'eng-image-'));
  mkdirSync(path.join(dir, 'out'), { recursive: true });
  writeFileSync(path.join(dir, 'calls.log'), '');
  writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      inspect: opts.inspect ?? healthyImageInspect(),
      runExit: opts.runExit ?? 64,
      buildExit: opts.buildExit ?? 0,
      aws: opts.awsResponses ?? {
        'sts get-caller-identity': ACCOUNT,
        'ecr describe-images': describeImages(),
        'ecr describe-image-scan-findings': scanFindings({ CRITICAL: 0, HIGH: 0 }),
      },
    }),
  );

  const posix = (p) => p.replace(/\\/g, '/');

  const fakeDocker = path.join(dir, 'fake-docker.mjs');
  writeFileSync(
    fakeDocker,
    `import { appendFileSync, readFileSync } from 'node:fs';
const dir = ${JSON.stringify(posix(dir))};
const args = process.argv.slice(2);
appendFileSync(dir + '/calls.log', 'docker ' + args.join(' ') + '\\n');
const state = JSON.parse(readFileSync(dir + '/state.json', 'utf8'));
if (args[0] === 'image' && args[1] === 'inspect') {
  process.stdout.write(JSON.stringify(state.inspect));
  process.exit(0);
}
if (args[0] === 'buildx') process.exit(state.buildExit);
if (args[0] === 'run') process.exit(state.runExit);
if (args[0] === 'login') process.exit(0);
process.exit(0);
`,
  );

  const fakeAws = path.join(dir, 'fake-aws.mjs');
  writeFileSync(
    fakeAws,
    `import { appendFileSync, readFileSync } from 'node:fs';
const dir = ${JSON.stringify(posix(dir))};
const args = process.argv.slice(2);
appendFileSync(dir + '/calls.log', 'aws ' + args.join(' ') + '\\n');
const state = JSON.parse(readFileSync(dir + '/state.json', 'utf8'));
const key = args[0] + ' ' + args[1];
if (key === 'ecr get-login-password') { process.stdout.write('token'); process.exit(0); }
const value = state.aws[key];
if (value === undefined) { process.stderr.write('no fixture for ' + key); process.exit(254); }
if (value === null) { process.stderr.write('simulated failure'); process.exit(255); }
process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
`,
  );

  const shim = (name, target) => {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/usr/bin/env bash\nexec node ${JSON.stringify(target)} "$@"\n`, {
      mode: 0o755,
    });
    return file;
  };

  return {
    dir,
    docker: shim('docker', fakeDocker),
    aws: shim('aws', fakeAws),
    outDir: path.join(dir, 'out'),
  };
}

function run(command, opts = {}, env = {}) {
  const box = sandbox(opts);
  let status = 0;
  let out = '';
  try {
    out = execFileSync('bash', [SCRIPT, command], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DOCKER_BIN: box.docker,
        AWS_BIN: box.aws,
        RELEASE_SHA: SHA,
        CAPIRO_ENV: 'dev',
        AWS_REGION: REGION,
        EXPECTED_AWS_ACCOUNT_ID: ACCOUNT,
        ENGAGEMENT_IMAGE_OUT_DIR: box.outDir,
        ...env,
      },
    });
  } catch (error) {
    status = error.status ?? 1;
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  const calls = readFileSync(path.join(box.dir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
  return { status, out, calls, outDir: box.outDir };
}

// ────────────────────────────────────────────────────────────────── build

test('build produces an ARM64 image tagged with the release SHA', () => {
  const result = run('build');
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /ENGAGEMENT_IMAGE_BUILD_COMPLETE/);

  const build = result.calls.find((c) => c.includes('buildx'));
  assert.ok(build, 'no build was attempted');
  assert.match(build, /--platform linux\/arm64/);
  assert.match(build, new RegExp(`--tag capiro-engagement-api:${SHA}`));
  assert.match(build, /-f apps\/engagement-api\/Dockerfile/);
});

test('build asserts the image is nonroot, serve-only and refuses every other verb', () => {
  const result = run('build');
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /serve-only entrypoint refused migrate, seed/);
  for (const verb of ['migrate', 'migration-status', 'seed', 'sync-directory', 'diag-anything']) {
    assert.ok(
      result.calls.some((c) => c === `docker run --rm capiro-engagement-api:${SHA} ${verb}`),
      `the image was never probed with ${verb}`,
    );
  }
});

test('NC-2.10-C an image that ACCEPTS migrate is rejected', () => {
  const result = run('build', { runExit: 0 });
  assert.equal(result.status, 2);
  assert.match(result.out, /image accepted 'migrate' \(exit 0\); it must refuse with 64/);
});

test('a root image is rejected', () => {
  const inspect = healthyImageInspect();
  inspect[0].Config.User = 'root';
  const result = run('build', { inspect });
  assert.equal(result.status, 2);
  assert.match(result.out, /image runs as "root"/);
});

test('a non-ARM64 image is rejected', () => {
  const inspect = healthyImageInspect();
  inspect[0].Architecture = 'amd64';
  const result = run('build', { inspect });
  assert.equal(result.status, 2);
  assert.match(result.out, /architecture is amd64, expected arm64/);
});

test('an image whose CMD is not serve is rejected', () => {
  const inspect = healthyImageInspect();
  inspect[0].Config.Cmd = ['migrate'];
  const result = run('build', { inspect });
  assert.equal(result.status, 2);
  assert.match(result.out, /CMD is \["migrate"\]/);
});

test('NC-2.10-B a bundled prototype or V3 flag baked into the image is rejected', () => {
  const withUi = healthyImageInspect();
  withUi[0].Config.Env = ['PROTOTYPE=<!DOCTYPE html><html></html>'];
  assert.match(run('build', { inspect: withUi }).out, /bakes UI asset content/);

  const withFlag = healthyImageInspect();
  withFlag[0].Config.Env = ['OUTREACH_V3_ENABLED=true'];
  const result = run('build', { inspect: withFlag });
  assert.equal(result.status, 2);
  assert.match(result.out, /bakes a forbidden variable: OUTREACH_V3_ENABLED/);
});

// ─────────────────────────────────────────────────────────── tag discipline

test('NC-2.10-A a latest tag can never be produced', () => {
  // RELEASE_SHA is the only tag input and must be 40 hex characters, so
  // "latest" is rejected before any docker call happens.
  const result = run('build', {}, { RELEASE_SHA: 'latest' });
  assert.equal(result.status, 1);
  assert.match(result.out, /RELEASE_SHA must be 40 lowercase hex characters/);
  assert.deepEqual(result.calls, [], 'docker was invoked with an invalid tag');
});

test('a short or non-hex release SHA is rejected before any build', () => {
  for (const bad of ['abc', 'z'.repeat(40), `${'a'.repeat(39)}`]) {
    const result = run('build', {}, { RELEASE_SHA: bad });
    assert.equal(result.status, 1, `${bad} was accepted`);
    assert.deepEqual(result.calls, []);
  }
});

// ─────────────────────────────────────────────────────────────────── push

test('push refuses without the exact confirmation token', () => {
  const result = run('push');
  assert.equal(result.status, 1);
  assert.match(result.out, /CONFIRM_ENGAGEMENT_IMAGE_PUSH/);
  assert.ok(
    !result.calls.some((c) => c.includes('--push')),
    'a push was attempted without confirmation',
  );
});

test('push refuses a wrong confirmation token', () => {
  const result = run('push', {}, { CONFIRM_ENGAGEMENT_IMAGE_PUSH: 'yes' });
  assert.equal(result.status, 1);
  assert.ok(!result.calls.some((c) => c.includes('--push')));
});

test('push refuses when the caller account does not match', () => {
  const result = run(
    'push',
    { awsResponses: { 'sts get-caller-identity': '111111111111' } },
    { CONFIRM_ENGAGEMENT_IMAGE_PUSH: `${ACCOUNT}:${REGION}:${SHA}` },
  );
  assert.equal(result.status, 2);
  assert.match(result.out, /does not match expected/);
  assert.ok(!result.calls.some((c) => c.includes('--push')));
});

test('push refuses to overwrite an existing immutable tag', () => {
  const result = run(
    'push',
    {
      awsResponses: {
        'sts get-caller-identity': ACCOUNT,
        'ecr describe-images': describeImages(),
      },
    },
    { CONFIRM_ENGAGEMENT_IMAGE_PUSH: `${ACCOUNT}:${REGION}:${SHA}` },
  );
  assert.equal(result.status, 2);
  assert.match(result.out, /already exists; the repository is immutable/);
  assert.ok(!result.calls.some((c) => c.includes('--push')));
});

test('push succeeds with confirmation and an unused tag', () => {
  const result = run(
    'push',
    {
      awsResponses: {
        'sts get-caller-identity': ACCOUNT,
        'ecr describe-images': null, // not found
      },
    },
    { CONFIRM_ENGAGEMENT_IMAGE_PUSH: `${ACCOUNT}:${REGION}:${SHA}` },
  );
  assert.equal(result.status, 0, result.out);
  const push = result.calls.find((c) => c.includes('--push'));
  assert.ok(push, 'no push happened');
  assert.match(push, /--platform linux\/arm64/);
  assert.match(push, new RegExp(`${ACCOUNT}\\.dkr\\.ecr\\.${REGION}\\.amazonaws\\.com`));
  assert.doesNotMatch(push, /latest/);
});

// ─────────────────────────────────────────────────────────────── describe

test('describe resolves an immutable digest', () => {
  const result = run('describe');
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, new RegExp(DIGEST));
  assert.match(result.out, /ENGAGEMENT_IMAGE_DESCRIBE_COMPLETE/);
  const digestFile = readFileSync(path.join(result.outDir, 'image-digest.txt'), 'utf8').trim();
  assert.equal(digestFile, DIGEST);
});

test('describe rejects an image that also carries latest', () => {
  const details = describeImages();
  details.imageDetails[0].imageTags = [SHA, 'latest'];
  const result = run('describe', { awsResponses: { 'ecr describe-images': details } });
  assert.equal(result.status, 2);
  assert.match(result.out, /carries a mutable latest tag/);
});

test('describe rejects a malformed digest', () => {
  const details = describeImages();
  details.imageDetails[0].imageDigest = 'sha256:short';
  const result = run('describe', { awsResponses: { 'ecr describe-images': details } });
  assert.equal(result.status, 2);
  assert.match(result.out, /digest is not sha256 plus 64 hex/);
});

// ──────────────────────────────────────────────────────────── verify-scan

test('verify-scan passes on a complete clean scan', () => {
  const result = run('verify-scan');
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /ENGAGEMENT_IMAGE_SCAN_CLEAN/);
});

test('verify-scan blocks on any Critical finding', () => {
  const result = run('verify-scan', {
    awsResponses: {
      'ecr describe-image-scan-findings': scanFindings({ CRITICAL: 1, HIGH: 0 }),
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /1 unaccepted Critical finding\(s\); publication is blocked/);
});

test('verify-scan blocks when High exceeds the reviewed baseline', () => {
  const responses = {
    'ecr describe-image-scan-findings': scanFindings({ CRITICAL: 0, HIGH: 3 }),
  };
  assert.equal(run('verify-scan', { awsResponses: responses }).status, 2);
  assert.equal(
    run('verify-scan', { awsResponses: responses }, { HIGH_FINDING_BASELINE: '5' }).status,
    0,
  );
});

const perlFinding = (name, severity) => ({
  name,
  severity,
  attributes: [{ key: 'package_name', value: 'perl' }],
});

test('verify-scan passes when every Critical/High finding is on the reviewed perl-base allowlist', () => {
  const result = run('verify-scan', {
    awsResponses: {
      'ecr describe-image-scan-findings': {
        imageScanStatus: { status: 'COMPLETE' },
        imageScanFindings: {
          findingSeverityCounts: { CRITICAL: 1, HIGH: 1 },
          findings: [perlFinding('CVE-2026-57433', 'CRITICAL'), perlFinding('CVE-2026-48961', 'HIGH')],
        },
      },
    },
  });
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /accepted findings 2/);
  assert.match(result.out, /ENGAGEMENT_IMAGE_SCAN_CLEAN/);
});

test('the allowlist is not a blanket bypass: an unaccepted Critical still blocks', () => {
  const result = run('verify-scan', {
    awsResponses: {
      'ecr describe-image-scan-findings': {
        imageScanStatus: { status: 'COMPLETE' },
        imageScanFindings: {
          findingSeverityCounts: { CRITICAL: 2, HIGH: 0 },
          findings: [
            perlFinding('CVE-2026-57433', 'CRITICAL'),
            { name: 'CVE-2099-00001', severity: 'CRITICAL', attributes: [{ key: 'package_name', value: 'openssl' }] },
          ],
        },
      },
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /accepted findings 1/);
  assert.match(result.out, /1 unaccepted Critical finding\(s\); publication is blocked/);
});

test('an incomplete scan is not treated as a pass', () => {
  const result = run('verify-scan', {
    awsResponses: {
      'ecr describe-image-scan-findings': scanFindings({}, 'IN_PROGRESS'),
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /scan status is IN_PROGRESS, expected COMPLETE/);
});

// ────────────────────────────────────────────────────────────────── misc

test('an unknown command is rejected', () => {
  const result = run('deploy');
  assert.equal(result.status, 1);
  assert.match(result.out, /unknown command 'deploy'/);
});

test('the script never issues a mutating AWS call outside push', () => {
  for (const command of ['describe', 'verify-scan']) {
    const result = run(command);
    for (const call of result.calls.filter((c) => c.startsWith('aws '))) {
      const operation = call.split(' ')[2];
      assert.match(
        operation,
        /^(describe|list|get)-/,
        `${command} made a non read-only AWS call: ${call}`,
      );
    }
  }
});
