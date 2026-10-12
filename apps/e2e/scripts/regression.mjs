#!/usr/bin/env node
/**
 * Pinned visual REGRESSION driver (CleanUp1 §8.5, review round 60).
 *
 * Runs the REAL, COMPLETE Playwright comparison suite against an IMMUTABLE
 * golden baselines tree captured on a HISTORICAL source commit, PLUS the
 * SEPARATE onboarding smoke, and emits ONE machine-checkable evidence record.
 *
 *   node scripts/regression.mjs
 *
 * It NEVER captures, updates or promotes golden bytes: any snapshot-update /
 * capture flag in the environment or argv is REFUSED. The baseline guard
 * (scripts/guard-route-coverage.mjs) must pass BEFORE and AFTER the run, and the
 * baseline manifest bytes AND every baseline PNG byte must be identical across
 * the run.
 *
 * It deliberately does NOT use the strict same-head/fingerprint
 * repeat-zero-diff driver: a normal CI/regression comparison runs the CURRENT
 * source against a baseline captured on a HISTORICAL source commit, so a
 * baseline-only commit or a later refactor MUST be allowed to reach pixel
 * comparison. Source identity + baseline immutability are proven independently.
 *
 * Round-60 corrections over the previous ad-hoc shape:
 *   - identity + status come from the ONE canonical kernel
 *     (apps/e2e/lib/playwright-report.mjs → scripts/test-proof/lib/adapters.mjs
 *     parsePlaywrightList), NOT a bespoke text / status parser. The old code
 *     compared `result.status` against `unexpected`/`flaky` (values that never
 *     appear there) and so missed real failures;
 *   - the ONBOARDING smoke is discovered INDEPENDENTLY from its OWN config
 *     `--list` (never `expected = observed`);
 *   - the RAW `--list` and run reports are written to disk and their bytes are
 *     hashed into the evidence, so the gate can re-derive identity/status from
 *     the actual bytes instead of trusting the summary;
 *   - the renderer binding uses the COMPLETE renderer/context contract
 *     (apps/e2e/lib/renderer-contract.mjs), not four fields.
 *
 * Env (set by the container entry / portable runner):
 *   CAPIRO_BASELINE_ROOT      golden baselines dir (mounted read-only)
 *   CAPIRO_SOURCE_PROVENANCE  archived-source manifest (in-container provenance)
 *   CAPIRO_VISUAL_IMAGE / CAPIRO_VISUAL_IMAGE_DIGEST
 *   CAPIRO_REGRESSION_OUT     evidence output path (default /out/regression-evidence.json)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceIdentity, verifyManifest } from '../lib/source-identity.mjs';
import { COMPARISON, CONDITIONAL_SCREENSHOT_NAMES } from '../lib/projects.mjs';
import {
  playwrightExecutionSummary,
  playwrightDiscoveredMultiset,
  playwrightAgreementProblems,
} from '../lib/playwright-report.mjs';
import { rendererBindingProblems } from '../lib/renderer-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // apps/e2e
const REPO = path.resolve(ROOT, '..', '..');
const IMAGE = process.env.CAPIRO_VISUAL_IMAGE || 'unknown';
const IMAGE_DIGEST = process.env.CAPIRO_VISUAL_IMAGE_DIGEST || 'unknown';
const BASELINES = process.env.CAPIRO_BASELINE_ROOT || path.join(ROOT, 'baselines');
const OUT = process.env.CAPIRO_REGRESSION_OUT || path.join(process.env.OUT_DIR || '/out', 'regression-evidence.json');
const OUT_DIR = path.dirname(OUT);
const SCHEMA = 'capiro.cleanup1.visual-regression.v1';

// The ACTUAL page-context observations the specs append for THIS run (route +
// onboarding). A fresh run-owned path, cleared up front, so a stale same-source
// observation set can never be reused.
const RENDER_OBSERVATIONS = path.join(OUT_DIR, 'render-context-observations.json');

const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256File = (p) => sha256Buf(readFileSync(p));

function refuse(msg) {
  console.error(`[regression] REFUSING: ${msg}`);
  process.exit(3);
}

// ── 0. Refuse every capture/update/promote shape ─────────────────────────────
const FORBIDDEN_ARGV = /(^|\s)(--update-snapshots|-u|--grep-update|--capture|--promote)(\s|$)/;
const argvJoined = process.argv.slice(2).join(' ');
if (FORBIDDEN_ARGV.test(argvJoined) || process.env.CAPIRO_UPDATE_SNAPSHOTS || process.env.CAPIRO_CAPTURE) {
  refuse('snapshot-update/capture flags are forbidden in regression mode (goldens are read-only and never regenerated)');
}

// ── 1. Archived-source provenance (mandatory) ────────────────────────────────
const provPath = process.env.CAPIRO_SOURCE_PROVENANCE;
if (!provPath || !existsSync(provPath)) refuse('CAPIRO_SOURCE_PROVENANCE is required (no verified provenance)');
let prov;
try {
  prov = JSON.parse(readFileSync(provPath, 'utf8'));
} catch (e) {
  refuse(`provenance unreadable: ${e.message}`);
}
const pv = verifyManifest(prov, REPO);
if (!pv.ok) {
  console.error('[regression] provenance invalid/forged/changed:');
  for (const e of pv.errors) console.error(`  ${e}`);
  process.exit(3);
}
const provenanceHead = prov.head;
const provenanceTree = prov.treeHash;
const provenanceFingerprint = prov.fingerprint;

// ── 2. Baseline identity + immutable-bytes snapshot ──────────────────────────
const baselineManifestPath = path.join(BASELINES, 'manifest.json');
if (!existsSync(baselineManifestPath)) refuse(`golden baselines manifest missing: ${baselineManifestPath}`);
const baselineManifestShaBefore = sha256File(baselineManifestPath);
const baselineManifest = JSON.parse(readFileSync(baselineManifestPath, 'utf8'));
const cmp = baselineManifest.comparison ?? {};
if (cmp.maxDiffPixelRatio !== COMPARISON.maxDiffPixelRatio || cmp.threshold !== COMPARISON.threshold) {
  refuse(`baseline comparison policy must be ${JSON.stringify(COMPARISON)} (got ${JSON.stringify(cmp)})`);
}
const baselineSource = baselineManifest.source ?? {};
if (typeof baselineSource.sourceFingerprint !== 'string' || !baselineSource.sourceFingerprint) {
  refuse('baseline manifest has no captured source fingerprint');
}
const baselineCapturingSha =
  typeof baselineSource.capturingSha === 'string' && /^[0-9a-f]{40}$/.test(baselineSource.capturingSha)
    ? baselineSource.capturingSha
    : typeof baselineSource.committedHeadSha === 'string' && /^[0-9a-f]{40}$/.test(baselineSource.committedHeadSha)
      ? baselineSource.committedHeadSha
      : null;
if (!baselineCapturingSha) refuse('baseline manifest has no honest capturing commit identity (capturingSha/committedHeadSha)');
const baselineRuntime = baselineManifest.runtime;
if (!baselineRuntime) refuse('baseline manifest runtime identity is missing — cannot bind the comparison');

/** Byte-immutable inventory of the baseline tree (fails closed on unreadable). */
function baselineInventory(dir) {
  const out = {};
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (e) {
      throw new Error(`unreadable baseline dir ${d}: ${e.message}`);
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(d, e.name);
      let st;
      try {
        st = statSync(p);
      } catch (err) {
        throw new Error(`unreadable baseline entry ${p}: ${err.message}`);
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out[path.relative(dir, p).split(path.sep).join('/')] = sha256File(p);
      else throw new Error(`unsupported baseline entry type: ${p}`);
    }
  };
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) walk(dir);
  return out;
}
function pngDigest(inv) {
  const lines = Object.entries(inv)
    .filter(([rel]) => rel.toLowerCase().endsWith('.png'))
    .map(([rel, sha]) => `${rel}\u0000${sha}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { count: lines.length, digest: sha256Buf(Buffer.from(lines.join('\n'))) };
}

// ── 3. Source identity BEFORE ────────────────────────────────────────────────
function git(args) {
  const r = spawnSync('git', ['--no-pager', ...args], { cwd: REPO, encoding: 'utf8' });
  if (r.error || typeof r.status !== 'number') return null;
  return r.status === 0 ? r.stdout.trim() : null;
}
function identityNow() {
  const s = sourceIdentity(REPO, git);
  if (!s.gitPresent) {
    s.head = provenanceHead;
    s.treeHash = provenanceTree;
    s.measuredDirty = [];
    s.dirtiesKnown = true;
  }
  return s;
}
const startId = identityNow();
if (!provenanceFingerprint || startId.sourceFingerprint !== provenanceFingerprint) {
  refuse('current measured source fingerprint does not match the verified archive provenance (source changed since archiving)');
}

// ── 4. Baseline guard BEFORE ─────────────────────────────────────────────────
function runGuard(label) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'guard-route-coverage.mjs')], { cwd: ROOT, encoding: 'utf8' });
  const ok = typeof r.status === 'number' && r.status === 0;
  if (!ok) console.error(`[regression] baseline guard ${label} FAILED (rc=${r.status}):\n${(r.stderr || '').slice(0, 2000)}`);
  return ok;
}
const guardBefore = runGuard('before');
const baselineInvBefore = baselineInventory(BASELINES);
const pngsBefore = pngDigest(baselineInvBefore);

// ── 5. Independent discovery (route + onboarding), from each OWN --list ──────
// Resolve the unchanged pinned runtime only after every source/baseline refusal.
// Invalid flags or provenance cannot load a browser package or delete receipts.
const { captureRuntimeIdentity } = await import('../lib/runtime-identity.mjs');
try { rmSync(RENDER_OBSERVATIONS, { force: true }); } catch { /* ignore */ }
mkdirSync(OUT_DIR, { recursive: true });

function runPlaywrightJson({ args, reportPath, phase = 'regression' }) {
  const res = spawnSync(process.execPath, [path.join(HERE, 'run-playwright.mjs'), 'test', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CAPIRO_BASELINE_ROOT: BASELINES, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath, CAPIRO_RENDER_OBSERVATIONS: RENDER_OBSERVATIONS, CAPIRO_RENDER_PHASE: phase },
  });
  const exitCode = typeof res.status === 'number' ? res.status : null;
  return { exitCode, signal: res.signal ?? null, spawnError: res.error ? String(res.error.message) : null, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function readJsonFile(p) {
  if (!existsSync(p)) return { ok: false, error: 'report file not produced' };
  try {
    return { ok: true, json: JSON.parse(readFileSync(p, 'utf8')), sha256: sha256File(p) };
  } catch (e) {
    return { ok: false, error: `unparseable JSON: ${e.message}` };
  }
}

const ONBOARD_CONFIG = 'smoke-onboard/playwright.onboard.config.ts';

function discover({ name, extraArgs = [] }) {
  const listPath = path.join(OUT_DIR, `${name}.list.json`);
  const run = runPlaywrightJson({ args: [...extraArgs, '--list', '--reporter=json'], reportPath: listPath });
  const read = readJsonFile(listPath);
  if (run.exitCode !== 0 || !read.ok) {
    refuse(`could not derive the ${name} discovery from --list (exit=${run.exitCode}, ${read.error || 'ok'})`);
  }
  const identity = playwrightDiscoveredMultiset(read.json);
  if (identity.length === 0) refuse(`${name} --list discovery is EMPTY`);
  return { name, listName: path.basename(listPath), listSha256: read.sha256, identity };
}

const routeDisc = discover({ name: 'route-comparison', extraArgs: [] });
const onboardDisc = discover({ name: 'onboard-smoke', extraArgs: ['--config', ONBOARD_CONFIG] });

// ── 6. The REAL complete comparison suite + SEPARATE onboarding smoke ────────
function runSuite({ name, extraArgs = [], phase = 'regression' }) {
  const reportPath = path.join(OUT_DIR, `${name}.report.json`);
  const run = runPlaywrightJson({ args: [...extraArgs, '--reporter=json'], reportPath, phase });
  const read = readJsonFile(reportPath);
  return {
    name,
    exitCode: run.exitCode,
    signal: run.signal,
    spawnError: run.spawnError,
    reportName: path.basename(reportPath),
    reportSha256: read.ok ? read.sha256 : null,
    report: read.ok ? read.json : null,
    parseError: read.ok ? null : read.error,
  };
}

const routeRun = runSuite({ name: 'route-comparison', phase: 'regression' });
const onboardRun = runSuite({ name: 'onboard-smoke', extraArgs: ['--config', ONBOARD_CONFIG], phase: 'onboard-smoke' });

// ── 7. Source + baseline identity AFTER ──────────────────────────────────────
const endId = identityNow();
const baselineManifestShaAfter = sha256File(baselineManifestPath);
const baselineInvAfter = baselineInventory(BASELINES);
const pngsAfter = pngDigest(baselineInvAfter);

const routeSummary = routeRun.report ? playwrightExecutionSummary(routeRun.report) : null;
const onboardSummary = onboardRun.report ? playwrightExecutionSummary(onboardRun.report) : null;

const runRuntime = await captureRuntimeIdentity({ observationsPath: RENDER_OBSERVATIONS });

function stageStatus(name, run, summary, discovery) {
  const agreementProblems = summary ? playwrightAgreementProblems(summary, discovery.identity, { label: name }) : ['no run report'];
  return {
    name,
    status: run.exitCode,
    signal: run.signal,
    spawnError: run.spawnError,
    reportName: run.reportName,
    reportSha256: run.reportSha256,
    listName: discovery.listName,
    listSha256: discovery.listSha256,
    report: summary
      ? {
          total: summary.count,
          expected: summary.expected,
          skipped: summary.skipped,
          flaky: summary.flaky,
          unexpected: summary.unexpected,
          native: summary.stats,
        }
      : null,
    identityDigest: summary ? summary.identityDigest : null,
    identityCount: summary ? summary.count : 0,
    expectedCount: discovery.identity.length,
    identityMatchesList: Boolean(summary && summary.identityDigest === discovery.identity.slice().sort().join('\n')),
    agreementProblems,
  };
}

const routeStage = stageStatus('route-comparison', routeRun, routeSummary, routeDisc);
const onboardStage = stageStatus('onboard-smoke', onboardRun, onboardSummary, onboardDisc);

const rendererProblems = rendererBindingProblems(runRuntime, baselineRuntime);

const evidence = {
  schema: SCHEMA,
  mode: 'regression',
  generatedAt: new Date().toISOString(),
  image: { ref: IMAGE, digest: IMAGE_DIGEST },
  runtime: runRuntime,
  rendererProblems,
  source: {
    head: startId.head,
    treeHash: startId.treeHash,
    fingerprint: startId.sourceFingerprint,
    fingerprintBefore: startId.sourceFingerprint,
    fingerprintAfter: endId.sourceFingerprint,
    unchanged:
      startId.sourceFingerprint === endId.sourceFingerprint &&
      startId.head === endId.head &&
      startId.treeHash === endId.treeHash,
  },
  baseline: {
    manifestSha256: baselineManifestShaBefore,
    manifestSha256Before: baselineManifestShaBefore,
    manifestSha256After: baselineManifestShaAfter,
    immutable: baselineManifestShaBefore === baselineManifestShaAfter,
    sourceFingerprint: baselineSource.sourceFingerprint,
    capturingSha: baselineCapturingSha,
    runtime: baselineRuntime,
    pngsDigest: pngsBefore.digest,
    pngsCount: pngsBefore.count,
    pngsDigestBefore: pngsBefore.digest,
    pngsDigestAfter: pngsAfter.digest,
    pngsImmutable: pngsBefore.digest === pngsAfter.digest && pngsBefore.count === pngsAfter.count,
    conditionalObligations: CONDITIONAL_SCREENSHOT_NAMES.length,
  },
  policy: { maxDiffPixelRatio: COMPARISON.maxDiffPixelRatio, threshold: COMPARISON.threshold },
  guardBefore,
  guardAfter: null,
  stages: [routeStage, onboardStage],
  identity: {
    listDerived: true,
    count: routeSummary?.count ?? 0,
    expected: routeDisc.identity.length,
    skipped: routeSummary?.skipped ?? 0,
    flaky: routeSummary?.flaky ?? 0,
    unexpected: routeSummary?.unexpected ?? 0,
    complete: routeStage.identityMatchesList && routeStage.agreementProblems.length === 0,
    routeReport: routeStage.reportName,
    routeList: routeStage.listName,
    onboarding: {
      count: onboardSummary?.count ?? 0,
      expected: onboardDisc.identity.length,
      skipped: onboardSummary?.skipped ?? 0,
      flaky: onboardSummary?.flaky ?? 0,
      unexpected: onboardSummary?.unexpected ?? 0,
      complete: onboardStage.identityMatchesList && onboardStage.agreementProblems.length === 0,
      report: onboardStage.reportName,
      list: onboardStage.listName,
    },
  },
};

// ── 8. Baseline guard AFTER (bytes must be unchanged), then emit ─────────────
evidence.guardAfter = runGuard('after');
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.error(`[regression] wrote ${OUT}`);

// The driver's OWN exit reflects the raw stages + the actual agreement checks;
// the gate re-validates the evidence from the raw bytes. A red stage, an
// incomplete identity set, a renderer mismatch or a changed baseline is a
// genuine failure, never a green.
const hardFail =
  routeRun.exitCode !== 0 ||
  onboardRun.exitCode !== 0 ||
  !evidence.source.unchanged ||
  !evidence.baseline.immutable ||
  !evidence.baseline.pngsImmutable ||
  !evidence.identity.complete ||
  !evidence.identity.onboarding.complete ||
  evidence.identity.count === 0 ||
  evidence.identity.skipped !== 0 ||
  evidence.identity.flaky !== 0 ||
  evidence.identity.unexpected !== 0 ||
  routeStage.agreementProblems.length > 0 ||
  onboardStage.agreementProblems.length > 0 ||
  rendererProblems.length > 0 ||
  !evidence.guardAfter ||
  !evidence.guardBefore;
process.exit(hardFail ? 1 : 0);
