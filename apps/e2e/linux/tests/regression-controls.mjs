#!/usr/bin/env node
/**
 * Pinned visual REGRESSION controls (CleanUp1 §8.5, review round 60).
 *
 * Pure controls over the REAL production helpers:
 *   - scripts/cleanup-gates/lib/pinned-visual.mjs  (the regression evidence
 *     validator + the shell-safe portable-runner argv builder), and
 *   - the regression driver apps/e2e/scripts/regression.mjs  (exercised ONLY
 *     through its fail-closed refusals, which fire BEFORE any browser/container
 *     work — so no Playwright/Docker result is ever mocked as acceptance).
 *
 * The positive evidence is produced from REAL fixture report/list files through
 * the REAL canonical parser (apps/e2e/lib/playwright-report.mjs), and validated
 * against a ROOT-built context carrying the ACTUAL raw-file hashes — never a
 * boolean that mirrors the implementation.
 *
 * Route identity expectations are DERIVED from the committed route inventory
 * (captured routes x projects), never hard-coded as acceptance evidence.
 *
 *   node apps/e2e/linux/tests/regression-controls.mjs
 * Exit: 0 all controls pass; 1 any failed.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPARISON, CONDITIONAL_SCREENSHOT_NAMES, PROJECTS, ONBOARD_PROJECT } from '../../lib/projects.mjs';
import { PROJECT_VIEWPORTS } from '../../lib/render-context.mjs';
import {
  validateRegressionEvidence,
  buildPortableRunnerArgv,
  PINNED_VISUAL_SCHEMA,
  PINNED_COMPARISON,
} from '../../../../scripts/cleanup-gates/lib/pinned-visual.mjs';
import { playwrightExecutionSummary, playwrightDiscoveredMultiset } from '../../lib/playwright-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..'); // apps/e2e
const REPO = path.resolve(ROOT, '..', '..');

let failures = 0;
function control(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r === true || (r && r.ok === true);
    if (r && typeof r === 'object' && r.detail) detail = r.detail;
  } catch (e) {
    detail = `threw: ${e.message}`;
  }
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

// ---- policy contract is the SAME single source of truth --------------------
control('regression policy matches projects.mjs COMPARISON (0.002 / 0.2)', () => ({
  ok: PINNED_COMPARISON.maxDiffPixelRatio === COMPARISON.maxDiffPixelRatio && PINNED_COMPARISON.threshold === COMPARISON.threshold,
  detail: JSON.stringify(PINNED_COMPARISON),
}));

// ---- derived identity set (NOT hard-coded) ---------------------------------
const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes.inventory.json'), 'utf8'));
const capturedRoutes = inventory.routes.filter((r) => r.coverage === 'captured').map((r) => r.path);
const projects = inventory.viewports.map((v) => v.name);
const derivedRouteIdentities = capturedRoutes.length * projects.length;

control('route identity set is derived from the inventory (captured x projects)', () => ({
  ok: derivedRouteIdentities > 0 && projects.length === PROJECTS.length,
  detail: `captured=${capturedRoutes.length} projects=${projects.length} => ${derivedRouteIdentities}`,
}));

// ---- real fixture context --------------------------------------------------
const H40 = 'a'.repeat(40);
const H64 = 'b'.repeat(64);
const H64B = '1'.repeat(64);
const DIGEST = `sha256:${'c'.repeat(64)}`;
const IMG_REF = `mcr.microsoft.com/playwright@${DIGEST}`;
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function makeRuntime() {
  return {
    os: 'linux x64',
    node: 'v22.0.0',
    browserVersion: '141.0.7390.37',
    launchedBrowser: { path: '/x/chrome-headless-shell', sha256: H64, via: 'proc:headless-shell', isHeadlessShell: true },
    image: { ref: IMG_REF, digest: DIGEST },
    fonts: { source: 'fc-list', count: 2, listSha256: H64, files: [{ path: '/usr/share/fonts/a.ttf', sha256: H64 }, { path: '/usr/share/fonts/b.ttf', sha256: H64B }] },
    colorScheme: 'light',
    mediaType: 'screen',
    viewports: PROJECT_VIEWPORTS.map((v) => ({ name: v.name, width: v.width, height: v.height })),
    locale: 'en-US',
    timezone: 'America/New_York',
    deviceScaleFactor: 1,
    reducedMotion: true,
    fixedClock: '2026-10-07T12:00:00.000Z',
    // The SEPARATE onboarding page context is now mandatory in the canonical
    // renderer contract (rendererContractProblems → canonicalOnboarding). The
    // fixture must carry it too; its viewport is the ACTUAL ONBOARD_PROJECT
    // resolved value (never a duplicated literal), and its context fields agree
    // with the route context above.
    onboarding: {
      viewport: { width: ONBOARD_PROJECT.viewport.width, height: ONBOARD_PROJECT.viewport.height },
      colorScheme: 'light',
      mediaType: 'screen',
      locale: 'en-US',
      timezone: 'America/New_York',
      deviceScaleFactor: 1,
      reducedMotion: true,
      fixedClock: '2026-10-07T12:00:00.000Z',
    },
  };
}
function pwReport(projectsArr, specs) {
  return {
    config: {},
    suites: projectsArr.map((project) => ({
      title: '',
      file: 'tests/routes.spec.ts',
      specs: specs.map((title) => ({ title, tests: [{ projectName: project, status: 'expected', results: [{ status: 'passed' }] }] })),
      suites: [],
    })),
    stats: { expected: projectsArr.length * specs.length, skipped: 0, unexpected: 0, flaky: 0, errors: 0 },
    errors: [],
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-controls-'));
const reportDir = path.join(tmp, 'reports');
fs.mkdirSync(reportDir, { recursive: true });
const routeList = pwReport(['desktop-1440'], ['route one', 'route two']);
const routeRun = pwReport(['desktop-1440'], ['route one', 'route two']);
const onboardList = pwReport(['onboard-desktop-1440'], ['onboard a', 'onboard b']);
const onboardRun = pwReport(['onboard-desktop-1440'], ['onboard a', 'onboard b']);
for (const [n, o] of [
  ['route-comparison.list.json', routeList],
  ['route-comparison.report.json', routeRun],
  ['onboard-smoke.list.json', onboardList],
  ['onboard-smoke.report.json', onboardRun],
]) fs.writeFileSync(path.join(reportDir, n), `${JSON.stringify(o, null, 2)}\n`, 'utf8');

const routeSummary = playwrightExecutionSummary(routeRun);
const routeDiscovered = playwrightDiscoveredMultiset(routeList);
const onboardSummary = playwrightExecutionSummary(onboardRun);
const onboardDiscovered = playwrightDiscoveredMultiset(onboardList);

function makeCtx() {
  return {
    expectedImageRef: IMG_REF,
    expectedImageDigest: DIGEST,
    reportDir,
    readText: (p) => fs.readFileSync(p, 'utf8'),
    exists: (p) => fs.existsSync(p),
    sha256,
    archive: { head: H40, treeHash: H40, fingerprint: H64 },
    baselineBefore: { manifestSha256: H64, pngDigest: H64B, pngCount: 2, manifestRuntime: makeRuntime(), capturingSha: H40, sourceFingerprint: H64 },
    baselineAfter: { manifestSha256: H64, pngDigest: H64B, pngCount: 2, manifestRuntime: makeRuntime(), capturingSha: H40, sourceFingerprint: H64 },
    sourceBefore: { head: H40, treeHash: H40, fingerprint: H64 },
    sourceAfter: { head: H40, treeHash: H40, fingerprint: H64 },
    current: { head: H40, treeHash: H40, fingerprint: H64 },
    guard: { before: true, after: true },
  };
}
function makeEvidence() {
  const runtime = makeRuntime();
  return {
    schema: PINNED_VISUAL_SCHEMA,
    mode: 'regression',
    image: { ref: IMG_REF, digest: DIGEST },
    runtime,
    source: { head: H40, treeHash: H40, fingerprint: H64, fingerprintBefore: H64, fingerprintAfter: H64, unchanged: true },
    baseline: {
      manifestSha256: H64, manifestSha256Before: H64, manifestSha256After: H64, immutable: true,
      sourceFingerprint: H64, capturingSha: H40, runtime,
      pngsDigest: H64B, pngsCount: 2, pngsDigestBefore: H64B, pngsDigestAfter: H64B, pngsImmutable: true,
    },
    policy: { maxDiffPixelRatio: COMPARISON.maxDiffPixelRatio, threshold: COMPARISON.threshold },
    guardBefore: true,
    guardAfter: true,
    stages: [
      { name: 'route-comparison', status: 0, signal: null, spawnError: null, reportName: 'route-comparison.report.json', reportSha256: sha256(path.join(reportDir, 'route-comparison.report.json')), listName: 'route-comparison.list.json', listSha256: sha256(path.join(reportDir, 'route-comparison.list.json')), report: { total: routeSummary.count, skipped: 0, flaky: 0, unexpected: 0 }, identityDigest: routeSummary.identityDigest, identityCount: routeSummary.count, expectedCount: routeDiscovered.length, identityMatchesList: true, agreementProblems: [] },
      { name: 'onboard-smoke', status: 0, signal: null, spawnError: null, reportName: 'onboard-smoke.report.json', reportSha256: sha256(path.join(reportDir, 'onboard-smoke.report.json')), listName: 'onboard-smoke.list.json', listSha256: sha256(path.join(reportDir, 'onboard-smoke.list.json')), report: { total: onboardSummary.count, skipped: 0, flaky: 0, unexpected: 0 }, identityDigest: onboardSummary.identityDigest, identityCount: onboardSummary.count, expectedCount: onboardDiscovered.length, identityMatchesList: true, agreementProblems: [] },
    ],
    identity: {
      listDerived: true,
      count: routeSummary.count, expected: routeDiscovered.length, skipped: 0, flaky: 0, unexpected: 0, complete: true,
      routeReport: 'route-comparison.report.json', routeList: 'route-comparison.list.json',
      onboarding: { count: onboardSummary.count, expected: onboardDiscovered.length, skipped: 0, flaky: 0, unexpected: 0, complete: true, report: 'onboard-smoke.report.json', list: 'onboard-smoke.list.json' },
    },
  };
}
const clone = (o) => JSON.parse(JSON.stringify(o));

control('a valid regression evidence object (real fixture files) validates', () => {
  const p = validateRegressionEvidence(makeEvidence(), makeCtx());
  return { ok: p.length === 0, detail: p.join('; ') };
});
control('an INCOMPLETE identity set is refused', () => {
  const ev = clone(makeEvidence());
  ev.identity.count = routeDiscovered.length - 1;
  return { ok: validateRegressionEvidence(ev, makeCtx()).some((p) => /incomplete/.test(p)) };
});
control('PIXEL DRIFT in the comparison is refused', () => {
  const ev = clone(makeEvidence());
  ev.identity.unexpected = 1;
  return { ok: validateRegressionEvidence(ev, makeCtx()).some((p) => /unexpected|pixel/.test(p)) };
});
control('a MUTABLE baseline (bytes changed) is refused', () => {
  const ev = clone(makeEvidence());
  ev.baseline.manifestSha256After = 'd'.repeat(64);
  return { ok: validateRegressionEvidence(ev, makeCtx()).some((p) => /mutable baseline|changed during/.test(p)) };
});
control('a CHANGED source during the run is refused', () => {
  const ev = clone(makeEvidence());
  ev.source.fingerprintAfter = 'e'.repeat(64);
  return { ok: validateRegressionEvidence(ev, makeCtx()).some((p) => /changed during/.test(p)) };
});
control('a MISSING stage (onboarding smoke) is refused', () => {
  const ev = clone(makeEvidence());
  ev.stages = ev.stages.filter((s) => s.name !== 'onboard-smoke');
  return { ok: validateRegressionEvidence(ev, makeCtx()).some((p) => /onboard-smoke/.test(p)) };
});

// ---- the driver's own refusals fire before any browser/container work ------
control('the regression driver REFUSES --update-snapshots (no golden regeneration)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'regression.mjs'), '--update-snapshots'], { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 3 && /forbidden/i.test(`${r.stdout}${r.stderr}`), detail: `rc=${r.status}` };
});
control('the regression driver REFUSES CAPIRO_UPDATE_SNAPSHOTS=1', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'regression.mjs')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CAPIRO_UPDATE_SNAPSHOTS: '1' } });
  return { ok: r.status === 3 && /forbidden/i.test(`${r.stdout}${r.stderr}`), detail: `rc=${r.status}` };
});
control('the regression driver REFUSES when provenance is missing (not a silent pass)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'regression.mjs')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CAPIRO_SOURCE_PROVENANCE: '' } });
  return { ok: r.status === 3, detail: `rc=${r.status}` };
});

// ---- shell-safe portable runner argv (no interpolation) --------------------
control('portable runner argv passes dynamic values as positional argv (Linux)', () => {
  const r = buildPortableRunnerArgv({ script: '/r/run-linux-capture.sh', mode: 'regression', positional: ['/arch', '/gold', '/out'] }, { platform: 'linux' });
  return { ok: r.file === 'bash' && r.args.join(' ').includes('/r/run-linux-capture.sh regression /arch /gold /out') };
});
control('portable runner argv uses a fixed pwd -W bridge (Windows), MSYS disabled', () => {
  const r = buildPortableRunnerArgv({ script: 'C:/repo/run-linux-capture.sh', mode: 'regression', positional: ['C:/a', 'C:/g', 'C:/o'] }, { platform: 'win32', bashPath: 'C:/Program Files/Git/bin/bash.exe' });
  return { ok: r.args.includes('cd "$(pwd -W 2>/dev/null || pwd)" && exec bash "$@"') && r.env.MSYS_NO_PATHCONV === '1' };
});
control('conditional-page obligations are a non-empty set (derived from projects.mjs)', () => ({
  ok: Array.isArray(CONDITIONAL_SCREENSHOT_NAMES) && CONDITIONAL_SCREENSHOT_NAMES.length > 0,
  detail: CONDITIONAL_SCREENSHOT_NAMES.join(','),
}));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }

process.stdout.write(`\n[regression-controls] ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
