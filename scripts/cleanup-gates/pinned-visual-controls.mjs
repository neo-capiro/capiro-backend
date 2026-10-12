#!/usr/bin/env node
/**
 * Pinned-visual PURE controls (CleanUp1 §8, review round 60).
 *
 * These are NOT a mock of Playwright/Docker and NOT native acceptance: they
 * exercise the REAL production validator in
 * scripts/cleanup-gates/lib/pinned-visual.mjs against contexts built from REAL
 * FIXTURE FILES and the REAL canonical parser (apps/e2e/lib/playwright-report.mjs
 * → scripts/test-proof/lib/adapters.mjs). The positive context is produced from
 * actual raw report/list files and the actual parser output — NOT from booleans
 * that merely mirror the implementation.
 *
 * Every adverse control (absent / foreign / stale / mutated evidence, a
 * different current commit, an altered raw report/list, incomplete onboarding,
 * a changed PNG digest, a guard failure, a zero / non-zero / native spawn error,
 * a missing context) must be REFUSED.
 *
 *   node scripts/cleanup-gates/pinned-visual-controls.mjs
 * Exit: 0 all controls pass; 1 any control failed.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateRegressionEvidence,
  rendererCanonical,
  normalizeVisualSuite,
  buildPortableRunnerArgv,
  PINNED_VISUAL_SCHEMA,
  PINNED_COMPARISON,
  MSYS_DISABLE_ENV,
} from './lib/pinned-visual.mjs';
import { playwrightExecutionSummary, playwrightDiscoveredMultiset, playwrightAgreementProblems } from '../../apps/e2e/lib/playwright-report.mjs';
import { PROJECT_VIEWPORTS } from '../../apps/e2e/lib/render-context.mjs';

const results = [];
let failures = 0;
function control(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r === true || (r && r.ok === true);
    if (r && typeof r === 'object' && r.detail) detail = r.detail;
  } catch (e) {
    ok = false;
    detail = `threw: ${e.message}`;
  }
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const H40 = 'a'.repeat(40);
const H64 = 'b'.repeat(64);
const H64B = '1'.repeat(64);
const DIGEST = `sha256:${'c'.repeat(64)}`;
const IMG_REF = `mcr.microsoft.com/playwright@${DIGEST}`;

const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function makeRuntime() {
  return {
    capturedAt: '2026-10-07T12:00:00.000Z',
    os: 'linux x64',
    node: 'v22.0.0',
    browserVersion: '141.0.7390.37',
    launchedBrowser: { path: '/ms-playwright/chromium_headless_shell/chrome-headless-shell', sha256: H64, via: 'proc:headless-shell', isHeadlessShell: true },
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
    onboarding: {
      viewport: { width: 1440, height: 1000 },
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

/** A real Playwright JSON report shape (list OR run) for N specs across P projects. */
function pwReport(projects, specs, { file = 'tests/routes.spec.ts', fail = false, skip = false } = {}) {
  const status = fail ? 'unexpected' : skip ? 'skipped' : 'expected';
  const result = fail ? 'failed' : skip ? 'skipped' : 'passed';
  return {
    config: {},
    suites: projects.map((project) => ({
      title: '',
      file,
      specs: specs.map((title) => ({ title, tests: [{ projectName: project, status, results: [{ status: result }] }] })),
      suites: [],
    })),
    stats: { expected: skip || fail ? 0 : projects.length * specs.length, skipped: skip ? projects.length * specs.length : 0, unexpected: fail ? projects.length * specs.length : 0, flaky: 0, errors: 0 },
    errors: [],
  };
}

function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  return p;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-controls-'));
const reportDir = path.join(tmp, 'reports');
fs.mkdirSync(reportDir, { recursive: true });

const ROUTE_PROJECTS = ['desktop-1440', 'tablet-1024', 'mobile-390'];
const ROUTE_SPECS = ['route one', 'route two', 'route three', 'route four'];
const ONBOARD_PROJECTS = ['onboard-desktop-1440'];
const ONBOARD_SPECS = ['onboard registration', 'onboard fallback'];

const routeList = pwReport(ROUTE_PROJECTS, ROUTE_SPECS);
const routeRun = pwReport(ROUTE_PROJECTS, ROUTE_SPECS);
const onboardList = pwReport(ONBOARD_PROJECTS, ONBOARD_SPECS, { file: 'smoke-onboard/onboard-smoke.spec.ts' });
const onboardRun = pwReport(ONBOARD_PROJECTS, ONBOARD_SPECS, { file: 'smoke-onboard/onboard-smoke.spec.ts' });

writeJson(reportDir, 'route-comparison.list.json', routeList);
writeJson(reportDir, 'route-comparison.report.json', routeRun);
writeJson(reportDir, 'onboard-smoke.list.json', onboardList);
writeJson(reportDir, 'onboard-smoke.report.json', onboardRun);

const routeDiscovered = playwrightDiscoveredMultiset(routeList);
const routeSummary = playwrightExecutionSummary(routeRun);
const onboardDiscovered = playwrightDiscoveredMultiset(onboardList);
const onboardSummary = playwrightExecutionSummary(onboardRun);

function ctxBase() {
  return {
    expectedImageRef: IMG_REF,
    expectedImageDigest: DIGEST,
    reportDir,
    readText: (p) => fs.readFileSync(p, 'utf8'),
    exists: (p) => fs.existsSync(p),
    sha256,
    archive: { head: H40, treeHash: H40, fingerprint: H64, fileCount: 411 },
    baselineBefore: { manifestSha256: H64, pngDigest: H64B, pngCount: 411, manifestRuntime: makeRuntime(), capturingSha: H40, sourceFingerprint: H64 },
    baselineAfter: { manifestSha256: H64, pngDigest: H64B, pngCount: 411, manifestRuntime: makeRuntime(), capturingSha: H40, sourceFingerprint: H64 },
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
    rendererProblems: [],
    source: { head: H40, treeHash: H40, fingerprint: H64, fingerprintBefore: H64, fingerprintAfter: H64, unchanged: true },
    baseline: {
      manifestSha256: H64,
      manifestSha256Before: H64,
      manifestSha256After: H64,
      immutable: true,
      sourceFingerprint: H64,
      capturingSha: H40,
      runtime,
      pngsDigest: H64B,
      pngsCount: 411,
      pngsDigestBefore: H64B,
      pngsDigestAfter: H64B,
      pngsImmutable: true,
    },
    policy: { maxDiffPixelRatio: PINNED_COMPARISON.maxDiffPixelRatio, threshold: PINNED_COMPARISON.threshold },
    guardBefore: true,
    guardAfter: true,
    stages: [
      {
        name: 'route-comparison',
        status: 0,
        signal: null,
        spawnError: null,
        reportName: 'route-comparison.report.json',
        reportSha256: sha256(path.join(reportDir, 'route-comparison.report.json')),
        listName: 'route-comparison.list.json',
        listSha256: sha256(path.join(reportDir, 'route-comparison.list.json')),
        report: { total: routeSummary.count, expected: routeSummary.expected, skipped: 0, flaky: 0, unexpected: 0 },
        identityDigest: routeSummary.identityDigest,
        identityCount: routeSummary.count,
        expectedCount: routeDiscovered.length,
        identityMatchesList: true,
        agreementProblems: [],
      },
      {
        name: 'onboard-smoke',
        status: 0,
        signal: null,
        spawnError: null,
        reportName: 'onboard-smoke.report.json',
        reportSha256: sha256(path.join(reportDir, 'onboard-smoke.report.json')),
        listName: 'onboard-smoke.list.json',
        listSha256: sha256(path.join(reportDir, 'onboard-smoke.list.json')),
        report: { total: onboardSummary.count, expected: onboardSummary.expected, skipped: 0, flaky: 0, unexpected: 0 },
        identityDigest: onboardSummary.identityDigest,
        identityCount: onboardSummary.count,
        expectedCount: onboardDiscovered.length,
        identityMatchesList: true,
        agreementProblems: [],
      },
    ],
    identity: {
      listDerived: true,
      count: routeSummary.count,
      expected: routeDiscovered.length,
      skipped: 0,
      flaky: 0,
      unexpected: 0,
      complete: true,
      routeReport: 'route-comparison.report.json',
      routeList: 'route-comparison.list.json',
      onboarding: {
        count: onboardSummary.count,
        expected: onboardDiscovered.length,
        skipped: 0,
        flaky: 0,
        unexpected: 0,
        complete: true,
        report: 'onboard-smoke.report.json',
        list: 'onboard-smoke.list.json',
      },
    },
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// ---- positive (real files + real parser) -----------------------------------
control('a complete pinned regression evidence object built from REAL fixture files validates', () => {
  const p = validateRegressionEvidence(makeEvidence(), ctxBase());
  return { ok: p.length === 0, detail: p.join('; ') };
});

// ---- malformed / missing ---------------------------------------------------
control('MISSING context is refused (fail closed)', () => {
  return { ok: validateRegressionEvidence(makeEvidence(), undefined).some((p) => /context/.test(p)) };
});
control('an INCOMPLETE context (no reportDir) is refused', () => {
  const ctx = ctxBase();
  delete ctx.reportDir;
  return { ok: validateRegressionEvidence(makeEvidence(), ctx).some((p) => /raw report directory/.test(p)) };
});
control('MISSING runtime is refused', () => {
  const ev = makeEvidence();
  delete ev.runtime;
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /run renderer/.test(p)) };
});
control('an INCOMPLETE runtime (no fixedClock) is refused', () => {
  const ev = makeEvidence();
  delete ev.runtime.fixedClock;
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /fixedClock/.test(p)) };
});
control('MISSING baseline is refused', () => {
  const ev = makeEvidence();
  delete ev.baseline;
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /baseline/.test(p)) };
});
control('MISSING a required stage is refused (never silently skipped)', () => {
  const ev = makeEvidence();
  ev.stages = ev.stages.filter((s) => s.name !== 'onboard-smoke');
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /onboard-smoke/.test(p)) };
});

// ---- raw report / list byte binding + independent re-derivation ------------
control('an ABSENT raw run report is refused', () => {
  const ev = makeEvidence();
  ev.stages[0].reportName = 'does-not-exist.report.json';
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /raw run report/.test(p)) };
});
control('a MUTATED raw run report (bytes changed, declared hash kept) is refused', () => {
  const ev = makeEvidence();
  const before = fs.readFileSync(path.join(reportDir, 'route-comparison.report.json'), 'utf8');
  fs.writeFileSync(path.join(reportDir, 'route-comparison.report.json'), before.replace('route one', 'route ONE'), 'utf8');
  try {
    const probs = validateRegressionEvidence(ev, ctxBase());
    return { ok: probs.some((p) => /BYTES do not match|identity multiset/.test(p)), detail: probs.slice(0, 2).join('; ') };
  } finally {
    fs.writeFileSync(path.join(reportDir, 'route-comparison.report.json'), before, 'utf8');
  }
});
control('an ALTERED raw --list report is refused', () => {
  const ev = makeEvidence();
  // Declared report bytes are correct, but the list no longer matches the run.
  const p = path.join(reportDir, 'route-comparison.list.json');
  const before = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, JSON.stringify(pwReport(ROUTE_PROJECTS, ['route one', 'route two'])), 'utf8');
  try {
    const probs = validateRegressionEvidence(ev, ctxBase());
    return { ok: probs.some((p2) => /does not equal its own raw --list|BYTES do not match|list length/.test(p2)), detail: probs.slice(0, 2).join('; ') };
  } finally {
    fs.writeFileSync(p, before, 'utf8');
  }
});
control('a stage whose declared identityDigest does NOT match the actual raw report is refused', () => {
  const ev = makeEvidence();
  ev.stages[0].identityDigest = 'deadbeef';
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /identityDigest/.test(p)) };
});

// ---- identity holes --------------------------------------------------------
control('a ZERO identity set is refused', () => {
  const ev = makeEvidence();
  ev.identity = { ...ev.identity, count: 0, expected: 0 };
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /empty/.test(p)) };
});
control('a SKIPPED case is refused', () => {
  const ev = makeEvidence();
  ev.identity = { ...ev.identity, skipped: 1 };
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /skipped/.test(p)) };
});
control('an INCOMPLETE identity set (count != expected) is refused', () => {
  const ev = makeEvidence();
  ev.identity = { ...ev.identity, count: routeSummary.count - 1, expected: routeDiscovered.length };
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /incomplete/.test(p)) };
});
control('PIXEL DRIFT (unexpected != 0) is refused', () => {
  const ev = makeEvidence();
  ev.identity = { ...ev.identity, unexpected: 1 };
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /unexpected|pixel/.test(p)) };
});

// ---- onboarding independence ----------------------------------------------
control('an INCOMPLETE onboarding set is refused', () => {
  const ev = makeEvidence();
  ev.identity.onboarding = { ...ev.identity.onboarding, count: 0 };
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /onboarding/.test(p)) };
});
control('MISSING onboarding identity is refused', () => {
  const ev = makeEvidence();
  delete ev.identity.onboarding;
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /onboarding/.test(p)) };
});

// ---- renderer / baseline / source honesty ---------------------------------
control('a RENDERER MISMATCH against the baseline is refused', () => {
  const ev = makeEvidence();
  ev.baseline.runtime = { ...ev.baseline.runtime, browserVersion: '999.0.0.0' };
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /renderer mismatch/.test(p)) };
});
control('a MUTABLE baseline manifest (bytes changed) is refused', () => {
  const ev = makeEvidence();
  ev.baseline.manifestSha256After = 'd'.repeat(64);
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /mutable baseline|changed during/.test(p)) };
});
control('a MUTABLE baseline PNG digest is refused', () => {
  const ev = makeEvidence();
  ev.baseline.pngsDigestAfter = 'e'.repeat(64);
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /PNG bytes changed|mutable baseline PNGs/.test(p)) };
});
control('a CHANGED PNG digest vs the gate observation is refused', () => {
  const ctx = ctxBase();
  // Change ONLY the gate's AFTER PNG-byte observation; every other observation
  // field stays intact so the refusal is isolated to the real mismatch.
  ctx.baselineAfter = { ...ctx.baselineAfter, pngDigest: 'f'.repeat(64) };
  return { ok: validateRegressionEvidence(makeEvidence(), ctx).some((p) => /PNG bytes observed by the gate/.test(p)) };
});
control('a CHANGED source during the run is refused', () => {
  const ev = makeEvidence();
  ev.source.fingerprintAfter = 'e'.repeat(64);
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /changed during/.test(p)) };
});
control('a source NO LONGER BOUND to the current archive is refused', () => {
  const ctx = ctxBase();
  ctx.archive = { head: 'f'.repeat(40), treeHash: H40, fingerprint: 'f'.repeat(64) };
  return { ok: validateRegressionEvidence(makeEvidence(), ctx).some((p) => /not bound to the current verified archive|archive head/.test(p)) };
});
control('a DIFFERENT current commit is refused', () => {
  const ctx = ctxBase();
  ctx.current = { head: '9'.repeat(40), treeHash: '9'.repeat(40), fingerprint: '9'.repeat(64) };
  const probs = validateRegressionEvidence(makeEvidence(), ctx);
  return { ok: probs.some((p) => /ACTUAL current commit|ACTUAL current source/.test(p)), detail: probs.slice(0, 2).join('; ') };
});
control('an UNCONFIGURED image digest is refused', () => {
  const ev = makeEvidence();
  ev.image.digest = `sha256:${'f'.repeat(64)}`;
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /pinned digest/.test(p)) };
});

// ---- round-73: source/archive context fields are MANDATORY (full matrix) ----
control('MISSING sourceBefore context is refused', () => {
  const ctx = ctxBase();
  delete ctx.sourceBefore;
  return { ok: validateRegressionEvidence(makeEvidence(), ctx).some((p) => /before source context is missing/.test(p)) };
});
control('a MALFORMED sourceBefore fingerprint is refused', () => {
  const ctx = ctxBase();
  ctx.sourceBefore = { head: H40, treeHash: H40, fingerprint: 'not-hex' };
  return { ok: validateRegressionEvidence(makeEvidence(), ctx).some((p) => /before source fingerprint must be 64-hex/.test(p)) };
});
control('MISSING sourceAfter context is refused', () => {
  const ctx = ctxBase();
  delete ctx.sourceAfter;
  return { ok: validateRegressionEvidence(makeEvidence(), ctx).some((p) => /after source context is missing/.test(p)) };
});
control('MISSING current context is refused', () => {
  const ctx = ctxBase();
  delete ctx.current;
  return { ok: validateRegressionEvidence(makeEvidence(), ctx).some((p) => /current source context is missing/.test(p)) };
});
control('a MALFORMED current treeHash is refused', () => {
  const ctx = ctxBase();
  ctx.current = { head: H40, treeHash: 'zz', fingerprint: H64 };
  return { ok: validateRegressionEvidence(makeEvidence(), ctx).some((p) => /current source treeHash must be 40-hex/.test(p)) };
});
control('MISSING archive context is refused', () => {
  const ctx = ctxBase();
  delete ctx.archive;
  return { ok: validateRegressionEvidence(makeEvidence(), ctx).some((p) => /archive context is missing/.test(p)) };
});
control('a MALFORMED archive head is refused', () => {
  const ctx = ctxBase();
  ctx.archive = { head: 'nope', treeHash: H40, fingerprint: H64 };
  return { ok: validateRegressionEvidence(makeEvidence(), ctx).some((p) => /archive context head must be 40-hex/.test(p)) };
});
control('a FOREIGN archive fingerprint (valid shape, wrong value) is refused', () => {
  const ctx = ctxBase();
  ctx.archive = { head: H40, treeHash: H40, fingerprint: 'd'.repeat(64) };
  return { ok: validateRegressionEvidence(makeEvidence(), ctx).some((p) => /not bound to the current verified archive fingerprint/.test(p)) };
});
control('a FOREIGN report name (path traversal) is refused', () => {
  const ev = makeEvidence();
  ev.stages[0].reportName = '../escape.report.json';
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /bare file name/.test(p)) };
});

// ---- round-73: report adapter refuses unexecuted/unknown/interrupted states -
// These exercise the REAL adapter used by BOTH caller paths (the regression
// driver via playwrightAgreementProblems, the strict-repeat proof via
// playwrightExecutionSummary) AND the gate validator (raw run report).
control('regression/agreement: an EMPTY results[] case is refused (never counted expected)', () => {
  const r = pwReport(ROUTE_PROJECTS, ROUTE_SPECS);
  r.suites[0].specs[0].tests[0].results = [];
  const s = playwrightExecutionSummary(r);
  const probs = playwrightAgreementProblems(s, routeDiscovered);
  return { ok: s.unexpected >= 1 && s.statusProblems.some((m) => /NO raw results/.test(m)) && probs.length > 0, detail: probs.slice(0, 2).join('; ') };
});
control('regression/agreement: an UNKNOWN result status (cancelled) is refused', () => {
  const r = pwReport(ROUTE_PROJECTS, ROUTE_SPECS);
  r.suites[0].specs[0].tests[0].results = [{ status: 'cancelled' }];
  const s = playwrightExecutionSummary(r);
  return { ok: s.unexpected >= 1 && s.statusProblems.some((m) => /UNKNOWN\/cancelled\/interrupted/.test(m)) && playwrightAgreementProblems(s, routeDiscovered).length > 0 };
});
control('regression/agreement: an UNKNOWN test classification is refused', () => {
  const r = pwReport(ROUTE_PROJECTS, ROUTE_SPECS);
  r.suites[0].specs[0].tests[0].status = 'bogus';
  const s = playwrightExecutionSummary(r);
  return { ok: s.unexpected >= 1 && s.statusProblems.some((m) => /UNKNOWN test classification/.test(m)) && playwrightAgreementProblems(s, routeDiscovered).length > 0 };
});
control('strictrepeat: an interrupted raw result is a failure, not a pass', () => {
  const r = pwReport(ROUTE_PROJECTS, ROUTE_SPECS);
  r.suites[0].specs[0].tests[0].results = [{ status: 'interrupted' }];
  const s = playwrightExecutionSummary(r);
  return { ok: s.unexpected >= 1 && s.statusProblems.some((m) => /not a clean pass/.test(m)) };
});
control('regression/agreement: a native stats mismatch is refused', () => {
  const r = pwReport(ROUTE_PROJECTS, ROUTE_SPECS);
  r.stats.expected = r.stats.expected + 1;
  const s = playwrightExecutionSummary(r);
  return { ok: playwrightAgreementProblems(s, routeDiscovered).some((p) => /stats expected/.test(p)) };
});
control('regression/agreement: a MISSING top-level errors[] is refused', () => {
  const r = pwReport(ROUTE_PROJECTS, ROUTE_SPECS);
  delete r.errors;
  const s = playwrightExecutionSummary(r);
  return { ok: playwrightAgreementProblems(s, routeDiscovered).some((p) => /error list is not recorded/.test(p)) };
});
control('regression/agreement: a NON-EMPTY error list is refused', () => {
  const r = pwReport(ROUTE_PROJECTS, ROUTE_SPECS);
  r.errors = [{ message: 'boom' }];
  const s = playwrightExecutionSummary(r);
  return { ok: playwrightAgreementProblems(s, routeDiscovered).some((p) => /error\(s\)/.test(p)) };
});
control('gate: a raw run report with an EMPTY results[] is refused by the validator', () => {
  const bad = pwReport(ROUTE_PROJECTS, ROUTE_SPECS);
  bad.suites[0].specs[0].tests[0].results = [];
  const p = path.join(reportDir, 'route-comparison.report.json');
  const before = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, `${JSON.stringify(bad, null, 2)}\n`, 'utf8');
  try {
    const probs = validateRegressionEvidence(makeEvidence(), ctxBase());
    return { ok: probs.some((x) => /raw run report has .* unexpected/.test(x)), detail: probs.slice(0, 2).join('; ') };
  } finally {
    fs.writeFileSync(p, before, 'utf8');
  }
});
control('gate: a raw run report with an UNKNOWN result status is refused by the validator', () => {
  const bad = pwReport(ROUTE_PROJECTS, ROUTE_SPECS);
  bad.suites[0].specs[0].tests[0].results = [{ status: 'weird' }];
  const p = path.join(reportDir, 'route-comparison.report.json');
  const before = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, `${JSON.stringify(bad, null, 2)}\n`, 'utf8');
  try {
    const probs = validateRegressionEvidence(makeEvidence(), ctxBase());
    return { ok: probs.some((x) => /raw run report has .* unexpected/.test(x)), detail: probs.slice(0, 2).join('; ') };
  } finally {
    fs.writeFileSync(p, before, 'utf8');
  }
});

// ---- guards + native stage outcomes ---------------------------------------
control('a GUARD failure (gate observed after=false) is refused', () => {
  const ctx = ctxBase();
  ctx.guard = { before: true, after: false };
  return { ok: validateRegressionEvidence(makeEvidence(), ctx).some((p) => /guard AFTER/.test(p)) };
});
control('a NON-ZERO stage status is refused', () => {
  const ev = makeEvidence();
  ev.stages[0].status = 2;
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /non-zero/.test(p)) };
});
control('a NATIVE spawn error on a stage is refused', () => {
  const ev = makeEvidence();
  ev.stages[0].spawnError = 'spawn ENOENT';
  return { ok: validateRegressionEvidence(ev, ctxBase()).some((p) => /spawn error/.test(p)) };
});

// ---- failure propagation ---------------------------------------------------
control('every adverse case yields at least one problem (a red run is never green)', () => {
  const bad = [
    (() => { const e = makeEvidence(); delete e.runtime; return e; })(),
    (() => { const e = makeEvidence(); e.stages[0].status = 1; return e; })(),
    (() => { const e = makeEvidence(); e.identity.count = 0; e.identity.expected = 0; return e; })(),
  ];
  const allRefused = bad.every((e) => validateRegressionEvidence(e, ctxBase()).length > 0);
  const valid = validateRegressionEvidence(makeEvidence(), ctxBase());
  return { ok: allRefused && valid.length === 0, detail: `adverse=${allRefused} validProblems=${valid.length}` };
});

// ---- cross-worktree suite identity -----------------------------------------
control('same logical visual suite from two worktrees normalises equal', () => {
  const a = normalizeVisualSuite('C:/dev/main/wt-A/apps/e2e/tests/routes.spec.ts', 'C:/dev/main/wt-A/apps/e2e', 'apps/e2e');
  const b = normalizeVisualSuite('C:\\dev\\main\\wt-B\\apps\\e2e\\tests\\routes.spec.ts', 'C:/dev/main/wt-B/apps/e2e', 'apps/e2e');
  return { ok: a === 'tests/routes.spec.ts' && a === b, detail: `${a} vs ${b}` };
});

// ---- argv builder (no shell interpolation) ---------------------------------
control('Linux runner argv is bash + positional values (no -c interpolation)', () => {
  const r = buildPortableRunnerArgv({ script: '/r/run-linux-capture.sh', mode: 'regression', positional: ['/arch', '/gold', '/out'] }, { platform: 'linux' });
  return {
    ok: r.file === 'bash' && r.args[0] === '/r/run-linux-capture.sh' && r.args[1] === 'regression' && r.args.slice(2).join(',') === '/arch,/gold,/out' && !r.args.some((a) => /[\n;]/.test(a)),
    detail: JSON.stringify(r.args),
  };
});
control('Windows runner argv uses Git Bash with a fixed pwd -W bridge and disabled path conversion', () => {
  const r = buildPortableRunnerArgv({ script: 'C:/repo/apps/e2e/linux/run-linux-capture.sh', mode: 'regression', positional: ['C:/arch', 'C:/gold', 'C:/out'] }, { platform: 'win32', bashPath: 'C:/Program Files/Git/bin/bash.exe' });
  const hasBridge = r.args.includes('cd "$(pwd -W 2>/dev/null || pwd)" && exec bash "$@"');
  const positional = r.args.slice(r.args.indexOf('bash') + 1);
  return {
    ok:
      r.file === 'C:/Program Files/Git/bin/bash.exe' &&
      hasBridge &&
      positional.join(',') === 'C:/repo/apps/e2e/linux/run-linux-capture.sh,regression,C:/arch,C:/gold,C:/out' &&
      r.env.MSYS_NO_PATHCONV === MSYS_DISABLE_ENV.MSYS_NO_PATHCONV &&
      r.env.MSYS2_ARG_CONV_EXCL === MSYS_DISABLE_ENV.MSYS2_ARG_CONV_EXCL,
    detail: `${r.file} :: ${r.args.join(' ')}`,
  };
});
control('rendererCanonical is order-stable and content-sensitive', () => {
  const a = rendererCanonical(makeRuntime());
  const b = rendererCanonical({ ...makeRuntime(), fonts: { ...makeRuntime().fonts } });
  const c = rendererCanonical({ ...makeRuntime(), fonts: { ...makeRuntime().fonts, listSha256: 'd'.repeat(64) } });
  return { ok: a === b && a !== c };
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }

process.stdout.write(`\n[pinned-visual-controls] ${results.length - failures}/${results.length} controls passed\n`);
if (failures > 0) {
  process.stderr.write(`[pinned-visual-controls] ${failures} control(s) FAILED\n`);
  process.exit(1);
}
process.stdout.write('[pinned-visual-controls] ALL PASS\n');
