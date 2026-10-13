import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {lstatSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Four immutable raw observations from published PR2445, not a docs/evidence
// glob or a general patch exemption. Normal docs and all source are checked.
export const RAW_ARCHIVE_SOURCE = '9db4e1cd5589a05e08fb88caa38a4ac44937def5';
export const RAW_ARCHIVES = Object.freeze([
  ['docs/cleanup-newsletter-canonical-builder-20261013/evidence/five-path-code-diff.patch', '04c1a6da2d286c29e01d072b20c292341df784a365eb55f66bfc5a5063413931', 42780],
  ['docs/cleanup-newsletter-canonical-builder-independent-review-20261013/evidence/original-scopes.stdout', '99be960ecfc6232814832661cb9bd074fba90130322519369035bed44b6ab3e2', 3338],
  ['docs/newsletter-builder-reviewed-publication-20261013/physical-evidence-whitespace.txt', '5b6296b3ffce8f2da9ef49bc12af2dc1781d9da4d592eb2e5b3a0de7f5a2bf91', 605],
  ['docs/newsletter-builder-reviewed-publication-20261013/root-wired-backend-source-guards.tap', '0372d5dc0d64e3b09d6be464ebc9836612b1c7c85e98977ffab6003bb45e6423', 33487],
].map(row => Object.freeze(row)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 4096 && !value.startsWith('/') && !/[\0\r\n\\]/.test(value) &&
  !value.split('/').some(part => part === '' || part === '.' || part === '..');

export function classifyReviewedHygienePaths(changedPaths, archiveBytes) {
  if (!Array.isArray(changedPaths) || changedPaths.length > 100000 ||
      changedPaths.some(value => !canonical(value)) ||
      new Set(changedPaths).size !== changedPaths.length || !(archiveBytes instanceof Map))
    throw new Error('Bounded unique literal repository paths and archive bytes required');
  if (archiveBytes.size !== RAW_ARCHIVES.length)
    throw new Error('Only the four exact reviewed raw archives can be classified');
  for (const [file, hash, size] of RAW_ARCHIVES) {
    const bytes = archiveBytes.get(file);
    if (!Buffer.isBuffer(bytes) || bytes.length !== size || sha(bytes) !== hash)
      throw new Error(`Immutable raw archive identity mismatch: ${file}`);
  }
  const rawPaths = new Set(RAW_ARCHIVES.map(([file]) => file));
  return Object.freeze({
    checkedPaths: Object.freeze(changedPaths.filter(file => !rawPaths.has(file))),
    classifiedRawPaths: Object.freeze(changedPaths.filter(file => rawPaths.has(file))),
  });
}

// Read-only local Git. No shell, aliases, textconv, external diff, fsmonitor,
// credential-bearing environment, network, application imports or writes.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function git(args) {
  const result = spawnSync('git', ['--literal-pathspecs', '-c', 'core.fsmonitor=false',
    '-c', 'core.pager=cat', '-c', 'core.filemode=true',
    '-c', 'core.whitespace=blank-at-eol,blank-at-eof,space-before-tab',
    '-c', 'core.attributesfile=/dev/null', ...args], {cwd: ROOT, maxBuffer: 16 * 1024 * 1024,
    env: {PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1'}});
  if (result.error || result.signal || result.status === null)
    throw new Error('Read-only Git operation failed');
  return result;
}
function successful(args) {
  const result = git(args);
  if (result.status !== 0) throw new Error('Read-only Git identity operation failed');
  return result.stdout;
}
// --text prevents a binary/diff attribute from hiding an added source line.
const diff = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--text'];
function literalNames(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || (text.length && !text.endsWith('\0')))
    throw new Error('Literal UTF-8 repository path list required');
  return text.length ? text.slice(0, -1).split('\0') : [];
}
function checkIndexVisibility() {
  const entries = literalNames(successful(['ls-files', '-v', '-z']));
  if (entries.length > 100000) throw new Error('Bounded tracked index required');
  for (const entry of entries) {
    const tag = entry.slice(0, 1), file = entry.slice(2);
    if (entry[1] !== ' ' || !canonical(file) || !['H', 'S'].includes(tag))
      throw new Error('Assume-unchanged or unreviewed index visibility flags refused');
    if (tag === 'S') {
      // Sparse omissions are legitimate. A materialized flagged path can hide
      // changed bytes from Git diff, so refuse it without reading its contents.
      try {
        lstatSync(path.join(ROOT, file));
        throw new Error(`Materialized skip-worktree path refused: ${file}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}
function checkAttributes(paths) {
  // Per-path attributes outrank core.whitespace. Inspect both states; local
  // info/attributes also appears here and cannot silently suppress this gate.
  for (const cached of [[], ['--cached']]) {
    for (let offset = 0; offset < paths.length; offset += 128) {
      const selected = paths.slice(offset, offset + 128);
      const fields = literalNames(successful(['check-attr', '-z', ...cached, 'whitespace', 'diff', '--', ...selected]));
      if (fields.length !== selected.length * 6) throw new Error('Exact whitespace attribute observations required');
      for (let index = 0; index < selected.length; index++) {
        const [file, kind, value, diffFile, diffKind, diffValue] = fields.slice(index * 6, index * 6 + 6);
        if (file !== selected[index] || diffFile !== file || kind !== 'whitespace' || diffKind !== 'diff' ||
            value !== 'unspecified' || !['unspecified', 'set'].includes(diffValue))
          throw new Error(`Unreviewed source whitespace/diff attribute override refused: ${selected[index]}`);
      }
    }
  }
}

export function runReviewedSourceHygiene(base) {
  if (typeof base !== 'string' || !/^[a-f0-9]{40}$/.test(base))
    throw new Error('Exact lowercase base commit required');
  const commit = successful(['rev-parse', '--verify', `${base}^{commit}`]).toString().trim();
  if (commit !== base) throw new Error('Exact base commit identity mismatch');
  checkIndexVisibility();
  const archiveBytes = new Map();
  for (const [file] of RAW_ARCHIVES) {
    const headMode = successful(['ls-tree', '-z', 'HEAD', '--', file]).toString();
    const indexMode = successful(['ls-files', '--stage', '-z', '--', file]).toString();
    if (!/^100644 blob [a-f0-9]{40}\t/.test(headMode) || !headMode.endsWith(`\t${file}\0`) ||
        !/^100644 [a-f0-9]{40} 0\t/.test(indexMode) || !indexMode.endsWith(`\t${file}\0`))
      throw new Error(`Immutable raw archive HEAD/index mode mismatch: ${file}`);
    archiveBytes.set(file, successful(['show', `HEAD:${file}`]));
    if (successful([...diff, '--cached', 'HEAD', '--', file]).length !== 0 ||
        successful([...diff, '--', file]).length !== 0)
      throw new Error(`Immutable raw archive worktree/index edits refused: ${file}`);
  }
  const changedPaths = [...new Set([
    ...literalNames(successful([...diff, '--name-only', '-z', '--cached', base, '--'])),
    ...literalNames(successful([...diff, '--name-only', '-z', base, '--'])),
  ])];
  const scope = classifyReviewedHygienePaths(changedPaths, archiveBytes);
  checkAttributes(changedPaths);
  let checkedDiagnostics = '';
  for (const cached of [[], ['--cached']]) {
    for (let offset = 0; offset < scope.checkedPaths.length; offset += 128) {
      const result = git([...diff, '--check', ...cached, base, '--', ...scope.checkedPaths.slice(offset, offset + 128)]);
      checkedDiagnostics += result.stdout.toString() + result.stderr.toString();
      if (result.status !== 0) return {sourceHygiene: 'FAIL', base,
        checkedPaths: scope.checkedPaths.length, checkedStates: ['index', 'working-tree'],
        rawArchivesClassified: scope.classifiedRawPaths, checkedDiagnostics, rawArchiveSource: RAW_ARCHIVE_SOURCE};
    }
  }
  let rawArchiveDiagnostics = '';
  if (scope.classifiedRawPaths.length) {
    const result = git([...diff, '--check', base, '--', ...scope.classifiedRawPaths]);
    // Git exits 2 for whitespace observations. Any other failure is not archived.
    if (![0, 2].includes(result.status)) throw new Error('Raw archive diagnostic collection failed');
    rawArchiveDiagnostics = result.stdout.toString() + result.stderr.toString();
  }
  return {sourceHygiene: 'PASS', base, checkedPaths: scope.checkedPaths.length,
    checkedStates: ['index', 'working-tree'], whitespaceRules: ['blank-at-eol', 'blank-at-eof', 'space-before-tab'],
    rawArchivesClassified: scope.classifiedRawPaths, rawArchiveSource: RAW_ARCHIVE_SOURCE,
    rawArchiveHashes: RAW_ARCHIVES.map(([file, sha256, bytes]) => ({file, sha256, bytes})),
    checkedDiagnostics, rawArchiveDiagnostics,
    wholePhysicalPatchWhitespacePass: rawArchiveDiagnostics.length === 0};
}

const usage = 'Usage: node scripts/lib/reviewed-source-hygiene.mjs --run --base <exact-lowercase-40-hex-commit>';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {console.log(usage); process.exitCode = 0;}
  else if (args.length !== 3 || args[0] !== '--run' || args[1] !== '--base' || !/^[a-f0-9]{40}$/.test(args[2])) {
    console.error(usage); process.exitCode = 2;
  } else {
    try {
      const result = runReviewedSourceHygiene(args[2]);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.sourceHygiene === 'PASS' ? 0 : 1;
    } catch (error) {console.error(error.message); process.exitCode = 1;}
  }
}
