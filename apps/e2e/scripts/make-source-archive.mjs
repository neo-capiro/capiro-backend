/**
 * Owned, contained source archive + provenance (CleanUp1 §8.5, round-11).
 *
 * The Linux capture must run over the EXACT COMMITTED source, not a synthetic
 * commit and not a dirty working tree. This helper:
 *
 *   - refuses a dirty measured tree (lib/source-identity.mjs);
 *   - writes a `git archive` tarball of the committed HEAD (exact bytes);
 *   - writes a `source-manifest.json` (path → sha256) + fingerprint over the
 *     measured inputs as the INDEPENDENTLY VERIFIABLE provenance — the container
 *     can re-walk the extracted tree and assert the fingerprint without Git;
 *   - verifies ARCHIVE ENTRY CONTAINMENT: every tar entry is a relative path
 *     with no `..`, no leading `/`, so extraction cannot escape the target.
 *
 *   node scripts/make-source-archive.mjs --write   # pinned default output
 *   node scripts/make-source-archive.mjs <outDir>   # explicit output
 * @cleanup-smoke noArgsExit=2 helpExit=0
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceIdentity, writeSourceManifest, sameIdentity, inMeasuredScope, comparePaths, REQUIRED_INPUTS } from '../lib/source-identity.mjs';
import { parseAndValidateTar } from '../lib/tar-validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const USAGE = 'Usage: node apps/e2e/scripts/make-source-archive.mjs (--write | <outDir>)';
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(USAGE);
  process.exit(2);
}
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (args.length !== 1 || (args[0].startsWith('-') && args[0] !== '--write')) {
  console.error(USAGE);
  console.error(`[archive] unknown argument: ${args.join(' ')}`);
  process.exit(2);
}
const OUT = path.resolve(args[0] === '--write' ? path.join(HERE, '..', '.source-archive') : args[0]);

// §5: output-root OWNERSHIP. The directory must be empty or contain only files
// this tool owns (source-*.tar / source-manifest.json / archive-receipt.json);
// refuse to overwrite unrelated content.
if (existsSync(OUT)) {
  const owned = /^(source-[0-9a-f]{7,64}\.tar|source-manifest\.json|archive-receipt\.json)$/;
  const foreign = readdirSync(OUT).filter((n) => !owned.test(n));
  if (foreign.length) {
    console.error(`[archive] REFUSING: output dir contains unrelated entries: ${foreign.slice(0, 10).join(', ')}`);
    process.exit(3);
  }
}
mkdirSync(OUT, { recursive: true });

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', ...opts });
  if (r.error) return { status: null, stdout: '', error: r.error.message };
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const gitFn = (a) => { const r = git(a); return typeof r.status === 'number' && r.status === 0 ? r.stdout.trim() : null; };

const id = sourceIdentity(REPO, gitFn);
if (!id.gitPresent) { console.error('[archive] REFUSING: no Git provenance to archive.'); process.exit(3); }
if (id.measuredDirty === null) { console.error('[archive] REFUSING: measured dirty-status unknown.'); process.exit(3); }
if (id.measuredDirty.length) {
  console.error(`[archive] REFUSING: ${id.measuredDirty.length} measured source input(s) are dirty — commit first:`);
  for (const l of id.measuredDirty.slice(0, 40)) console.error(`  ${l}`);
  process.exit(3);
}

const tarPath = path.join(OUT, `source-${id.head}.tar`);
const ar = spawnSync('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', '-o', tarPath, 'HEAD'], { cwd: REPO, encoding: 'utf8' });
if (typeof ar.status !== 'number' || ar.status !== 0) { console.error(`[archive] git archive failed (status=${ar.status}): ${ar.stderr}`); process.exit(1); }
if (!existsSync(tarPath)) { console.error('[archive] archive not written'); process.exit(1); }

// Containment + manifest from the AUTHORITATIVE TRACKED archive bytes. The
// producer used to build the manifest by walking the WORKTREE while the payload
// was the Git archive — so ignored local files (apps/e2e/.dbg.mjs) entered the
// manifest, and CRLF-vs-LF working-tree bytes (JSON files) disagreed with the
// git blob bytes (root round-17: three host preflight errors). Build the manifest
// from the tar payload with the SAME source-scope contract as the walker.
const buf = readFileSync(tarPath);
const parsed = parseAndValidateTar(buf);
if (!parsed.ok) {
  console.error('[archive] REFUSING: archive containment/type violated:');
  for (const e of parsed.errors.slice(0, 20)) console.error(`  ${e}`);
  process.exit(1);
}
const entries = parsed.entries;
const entriesChecked = entries.length;
const tarSha256 = createHash('sha256').update(buf).digest('hex');

const fileEntries = entries.filter((e) => e.type === 'file' && inMeasuredScope(e.path));
for (const req of REQUIRED_INPUTS) {
  const base = req.replace(/\/+$/, '');
  if (!fileEntries.some((e) => e.path === base || e.path.startsWith(`${base}/`))) {
    console.error(`[archive] REFUSING: required source input has no tracked file in the archive: ${req}`);
    process.exit(1);
  }
}
const files = fileEntries
  .map((e) => ({ path: e.path, sha256: e.sha256, bytes: e.size }))
  .sort((a, b) => comparePaths(a.path, b.path));
const manifest = writeSourceManifest(files, path.join(OUT, 'source-manifest.json'), {
  head: id.head,
  treeHash: id.treeHash,
  tarball: path.basename(tarPath),
  tarSha256,
});

// Final source stability: the tree must be byte-identical after archiving.
const after = sourceIdentity(REPO, gitFn);
if (!sameIdentity(id, after)) {
  console.error('[archive] REFUSING: source changed during archiving.');
  process.exit(1);
}

writeFileSync(path.join(OUT, 'archive-receipt.json'), `${JSON.stringify({
  schema: 'capiro.cleanup1.visual-source-archive.v1',
  head: id.head,
  treeHash: id.treeHash,
  tarball: path.basename(tarPath),
  tarSha256,
  sourceFingerprint: manifest.fingerprint,
  fileCount: manifest.fileCount,
  entriesChecked,
  containment: 'ok',
}, null, 2)}\n`, 'utf8');

console.log(`[archive] ${path.basename(tarPath)} (${manifest.fileCount} measured files) sha256=${tarSha256.slice(0, 16)}`);
console.log(`[archive] fingerprint=${manifest.fingerprint.slice(0, 16)} provenance=${path.join(OUT, 'source-manifest.json')}`);
