/**
 * COMPLETE measured source inputs + byte fingerprint (CleanUp1 §8.5, round-12).
 *
 * Round-11 fixes retained; round-12 additions from the root review:
 *   - PUBLIC/STATIC assets are measured (`apps/web/public`) — the root probe
 *     showed a real render asset (brand.svg) changing the fingerprint ZERO.
 *   - REQUIRED inputs must be present and readable; a missing/unreadable required
 *     input FAILS instead of being silently skipped.
 *   - symlinks that resolve OUTSIDE the repo are rejected (unsafe realpath escape).
 *   - Git dirty-status is filtered through the SAME scope predicate as the byte
 *     walker, so generated captures/results/staging never count as source dirt.
 *   - round-35: the pipeline's OWNED ephemeral output dirs (dynamic pid+time
 *     names, created immediately under apps/e2e) are excluded by SHAPE — the
 *     round-31 pinned Linux capture otherwise measured the `.capture-staging-*`
 *     PNGs it had JUST written and refused publication on a self-induced
 *     fingerprint change (before ≠ after). See isOwnedOutputRel().
 *   - round-36: Git dirtiness is parsed from `git status --porcelain=v2 -z`
 *     (NUL-delimited, `--untracked-files=all`), NOT v1 lines. The v1 parser
 *     (`line.slice(3)`) silently corrupted the result because every real caller
 *     trims stdout — a first tracked line ` M apps/web/src/main.tsx` arrived as
 *     `M apps/web/src/main.tsx`, slice(3) dropped the leading `a`, and the path
 *     fell out of scope (empty dirty set); a quoted v1 path (space/Unicode) was
 *     dropped the same way. v2 `-z` never quotes/re-encodes, keeps both sides of
 *   a rename, and a malformed/unknown record FAILS CLOSED. See parsePorcelainV2Z().
 *   - overlap: MEASURED_INPUTS deliberately mixes a directory root (`apps/e2e`)
 *     with explicit file roots inside it (`apps/e2e/lib/*.mjs`). walkInto's
 *     directory recursion and the explicit-path branch therefore measured those
 *     kernel files TWICE, so the walker's manifest carried duplicate records and
 *     its fingerprint diverged from the archive's once-per-path tracked set
 *     ("fingerprint mismatch vs current tree", no added/changed paths). walkSource
 *     now keys records by UNIQUE repo-relative path (recordMeasured), collapsing
 *     the duplicate while preserving the actual byte hash/size — and FAILS CLOSED
 *     if a path is measured twice with conflicting bytes (a read race). Canonical
 *     ordering (comparePaths) and the ONE scope predicate are unchanged.
 *
 * The fingerprint is derived from real bytes; Git is used only for dirtiness and
 * HEAD/tree. A missing Git is an explicit, reported state — never "clean" — and a
 * verified archived-source manifest (schema/head/tree/fingerprint) is required in
 * that case (see verifyManifest()).
 */
import { createHash } from 'node:crypto';
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  lstatSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** The measured rendered inputs, relative to the repo root. */
export const MEASURED_INPUTS = Object.freeze([
  // Web application source + its build config / entry points + public assets.
  'apps/web/src',
  'apps/web/public',
  'apps/web/vite.config.ts',
  'apps/web/vite.config.js',
  'apps/web/tsconfig.json',
  'apps/web/package.json',
  'apps/web/index.html',
  // The offline route-capture harness (the fixture layer itself).
  'apps/e2e',
  // Separate rendered frontend (round-13 R7 finding): apps/onboard-web is its own
  // Vite app, distinct from the apps/web /onboarding proxy route. Its source is a
  // real rendered input that MUST be measured (round-14: onboard-web rendering is
  // REQUIRED, so it is a REQUIRED input below, not silently optional).
  'apps/onboard-web/src',
  'apps/onboard-web/smoke',
  'apps/onboard-web/index.html',
  'apps/onboard-web/public',
  'apps/onboard-web/vite.config.ts',
  'apps/onboard-web/vitest.config.ts',
  'apps/onboard-web/tsconfig.json',
  'apps/onboard-web/package.json',
  // Shared + strategy packages the web app imports (formatters, contracts).
  'packages/shared/src',
  'packages/shared/package.json',
  'packages/strategy-verifier/src',
  'packages/strategy-verifier/package.json',
  // Round-60: the shared renderer/context kernel and the shared Playwright
  // report adapter are REAL rendered-input dependencies (the regression driver
  // and repeat proof import them, and they decide identity/renderer equality),
  // so they are measured and REQUIRED — the archive provenance byte-binds them.
  'apps/e2e/lib/renderer-contract.mjs',
  'apps/e2e/lib/render-context.mjs',
  'apps/e2e/lib/playwright-report.mjs',
  'scripts/test-proof/lib/adapters.mjs',
  'scripts/test-proof/lib/paths.mjs',
  'scripts/test-proof/lib/schema.mjs',
  // Root build/config/lock inputs that decide the compiled output.
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'turbo.json',
]);

/** Inputs that MUST exist and be readable; absence is a hard failure. */
export const REQUIRED_INPUTS = Object.freeze([
  'apps/web/src',
  'apps/web/package.json',
  'apps/e2e',
  'apps/onboard-web/src',
  'apps/onboard-web/package.json',
  'apps/onboard-web/index.html',
  'apps/onboard-web/vite.config.ts',
  'packages/shared/src',
  'packages/strategy-verifier/src',
  'package.json',
  'pnpm-lock.yaml',
  // Round-60 renderer/parser kernel deps (must be present + readable).
  'apps/e2e/lib/renderer-contract.mjs',
  'apps/e2e/lib/render-context.mjs',
  'apps/e2e/lib/playwright-report.mjs',
  'scripts/test-proof/lib/adapters.mjs',
]);

/**
 * Directory names excluded ANYWHERE — these are unambiguously generated caches/
 * outputs and never product source, so a name match is safe.
 */
export const EXCLUDE_DIRNAMES = new Set(['node_modules', '.git', '.vite', '.turbo', 'dist', 'build', 'coverage']);

/**
 * Repo-relative generated-output prefixes excluded from the measured scope.
 * Scoped to their ACTUAL paths so a product SOURCE folder sharing a basename is
 * NOT excluded (root round-17: a blanket `reports` name excluded five real
 * LegiWatch reports source files under apps/web/src/.../legiwatch/reports/).
 */
export const EXCLUDE_RELPREFIXES = Object.freeze([
  'apps/e2e/reports',
  'apps/e2e/baselines',
  'apps/e2e/test-results',
  'apps/e2e/playwright-report',
  // The onboarding smoke config writes Playwright diagnostics here. Keep the
  // adjacent smoke spec and config measured by excluding only this subtree.
  'apps/e2e/smoke-onboard/test-results',
  'apps/e2e/.hermes-scratch',
  'apps/e2e/.hermes-diagnostics',
  'apps/e2e/.source-archive',
]);

/** Files never included (generated / ignored by convention). */
export const EXCLUDE_FILE_RE = /(^|\/)(\.DS_Store|.*\.log|tsconfig\.visual-typecheck\.json|.*\.tmp|.*\.receipt\.json|\.dbg\.mjs)$/;

/**
 * Owned ephemeral OUTPUT directory names created by the capture/publish pipeline
 * IMMEDIATELY under apps/e2e (`scripts/capture-baselines.mjs`):
 *   .capture-staging-<pid>-<timestamp>     whole-suite capture staging root
 *   .diagnostic-staging-<pid>-<timestamp>  retained dirty/incomplete diagnostic
 *   .baselines-old-<pid>-<timestamp>       previous accepted tree during swap
 *   .baselines-failed-<pid>-<timestamp>    partial tree moved aside on rollback
 *
 * These are GENERATED OUTPUTS, not source. Their names are dynamic (pid+time) so
 * they cannot be enumerated as static prefixes above; they are recognised by
 * SHAPE. The spelling is STRICT: a literal leading dot, the exact role token,
 * then a NUMERIC pid and NUMERIC timestamp, anchored to the whole component —
 * `\d+-\d+` with no extra characters. A blanket basename/extension rule is NOT
 * used, so product source under a same-named folder elsewhere stays measured.
 */
export const OWNED_OUTPUT_DIRNAME_RE = /^\.(?:capture-staging|diagnostic-staging|baselines-old|baselines-failed)-\d+-\d+$/;

/**
 * Is `rel` (repo-relative) inside an owned generated-output dir? TRUE only when
 * the owned component sits IMMEDIATELY under `apps/e2e` (a real path-component
 * boundary) — never for a lookalike nested deeper, a non-numeric/malformed name,
 * or an identically named folder outside apps/e2e.
 */
export function isOwnedOutputRel(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  if (rel.startsWith('/') || rel.split('/').includes('..')) return false;
  const norm = rel.replace(/\/+$/, ''); // tolerate a trailing slash (untracked dir)
  if (norm.length === 0) return false;
  const segs = norm.split('/');
  if (segs.length < 3) return false; // need at least apps/e2e/<owned>
  return segs[0] === 'apps' && segs[1] === 'e2e' && OWNED_OUTPUT_DIRNAME_RE.test(segs[2]);
}

/**
 * The ONE source-scope contract: is a REPO-RELATIVE path a measured source input?
 * Used by the worktree walker, the archive-manifest builder (tracked bytes) and
 * the Git dirtiness filter, so every side applies the IDENTICAL scope — the
 * classification logic is never duplicated anywhere else.
 */
export function inMeasuredScope(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  if (rel.startsWith('/') || rel.split('/').includes('..')) return false;
  if (rel.split('/').some((seg) => EXCLUDE_DIRNAMES.has(seg))) return false;
  for (const p of EXCLUDE_RELPREFIXES) if (rel === p || rel.startsWith(`${p}/`)) return false;
  if (isOwnedOutputRel(rel)) return false;
  if (EXCLUDE_FILE_RE.test(rel)) return false;
  for (const input of MEASURED_INPUTS) if (rel === input || rel.startsWith(`${input}/`)) return true;
  return false;
}

const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The ONE canonical path ordering used by BOTH the producer (walkSource) and the
 * verifier (verifyManifest). Pure code-point comparison — locale-INDEPENDENT, so
 * an archive produced on any host/OS matches the verifier's expectation exactly.
 * (`localeCompare` is locale/ICU dependent and produced a manifest the lexical
 * verifier rejected: root round-13 probe "files[] is not path-ordered".)
 */
export const comparePaths = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function assertContained(abs, repoReal) {
  const real = realpathSync(abs);
  if (real !== repoReal && !real.startsWith(repoReal + path.sep)) {
    throw new Error(`source input escapes the repo via symlink/realpath: ${abs} -> ${real}`);
  }
}

/**
 * Walk a measured directory, keeping ONLY paths accepted by the ONE scope
 * predicate `inMeasuredScope` — no second copy of the exclusion rules lives here.
 */
function walkInto(absDir, repoRoot, repoReal, out) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`unreadable measured directory ${absDir}: ${e.message}`);
  }
  for (const e of entries.sort((a, b) => comparePaths(a.name, b.name))) {
    const abs = path.join(absDir, e.name);
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    if (!inMeasuredScope(rel)) continue;
    if (e.isSymbolicLink()) assertContained(abs, repoReal);
    let st;
    try { st = lstatSync(abs); } catch (e) { throw new Error(`unreadable ${abs}: ${e.message}`); }
    if (st.isSymbolicLink()) {
      // Followed only after containment check.
      const target = statSync(abs);
      if (target.isDirectory()) walkInto(abs, repoRoot, repoReal, out);
      else if (target.isFile()) out.push({ path: rel, sha256: sha256Buf(readFileSync(abs)), bytes: target.size });
      continue;
    }
    if (e.isDirectory()) walkInto(abs, repoRoot, repoReal, out);
    else if (e.isFile()) {
      let bytes;
      try { bytes = readFileSync(abs); } catch (e2) { throw new Error(`unreadable measured file ${rel}: ${e2.message}`); }
      out.push({ path: rel, sha256: sha256Buf(bytes), bytes: bytes.length });
    }
  }
}

/**
 * Record one measured file into the by-path map, keyed by its UNIQUE repo-
 * relative path. When the SAME path is measured more than once — which happens
 * exactly when a directory root and an explicit file root overlap (e.g. the
 * `apps/e2e` directory recursion plus the explicit `apps/e2e/lib/*.mjs` kernel
 * inputs) — the duplicate is COLLAPSED so the manifest carries each path once,
 * matching the archive's tracked-path set.
 *
 * FAIL CLOSED on a detected race: if a path is measured twice with a DIFFERENT
 * sha256/byte-size (the file changed between reads), the two records conflict;
 * we refuse to silently select one and throw so the caller aborts.
 */
function recordMeasured(byPath, rec) {
  const prev = byPath.get(rec.path);
  if (prev === undefined) { byPath.set(rec.path, rec); return; }
  if (prev.sha256 !== rec.sha256 || prev.bytes !== rec.bytes) {
    throw new Error(
      `conflicting measurements for measured source path ${rec.path}: ` +
      `sha256 ${prev.sha256} (${prev.bytes}B) vs ${rec.sha256} (${rec.bytes}B) — ` +
      `the file changed between reads; refusing to select one`,
    );
  }
}

/** Deterministic (path → sha256) manifest of the complete measured inputs. */
export function walkSource(repoRoot) {
  const repoReal = realpathSync(repoRoot);
  for (const rel of REQUIRED_INPUTS) {
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) throw new Error(`required source input is missing: ${rel}`);
    assertContained(abs, repoReal);
  }
  // A path-keyed map guarantees each UNIQUE repo-relative path is measured once,
  // even when MEASURED_INPUTS overlaps (directory root + explicit file roots).
  const byPath = new Map();
  const collector = { push: (rec) => recordMeasured(byPath, rec) };
  for (const rel of MEASURED_INPUTS) {
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) continue; // optional input absent is fine
    assertContained(abs, repoReal);
    const st = statSync(abs);
    if (st.isDirectory()) walkInto(abs, repoRoot, repoReal, collector);
    else {
      if (!inMeasuredScope(rel)) continue;
      const bytes = readFileSync(abs);
      recordMeasured(byPath, { path: rel, sha256: sha256Buf(bytes), bytes: bytes.length });
    }
  }
  const files = [...byPath.values()];
  files.sort((a, b) => comparePaths(a.path, b.path));
  return files;
}

/** A single fingerprint over an ordered manifest. */
export function fingerprintOf(files) {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f.path); h.update('\0'); h.update(f.sha256); h.update('\0'); h.update(String(f.bytes)); h.update('\n');
  }
  return h.digest('hex');
}

const SOURCE_MANIFEST_SCHEMA = 'capiro.cleanup1.visual-source-manifest.v1';
const HEX40 = /^[0-9a-f]{40}$/;

/** Write the manifest (the independently verifiable provenance). */
export function writeSourceManifest(files, destPath, extra = {}) {
  const doc = {
    schema: SOURCE_MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    measuredInputs: [...MEASURED_INPUTS],
    fingerprint: fingerprintOf(files),
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => f.bytes + n, 0),
    ...extra,
    files,
  };
  writeFileSync(destPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return doc;
}

/**
 * Validate a source-manifest document STRUCTURALLY and, when `repoRoot` is
 * given, against the current bytes. Round-13 hardening (root probe accepted a
 * null head/tree, a FORGED files[] and a producer-omitted measuredInputs set):
 *   - head/tree MUST be exact 40-hex (a Git archive always carries them);
 *   - measuredInputs MUST equal the canonical MEASURED_INPUTS exactly;
 *   - files[] MUST be a unique, path-ordered list of {path,sha256(64hex),bytes};
 *   - the manifest fingerprint MUST equal fingerprintOf(doc.files) AND the
 *     recomputed fingerprint of the current tree (no "trust the producer" path).
 */
export function verifyManifest(doc, repoRoot) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['manifest is not an object'] };
  if (doc.schema !== SOURCE_MANIFEST_SCHEMA) errors.push(`unexpected schema: ${doc.schema}`);
  if (typeof doc.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(doc.fingerprint)) errors.push('missing/invalid fingerprint');
  if (!HEX40.test(String(doc.head))) errors.push(`head must be 40-hex, got ${JSON.stringify(doc.head)}`);
  if (!HEX40.test(String(doc.treeHash))) errors.push(`treeHash must be 40-hex, got ${JSON.stringify(doc.treeHash)}`);
  // Canonical measured-input set (a producer may not narrow or widen it).
  const wantInputs = JSON.stringify([...MEASURED_INPUTS]);
  if (JSON.stringify(doc.measuredInputs) !== wantInputs) errors.push('measuredInputs does not match the canonical input set');
  if (!Array.isArray(doc.files) || doc.files.length === 0) errors.push('files[] missing/empty');
  else {
    if (!Number.isInteger(doc.fileCount) || doc.fileCount !== doc.files.length) errors.push('fileCount mismatch');
    const seen = new Set();
    let prev = '';
    let shapeOk = true;
    for (const f of doc.files) {
      if (!f || typeof f.path !== 'string' || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isInteger(f.bytes)) { shapeOk = false; break; }
      if (f.path.startsWith('/') || f.path.split('/').includes('..')) { shapeOk = false; break; }
      if (seen.has(f.path)) { errors.push(`duplicate file path: ${f.path}`); shapeOk = false; break; }
      if (comparePaths(prev, f.path) > 0) { errors.push('files[] is not path-ordered'); shapeOk = false; break; }
      seen.add(f.path); prev = f.path;
    }
    if (!shapeOk && !errors.length) errors.push('files[] entry shape invalid');
    // Self-consistency: the declared fingerprint must be derivable from files[].
    if (!errors.length) {
      const recomputed = fingerprintOf(doc.files);
      if (recomputed !== doc.fingerprint) errors.push('fingerprint is not the digest of the declared files[]');
    }
  }
  if (errors.length) return { ok: false, errors };
  if (repoRoot) {
    const actual = walkSource(repoRoot);
    const fp = fingerprintOf(actual);
    if (fp !== doc.fingerprint) {
      const byPath = new Map(actual.map((f) => [f.path, f]));
      const missing = []; const changed = [];
      for (const f of doc.files) {
        const a = byPath.get(f.path);
        if (!a) missing.push(f.path);
        else if (a.sha256 !== f.sha256 || a.bytes !== f.bytes) changed.push(f.path);
        byPath.delete(f.path);
      }
      return { ok: false, errors: ['fingerprint mismatch vs current tree'], actualFingerprint: fp, missing, changed, added: [...byPath.keys()] };
    }
    return { ok: true, fingerprint: fp };
  }
  return { ok: true };
}

/** Re-walk the tree and compare byte-for-byte against a manifest file. */
export function verifyAgainst(manifestPath, repoRoot) {
  const doc = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return verifyManifest(doc, repoRoot);
}

/**
 * Skip `n` space-delimited leading fields of a porcelain v2 record and return
 * the remainder (the path). The fixed fields preceding the path never contain a
 * space, so the path — which may contain spaces, Unicode, quotes and NEWLINES —
 * is taken VERBATIM. Returns null when the record has fewer than `n` fields
 * (malformed).
 */
function porcelainAfterFields(rec, n) {
  let idx = 0;
  for (let k = 0; k < n; k++) {
    const sp = rec.indexOf(' ', idx);
    if (sp === -1) return null;
    idx = sp + 1;
  }
  return rec.slice(idx);
}

/**
 * Parse `git status --porcelain=v2 -z` (NUL-delimited) into entries
 * `{ xy, paths }` where `paths` is `[path]` for ordinary/untracked records and
 * `[oldPath, newPath]` for a rename/copy (v2 `-z` carries the NEW path inside
 * the record and the OLD path as the immediately following NUL field). Paths
 * are never quoted in `-z` mode, so the exact bytes survive.
 *
 * FAIL CLOSED: any record that is not a known v2 shape (unknown type, missing
 * fields, non-status columns, empty/absolute path) throws — the caller must
 * REFUSE rather than ever conclude the source is clean.
 */
function parsePorcelainV2Z(raw) {
  if (typeof raw !== 'string') throw new Error('porcelain v2 output must be a string');
  if (raw.length === 0) return [];
  if (!raw.endsWith('\0')) throw new Error('truncated porcelain v2 output: missing final NUL');
  const records = raw.split('\0'); // each record is NUL-terminated → trailing ''
  const entries = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec === '') {
      if (i !== records.length - 1) throw new Error('empty record in porcelain v2 output');
      continue;
    }
    const type = rec[0];
    if (rec[1] !== ' ') throw new Error(`malformed porcelain v2 record (no separator): ${JSON.stringify(rec)}`);
    let xy;
    let paths;
    if (type === '1' || type === '2' || type === 'u') {
      const fields = type === '1' ? 8 : type === '2' ? 9 : 10; // fields before the path
      const rest = porcelainAfterFields(rec, fields);
      if (rest === null) throw new Error(`malformed porcelain v2 record (missing fields): ${JSON.stringify(rec)}`);
      xy = rec.slice(2, 4);
      if (!/^[.MADRCUT]{2}$/.test(xy)) throw new Error(`malformed porcelain v2 status columns: ${JSON.stringify(rec)}`);
      const header = rec.split(' ').slice(0, fields);
      const modeEnd = type === 'u' ? 7 : 6;
      if (!/^(?:N\.\.\.|S[.C][.M][.U])$/.test(header[2]) ||
          !header.slice(3, modeEnd).every((m) => /^[0-7]{6}$/.test(m)) ||
          !header.slice(modeEnd, type === '2' ? 8 : fields).every((h) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(h)) ||
          (type === '2' && !/^[RC](?:100|[1-9]?\d)$/.test(header[8]))) {
        throw new Error(`malformed porcelain v2 metadata: ${JSON.stringify(rec)}`);
      }
      if (type === '2') {
        const newPath = rest;
        const oldPath = records[++i];
        if (typeof oldPath !== 'string' || oldPath === '') throw new Error('malformed porcelain v2 rename record: missing original path');
        paths = [oldPath, newPath];
      } else {
        paths = [rest];
      }
    } else if (type === '?' || type === '!') {
      const rest = porcelainAfterFields(rec, 1);
      if (rest === null) throw new Error(`malformed porcelain v2 record: ${JSON.stringify(rec)}`);
      xy = type === '?' ? '??' : '!!';
      paths = [rest];
    } else {
      throw new Error(`unknown porcelain v2 record type ${JSON.stringify(type)}: ${JSON.stringify(rec)}`);
    }
    for (const p of paths) {
      if (p.length === 0) throw new Error(`empty path in porcelain v2 record: ${JSON.stringify(rec)}`);
      if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) {
        throw new Error(`non-relative path in porcelain v2 record: ${JSON.stringify(p)}`);
      }
    }
    entries.push({ xy, paths });
  }
  return entries;
}

/** Render a parsed v2 entry to a stable, scope-routed dirty line. */
function formatDirtyEntry(entry) {
  return entry.paths.length === 2
    ? `${entry.xy} ${entry.paths[0]} -> ${entry.paths[1]}`
    : `${entry.xy} ${entry.paths[0]}`;
}

/**
 * Git dirty-status over the measured inputs. Queries `git status
 * --porcelain=v2 -z --untracked-files=all` — fully NUL-delimited, so paths with
 * spaces/Unicode/quotes/internal newlines and BOTH sides of a rename/copy are
 * preserved (unlike the v1 `slice(3)` parser, which broke on the trimming every
 * real caller performs). Every entry is filtered through the SAME
 * `inMeasuredScope` predicate the byte walker uses, so generated
 * captures/results/staging (including the owned `.capture-staging-*` dirs) are
 * NEVER reported as source dirt — the dirty set matches the measured set exactly.
 *
 * Missing Git → `null` (unknown, NOT clean). A malformed/unknown record →
 * thrown (fail-closed), so a broken query can never be read as "clean".
 */
export function gitMeasuredDirty(repoRoot, gitFn) {
  const out = gitFn(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', ...MEASURED_INPUTS]);
  if (out === null) return null; // Git missing → unknown, NOT clean
  const dirty = [];
  for (const entry of parsePorcelainV2Z(out)) {
    if (entry.paths.some((p) => inMeasuredScope(p))) dirty.push(formatDirtyEntry(entry));
  }
  return dirty;
}

/**
 * Full source identity: measured fingerprint + Git provenance. Git absence is
 * reported explicitly; unknown dirtiness is `null` (never coerced to clean).
 */
export function sourceIdentity(repoRoot, gitFn) {
  const files = walkSource(repoRoot);
  const fingerprint = fingerprintOf(files);
  const gitHead = gitFn(['rev-parse', 'HEAD']);
  const gitTree = gitFn(['rev-parse', 'HEAD^{tree}']);
  const dirty = gitMeasuredDirty(repoRoot, gitFn);
  const gitPresent = gitHead !== null && gitTree !== null;
  return {
    gitPresent,
    head: gitHead,
    treeHash: gitTree,
    measuredDirty: dirty,
    dirtiesKnown: dirty !== null,
    sourceFingerprint: fingerprint,
    sourceFileCount: files.length,
  };
}

export function sameIdentity(a, b) {
  return (
    a.sourceFingerprint === b.sourceFingerprint &&
    a.head === b.head &&
    a.treeHash === b.treeHash &&
    JSON.stringify(a.measuredDirty) === JSON.stringify(b.measuredDirty)
  );
}
