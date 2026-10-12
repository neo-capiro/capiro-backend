#!/usr/bin/env node
/**
 * Atomic, verified baseline publication (CleanUp1 §8.5) — round-11.
 *
 * Contract (root round-11 preflight):
 *   1. Only a CLEAN, fully-identified source may publish. A forced/manual dirty
 *      capture is a retained DIAGNOSTIC stage that NEVER swaps into the accepted
 *      tree. Missing Git provenance is rejected unless an independently
 *      verifiable source manifest (written by an owned runner) matches the
 *      measured byte fingerprint.
 *   2. The measured source inputs are COMPLETE (all web/shared/strategy source +
 *      root config/lock), fingerprinted as real bytes — validated before AND
 *      after capture. Any source mutation during capture fails the publish.
 *   3. The manifest is WRITTEN AND VERIFIED INSIDE staging BEFORE any rename.
 *      Publication is two renames with VERIFIED rollback (restored hashes
 *      checked; a failed restoration is reported, never assumed).
 *   4. Unknown renderer/font/image metadata is DIAGNOSTIC: an accepted publish
 *      requires the actual verified runtime identity bound to the captures.
 *   5. Retain artifacts by default. Bounded pruning is opt-in and only removes
 *      exact recorded owned snapshots after realpath containment + owner receipt.
 *
 *   node scripts/capture-baselines.mjs --capture [--diagnostic-dirty] [--prune-old N] [--keep-staging]
 * @cleanup-smoke noArgsExit=2 helpExit=0
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, renameSync,
  readdirSync, statSync, realpathSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..', '..');
const BASELINES = path.join(ROOT, 'baselines');

// ── flags: unknown/invalid fail with usage, never silent behaviour ──────────
const USAGE = 'Usage: capture-baselines.mjs --capture [--diagnostic-dirty] [--prune-old N] [--keep-staging] (existing diagnostic/prune/keep flags also explicitly start capture)';
function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  if (argv.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }
  const out = { diagnosticDirty: false, keepStaging: false, pruneOld: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--capture') continue;
    if (a === '--diagnostic-dirty') out.diagnosticDirty = true;
    else if (a === '--keep-staging') out.keepStaging = true;
    else if (a === '--prune-old') {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) { console.error(`[capture] invalid --prune-old value: ${v}\n${USAGE}`); process.exit(2); }
      out.pruneOld = n;
    } else { console.error(`[capture] unknown flag: ${a}\n${USAGE}`); process.exit(2); }
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

const { COMPARISON, PROJECTS } = await import('../lib/projects.mjs');
const { deriveCaptureObligations } = await import('../lib/capture-obligations.mjs');
const { captureRuntimeIdentity } = await import('../lib/runtime-identity.mjs');
const { rendererContractProblems } = await import('../lib/renderer-contract.mjs');
const { sourceIdentity, walkSource, fingerprintOf, writeSourceManifest, sameIdentity, verifyManifest } = await import('../lib/source-identity.mjs');

const STAMP = `${process.pid}-${Date.now()}`;
const STAGING = path.join(ROOT, `.capture-staging-${STAMP}`);
// Fresh, run-owned file the specs append their ACTUAL page-context observations
// to (route + conditional captures AND the separate onboarding smoke). A unique
// path per run means a stale observation set from a previous run can never be
// reused.
const RENDER_OBSERVATIONS = path.join(ROOT, 'reports', `render-observations-${STAMP}.json`);
const ONBOARD_CONFIG = 'smoke-onboard/playwright.onboard.config.ts';

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  if (r.error) return null;
  if (typeof r.status !== 'number') return null; // signal / spawn error → unknown
  return r.status === 0 ? r.stdout.trim() : null;
}
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function listPngs(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.png')) out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

// ── 1. source identity (complete measured inputs) ───────────────────────────
const before = sourceIdentity(REPO, git);
// Verified immutable identity. With Git: HEAD/tree + measured dirtiness. Without
// Git: a STRUCTURALLY VERIFIED archived-source manifest (schema/head/tree/files)
// whose fingerprint matches the current bytes supplies head/tree — never null.
let verified = { head: before.head, treeHash: before.treeHash, provenance: 'git', ok: before.gitPresent };
if (!before.gitPresent) {
  const prov = process.env.CAPIRO_SOURCE_PROVENANCE;
  if (!prov || !existsSync(prov)) {
    console.error('[capture] REFUSING: no Git provenance and no CAPIRO_SOURCE_PROVENANCE manifest.');
    process.exit(3);
  }
  let doc;
  try { doc = JSON.parse(readFileSync(prov, 'utf8')); } catch (e) { console.error(`[capture] REFUSING: provenance unreadable: ${e.message}`); process.exit(3); }
  const v = verifyManifest(doc, REPO);
  if (!v.ok) {
    console.error('[capture] REFUSING: archived-source provenance is invalid/forged/changed:');
    for (const e of v.errors) console.error(`  ${e}`);
    process.exit(3);
  }
  if (doc.head == null || doc.treeHash == null) {
    console.error('[capture] REFUSING: provenance manifest lacks an immutable head/tree.');
    process.exit(3);
  }
  verified = { head: String(doc.head), treeHash: String(doc.treeHash), provenance: 'CAPIRO_SOURCE_PROVENANCE', ok: true };
  console.error(`[capture] provenance: verified archived-source manifest head=${verified.head} fingerprint=${doc.fingerprint.slice(0, 16)}`);
} else if (before.measuredDirty === null) {
  console.error('[capture] REFUSING: Git is present but the measured dirty-status query failed (unknown dirtiness).');
  process.exit(3);
}
const dirties = before.measuredDirty ?? [];
if (!verified.ok) { console.error('[capture] REFUSING: no verified source identity.'); process.exit(3); }
if (dirties.length && !ARGS.diagnosticDirty) {
  console.error(`[capture] REFUSING: ${dirties.length} measured source input(s) are dirty:`);
  for (const l of dirties.slice(0, 40)) console.error(`  ${l}`);
  console.error('[capture] commit the full rendered source, then capture. (--diagnostic-dirty is a NON-publishing diagnostic.)');
  process.exit(3);
}

// ── 2. whole-suite capture into a unique staging root ───────────────────────
mkdirSync(STAGING, { recursive: true });
console.log('[capture] whole-suite capture into staging:', path.relative(REPO, STAGING));
const res = spawnSync(
  process.execPath,
  [path.join(HERE, 'run-playwright.mjs'), 'test', '--update-snapshots'],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CAPIRO_BASELINE_ROOT: STAGING, CAPIRO_RENDER_OBSERVATIONS: RENDER_OBSERVATIONS, CAPIRO_RENDER_PHASE: 'capture' },
  },
);
const exitCode = typeof res.status === 'number' ? res.status : null;
if (exitCode === null) {
  console.error(`[capture] suite terminated by signal ${res.signal ?? '?'} — no publish. staging kept at ${path.relative(REPO, STAGING)}`);
  process.exit(1);
}
if (exitCode !== 0) {
  console.error(`\n[capture] suite NOT green (exit ${exitCode}) — baselines/ untouched. staging kept at ${path.relative(REPO, STAGING)}`);
  process.exit(exitCode);
}

// The SEPARATE onboarding smoke (own config, own server) is REQUIRED so the
// onboarding page context is observed on the SAME run before the manifest is
// built. It captures no PNGs — it exists to prove the onboarding page context.
const onboardRes = spawnSync(
  process.execPath,
  [path.join(HERE, 'run-playwright.mjs'), 'test', '--config', ONBOARD_CONFIG],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CAPIRO_BASELINE_ROOT: STAGING, CAPIRO_RENDER_OBSERVATIONS: RENDER_OBSERVATIONS, CAPIRO_RENDER_PHASE: 'onboard-smoke' },
  },
);
const onboardExit = typeof onboardRes.status === 'number' ? onboardRes.status : null;
if (onboardExit !== 0) {
  console.error(`\n[capture] onboarding smoke NOT green (exit ${onboardExit ?? 'signal'}) — no publish. staging kept at ${path.relative(REPO, STAGING)}`);
  process.exit(onboardExit === null ? 1 : onboardExit);
}

// Source must be byte-identical across the capture itself.
const after = sourceIdentity(REPO, git);
if (!sameIdentity(before, after)) {
  console.error('[capture] REFUSING: measured source CHANGED during capture — no publish.');
  console.error(`  before fingerprint=${before.sourceFingerprint}`);
  console.error(`  after  fingerprint=${after.sourceFingerprint}`);
  process.exit(1);
}

// ── 3. build + verify the manifest INSIDE staging ───────────────────────────
const inventory = JSON.parse(readFileSync(path.join(ROOT, 'routes.inventory.json'), 'utf8'));
const sentinels = JSON.parse(readFileSync(path.join(ROOT, 'route-sentinels.json'), 'utf8'));
// §8.3/§8.4: the SAME derived obligation contract the guard enforces. A captured
// route observed to redirect still requires its OWN requested-route PNG (with the
// exact destination + content-sentinel provenance recorded) — a navigation-only
// redirect proof is NOT a baseline. Declared redirects get the explicit
// `redirect_` namespace; both conditional captures are required too.
const obligations = deriveCaptureObligations({ inventory, sentinels });
if (!obligations.ok) {
  console.error(`[capture] capture-obligation contract is invalid (${obligations.problems.length} problem(s)) — no publish:`);
  for (const p of obligations.problems) console.error(`  ${p}`);
  process.exit(1);
}
const projectNames = PROJECTS.map((p) => p.name);
const projectSet = new Set(projectNames);
// Filename → owning obligation, for strict orphan detection of staged PNGs.
const byFilename = new Map();
for (const o of obligations.routes) byFilename.set(o.filename, { kind: o.kind });
for (const o of obligations.redirects) byFilename.set(o.filename, { kind: 'redirect' });
for (const o of obligations.conditional) byFilename.set(o.filename, { kind: 'conditional' });

const stagedPngs = listPngs(STAGING);
if (!stagedPngs.length) { console.error('[capture] no staged PNGs produced — aborting.'); process.exit(1); }

const captures = [];
const missing = [];
const digestOf = (rel) => ({
  sha256: sha256File(path.join(STAGING, rel)),
  bytes: statSync(path.join(STAGING, rel)).size,
});
for (const project of projectNames) {
  const vp = PROJECTS.find((p) => p.name === project).viewport;
  for (const o of obligations.routes) {
    const rel = `${project}/${o.filename}`;
    if (!existsSync(path.join(STAGING, rel))) { missing.push(rel); continue; }
    const entry = { project, route: o.path, kind: o.kind, file: `baselines/${rel}`, ...digestOf(rel), viewport: vp, purpose: 'regression-not-parity' };
    // Redirected captures record the exact requested→destination relationship
    // and the content-sentinel provenance that gated the image.
    if (o.kind === 'redirect') { entry.redirectTo = o.redirectTo; entry.sentinelKey = o.sentinelKey; }
    captures.push(entry);
  }
  for (const o of obligations.redirects) {
    const rel = `${project}/${o.filename}`;
    if (!existsSync(path.join(STAGING, rel))) { missing.push(rel); continue; }
    captures.push({ project, route: o.path, kind: 'redirect', redirectTo: o.redirectTo, sentinelKey: o.sentinelKey, file: `baselines/${rel}`, ...digestOf(rel), viewport: vp, purpose: 'regression-not-parity' });
  }
  for (const o of obligations.conditional) {
    const rel = `${project}/${o.filename}`;
    if (!existsSync(path.join(STAGING, rel))) { missing.push(rel); continue; }
    captures.push({ project, route: null, obligation: o.name, kind: 'conditional', file: `baselines/${rel}`, ...digestOf(rel), viewport: vp, purpose: 'regression-not-parity' });
  }
}
if (missing.length) {
  console.error(`[capture] ${missing.length} obligation PNG(s) missing — aborting publish. staging kept at ${path.relative(REPO, STAGING)}`);
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}
for (const rel of stagedPngs) {
  const [project, ...rest] = rel.split('/');
  const filename = rest.join('/');
  if (rest.length !== 1 || !projectSet.has(project)) { console.error(`[capture] orphan project dir: ${rel}`); process.exit(1); }
  if (!byFilename.has(filename)) { console.error(`[capture] orphan staged PNG: ${rel}`); process.exit(1); }
}

// Runtime identity — obtained with the same runtime/launch policy as the suite,
// bound to the ACTUAL page contexts the specs observed on THIS run.
console.log('[capture] reading ACTUAL runtime identity + observed page contexts...');
const runtime = await captureRuntimeIdentity({ observationsPath: RENDER_OBSERVATIONS });
// §6: require the ACTUAL verified runtime bound to the captures — executable
// SHA, every font hash, image ref+digest, browser version + node — AND the
// COMPLETE observed render context (route projects + separate onboarding).
// Unknown metadata is diagnostic-only, never accepted.
const fontsComplete =
  runtime.fonts && runtime.fonts.count > 0 && Array.isArray(runtime.fonts.files) &&
  runtime.fonts.files.length === runtime.fonts.count && runtime.fonts.files.every((f) => typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256)) &&
  typeof runtime.fonts.listSha256 === 'string';
const rendererComplete = rendererContractProblems(runtime, { label: 'capture renderer' }).length === 0;
const runtimeKnown = Boolean(
  runtime &&
  typeof runtime.browserVersion === 'string' && runtime.browserVersion &&
  runtime.launchedBrowser && typeof runtime.launchedBrowser.sha256 === 'string' && /^[0-9a-f]{64}$/.test(runtime.launchedBrowser.sha256) &&
  typeof runtime.launchedBrowser.path === 'string' && runtime.launchedBrowser.path &&
  runtime.image && typeof runtime.image.ref === 'string' && typeof runtime.image.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(runtime.image.digest) &&
  typeof runtime.node === 'string' &&
  runtime.fonts && fontsComplete &&
  rendererComplete,
);
if (!runtimeKnown) {
  console.warn('[capture] runtime identity is INCOMPLETE (diagnostic-only):', JSON.stringify({
    browserVersion: runtime?.browserVersion, launchedSha: runtime?.launchedBrowser?.sha256,
    fonts: runtime?.fonts?.count, fontFiles: runtime?.fonts?.files?.length, image: runtime?.image?.digest,
    pageContextProblems: rendererContractProblems(runtime, { label: 'capture renderer' }),
  }));
}

const clean = dirties.length === 0 && ARGS.diagnosticDirty === false;
const manifest = {
  schema: 'capiro.cleanup1.visual-baseline.v4',
  purpose: 'regression-not-parity',
  note:
    'Committed regression baselines. Assert "renders the same as before", NOT Figma parity. ' +
    'Published ATOMICALLY (verified rename swap) from a fully-green whole-suite run over a byte-identified clean source.',
  source: {
    gitPresent: before.gitPresent,
    provenance: verified.provenance,
    committedHeadSha: verified.head,
    treeHash: verified.treeHash,
    measuredDirty: dirties,
    worktreeCleanAtCapture: clean,
    capturingSha: clean ? verified.head : null,
    sourceFingerprint: before.sourceFingerprint,
    sourceFileCount: before.sourceFileCount,
    note: clean
      ? 'complete measured source clean at capture; sourceFingerprint binds the rendered bytes'
      : 'DIAGNOSTIC capture over dirty/forced source — NOT an accepted baseline',
  },
  comparison: { maxDiffPixelRatio: COMPARISON.maxDiffPixelRatio, threshold: COMPARISON.threshold },
  runtime,
  runtimeKnown,
  counts: { captures: captures.length, projects: PROJECTS.length, routes: obligations.routes.length, redirects: obligations.redirects.length, conditional: captures.filter((c) => c.kind === 'conditional').length },
  captures,
};

// Write manifest + source provenance INSIDE staging and VERIFY before publishing.
writeFileSync(path.join(STAGING, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
writeSourceManifest(walkSource(REPO), path.join(STAGING, 'source-manifest.json'), { sourceFingerprint: before.sourceFingerprint, head: before.head, treeHash: before.treeHash });

function verifyStaged() {
  for (const c of manifest.captures) {
    const rel = c.file.replace(/^baselines\//, '');
    const p = path.join(STAGING, rel);
    if (!existsSync(p)) return `missing in staging: ${c.file}`;
    if (sha256File(p) !== c.sha256) return `staging sha mismatch: ${c.file}`;
  }
  const mf = path.join(STAGING, 'manifest.json');
  if (!existsSync(mf)) return 'manifest.json missing in staging';
  return null;
}
const stagedProblem = verifyStaged();
if (stagedProblem) {
  console.error(`[capture] staging manifest verification FAILED: ${stagedProblem}`);
  console.error(`          staging kept at ${path.relative(REPO, STAGING)} (no publish).`);
  process.exit(1);
}

// ── 5a. DIAGNOSTIC (dirty/forced): retain staging, NEVER publish ────────────
if (!clean || !runtimeKnown) {
  const diag = path.join(ROOT, `.diagnostic-staging-${STAMP}`);
  renameSync(STAGING, diag);
  console.error(`[capture] DIAGNOSTIC stage retained at ${path.relative(REPO, diag)} — accepted baselines/ NOT replaced`);
  console.error(`          reason: ${!clean ? 'source dirty/forced' : 'runtime metadata incomplete'}`);
  process.exit(4);
}

// ── 5b. ACCEPTED publish: two renames + verified rollback ───────────────────
const oldRoot = path.join(ROOT, `.baselines-old-${STAMP}`);
const receipt = path.join(ROOT, `.baselines-old-${STAMP}.receipt.json`);
let movedOld = false;
const rollback = (why) => {
  console.error(`[capture] publish FAILED (${why}) — rolling back.`);
  const failed = path.join(ROOT, `.baselines-failed-${STAMP}`);
  try { if (existsSync(BASELINES)) renameSync(BASELINES, failed); } catch (e) { console.error(`  ! could not move partial new tree aside: ${e.message}`); }
  if (movedOld) {
    try {
      renameSync(oldRoot, BASELINES);
      // VERIFY restoration, do not assume it.
      let restoredOk = true;
      try {
        const oldManifest = JSON.parse(readFileSync(path.join(BASELINES, 'manifest.json'), 'utf8'));
        for (const c of oldManifest.captures ?? []) {
          const p = path.join(ROOT, c.file);
          if (!existsSync(p) || sha256File(p) !== c.sha256) { restoredOk = false; break; }
        }
      } catch { restoredOk = false; }
      console.error(restoredOk ? '  previous baselines RESTORED and hash-verified.' : '  ! ROLLBACK RESTORATION UNVERIFIED — manual attention needed.');
      if (!restoredOk) process.exit(1);
    } catch (e) {
      console.error(`  ! ROLLBACK RESTORE FAILED: ${e.message} — previous tree remains at ${path.relative(REPO, oldRoot)}`);
      process.exit(1);
    }
  }
  process.exit(1);
};

try {
  if (existsSync(BASELINES)) { renameSync(BASELINES, oldRoot); movedOld = true; }
  renameSync(STAGING, BASELINES);
} catch (e) {
  rollback(`rename: ${e.message}`);
}
if (movedOld) writeFileSync(receipt, `${JSON.stringify({ ownedSnapshot: path.basename(oldRoot), createdBy: 'capture-baselines.mjs', stamp: STAMP, retainedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');

// Post-publish verification of the LIVE tree.
let liveProblem = null;
for (const c of manifest.captures) {
  const p = path.join(ROOT, c.file);
  if (!existsSync(p)) { liveProblem = `missing live: ${c.file}`; break; }
  if (sha256File(p) !== c.sha256) { liveProblem = `live sha mismatch: ${c.file}`; break; }
}
const afterPublish = sourceIdentity(REPO, git);
if (!sameIdentity(before, afterPublish)) liveProblem = liveProblem ?? 'source changed during publish';
if (liveProblem) rollback(liveProblem);

if (movedOld) console.log(`[capture] previous baselines retained at ${path.relative(REPO, oldRoot)} (receipt ${path.basename(receipt)})`);
if (ARGS.pruneOld !== null) pruneOwnedSnapshots(ARGS.pruneOld);
// §7: retain by default — a failed/diagnostic tree is NEVER recursively deleted
// here. Its exact path is reported so it can be pruned explicitly.
for (const d of readdirSync(ROOT).filter((n) => n.startsWith('.baselines-failed-'))) {
  console.log(`[capture] retained failed tree: ${path.relative(REPO, path.join(ROOT, d))} (not deleted)`);
}

console.log(`[capture] published ${captures.length} baselines + v4 manifest to ${path.relative(REPO, BASELINES)}`);
console.log(`[capture] source fingerprint=${before.sourceFingerprint.slice(0, 16)} head=${before.head}`);
console.log(`[capture] renderer browser=${runtime.browserVersion} launched=${runtime.launchedBrowser.path} fonts=${runtime.fonts.count}`);

/**
 * Opt-in bounded prune. Only removes EXACT recorded owned snapshots
 * (`<name>.receipt.json` present, name matches, realpath inside ROOT) beyond the
 * newest `keep`. No prefix wildcarding; unowned directories are never touched.
 */
function pruneOwnedSnapshots(keep) {
  let entries;
  try { entries = readdirSync(ROOT, { withFileTypes: true }); } catch { return; }
  const owned = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = /^\.baselines-old-(\d+)-(\d+)$/.exec(e.name);
    if (!m) continue;
    const dir = path.join(ROOT, e.name);
    const rec = path.join(ROOT, `${e.name}.receipt.json`);
    if (!existsSync(rec)) continue; // unowned → never delete
    const real = realpathSync(dir);
    if (!real.startsWith(realpathSync(ROOT) + path.sep)) continue; // containment
    owned.push({ name: e.name, dir, rec, mtime: statSync(dir).mtimeMs });
  }
  owned.sort((a, b) => b.mtime - a.mtime);
  for (const o of owned.slice(Math.max(0, keep))) {
    try { rmSync(o.dir, { recursive: true, force: true }); rmSync(o.rec, { force: true }); } catch { /* bounded owned cleanup only */ }
  }
}
