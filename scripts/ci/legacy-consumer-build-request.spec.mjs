import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    // A git checkout on this host does not reproduce symlinks (core.symlinks is
    // off), so the fixture is a real tree with Node-created links; the builder's
    // Linux checkout materialises the same link text the git object records.
    const root = mkdtempSync(path.join(tmpdir(), 'legacy-links-'));
    writeFileSync(path.join(root, 'README.md'), 'one\n');
    try {
      symlinkSync('README.md', path.join(root, 'alias.md'));
    } catch (error) {
      assert.ok(['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code), error.code);
      t.diagnostic('symlink creation is not permitted on this host; executed only the pure-record controls');
      const records = canonicalRecordBytes([{ path: 'alias.md', type: 'symlink', value: 'README.md' }]).toString('utf8');
      assert.equal(records, 'L\talias.md\tREADME.md\n');
      for (const [target, pattern] of [['/etc/passwd', /absolute symlink target/],
        ['nested/../../etc/passwd', /escaping symlink target/], ['a\nb', /control character in symlink target/]])
        assert.throws(() => canonicalRecordBytes([{ path: 'alias.md', type: 'symlink', value: target }]), pattern, target);
      return;
    }
    const shim = shimDir();
    try {
      const expected = sourceDigest(collectSourceEntries(root)).digest;
      assert.match(canonicalRecordBytes(collectSourceEntries(root)).toString('utf8'), /\nL\talias\.md\tREADME\.md\n/);
      const pass = runVerifier(decodedScript('web'), root, expected, shim);
      assert.equal(pass.status, 0, `${pass.stdout}${pass.stderr}`);
      assert.match(pass.stdout, /SOURCE_TREE_DIGEST_PASS/);

      const retargeted = mkdtempSync(path.join(tmpdir(), 'legacy-links-'));
      writeFileSync(path.join(retargeted, 'README.md'), 'one\n');
      symlinkSync('other.md', path.join(retargeted, 'alias.md'));
      const changed = runVerifier(decodedScript('web'), retargeted, expected, shim);
      assert.equal(changed.status, 1);
      assert.match(changed.stdout, /SOURCE_TREE_DIGEST_MISMATCH/);

      for (const target of ['/etc/passwd', '../../etc/passwd']) {
        const escaping = mkdtempSync(path.join(tmpdir(), 'legacy-links-'));
        writeFileSync(path.join(escaping, 'README.md'), 'one\n');
        symlinkSync(target, path.join(escaping, 'alias.md'));
        const refused = runVerifier(decodedScript('web'), escaping, expected, shim);
        assert.equal(refused.status, 1, target);
        assert.match(refused.stderr, /SOURCE_TREE_REFUSED (absolute|escaping) symlink target/, target);
        assert.throws(() => canonicalRecordBytes([{ path: 'alias.md', type: 'symlink', value: target }]),
          /(absolute|escaping) symlink target/, target);
      }
    } finally {
      rmSync(shim, { recursive: true, force: true });
    }
  });

  test('mixed regular-file and symlink ordering is identical in git, generator and verifier', () => {
    // Concrete records from review: symlink a-link -> z-file and file z-file.
    const concrete = [{ path: 'z-file', type: 'file', value: '0'.repeat(64) },
      { path: 'a-link', type: 'symlink', value: 'z-file' }];
    const ordered = sourceDigest(concrete);
    assert.equal(ordered.digest, 'c7623d520ce525f15d88545e3041ae773342e925953df24fb350170a2184706a',
      'path-ordered canonical digest');
    // Whole-record ordering (F before L, the pre-fix Python behaviour) hashes
    // differently and must not be what either side computes.
    const raw = (entry) => `${entry.type === 'file' ? 'F' : 'L'}\t${entry.path}\t${entry.value}\n`;
    const wholeRecord = createHash('sha256').update(concrete.map(raw).sort().join('')).digest('hex');
    assert.equal(wholeRecord, 'c994b188cf132583a1b263d8253de0395cfacd90cab9a6aef6d5091f3260f0f9',
      'whole-record order is the reviewed counter-example');
    assert.notEqual(wholeRecord, ordered.digest);

    const root = mkdtempSync(path.join(tmpdir(), 'legacy-mixed-'));
    writeFileSync(path.join(root, 'z-file'), 'zero-file\n');
    try {
      symlinkSync('z-file', path.join(root, 'a-link'));
    } catch (error) {
      assert.ok(['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code), error.code);
      return; // grammar controls above still pin the ordering; on-disk case needs links
    }
    const entries = collectSourceEntries(root);
    const walkDigest = sourceDigest(entries).digest;
    const records = canonicalRecordBytes(entries).toString('utf8').split('\n').filter(Boolean);
    assert.equal(records.length, 2);
    assert.match(records[0], /^L\ta-link\tz-file$/);
    assert.match(records[1], /^F\tz-file\t[0-9a-f]{64}$/);

    const shim = shimDir();
    try {
      const run = runVerifier(decodedScript('web'), root, walkDigest, shim);
      assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
      assert.match(run.stdout, new RegExp(`SOURCE_TREE_DIGEST_PASS ${walkDigest} 2`));

      // Re-targeting the link must change the digest on both sides.
      const retargeted = mkdtempSync(path.join(tmpdir(), 'legacy-mixed-'));
      writeFileSync(path.join(retargeted, 'z-file'), 'zero-file\n');
      symlinkSync('other-target', path.join(retargeted, 'a-link'));
      const changed = runVerifier(decodedScript('web'), retargeted, walkDigest, shim);
      assert.equal(changed.status, 1);
      assert.match(changed.stdout, /SOURCE_TREE_DIGEST_MISMATCH/);
      assert.notEqual(sourceDigest(collectSourceEntries(retargeted)).digest, walkDigest);
    } finally {
      rmSync(shim, { recursive: true, force: true });
    }

    // A genuine symlink in the *git object database* (mode 120000), not a text file.
    const repo = mkdtempSync(path.join(tmpdir(), 'legacy-mixed-git-'));
    execFileSync('git', ['init', '-q', repo], { env: GIT_ENV });
    writeFileSync(path.join(repo, 'z-file'), 'zero-file\n');
    execFileSync('git', ['-C', repo, 'add', 'z-file'], { env: GIT_ENV });
    const blob = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], { input: 'z-file', env: GIT_ENV, encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', repo, 'update-index', '--add', '--cacheinfo', `120000,${blob},a-link`], { env: GIT_ENV });
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'mixed'], { env: GIT_ENV });
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const modes = execFileSync('git', ['-C', repo, 'ls-tree', '-r', head], { encoding: 'utf8' });
    assert.match(modes, /^120000 blob [0-9a-f]{40}\ta-link$/m, 'git tree holds a real symlink entry');
    assert.equal(treeDigest(repo, head).digest, walkDigest,
      'generator git-object digest equals the verifier value for interleaved names');
    // Changed file content changes the git-object digest too.
    writeFileSync(path.join(repo, 'z-file'), 'other-content\n');
    execFileSync('git', ['-C', repo, 'commit', '-qam', 'content'], { env: GIT_ENV });
    const head2 = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.notEqual(treeDigest(repo, head2).digest, walkDigest);
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
    assert.ok(script.includes('pushed_digest "$CONSUMER_IMAGE" "$REGISTRY_URI"/capiro/dev/web'));
    assert.ok(script.includes('pushed_digest "$CONSUMER_IMAGE" "$REGISTRY_URI"/capiro/dev/web-vnext'));
    assert.ok(script.includes('capture requires the exact fully-qualified ECR repository URI'));
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
    assert.ok(script.includes('pushed_digest "$IMAGE" "$REGISTRY_URI"/capiro/dev/marketing'));
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
const REGISTRY = '967807252336.dkr.ecr.us-east-1.amazonaws.com';
const WEB_URI = `${REGISTRY}/capiro/dev/web`;
const VNEXT_URI = `${REGISTRY}/capiro/dev/web-vnext`;
const MKT_URI = `${REGISTRY}/capiro/dev/marketing`;
const TAG = '0123456789abcdef0123456789abcdef01234567';

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
const CHECK_SECTION = (script) => section(script, 'ADMITTED-IMAGE-CHECK');
function runCapture(script, repository, env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-harness-'));
  const file = path.join(dir, 'capture.sh');
  writeFileSync(file, `set -euo pipefail
EXPECTED_SHA=${TAG}
REGION=us-east-1
SCAN_ATTEMPTS=2
SCAN_INTERVAL=0
${CHECK_SECTION(script)}
pushed_digest "$IMAGE_REF" '${repository}'
`);
  return spawnSync('bash', [file], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
}
function runVerify(script, repository, captured, env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-verify-'));
  const file = path.join(dir, 'verify.sh');
  writeFileSync(file, `set -euo pipefail
EXPECTED_SHA=${TAG}
REGION=us-east-1
SCAN_ATTEMPTS=2
SCAN_INTERVAL=0
${CHECK_SECTION(script)}
verify_admitted_image '${repository}' '${captured}'
`);
  return spawnSync('bash', [file], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
}
const envFor = (stub, overrides) => ({ PATH: `${stub}${path.delimiter}${process.env.PATH}`,
  IMAGE_REF: `${WEB_URI}:${TAG}`, ...overrides });
const cleanIdentity = (uri, digest) => ({ FAKE_TAG_DIGEST: digest,
  FAKE_IMAGE_JSON: imageJson(digest, [TAG]), FAKE_SCAN_JSON: scanJson(digest, 'COMPLETE') });

describe('legacy consumer build request: captured digest and scan controls (executed)', () => {
  test('both web repositories and marketing capture from fully-qualified RepoDigests', () => {
    const script = decodedScript('web');
    const marketingScript = decodedScript('marketing');
    for (const [label, uri, href, sc] of [['web', WEB_URI, `${WEB_URI}:${TAG}`, script],
      ['web-vnext', VNEXT_URI, `${WEB_URI}:${TAG}`, script],
      ['marketing', MKT_URI, `${MKT_URI}:${TAG}`, marketingScript]]) {
      const stub = stubs();
      try {
        const run = runCapture(sc, uri, envFor(stub, { IMAGE_REF: href,
          FAKE_REPODIGESTS: JSON.stringify([`${uri}@${CAPTURED}`]) }));
        assert.equal(run.status, 0, `${label}: ${run.stderr}`);
        assert.equal(run.stdout.trim(), CAPTURED, label);
        const verify = runVerify(sc === marketingScript ? marketingScript : script,
          uri.replace(`${REGISTRY}/`, ''), CAPTURED, envFor(stub, cleanIdentity(uri, CAPTURED)));
        assert.equal(verify.status, 0, `${label} verify: ${verify.stderr}`);
        assert.match(verify.stdout, /ADMITTED_IMAGE_IDENTITY_PASS/);
        assert.match(verify.stdout, new RegExp(`SCAN_CLEAN_PASS .* ${CAPTURED}`));
      } finally { rmSync(stub, { recursive: true, force: true }); }
    }
  });

  test('another registry, another repository or a bare name is refused', () => {
    const script = decodedScript('web');
    const cases = [
      ['foreign registry with the same path', WEB_URI, `${WEB_URI}:${TAG}`,
        [`other-registry.example.com/capiro/dev/web@${CAPTURED}`]],
      ['other repository in the same registry', WEB_URI, `${WEB_URI}:${TAG}`,
        [`${VNEXT_URI}@${CAPTURED}`]],
      ['bare repository name', 'capiro/dev/web', `${WEB_URI}:${TAG}`, [`${WEB_URI}@${CAPTURED}`]],
    ];
    for (const [label, uri, href, rows] of cases) {
      const stub = stubs();
      try {
        const run = runCapture(script, uri, envFor(stub, { IMAGE_REF: href, FAKE_REPODIGESTS: JSON.stringify(rows) }));
        assert.equal(run.status, 1, `${label}: ${run.stdout}`);
        assert.match(run.stderr, /PUSH_DIGEST_REFUSED/, label);
      } finally { rmSync(stub, { recursive: true, force: true }); }
    }
  });

  test('a pushed reference that is missing, duplicated or malformed is refused', () => {
    const script = decodedScript('web');
    for (const rows of [[], [`${WEB_URI}@${CAPTURED}`, `${WEB_URI}@${OTHER}`],
      [`${WEB_URI}@sha256:abc`], [`${WEB_URI}`], [`${WEB_URI}@`]]) {
      const stub = stubs();
      try {
        const run = runCapture(script, WEB_URI, envFor(stub, { FAKE_REPODIGESTS: JSON.stringify(rows) }));
        assert.equal(run.status, 1, rows.join(','));
        assert.match(run.stderr, /PUSH_DIGEST_REFUSED/, rows.join(','));
      } finally { rmSync(stub, { recursive: true, force: true }); }
    }
  });

  test('tag drift, wrong returned identity/status and blocking findings are refused', () => {
    const script = decodedScript('web');
    const cases = [
      ['tag drift', { FAKE_TAG_DIGEST: OTHER, FAKE_IMAGE_JSON: imageJson(OTHER, [TAG]),
        FAKE_SCAN_JSON: scanJson(OTHER, 'COMPLETE') }, /tag resolves to/],
      ['describe-images identity drift', { FAKE_TAG_DIGEST: CAPTURED, FAKE_IMAGE_JSON: imageJson(OTHER, [TAG]),
        FAKE_SCAN_JSON: scanJson(CAPTURED, 'COMPLETE') }, /describe-images returned/],
      ['exact tag missing on digest', { FAKE_TAG_DIGEST: CAPTURED, FAKE_IMAGE_JSON: imageJson(CAPTURED, ['deadbeef']),
        FAKE_SCAN_JSON: scanJson(CAPTURED, 'COMPLETE') }, /exact tag missing/],
      ['inactive image', { FAKE_TAG_DIGEST: CAPTURED, FAKE_IMAGE_JSON: imageJson(CAPTURED, [TAG], 'INACTIVE'),
        FAKE_SCAN_JSON: scanJson(CAPTURED, 'COMPLETE') }, /status 'INACTIVE'/],
      ['scan identity drift', { FAKE_TAG_DIGEST: CAPTURED, FAKE_IMAGE_JSON: imageJson(CAPTURED, [TAG]),
        FAKE_SCAN_JSON: scanJson(OTHER, 'COMPLETE') }, /SCAN_REFUSED .*image identity/],
      ['scan never completes', { FAKE_TAG_DIGEST: CAPTURED, FAKE_IMAGE_JSON: imageJson(CAPTURED, [TAG]),
        FAKE_SCAN_JSON: scanJson(CAPTURED, 'IN_PROGRESS') }, /no COMPLETE scan/],
      ['blocking finding', { FAKE_TAG_DIGEST: CAPTURED, FAKE_IMAGE_JSON: imageJson(CAPTURED, [TAG]),
        FAKE_SCAN_JSON: scanJson(CAPTURED, 'COMPLETE', { HIGH: 1 }) }, /blocking findings 1/],
      ['critical finding', { FAKE_TAG_DIGEST: CAPTURED, FAKE_IMAGE_JSON: imageJson(CAPTURED, [TAG]),
        FAKE_SCAN_JSON: scanJson(CAPTURED, 'COMPLETE', { CRITICAL: 1 }) }, /blocking findings 1/],
    ];
    for (const [label, env, pattern] of cases) {
      const stub = stubs();
      try {
        const run = runVerify(script, 'capiro/dev/web', CAPTURED, envFor(stub, env));
        assert.equal(run.status, 1, `${label}: ${run.stdout}${run.stderr}`);
        assert.match(run.stderr, pattern, label);
      } finally { rmSync(stub, { recursive: true, force: true }); }
    }
  });

  test('cross-repository digest disagreement is detectable from the pushed references', () => {
    const script = decodedScript('web');
    const stub = stubs();
    try {
      const rows = [`${WEB_URI}@${CAPTURED}`, `${VNEXT_URI}@${OTHER}`];
      const primary = runCapture(script, WEB_URI, envFor(stub, { FAKE_REPODIGESTS: JSON.stringify(rows) }));
      assert.equal(primary.status, 0, primary.stderr);
      assert.equal(primary.stdout.trim(), CAPTURED);
      const vnext = runCapture(script, VNEXT_URI, envFor(stub, { FAKE_REPODIGESTS: JSON.stringify(rows) }));
      assert.equal(vnext.status, 0, vnext.stderr);
      assert.equal(vnext.stdout.trim(), OTHER);
      assert.ok(decodedScript('web').includes('test "$DIGEST_PRIMARY" = "$DIGEST_VNEXT"'));
      assert.ok(decodedScript('web').includes('cross-repository digest disagreement'));
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

// --- continuation 08: the decoded job commands must execute with exact argv ---
// The generator writes a shell script inside the buildspec. A JS template-literal
// line continuation defect kept the physical newline out of the emitted text, so a
// command line ended with backslash + spaces and the shell produced extra argv
// entries made of spaces. These tests decode the real emitted bytes, run the
// affected command groups through bash with argv-capturing stubs, and assert the
// exact argument vectors.
const BS = String.fromCharCode(92);

function stubToolDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'c08 stubs '));
  // Each invocation writes its own record file, so concurrent pipeline members
  // (node | tee) can never interleave bytes.
  const script = `#!/usr/bin/env bash
name="$(basename "$0")"
record="$(printf '%s\\x1f' "$name")"
for value in "$@"; do record="$record$(printf '%s\\x1f' "$value")"; done
printf '%s\\x1e' "$record" >> "$ARGV_DIR/rec.$$"
case "$name" in
  aws)
    if [ "$1" = ecr ] && [ "$2" = get-login-password ]; then printf '%s' 'stub-login-password'; fi
    if [ "$1" = sts ] && [ "$2" = get-caller-identity ]; then printf '%s\\n' '967807252336'; fi
    ;;
  docker)
    case "$1" in login|run) cat >/dev/null 2>&1 || true ;; esac ;;
  tee) cat >/dev/null 2>&1 || true ;;
  sha256sum) printf '%s  %s\\n' "${'$'}{STUB_SHA256:-${'c'.repeat(64)}}" "$2" ;;
esac
exit 0
`;
  for (const name of ['aws', 'docker', 'node', 'tee', 'sha256sum']) {
    writeFileSync(path.join(dir, name), script);
    chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}

function commandGroup(script, startsWith) {
  const lines = script.split('\n');
  const start = lines.findIndex((line) => line.trimStart().startsWith(startsWith));
  assert.ok(start >= 0, `emitted command not found: ${startsWith}`);
  const group = [];
  for (let index = start; index < lines.length; index += 1) {
    group.push(lines[index]);
    if (!lines[index].endsWith(BS)) break;
  }
  return group.join('\n');
}

function variablePrelude(script) {
  return script.split('\n')
    .filter((line) => /^(FE_IMAGE|NODE_IMAGE|CONSUMER_IMAGE|IMAGE)=/.test(line)).join('\n');
}

function parseCapturedCalls(dir) {
  const calls = [];
  for (const name of readdirSync(dir).filter((entry) => entry.startsWith('rec.'))) {
    for (const record of readFileSync(path.join(dir, name), 'utf8').split('\x1e')) {
      if (record.length === 0) continue;
      const fields = record.split('\x1f');
      calls.push({ tool: fields[0], argv: fields.slice(1, -1) });
    }
  }
  return calls;
}

function runEmittedGroup(service, startsWith) {
  const script = decodedScript(service);
  const work = mkdtempSync(path.join(tmpdir(), 'c08 argv dir '));
  const stubs = stubToolDir();
  const captureDir = path.join(work, 'argv');
  mkdirSync(captureDir);
  const file = path.join(work, 'group.sh');
  writeFileSync(file, ['set -uo pipefail', variablePrelude(script), commandGroup(script, startsWith)].join('\n') + '\n');
  const run = spawnSync('bash', [file], {
    cwd: work, encoding: 'utf8',
    env: { ...process.env, PATH: `${stubs}${path.delimiter}${process.env.PATH}`, ARGV_DIR: captureDir,
      EXPECTED_SHA: TAG, MANIFEST_SHA256: 'c'.repeat(64) },
  });
  const calls = parseCapturedCalls(captureDir);
  const bashCwd = spawnSync('bash', ['-c', 'pwd -P'], { cwd: work, encoding: 'utf8' }).stdout.trim();
  rmSync(stubs, { recursive: true, force: true });
  return { run, calls, cwd: bashCwd, work, script };
}

function assertExactArgv(calls) {
  for (const call of calls) {
    for (const value of call.argv) {
      assert.equal(typeof value, 'string', `${call.tool}: argv must be strings`);
      assert.notEqual(value.trim(), '', `${call.tool}: empty/whitespace-only argv element ${JSON.stringify(value)}`);
      assert.ok(!/^\s/.test(value), `${call.tool}: argv element starts with whitespace ${JSON.stringify(value)}`);
      assert.ok(!/\s$/.test(value), `${call.tool}: argv element ends with whitespace ${JSON.stringify(value)}`);
    }
  }
}

describe('legacy consumer build request: emitted command argv (executed)', () => {
  test('both ECR login pipelines pass exactly the region and registry arguments', () => {
    for (const service of ['web', 'marketing']) {
      const { run, calls, script } = runEmittedGroup(service, 'aws ecr get-login-password');
      assert.equal(run.status, 0, `${service} login: ${run.stderr}`);
      assertExactArgv(calls);
      assert.deepEqual(calls.map((call) => call.tool), ['aws', 'docker'], service);
      assert.deepEqual(calls[0].argv, ['ecr', 'get-login-password', '--region', 'us-east-1'], service);
      assert.deepEqual(calls[1].argv,
        ['login', '--username', 'AWS', '--password-stdin', '967807252336.dkr.ecr.us-east-1.amazonaws.com'], service);
    }
  });

  test('the Node gate runs inside the pinned image with all three test files', () => {
    const { run, calls, work } = runEmittedGroup('web', 'docker run --rm -v');
    assert.equal(run.status, 0, run.stderr);
    assertExactArgv(calls);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ['run', '--rm', '-v', calls[0].argv[3], '-w', '/src', NODE_IMAGE,
      'node', '--test', 'scripts/ci/legacy-web-release.spec.mjs',
      'scripts/ci/newsletter-accepted-source-profile.spec.mjs',
      'scripts/ci/frontend-standalone-artifact.contract.spec.mjs']);
    // The harness directory deliberately contains a space: the volume mapping must
    // stay one argument carrying the whole path, not a split pair.
    const volume = calls[0].argv[3];
    assert.ok(volume.endsWith(':/src'), volume);
    assert.ok(volume.includes(' '), 'space in the path must survive quoting');
    assert.equal(path.basename(volume.slice(0, -':/src'.length)), path.basename(work));
  });

  test('the assembler receives every option with the pinned producer identity', () => {
    const { run, calls } = runEmittedGroup('web', 'node scripts/legacy-web-release.mjs artifact');
    assert.equal(run.status, 0, run.stderr);
    assertExactArgv(calls);
    assert.deepEqual(calls[0].argv, ['scripts/legacy-web-release.mjs', 'artifact',
      '--extracted-app-dir', '/work/app',
      '--frontend-commit', FRONTEND_SOURCE_COMMIT,
      '--image-digest', FRONTEND_IMAGE_DIGEST,
      '--manifest', '/work/artifact.manifest.json',
      '--output-dir', '/src/release-artifacts/capiro-frontend',
      '--backend-commit', TAG,
      '--arch', 'arm64']);
    assert.deepEqual(calls[1].argv, ['work/assembly.json']);
  });

  test('the web and marketing Docker builds receive exact build arguments and labels', () => {
    const web = runEmittedGroup('web', 'docker build --platform linux/arm64 -f apps/web/Dockerfile');
    assert.equal(web.run.status, 0, web.run.stderr);
    assertExactArgv(web.calls);
    assert.deepEqual(web.calls[0].argv, ['build', '--platform', 'linux/arm64', '-f', 'apps/web/Dockerfile',
      '--build-arg', `FRONTEND_ARTIFACT_MANIFEST_SHA256=${'c'.repeat(64)}`,
      '--build-arg', 'FRONTEND_ARTIFACT_SOURCE_REPOSITORY=neo-capiro/capiro-frontend',
      '--build-arg', `FRONTEND_ARTIFACT_SOURCE_COMMIT=${FRONTEND_SOURCE_COMMIT}`,
      '--build-arg', 'TARGETPLATFORM=linux/arm64',
      '--label', `org.opencontainers.image.revision=${TAG}`,
      '--label', 'org.opencontainers.image.source=https://github.com/neo-capiro/capiro-backend',
      '-t', `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web:${TAG}`, '.']);

    const marketing = runEmittedGroup('marketing', 'docker build --platform linux/arm64 -f marketing/Dockerfile');
    assert.equal(marketing.run.status, 0, marketing.run.stderr);
    assertExactArgv(marketing.calls);
    assert.deepEqual(marketing.calls[0].argv, ['build', '--platform', 'linux/arm64', '-f', 'marketing/Dockerfile',
      '--label', `org.opencontainers.image.revision=${TAG}`,
      '--label', 'org.opencontainers.image.source=https://github.com/neo-capiro/capiro-backend',
      '-t', `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/marketing:${TAG}`, '.']);
  });

  test('no emitted line carries trailing whitespace', () => {
    for (const service of ['web', 'marketing']) {
      const offenders = decodedScript(service).split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter((entry) => entry.line !== entry.line.replace(/[ 	]+$/, ''))
        .map((entry) => entry.number);
      assert.deepEqual(offenders, [], `${service}: lines with trailing whitespace`);
    }
  });
});
