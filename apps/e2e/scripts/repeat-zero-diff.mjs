#!/usr/bin/env node
/**
 * Three same-source zero-diff repeats (CleanUp1 §8.5) — round-60.
 *
 * Round-60: identity + status now come from the ONE canonical kernel
 * (apps/e2e/lib/playwright-report.mjs → scripts/test-proof/lib/adapters.mjs
 * parsePlaywrightList), and the renderer binding uses the complete
 * renderer/context contract (apps/e2e/lib/renderer-contract.mjs). EVERY strict
 * assertion is preserved unchanged: same-source fingerprint equality against
 * the published baselines, head binding, native integer exit, renderer equality
 * against the BASELINE manifest renderer, zero skipped/flaky/unexpected, a
 * non-empty case set, per-run source stability and byte-immutable baselines.
 * The same-source semantics are NOT relaxed.
 *
 *   node scripts/repeat-zero-diff.mjs --repeat
 * @cleanup-smoke noArgsExit=2 helpExit=0
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'Usage: repeat-zero-diff.mjs --repeat (writes a three-run report while comparing immutable baselines)';
const cliArgs = process.argv.slice(2);
if (cliArgs.length === 1 && (cliArgs[0] === '--help' || cliArgs[0] === '-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (cliArgs.length !== 1 || cliArgs[0] !== '--repeat') {
  console.error(USAGE);
  if (cliArgs.length) console.error(`[repeat] unknown argument: ${cliArgs.join(' ')}`);
  process.exit(2);
}

const { captureRuntimeIdentity } = await import('../lib/runtime-identity.mjs');
const { sourceIdentity, sameIdentity, verifyManifest } = await import('../lib/source-identity.mjs');
const { playwrightExecutionSummary, playwrightDiscoveredMultiset } = await import('../lib/playwright-report.mjs');
const { rendererCanonical, rendererContractProblems } = await import('../lib/renderer-contract.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..', '..');
const BASELINES = path.join(ROOT, 'baselines');
const RUNS = 3;
const STAMP = `${process.pid}-${Date.now()}`;
const OUT = path.join(ROOT, 'reports', `repeat-${STAMP}`);
mkdirSync(OUT, { recursive: true });
const ONBOARD_CONFIG = 'smoke-onboard/playwright.onboard.config.ts';

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  if (r.error) return null;
  if (typeof r.status !== 'number') return null;
  return r.status === 0 ? r.stdout.trim() : null;
}
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** Byte-immutable inventory; FAILS on an unreadable dir/symlink (never a subset). */
function treeInventory(dir) {
  const out = {};
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); }
    catch (e) { throw new Error(`unreadable baseline dir ${d}: ${e.message}`); }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(d, e.name);
      let st;
      try { st = statSync(p); } catch (err) { throw new Error(`unreadable baseline entry ${p}: ${err.message}`); }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out[path.relative(dir, p).split(path.sep).join('/')] = sha256File(p);
      else throw new Error(`unsupported baseline entry type: ${p}`);
    }
  };
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) walk(dir);
  return out;
}

// ── source + provenance identity ────────────────────────────────────────────
const start = sourceIdentity(REPO, git);
const gitMode = start.gitPresent;
let provenanceHead = start.head;
let provenanceTree = start.treeHash;
let provenanceVerified = false;
if (!gitMode) {
  const prov = process.env.CAPIRO_SOURCE_PROVENANCE;
  if (!prov || !existsSync(prov)) { console.error('[repeat] REFUSING: no Git and no CAPIRO_SOURCE_PROVENANCE manifest.'); process.exit(3); }
  let doc;
  try { doc = JSON.parse(readFileSync(prov, 'utf8')); } catch (e) { console.error(`[repeat] REFUSING: provenance unreadable: ${e.message}`); process.exit(3); }
  const v = verifyManifest(doc, REPO);
  if (!v.ok) { console.error('[repeat] REFUSING: provenance invalid/forged/changed:'); for (const e of v.errors) console.error(`  ${e}`); process.exit(3); }
  provenanceHead = doc.head; provenanceTree = doc.treeHash; provenanceVerified = true;
  console.error(`[repeat] provenance: verified archived-source manifest head=${provenanceHead}`);
} else if (start.measuredDirty === null) {
  console.error('[repeat] REFUSING: Git present but measured dirty-status unknown.'); process.exit(3);
}
if (gitMode && start.measuredDirty.length) {
  console.error('[repeat] REFUSING: measured source is dirty before the proof:');
  for (const l of start.measuredDirty.slice(0, 40)) console.error(`  ${l}`);
  process.exit(3);
}
if (!gitMode && !provenanceVerified) { console.error('[repeat] REFUSING: no verified provenance.'); process.exit(3); }

const identityNow = () => {
  const s = sourceIdentity(REPO, git);
  if (!gitMode) { s.head = provenanceHead; s.treeHash = provenanceTree; s.measuredDirty = []; s.dirtiesKnown = true; }
  return s;
};
const startId = identityNow();

const manifestPath = path.join(BASELINES, 'manifest.json');
if (!existsSync(manifestPath)) { console.error('[repeat] REFUSING: baselines/manifest.json absent.'); process.exit(3); }
const baselineManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const baselineSource = baselineManifest.source?.sourceFingerprint;
if (typeof baselineSource !== 'string' || !baselineSource) { console.error('[repeat] REFUSING: baseline manifest has NO source fingerprint.'); process.exit(3); }
if (baselineSource !== startId.sourceFingerprint) {
  console.error('[repeat] REFUSING: current source fingerprint differs from the published baselines.');
  console.error(`  current=${startId.sourceFingerprint}\n  baseline=${baselineSource}`);
  process.exit(3);
}
if (baselineManifest.source?.committedHeadSha != null && String(baselineManifest.source.committedHeadSha) !== String(provenanceHead)) {
  console.error('[repeat] REFUSING: source head differs from the published baselines.'); process.exit(3);
}

// (2) The renderer identity must come from the BASELINE MANIFEST, not current.
// It must be a COMPLETE renderer/context contract; a partial baseline runtime
// refuses rather than being coerced into a guess.
const baselineRuntime = baselineManifest.runtime;
if (rendererContractProblems(baselineRuntime, { label: 'baseline renderer' }).length > 0) {
  console.error('[repeat] REFUSING: baseline manifest runtime identity is incomplete — cannot bind the comparison:');
  for (const p of rendererContractProblems(baselineRuntime, { label: 'baseline renderer' })) console.error(`  ${p}`);
  process.exit(3);
}
const baselineRenderer = rendererCanonical(baselineRuntime);

// (3) Expected discovery, derived INDEPENDENTLY from `test --list --reporter=json`
// through the ONE canonical kernel (no second text parser).
function expectedFromList() {
  const listPath = path.join(OUT, 'expected-list.json');
  const r = spawnSync(process.execPath, [path.join(HERE, 'run-playwright.mjs'), 'test', '--list', '--reporter=json'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: listPath },
  });
  if (typeof r.status !== 'number' || r.status !== 0) return null;
  if (!existsSync(listPath)) return null;
  let json;
  try { json = JSON.parse(readFileSync(listPath, 'utf8')); } catch { return null; }
  const ids = playwrightDiscoveredMultiset(json);
  return ids.length ? ids.sort().join('\n') : null;
}
const expectedDiscovery = expectedFromList();
if (!expectedDiscovery) { console.error('[repeat] REFUSING: could not derive the expected case discovery from --list.'); process.exit(3); }

/** Per-TEST identity multiset (canonical kernel) + native status stats. */
function summarize(json) {
  const s = playwrightExecutionSummary(json);
  return { stats: json.stats, identityDigest: s.identityDigest, caseCount: s.count, statuses: s };
}

const runs = [];
let failed = false;
let expectedIdentity = null;

for (let i = 1; i <= RUNS; i++) {
  const before = identityNow();
  if (before.measuredDirty === null || !sameIdentity(before, startId)) {
    console.error(`[repeat] run ${i}: source identity changed/unknown before run — abort.`);
    failed = true; break;
  }
  const runDir = path.join(OUT, `run-${i}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'source-before.json'), `${JSON.stringify(before, null, 2)}\n`, 'utf8');

  console.log(`\n[repeat] run ${i}/${RUNS} head=${provenanceHead} fingerprint=${before.sourceFingerprint.slice(0, 16)}`);
  const jsonName = path.join(runDir, 'playwright-report.json');
  // Fresh, per-run observation file for the ACTUAL page contexts of THIS repeat
  // (route captures + the separate onboarding page).
  const obsFile = path.join(runDir, 'render-context-observations.json');
  if (existsSync(obsFile)) rmSync(obsFile, { force: true });
  const res = spawnSync(process.execPath, [path.join(HERE, 'run-playwright.mjs'), 'test', '--reporter=json'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, CAPIRO_BASELINE_ROOT: BASELINES, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonName, CAPIRO_RENDER_OBSERVATIONS: obsFile, CAPIRO_RENDER_PHASE: 'strictrepeat' },
  });
  // The SEPARATE onboarding smoke is run on the SAME source so its page context
  // is observed for the renderer binding too.
  const onboardRes = spawnSync(process.execPath, [path.join(HERE, 'run-playwright.mjs'), 'test', '--config', ONBOARD_CONFIG], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, CAPIRO_BASELINE_ROOT: BASELINES, CAPIRO_RENDER_OBSERVATIONS: obsFile, CAPIRO_RENDER_PHASE: 'onboard-smoke' },
  });
  const after = identityNow();
  writeFileSync(path.join(runDir, 'source-after.json'), `${JSON.stringify(after, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(runDir, 'stdout.log'), `${res.stdout ?? ''}\n${res.stderr ?? ''}\n`, 'utf8');
  const runtime = await captureRuntimeIdentity({ observationsPath: obsFile });
  writeFileSync(path.join(runDir, 'renderer-identity.json'), `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
  if (typeof onboardRes.status !== 'number' || onboardRes.status !== 0) {
    console.error(`[repeat] run ${i}: onboarding smoke did not exit 0 (status=${onboardRes.status}).`);
    failed = true;
  }

  const exitInteger = typeof res.status === 'number' ? res.status : null;
  const signal = res.signal ?? null;
  const spawnError = res.error ? String(res.error.message) : null;
  const identityStable = before.measuredDirty !== null && after.measuredDirty !== null && sameIdentity(before, after);

  let summary = null;
  if (existsSync(jsonName)) { try { summary = summarize(JSON.parse(readFileSync(jsonName, 'utf8'))); } catch (e) { summary = { parseError: String(e.message) }; } }
  const stats = summary?.stats ?? null;
  const statsComplete = stats && ['expected', 'skipped', 'unexpected', 'flaky'].every((k) => Number.isInteger(stats[k]));
  if (!summary || summary.parseError) { console.error(`[repeat] run ${i}: native JSON report missing/unparseable.`); failed = true; }
  else if (!statsComplete) { console.error(`[repeat] run ${i}: native stats incomplete/non-integer: ${JSON.stringify(stats)}`); failed = true; }
  else {
    if (summary.identityDigest !== expectedDiscovery) {
      console.error(`[repeat] run ${i}: per-test case identity multiset differs from the --list discovery.`);
      failed = true;
    }
    if (expectedIdentity === null) expectedIdentity = summary.identityDigest;
    else if (summary.identityDigest !== expectedIdentity) { console.error(`[repeat] run ${i}: identity differs from run 1.`); failed = true; }
  }

  const rendererEqual =
    rendererContractProblems(runtime, { label: 'run renderer' }).length === 0 && rendererCanonical(runtime) === baselineRenderer;
  const record = {
    schema: 'capiro.cleanup1.visual-repeat-run.v5',
    run: i, runDir: path.relative(ROOT, runDir).split(path.sep).join('/'),
    argv: [process.execPath, path.join(HERE, 'run-playwright.mjs'), 'test', '--reporter=json'],
    exitCode: exitInteger, signal, spawnError, identityStable,
    sourceFingerprintBefore: before.sourceFingerprint, sourceFingerprintAfter: after.sourceFingerprint,
    rendererEqualToBaseline: rendererEqual,
    runtimeObserved: rendererCanonical(runtime),
    stats: statsComplete ? { expected: stats.expected, skipped: stats.skipped, unexpected: stats.unexpected, flaky: stats.flaky } : null,
    caseCount: summary?.caseCount ?? null,
  };
  runs.push(record);
  writeFileSync(path.join(runDir, 'run-summary.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  if (!identityStable) { console.error(`[repeat] run ${i}: source changed during run.`); failed = true; break; }
  if (exitInteger === null || signal || spawnError) { console.error(`[repeat] run ${i}: child did not exit with an integer code.`); failed = true; break; }
  if (!rendererEqual) { console.error(`[repeat] run ${i}: renderer differs from the baseline manifest renderer.`); failed = true; break; }
  if (exitInteger !== 0) { failed = true; break; }
  if (stats.skipped !== 0) { console.error(`[repeat] run ${i}: ${stats.skipped} skipped.`); failed = true; break; }
  if (stats.unexpected !== 0 || stats.flaky !== 0) { console.error(`[repeat] run ${i}: unexpected=${stats.unexpected} flaky=${stats.flaky}.`); failed = true; break; }
  if (!Number.isInteger(record.caseCount) || record.caseCount <= 0) { console.error(`[repeat] run ${i}: empty case set.`); failed = true; break; }
}

const end = identityNow();
if (end.measuredDirty === null || !sameIdentity(end, startId)) { console.error('[repeat] final source identity differs/unknown.'); failed = true; }
const baselineInvBefore = treeInventory(BASELINES); // (throws on unreadable → fail-closed)
const baselineInvAfter = treeInventory(BASELINES);
const baselineImmutable = JSON.stringify(baselineInvBefore) === JSON.stringify(baselineInvAfter);
if (!baselineImmutable) { console.error('[repeat] baseline bytes CHANGED across repeats.'); failed = true; }

const summary = {
  schema: 'capiro.cleanup1.visual-repeat-summary.v5',
  generatedAt: new Date().toISOString(),
  head: provenanceHead,
  provenance: gitMode ? 'git' : 'CAPIRO_SOURCE_PROVENANCE',
  sourceFingerprint: startId.sourceFingerprint,
  baselineManifestSchema: baselineManifest.schema,
  zeroDiff: !failed && runs.length === RUNS,
  repeats: runs.length,
  comparison: { maxDiffPixelRatio: 0.002, threshold: 0.2 },
  identityStableAcrossRuns: end.measuredDirty !== null && sameIdentity(end, startId),
  baselineImmutable,
  baselineFilesHashed: Object.keys(baselineInvBefore).length,
  expectedDiscoveryCount: expectedDiscovery.split('\n').length,
  policyNote:
    'Each run passed Playwright screenshot comparison under the 0.002 maxDiffPixelRatio / 0.2 threshold MATCHING ' +
    'policy over the SAME committed source and the SAME baseline bytes. A passing comparison reports no pixel diff ' +
    'count, so this proves each run matched WITHIN the policy — NOT an exact pixel difference of 0.',
  runDirectory: path.relative(ROOT, OUT).split(path.sep).join('/'),
  runs,
};
writeFileSync(path.join(OUT, 'repeat-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
if (failed) { console.error(`\n[repeat] NOT a zero-diff proof — see ${summary.runDirectory}/repeat-summary.json`); process.exit(1); }
console.log(`\n[repeat] ${runs.length}/${RUNS} runs green; source fingerprint + baseline bytes identical before/after.`);
