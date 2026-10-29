import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';
import { FRONTEND_IMAGE_DIGEST, FRONTEND_SOURCE_COMMIT, NODE_IMAGE, PROJECT, SOURCE_BUCKET,
  USAGE, buildspecFor, canonicalRecordBytes, collectSourceEntries, createPlan, materializeSource,
  parseInvocation, releaseMaterializedSource, sourceDigest, startBuildRequest, treeDigest } from '../legacy-consumer-build-request.mjs';
import { NEWSLETTER_ACCEPTED_SOURCE_PROFILE } from '../lib/frontend-standalone-artifact-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWNER = path.join('scripts', 'legacy-consumer-build-request.mjs');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Hermes', GIT_AUTHOR_EMAIL: 'hermes@example.test',
  GIT_COMMITTER_NAME: 'Hermes', GIT_COMMITTER_EMAIL: 'hermes@example.test' };
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

// The job runs `python3`; this host may only expose `python`. Shimming the name
// keeps the executed verifier identical to the emitted text.
function shimDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-shims-'));
  if (process.platform === 'win32') {
    writeFileSync(path.join(dir, 'python3'), `#!/usr/bin/env bash\nexec ${PYTHON} "$@"\n`);
    chmodSync(path.join(dir, 'python3'), 0o755);
  } else {
    symlinkSync(execFileSync('which', ['python3'], { encoding: 'utf8' }).trim(), path.join(dir, 'python3'));
  }
  return dir;
}

function decodedScript(service) {
  const command = buildspecFor(service).phases.build.commands[0];
  const encoded = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(command)[1];
  return execFileSync(process.execPath, ['-e',
    `process.stdout.write(require('node:zlib').gunzipSync(Buffer.from('${encoded}','base64')).toString())`],
  { encoding: 'utf8' });
}
function parsesBash(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-parse-'));
  const file = path.join(dir, 'job.sh');
  writeFileSync(file, script);
  return spawnSync('bash', ['-n', file], { encoding: 'utf8' });
}
function section(script, name) {
  const start = script.indexOf(`# BEGIN ${name}`);
  const end = script.indexOf(`# END ${name}`);
  assert.ok(start >= 0 && end > start, `missing ${name} markers`);
  return script.slice(start, end);
}
/** The exact Python verifier text the builder executes. */
function emittedVerifier(script) {
  const block = section(script, 'SOURCE-DIGEST-VERIFIER');
  const match = /python3 - <<'PY'\n([\s\S]*?)\nPY/.exec(block);
  assert.ok(match, 'verifier heredoc present');
  return match[1];
}

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-fixture-'));
  execFileSync('git', ['init', '-q', dir], { env: GIT_ENV });
  mkdirSync(path.join(dir, 'apps', 'web'), { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), 'one\n');
  writeFileSync(path.join(dir, 'apps', 'web', 'server.js'), 'process.exit(0)\n');
  writeFileSync(path.join(dir, 'apps', 'web', 'binary.bin'), Buffer.from([0, 1, 2, 255, 10, 13]));
  execFileSync('git', ['-C', dir, 'add', '-A'], { env: GIT_ENV });
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'one'], { env: GIT_ENV });
  return { dir, head: execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
}

function withVerifierTree(fixture, mutate) {
  const worktree = materializeSource(fixture.dir, fixture.head);
  try {
    if (mutate) mutate(worktree);
    return worktree;
  } catch (error) {
    releaseMaterializedSource(fixture.dir, worktree);
    throw error;
  }
}
function runVerifier(script, cwd, expected, shim) {
  const verifier = path.join(mkdtempSync(path.join(tmpdir(), 'legacy-verifier-')), 'verifier.py');
  writeFileSync(verifier, emittedVerifier(script));
  return spawnSync(PYTHON, [verifier], { cwd, encoding: 'utf8',
    env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}`, EXPECTED_TREE_SHA256: expected } });
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
    assert.equal(payload.imagePushed, false);
    assert.equal(payload.scanPerformed, false);
    assert.equal(payload.deployed, false);
  });

  test('explicit flags only: service, source kind, absolute paths, exact commit', () => {
    const base = ['--service', 'web', '--source-checkout', '/src', '--source-commit', 'a'.repeat(40), '--out-dir', '/out'];
    const parsed = parseInvocation(base);
    assert.equal(parsed.mode, 'plan');
    assert.equal(parsed.options.sourceKind, 'github', 'github source override is the default');
    assert.equal(parseInvocation([...base, '--source-kind', 'github']).options.sourceKind, 'github');
    assert.equal(parseInvocation([...base, '--source-kind', 's3']).options.sourceKind, 's3');
    for (const argv of [
      ['--service', 'api', ...base.slice(2)],
      ['--service', 'web', '--source-checkout', 'src', '--source-commit', 'a'.repeat(40), '--out-dir', '/out'],
      ['--service', 'web', '--source-checkout', '/src', '--source-commit', 'HEAD', '--out-dir', '/out'],
      [...base, '--start'],
      [...base, '--stage'],
      ['--service', 'web', '--service', 'web', ...base.slice(2)],
      [...base, '--source-kind', 'codecommit'],
    ]) assert.throws(() => parseInvocation(argv), undefined, argv.join(' '));
  });
});

describe('legacy consumer build request: canonical source digest parity', () => {
  test('generator and the emitted verifier agree on an unchanged source tree', () => {
    const repo = fixture();
    const expected = treeDigest(repo.dir, repo.head);
    assert.match(expected.digest, /^[a-f0-9]{64}$/);
    assert.ok(expected.entries >= 3, 'fixture entries counted');
    const worktree = withVerifierTree(repo);
    const shim = shimDir();
    try {
      const run = runVerifier(decodedScript('web'), worktree, expected.digest, shim);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, new RegExp(`SOURCE_TREE_DIGEST_PASS ${expected.digest} ${expected.entries}`));
      // The generator's own walk of the same tree yields the same digest.
      assert.equal(sourceDigest(collectSourceEntries(worktree)).digest, expected.digest);
    } finally {
      rmSync(shim, { recursive: true, force: true });
      releaseMaterializedSource(repo.dir, worktree);
    }
  });

  test('the emitted verifier refuses changed bytes, extra and missing entries and a wrong expectation', () => {
    const repo = fixture();
    const expected = treeDigest(repo.dir, repo.head).digest;
    const shim = shimDir();
    const cases = [
      ['changed bytes', (tree) => writeFileSync(path.join(tree, 'README.md'), 'two\n')],
      ['extra entry', (tree) => writeFileSync(path.join(tree, 'EXTRA.md'), 'x\n')],
      ['missing entry', (tree) => rmSync(path.join(tree, 'apps', 'web', 'binary.bin'))],
    ];
    try {
      for (const [label, mutate] of cases) {
        const worktree = withVerifierTree(repo, mutate);
        const run = runVerifier(decodedScript('web'), worktree, expected, shim);
        releaseMaterializedSource(repo.dir, worktree);
        assert.equal(run.status, 1, `${label}: ${run.stdout}${run.stderr}`);
        assert.match(run.stdout, /SOURCE_TREE_DIGEST_MISMATCH/, label);
      }
      const worktree = withVerifierTree(repo);
      const wrong = runVerifier(decodedScript('web'), worktree, 'f'.repeat(64), shim);
      releaseMaterializedSource(repo.dir, worktree);
      assert.equal(wrong.status, 1);
      assert.match(wrong.stdout, /SOURCE_TREE_DIGEST_MISMATCH/);
      // The generator never emits a git object id in place of a content digest.
      const entries = (() => {
        const tree = materializeSource(repo.dir, repo.head);
        try { return collectSourceEntries(tree); } finally { releaseMaterializedSource(repo.dir, tree); }
      })();
      assert.equal(canonicalRecordBytes(entries).toString('utf8').includes('F\tREADME.md\t'), true);
      assert.doesNotMatch(canonicalRecordBytes(entries).toString('utf8'), /\t[0-9a-f]{40}\n/);
    } finally {
      rmSync(shim, { recursive: true, force: true });
    }
  });

  test('symlink semantics match on both sides, including changed and escaping targets', (t) => {
    const repo = fixture();
    let symlinksSupported = true;
    try {
      symlinkSync('README.md', path.join(repo.dir, 'alias.md'));
    } catch (error) {
      symlinksSupported = false;
      assert.ok(['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code), error.code);
    }
    if (!symlinksSupported) {
      t.diagnostic('symlink creation is not permitted on this host; executed only the pure-record controls');
      const records = canonicalRecordBytes([{ path: 'alias.md', type: 'symlink', value: 'README.md' }]).toString('utf8');
      assert.equal(records, 'L\talias.md\tREADME.md\n');
      assert.throws(() => canonicalRecordBytes([{ path: 'alias.md', type: 'symlink', value: '/etc/passwd' }]),
        /absolute symlink target/);
      assert.throws(() => canonicalRecordBytes([{ path: 'nested/alias.md', type: 'symlink', value: '../../etc/passwd' }]),
        /escaping symlink target/);
      assert.throws(() => canonicalRecordBytes([{ path: 'alias.md', type: 'symlink', value: 'a\nb' }]),
        /control character in symlink target/);
      return;
    }
    execFileSync('git', ['-C', repo.dir, 'add', '-A'], { env: GIT_ENV });
    execFileSync('git', ['-C', repo.dir, 'commit', '-q', '-m', 'link'], { env: GIT_ENV });
    const head = execFileSync('git', ['-C', repo.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const expected = treeDigest(repo.dir, head).digest;
    const shim = shimDir();
    try {
      const clean = withVerifierTree({ dir: repo.dir, head });
      const pass = runVerifier(decodedScript('web'), clean, expected, shim);
      releaseMaterializedSource(repo.dir, clean);
      assert.equal(pass.status, 0, pass.stderr);
      assert.match(pass.stdout, /SOURCE_TREE_DIGEST_PASS/);

      const retargeted = withVerifierTree({ dir: repo.dir, head },
        (tree) => { rmSync(path.join(tree, 'alias.md')); symlinkSync('apps/web/server.js', path.join(tree, 'alias.md')); });
      const changed = runVerifier(decodedScript('web'), retargeted, expected, shim);
      releaseMaterializedSource(repo.dir, retargeted);
      assert.equal(changed.status, 1);
      assert.match(changed.stdout, /SOURCE_TREE_DIGEST_MISMATCH/);

      for (const target of ['/etc/passwd', '../../etc/passwd']) {
        const escaping = withVerifierTree({ dir: repo.dir, head },
          (tree) => { rmSync(path.join(tree, 'alias.md')); symlinkSync(target, path.join(tree, 'alias.md')); });
        const refused = runVerifier(decodedScript('web'), escaping, expected, shim);
        releaseMaterializedSource(repo.dir, escaping);
        assert.equal(refused.status, 1, target);
        assert.match(refused.stderr, /SOURCE_TREE_REFUSED (absolute|escaping) symlink target/, target);
        assert.throws(() => canonicalRecordBytes([{ path: 'alias.md', type: 'symlink', value: target }]),
          /(absolute|escaping) symlink target/, target);
      }
    } finally {
      rmSync(shim, { recursive: true, force: true });
    }
  });

  test('a tree with a tab or newline in a path is refused by both sides', () => {
    assert.throws(() => canonicalRecordBytes([{ path: 'a\tb', type: 'file', value: 'a'.repeat(64) }]),
      /control character in source path/);
    assert.throws(() => canonicalRecordBytes([{ path: 'a\nb', type: 'file', value: 'a'.repeat(64) }]),
      /control character in source path/);
    assert.throws(() => canonicalRecordBytes([{ path: '../escape', type: 'file', value: 'a'.repeat(64) }]),
      /non-canonical source path/);
    const repo = fixture();
    const worktree = withVerifierTree(repo);
    const shim = shimDir();
    try {
      const hostile = path.join(worktree, 'tab' + String.fromCharCode(9) + 'name');
      let created = true;
      try { writeFileSync(hostile, 'x' + String.fromCharCode(10)); } catch (error) {
        created = false;
        assert.ok(['EINVAL', 'ENOENT', 'EACCES'].includes(error.code), error.code);
      }
      if (!created) {
        // This filesystem refuses a tab in a filename, so only the grammar
        // controls above ran here; the on-disk case is left to the Linux builder.
        return;
      }
      const run = runVerifier(decodedScript('web'), worktree, treeDigest(repo.dir, repo.head).digest, shim);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /SOURCE_TREE_REFUSED control character in source path/);
    } finally {
      rmSync(shim, { recursive: true, force: true });
      releaseMaterializedSource(repo.dir, worktree);
    }
  });
});

describe('legacy consumer build request: job scripts', () => {
  test('the web job is bounded: qualified digest, no rebuild, exact-SHA tags, captured digest and clean scan', () => {
    const script = decodedScript('web');
    assert.ok(script.includes(`capiro/portfolio-preview@${FRONTEND_IMAGE_DIGEST}`), 'qualified frontend digest pin');
    assert.ok(script.includes(FRONTEND_SOURCE_COMMIT));
    assert.ok(script.includes(`:${'$'}EXPECTED_SHA`), 'exact commit tag only');
    assert.ok(script.includes('docker cp "$container:/app/." work/app'), 'extraction of the /app tree');
    assert.ok(script.includes(NODE_IMAGE), 'gates run in the pinned Linux/Node24.21 musl image');
    assert.ok(script.includes('scripts/ci/legacy-web-release.spec.mjs'));
    assert.ok(script.includes('scripts/ci/newsletter-accepted-source-profile.spec.mjs'));
    assert.ok(script.includes('node scripts/legacy-web-release.mjs artifact'));
    assert.ok(script.includes('apps/web/smoke-8080.sh'));
    assert.ok(script.includes('pushed_digest "$CONSUMER_IMAGE" capiro/dev/web'));
    assert.ok(script.includes('pushed_digest "$CONSUMER_IMAGE" capiro/dev/web-vnext'));
    assert.ok(script.includes('DIGEST_PRIMARY" = "$DIGEST_VNEXT"'), 'cross-repository digest equality required');
    assert.ok(script.includes('verify_admitted_image capiro/dev/web "$DIGEST_PRIMARY"'));
    assert.ok(script.includes('verify_admitted_image capiro/dev/web-vnext "$DIGEST_VNEXT"'));
    assert.ok(script.includes('LOCAL_IMAGE_ID'), 'build/smoke identity captured');
    assert.ok(script.includes('ADMITTED_IMAGE_IDENTITY_PASS'));
    assert.ok(script.includes('SCAN_CLEAN_PASS'));
    assert.ok(script.includes('SCAN_REFUSED'));
    assert.ok(script.includes('test "$(uname -m)" = aarch64'));
    assert.ok(script.includes('EXPECTED_TREE_SHA256'));
    assert.ok(script.includes(".replace(os.sep, '/')"), 'tree digest paths are POSIX-normalised');
    const parse = parsesBash(script);
    assert.equal(parse.status, 0, parse.stderr || 'job script parses');
    for (const forbidden of [':latest', 'start-build', 'update-service', 'create-project',
      'put-bucket-policy', 'force-new-deployment', '--target', 'npm ci', 'next build'])
      assert.ok(!script.includes(forbidden), forbidden);
  });

  test('the marketing job builds and smokes the static recipe and verifies its single repository', () => {
    const script = decodedScript('marketing');
    assert.ok(script.includes('docker build --platform linux/arm64 -f marketing/Dockerfile'));
    assert.ok(script.includes('marketing/smoke-8080.sh'));
    assert.ok(script.includes(`:${'$'}EXPECTED_SHA`));
    assert.ok(script.includes('pushed_digest "$IMAGE" capiro/dev/marketing'));
    assert.ok(script.includes('verify_admitted_image capiro/dev/marketing "$DIGEST"'));
    assert.ok(script.includes('SCAN_CLEAN_PASS'));
    const parse = parsesBash(script);
    assert.equal(parse.status, 0, parse.stderr || 'job script parses');
    assert.ok(!script.includes('portfolio-preview'));
    assert.ok(!script.includes('deploy.sh'));
    for (const forbidden of [':latest', 'start-build', 'update-service', 'create-project',
      '--push', 'force-new-deployment', '--target'])
      assert.ok(!script.includes(forbidden), forbidden);
  });

  test('the request pins an immutable source override and mutates no stored project', () => {
    assert.equal(PROJECT, 'capiro-build-web-dev');
    const githubPlan = { project: PROJECT, service: 'web', sourceKind: 'github',
      source: { type: 'GITHUB', location: 'https://github.com/neo-capiro/capiro-backend.git',
        sourceVersion: 'a'.repeat(40) },
      environmentVariables: [{ name: 'EXPECTED_SHA', value: 'a'.repeat(40), type: 'PLAINTEXT' },
        { name: 'EXPECTED_TREE_SHA256', value: 'b'.repeat(64), type: 'PLAINTEXT' }] };
    const github = startBuildRequest(githubPlan, null, 'token-12345');
    assert.equal(github.sourceTypeOverride, 'GITHUB');
    assert.equal(github.sourceLocationOverride, 'https://github.com/neo-capiro/capiro-backend.git');
    assert.equal(github.sourceVersion, 'a'.repeat(40));
    assert.deepEqual(github.environmentVariablesOverride.map((item) => item.name),
      ['EXPECTED_SHA', 'EXPECTED_TREE_SHA256']);

    const s3Plan = { project: PROJECT, service: 'web', sourceKind: 's3',
      source: { bucket: SOURCE_BUCKET, key: 'inputs/web-abc.zip' },
      environmentVariables: [{ name: 'EXPECTED_SHA', value: 'a'.repeat(40), type: 'PLAINTEXT' },
        { name: 'EXPECTED_TREE_SHA256', value: 'b'.repeat(64), type: 'PLAINTEXT' },
        { name: 'EXPECTED_S3_VERSION', value: '<S3_VERSION_ID>', type: 'PLAINTEXT' }] };
    assert.throws(() => startBuildRequest(s3Plan, '', 'token-12345'));
    assert.throws(() => startBuildRequest(s3Plan, '..', 'token-12345'));
    const request = startBuildRequest(s3Plan, '2yHi6FRdT1VBthvkKA9fpJG_SW3fHoHl', 'token-12345');
    assert.equal(request.projectName, PROJECT);
    assert.equal(request.sourceTypeOverride, 'S3');
    assert.equal(request.sourceLocationOverride, `${SOURCE_BUCKET}/inputs/web-abc.zip`);
    assert.equal(request.sourceVersion, '2yHi6FRdT1VBthvkKA9fpJG_SW3fHoHl');
    assert.deepEqual(request.environmentVariablesOverride.map((item) => item.name),
      ['EXPECTED_SHA', 'EXPECTED_TREE_SHA256', 'EXPECTED_S3_VERSION']);
    for (const forbidden of ['secondarySourcesOverride', 'serviceRole', 'environmentTypeOverride',
      'imageOverride', 'vpcConfigOverride']) assert.ok(!(forbidden in request), forbidden);
  });
});

// ---------------------------------------------------------------------------
// Executed negative controls for the captured-digest / scan checks
// ---------------------------------------------------------------------------

const CAPTURED = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;

function stubs() {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-stubs-'));
  if (process.platform === 'win32') {
    writeFileSync(path.join(dir, 'python3'), `#!/usr/bin/env bash\nexec ${PYTHON} "$@"\n`);
  } else {
    symlinkSync(execFileSync('which', ['python3'], { encoding: 'utf8' }).trim(), path.join(dir, 'python3'));
  }
  writeFileSync(path.join(dir, 'docker'), `#!/usr/bin/env bash
if [ "$1" = image ] && [ "$2" = inspect ]; then printf '%s' "$FAKE_REPODIGESTS"; exit 0; fi
echo "unexpected docker $*" >&2; exit 64
`);
  writeFileSync(path.join(dir, 'aws'), `#!/usr/bin/env bash
case "$*" in
  *describe-images*imageTag*) printf '%s' "$FAKE_TAG_DIGEST" ;;
  *describe-images*imageDigest*) printf '%s' "$FAKE_IMAGE_JSON" ;;
  *describe-image-scan-findings*) printf '%s' "$FAKE_SCAN_JSON" ;;
  *) echo "unexpected aws $*" >&2; exit 64 ;;
esac
`);
  for (const name of ['python3', 'docker', 'aws']) chmodSync(path.join(dir, name), 0o755);
  return dir;
}
function imageJson(digest, tags, status = 'ACTIVE') {
  return JSON.stringify({ imageDetails: [{ imageDigest: digest, imageTags: tags, imageStatus: status }] });
}
function scanJson(digest, status, findings = {}) {
  return JSON.stringify({ imageId: { imageDigest: digest }, imageScanStatus: { status },
    imageScanFindings: { findingSeverityCounts: findings } });
}
function runHarness(script, env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-harness-'));
  const file = path.join(dir, 'harness.sh');
  writeFileSync(file, `set -euo pipefail
EXPECTED_SHA=0123456789abcdef0123456789abcdef01234567
REGION=us-east-1
SCAN_ATTEMPTS=2
SCAN_INTERVAL=0
${section(script, 'ADMITTED-IMAGE-CHECK')}
pushed_digest "$IMAGE_REF" capiro/dev/web
`);
  return spawnSync('bash', [file], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
}
function runVerify(script, repository, captured, env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-verify-'));
  const file = path.join(dir, 'verify.sh');
  writeFileSync(file, `set -euo pipefail
EXPECTED_SHA=0123456789abcdef0123456789abcdef01234567
REGION=us-east-1
SCAN_ATTEMPTS=2
SCAN_INTERVAL=0
${section(script, 'ADMITTED-IMAGE-CHECK')}
verify_admitted_image '${repository}' '${captured}'
`);
  return spawnSync('bash', [file], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
}
const baseEnv = (stub, overrides) => ({ PATH: `${stub}${path.delimiter}${process.env.PATH}`,
  IMAGE_REF: 'registry/capiro/dev/web:0123456789abcdef0123456789abcdef01234567', ...overrides });

describe('legacy consumer build request: captured digest and scan controls (executed)', () => {
  test('captured digest is read from the pushed reference and bound to the exact commit tag', () => {
    const script = decodedScript('web');
    const stub = stubs();
    try {
      const capture = runHarness(script, baseEnv(stub, {
        FAKE_REPODIGESTS: JSON.stringify([`capiro/dev/web@${CAPTURED}`]), FAKE_TAG_DIGEST: CAPTURED,
        FAKE_IMAGE_JSON: imageJson(CAPTURED, ['0123456789abcdef0123456789abcdef01234567']),
        FAKE_SCAN_JSON: scanJson(CAPTURED, 'COMPLETE'),
      }));
      assert.equal(capture.status, 0, capture.stderr);
      assert.equal(capture.stdout.trim(), CAPTURED);

      const pass = runVerify(script, 'capiro/dev/web', CAPTURED, baseEnv(stub, {
        FAKE_TAG_DIGEST: CAPTURED,
        FAKE_IMAGE_JSON: imageJson(CAPTURED, ['0123456789abcdef0123456789abcdef01234567']),
        FAKE_SCAN_JSON: scanJson(CAPTURED, 'COMPLETE'),
      }));
      assert.equal(pass.status, 0, pass.stderr);
      assert.match(pass.stdout, /ADMITTED_IMAGE_IDENTITY_PASS capiro-dev-web/);
      assert.match(pass.stdout, new RegExp(`SCAN_CLEAN_PASS capiro-dev-web ${CAPTURED}`));
    } finally { rmSync(stub, { recursive: true, force: true }); }
  });

  test('a pushed reference that is missing, duplicated or malformed is refused', () => {
    const script = decodedScript('web');
    for (const rows of [[], [`capiro/dev/web@${CAPTURED}`, `capiro/dev/web@${OTHER}`],
      ['capiro/dev/other@' + CAPTURED], [`capiro/dev/web@sha256:abc`]]) {
      const stub = stubs();
      try {
        const run = runHarness(script, baseEnv(stub, { FAKE_REPODIGESTS: JSON.stringify(rows) }));
        assert.equal(run.status, 1, rows.join(','));
        assert.match(run.stderr, /PUSH_DIGEST_REFUSED/, rows.join(','));
      } finally { rmSync(stub, { recursive: true, force: true }); }
    }
  });

  test('tag drift, wrong returned identity/status and blocking findings are refused', () => {
    const script = decodedScript('web');
    const cases = [
      ['tag drift', { FAKE_TAG_DIGEST: OTHER,
        FAKE_IMAGE_JSON: imageJson(OTHER, ['0123456789abcdef0123456789abcdef01234567']),
        FAKE_SCAN_JSON: scanJson(OTHER, 'COMPLETE') }, /tag resolves to/],
      ['describe-images identity drift', { FAKE_TAG_DIGEST: CAPTURED,
        FAKE_IMAGE_JSON: imageJson(OTHER, ['0123456789abcdef0123456789abcdef01234567']),
        FAKE_SCAN_JSON: scanJson(CAPTURED, 'COMPLETE') }, /describe-images returned/],
      ['exact tag missing on digest', { FAKE_TAG_DIGEST: CAPTURED,
        FAKE_IMAGE_JSON: imageJson(CAPTURED, ['deadbeef']),
        FAKE_SCAN_JSON: scanJson(CAPTURED, 'COMPLETE') }, /exact tag missing/],
      ['inactive image', { FAKE_TAG_DIGEST: CAPTURED,
        FAKE_IMAGE_JSON: imageJson(CAPTURED, ['0123456789abcdef0123456789abcdef01234567'], 'INACTIVE'),
        FAKE_SCAN_JSON: scanJson(CAPTURED, 'COMPLETE') }, /status 'INACTIVE'/],
      ['scan identity drift', { FAKE_TAG_DIGEST: CAPTURED,
        FAKE_IMAGE_JSON: imageJson(CAPTURED, ['0123456789abcdef0123456789abcdef01234567']),
        FAKE_SCAN_JSON: scanJson(OTHER, 'COMPLETE') }, /SCAN_REFUSED .*image identity/],
      ['scan never completes', { FAKE_TAG_DIGEST: CAPTURED,
        FAKE_IMAGE_JSON: imageJson(CAPTURED, ['0123456789abcdef0123456789abcdef01234567']),
        FAKE_SCAN_JSON: scanJson(CAPTURED, 'IN_PROGRESS') }, /no COMPLETE scan/],
      ['blocking finding', { FAKE_TAG_DIGEST: CAPTURED,
        FAKE_IMAGE_JSON: imageJson(CAPTURED, ['0123456789abcdef0123456789abcdef01234567']),
        FAKE_SCAN_JSON: scanJson(CAPTURED, 'COMPLETE', { HIGH: 1 }) }, /blocking findings 1/],
      ['critical finding', { FAKE_TAG_DIGEST: CAPTURED,
        FAKE_IMAGE_JSON: imageJson(CAPTURED, ['0123456789abcdef0123456789abcdef01234567']),
        FAKE_SCAN_JSON: scanJson(CAPTURED, 'COMPLETE', { CRITICAL: 1 }) }, /blocking findings 1/],
    ];
    for (const [label, env, pattern] of cases) {
      const stub = stubs();
      try {
        const run = runVerify(script, 'capiro/dev/web', CAPTURED, baseEnv(stub, env));
        assert.equal(run.status, 1, `${label}: ${run.stdout}${run.stderr}`);
        assert.match(run.stderr, pattern, label);
      } finally { rmSync(stub, { recursive: true, force: true }); }
    }
  });

  test('cross-repository digest disagreement is detectable from the pushed references', () => {
    const script = decodedScript('web');
    const stub = stubs();
    try {
      const rows = [`capiro/dev/web@${CAPTURED}`, `capiro/dev/web-vnext@${OTHER}`];
      const primary = runHarness(script, baseEnv(stub, { FAKE_REPODIGESTS: JSON.stringify(rows) }));
      assert.equal(primary.status, 0, primary.stderr);
      assert.equal(primary.stdout.trim(), CAPTURED);
      const vnext = spawnSync('bash', ['-c', `set -euo pipefail
EXPECTED_SHA=0123456789abcdef0123456789abcdef01234567
REGION=us-east-1
SCAN_ATTEMPTS=1
SCAN_INTERVAL=0
${section(script, 'ADMITTED-IMAGE-CHECK')}
pushed_digest "$IMAGE_REF" capiro/dev/web-vnext
`], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, ...baseEnv(stub, { FAKE_REPODIGESTS: JSON.stringify(rows) }) } });
      assert.equal(vnext.status, 0, vnext.stderr);
      assert.equal(vnext.stdout.trim(), OTHER);
      // The emitted job refuses the disagreement with this exact guard.
      const job = decodedScript('web');
      assert.ok(job.includes('test "$DIGEST_PRIMARY" = "$DIGEST_VNEXT"'));
      assert.ok(job.includes('cross-repository digest disagreement'));
      assert.notEqual(primary.stdout.trim(), vnext.stdout.trim());
    } finally { rmSync(stub, { recursive: true, force: true }); }
  });
});

describe('legacy consumer build request: exact source binding', () => {
  test('a dirty checkout or a checkout at another commit is refused before any plan is emitted', () => {
    const { dir, head } = fixture();
    const outDir = mkdtempSync(path.join(tmpdir(), 'legacy-request-out-'));
    const base = { service: 'marketing', sourceCheckout: dir, outDir };
    assert.throws(() => createPlan({ ...base, sourceCommit: 'c'.repeat(40) }),
      /source checkout is not at the declared commit/);
    writeFileSync(path.join(dir, 'README.md'), 'uncommitted\n');
    assert.throws(() => createPlan({ ...base, sourceCommit: head }), /tracked modifications/);
  });

  test('the web plan binds the qualified frontend digest to the reviewed active source', () => {
    const { dir, head } = fixture();
    const outDir = mkdtempSync(path.join(tmpdir(), 'legacy-request-out-'));
    const plan = createPlan({ service: 'web', sourceCheckout: dir, sourceCommit: head, outDir });
    assert.equal(plan.frontend.imageDigest, FRONTEND_IMAGE_DIGEST);
    assert.equal(plan.frontend.sourceCommit, FRONTEND_SOURCE_COMMIT);
    assert.equal(plan.frontend.activeAcceptedSource, NEWSLETTER_ACCEPTED_SOURCE_PROFILE.activeCommit);
    assert.deepEqual([...plan.admittedRepositories], ['capiro/dev/web', 'capiro/dev/web-vnext']);
    assert.equal(plan.source.treeDigestEntries, 3);
    assert.equal(plan.source.treeDigestAlgorithm.authentication, undefined);
    assert.match(plan.imageTagPolicy, /no latest/);
    assert.equal(plan.startBuildPerformed, false);
    assert.equal(plan.imagePushed, false);
    assert.equal(plan.scanPerformed, false);
    const marketing = createPlan({ service: 'marketing', sourceCheckout: dir, sourceCommit: head, outDir });
    assert.equal(marketing.frontend, null);
    assert.deepEqual([...marketing.admittedRepositories], ['capiro/dev/marketing']);
  });
});
