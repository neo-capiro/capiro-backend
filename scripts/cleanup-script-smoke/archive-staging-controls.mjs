/**
 * CleanUp1 §6.2 — ARCHIVE-STAGING controls for the public `stageTrackedSource`.
 *
 * These are executable controls (root runs them; NO application subject and NO
 * Docker is touched here). They build a NEW, task-owned fixture Git repository
 * under the OS temp dir and drive the ACTUAL public `stageTrackedSource` from
 * run-smoke.mjs — the same function the runner and prove-boundary.mjs use — so
 * the reviewed archive path (git archive bytes → `materializeValidatedArchive`,
 * no host `tar`, no MSYS drive translation) is exercised end-to-end on bytes:
 *
 *   1. tracked UTF-8 bytes survive staging byte-for-byte;
 *   2. an ignored, untracked sentinel is NEVER staged (ignored/credentials stay
 *      out);
 *   3. a committed UNSAFE entry (a symlink) makes the materialiser refuse, and a
 *      refusal leaves the destination UNTOUCHED;
 *   4. a pre-populated (nonempty) destination is refused — nothing is overlaid;
 *   5. a non-Git root is refused.
 *
 * Only `git` (fixture setup and archive production) and Node fs calls run here;
 * no repository entry point is ever executed on the host. Every fixture artifact
 * (repos + stage dirs) is RETAINED — nothing is recursively deleted.
 *
 * Usage:
 *   node scripts/cleanup-script-smoke/archive-staging-controls.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageTrackedSource } from './run-smoke.mjs';
import { parseAndValidateTar } from './tar-validate.mjs';

const TMP = tmpdir();

/** Hermetic git environment: no host/system config, no prompt, no parent search. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CEILING_DIRECTORIES: TMP,
  GIT_AUTHOR_NAME: 'cleanup-smoke-fixture',
  GIT_AUTHOR_EMAIL: 'cleanup-smoke@example.invalid',
  GIT_COMMITTER_NAME: 'cleanup-smoke-fixture',
  GIT_COMMITTER_EMAIL: 'cleanup-smoke@example.invalid',
};

/** Run git in `cwd`, failing loudly on any nonzero exit. */
function git(cwd, args, opts = {}) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: GIT_ENV,
    ...opts,
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${`${r.stderr ?? ''}${r.error?.message ?? ''}`.trim()}`);
  }
  return r;
}

/** The archive bytes `stageTrackedSource` will itself consume for `repo`. */
function archiveBytes(repo) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-C', repo, 'archive', '--format=tar', 'HEAD'], {
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: GIT_ENV,
  });
  return r.status === 0 && Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.alloc(0);
}

/** A clean owned fixture repo: tracked UTF-8 file + tracked .gitignore + ignored sentinel. */
function makeCleanFixture(prefix) {
  const repo = mkdtempSync(join(TMP, prefix));
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, '.gitignore'), 'ignored-sentinel.txt\n');
  const content = Buffer.from('café — naïve ✓ ☃\nsecond line\n', 'utf8');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'utf8-note.txt'), content);
  // Ignored, untracked: MUST never be staged.
  writeFileSync(join(repo, 'ignored-sentinel.txt'), 'IGNORED SENTINEL — must not be staged\n');
  git(repo, ['add', '.gitignore', 'src/utf8-note.txt']);
  git(repo, ['commit', '-q', '-m', 'clean fixture']);
  return { repo, content };
}

/**
 * An owned fixture repo whose COMMITTED tree contains an unsafe entry: a symlink.
 * The symlink is registered directly in the index (mode 120000) from a blob — no
 * host symlink is created — and `git archive` then emits a symlink tar entry the
 * canonical validator refuses.
 */
function makeUnsafeFixture(prefix) {
  const repo = mkdtempSync(join(TMP, prefix));
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'README.md'), 'unsafe fixture\n');
  git(repo, ['add', 'README.md']);
  const blob = git(repo, ['hash-object', '-w', '--stdin'], { input: '../../escape-target\n' }).stdout.trim();
  git(repo, ['update-index', '--add', '--cacheinfo', `120000,${blob},evil-link`]);
  git(repo, ['commit', '-q', '-m', 'unsafe fixture']);
  return repo;
}

function runControls() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const artifacts = {};

  // ---- 1. clean fixture: validated staging preserves tracked UTF-8 bytes ----
  const clean = makeCleanFixture('cleanup-smoke-archive-clean-');
  artifacts.cleanRepo = clean.repo;
  const cleanStage = mkdtempSync(join(TMP, 'cleanup-smoke-stage-clean-'));
  artifacts.cleanStage = cleanStage;
  const cleanArchive = archiveBytes(clean.repo);
  const cleanParsed = parseAndValidateTar(cleanArchive);
  add(
    'clean fixture archive is VALID under the canonical parser (positive control)',
    cleanParsed.ok === true && cleanParsed.entries.some((e) => e.path === 'src/utf8-note.txt' && e.type === 'file'),
    JSON.stringify({ ok: cleanParsed.ok, errors: cleanParsed.errors, entries: cleanParsed.entries?.length }),
  );

  let cleanReturn = null;
  let cleanThrew = null;
  try {
    cleanReturn = stageTrackedSource(clean.repo, cleanStage);
  } catch (e) {
    cleanThrew = e;
  }
  const stagedNote = join(cleanStage, 'src', 'utf8-note.txt');
  add(
    'stageTrackedSource stages tracked UTF-8 bytes byte-for-byte (public return = stage dir)',
    cleanThrew === null && cleanReturn === cleanStage && existsSync(stagedNote) && readFileSync(stagedNote).equals(clean.content),
    JSON.stringify({ threw: cleanThrew?.message ?? null, returnIsStage: cleanReturn === cleanStage, notePresent: existsSync(stagedNote) }),
  );
  add(
    'ignored, untracked sentinel is NEVER staged (ignored/credential material stays out)',
    cleanThrew === null && !existsSync(join(cleanStage, 'ignored-sentinel.txt')) && existsSync(join(cleanStage, '.gitignore')),
    JSON.stringify({ sentinel: existsSync(join(cleanStage, 'ignored-sentinel.txt')), trackedGitignore: existsSync(join(cleanStage, '.gitignore')) }),
  );

  // ---- 2. committed UNSAFE archive refused, destination untouched -----------
  const unsafe = makeUnsafeFixture('cleanup-smoke-archive-unsafe-');
  artifacts.unsafeRepo = unsafe.repo;
  const unsafeArchive = archiveBytes(unsafe.repo);
  const unsafeParsed = parseAndValidateTar(unsafeArchive);
  const unsafeStage = mkdtempSync(join(TMP, 'cleanup-smoke-stage-unsafe-'));
  artifacts.unsafeStage = unsafeStage;
  let unsafeThrew = null;
  try {
    stageTrackedSource(unsafe.repo, unsafeStage);
  } catch (e) {
    unsafeThrew = e;
  }
  add(
    'unsafe committed archive (symlink entry) is refused by the materialiser',
    unsafeParsed.ok === false && unsafeThrew !== null,
    JSON.stringify({ archiveValid: unsafeParsed.ok, archiveErrors: unsafeParsed.errors, threw: unsafeThrew?.message ?? null }),
  );
  add(
    'a refused unsafe archive leaves the destination UNTOUCHED (still empty)',
    readdirSync(unsafeStage).length === 0,
    JSON.stringify({ entries: readdirSync(unsafeStage) }),
  );

  // ---- 3. nonempty destination refused (no overlay) -------------------------
  const nonEmptyStage = mkdtempSync(join(TMP, 'cleanup-smoke-stage-nonempty-'));
  artifacts.nonEmptyStage = nonEmptyStage;
  writeFileSync(join(nonEmptyStage, 'preexisting.txt'), 'keep me\n');
  let nonEmptyThrew = null;
  try {
    stageTrackedSource(clean.repo, nonEmptyStage);
  } catch (e) {
    nonEmptyThrew = e;
  }
  add(
    'a NONEMPTY destination is refused and nothing is overlaid',
    nonEmptyThrew !== null &&
      readFileSync(join(nonEmptyStage, 'preexisting.txt'), 'utf8') === 'keep me\n' &&
      !existsSync(join(nonEmptyStage, 'src', 'utf8-note.txt')),
    JSON.stringify({ threw: nonEmptyThrew?.message ?? null, preexisting: existsSync(join(nonEmptyStage, 'preexisting.txt')), staged: existsSync(join(nonEmptyStage, 'src', 'utf8-note.txt')) }),
  );

  // ---- 4. non-Git root refused ---------------------------------------------
  const notRepo = mkdtempSync(join(TMP, 'cleanup-smoke-notrepo-'));
  artifacts.notRepo = notRepo;
  const invalidStage = join(notRepo, 'stage');
  artifacts.invalidStage = invalidStage;
  let invalidThrew = null;
  try {
    stageTrackedSource(notRepo, invalidStage);
  } catch (e) {
    invalidThrew = e;
  }
  add(
    'a non-Git root is refused (no staging dir created)',
    invalidThrew !== null && !existsSync(invalidStage),
    JSON.stringify({ threw: invalidThrew?.message ?? null, stageCreated: existsSync(invalidStage) }),
  );

  const failed = checks.filter((c) => !c.ok);
  return {
    module: 'archive-staging-controls',
    checks,
    passed: checks.length - failed.length,
    total: checks.length,
    ok: failed.length === 0,
    artifacts,
  };
}

export { runControls as runArchiveStagingControls };

if (process.argv[1]?.endsWith('archive-staging-controls.mjs')) {
  const r = runControls();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exitCode = r.ok ? 0 : 1;
}
