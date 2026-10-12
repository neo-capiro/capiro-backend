#!/usr/bin/env node
/**
 * Source-scope regression controls (round-17, extended round-35). Exercises the
 * REAL exported scope predicate (lib/source-identity.mjs inMeasuredScope) against
 * actual product vs generated-output paths — a decision table, not a
 * re-implementation.
 *
 *   node apps/e2e/linux/tests/source-scope-controls.mjs
 *
 * Round-35 additions: the pipeline's OWNED ephemeral output dirs written DURING
 * capture (`.capture-staging-*`, `.diagnostic-staging-*`, `.baselines-old-*`,
 * `.baselines-failed-*`, dynamic pid+timestamp names) are OUT of scope, while
 * non-numeric/malformed lookalikes, deeper-nested lookalikes, same-named product
 * folders outside apps/e2e and ordinary e2e/public/shared/onboarding source stay
 * MEASURED.
 *
 * The companion FINGERPRINT-level control (walkSource/fingerprintOf on a retained
 * fixture) is apps/e2e/linux/tests/capture-output-fingerprint-controls.mjs.
 *
 * OVERLAP/kernel-provenance controls (appended below): the REAL walker is driven
 * on a retained fixture that mirrors the repo layout, proving that overlapping
 * MEASURED roots (the `apps/e2e` directory plus the explicit `apps/e2e/lib/*.mjs`
 * kernel inputs) collapse to ONE record per unique path, that a manifest produced
 * from those UNIQUE measured bytes verifies against the actual walker, that
 * mutating EACH of the three kernel files changes the fingerprint and fails
 * verification, and that a MISSING required kernel input fails the walk.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inMeasuredScope,
  walkSource,
  fingerprintOf,
  writeSourceManifest,
  verifyManifest,
  comparePaths,
  MEASURED_INPUTS,
} from '../../lib/source-identity.mjs';

const CASES = [
  // Actual LegiWatch product source under a folder NAMED reports → IN scope.
  ['apps/web/src/vnext/pages/legiwatch/reports/ReportWorkspace.tsx', true],
  ['apps/web/src/vnext/pages/legiwatch/reports/ReportWorkspace.test.tsx', true],
  ['apps/web/src/vnext/pages/legiwatch/reports/report-api.ts', true],
  ['apps/web/src/vnext/pages/legiwatch/reports/reports.css', true],
  ['apps/web/src/vnext/pages/legiwatch/reports/RecordBriefSelection.tsx', true],
  // Generated e2e output roots → OUT of scope.
  ['apps/e2e/reports/playwright-report.json', false],
  ['apps/e2e/baselines/desktop-1440/route-x.png', false],
  ['apps/e2e/test-results/x.json', false],
  ['apps/e2e/playwright-report/index.html', false],
  // The SEPARATE onboard smoke gate's OWNED generated output dir → OUT of scope.
  // (smoke-onboard/playwright.onboard.config.ts sets outputDir to this dir; the
  //  diagnosed added path was smoke-onboard/test-results/.last-run.json.)
  ['apps/e2e/smoke-onboard/test-results/', false],
  ['apps/e2e/smoke-onboard/test-results/.last-run.json', false],
  ['apps/e2e/smoke-onboard/test-results/onboard-smoke-desktop/trace.zip', false],
  ['apps/e2e/.hermes-scratch/a.mjs', false],
  ['apps/e2e/.hermes-diagnostics/_hermes-probe.mjs', false],
  ['apps/e2e/.source-archive/source-x.tar', false],
  // Known local diagnostics / generated files → OUT of scope.
  ['apps/e2e/.dbg.mjs', false],
  // A product source with a similar suffix still belongs to the manifest.
  ['apps/web/src/x.dbg.mjs', true],
  ['apps/e2e/foo.log', false],
  ['apps/e2e/tsconfig.visual-typecheck.json', false],
  // Ordinary measured source → IN scope.
  ['apps/web/src/vnext/testing/visual/routes-visual-api.ts', true],
  ['packages/shared/src/index.ts', true],
  ['apps/onboard-web/src/App.tsx', true],
  ['package.json', true],
  ['pnpm-lock.yaml', true],
  // Outside every measured input → OUT of scope.
  ['apps/api/src/main.ts', false],
  ['docs/x.md', false],

  // ── round-35: OWNED ephemeral OUTPUT dirs immediately under apps/e2e, written
  //    DURING capture with dynamic pid+timestamp names → OUT of scope. ─────────
  ['apps/e2e/.capture-staging-12345-1760000000000/', false],
  ['apps/e2e/.capture-staging-12345-1760000000000/desktop-1440/route-x.png', false],
  ['apps/e2e/.capture-staging-12345-1760000000000/manifest.json', false],
  ['apps/e2e/.capture-staging-12345-1760000000000/source-manifest.json', false],
  ['apps/e2e/.diagnostic-staging-12345-1760000000000/manifest.json', false],
  ['apps/e2e/.diagnostic-staging-12345-1760000000000/source-manifest.json', false],
  ['apps/e2e/.baselines-old-12345-1760000000000/desktop-1440/route-x.png', false],
  ['apps/e2e/.baselines-old-12345-1760000000000.receipt.json', false],
  ['apps/e2e/.baselines-failed-12345-1760000000000/desktop-1440/route-x.png', false],

  // ── round-35 NEGATIVE lookalikes that MUST stay MEASURED ────────────────────
  //  (a) product source under an identically named folder OUTSIDE apps/e2e
  ['apps/web/src/features/.capture-staging-12345-1760000000000/Page.tsx', true],
  ['packages/shared/src/.baselines-old-12345-1760000000000/index.ts', true],
  //  (b) ordinary e2e harness source (the very files that define the scope)
  ['apps/e2e/lib/source-identity.mjs', true],
  ['apps/e2e/scripts/capture-baselines.mjs', true],
  ['apps/e2e/linux/tests/capture-output-fingerprint-controls.mjs', true],
  //  (b2) the onboard smoke SPEC + CONFIG are REAL measured source — only the
  //       generated `test-results` OUTPUT subtree under smoke-onboard is excluded.
  ['apps/e2e/smoke-onboard/onboard-smoke.spec.ts', true],
  ['apps/e2e/smoke-onboard/playwright.onboard.config.ts', true],
  //  (b3) NEGATIVE component-boundary + no-global-basename controls: a lookalike
  //       `test-results` name (extra chars, no boundary), a same-named dir in an
  //       OTHER measured root, and a `.last-run.json` NOT under the owned onboard
  //       output path all stay MEASURED (no blanket basename/extension rule).
  ['apps/e2e/smoke-onboard/test-results-extra/x.json', true],
  ['apps/e2e/smoke-onboard/test-resultsx/.last-run.json', true],
  ['apps/e2e/lib/test-results/x.mjs', true],
  ['apps/e2e/lib/.last-run.json', true],
  ['apps/web/src/features/test-results/x.ts', true],
  //  (c) malformed / non-numeric lookalike names (spelling is STRICT) → measured
  ['apps/e2e/.capture-staging-abc-12345/x.mjs', true],
  ['apps/e2e/.capture-staging-12345-abc/x.mjs', true],
  ['apps/e2e/.capture-staging-12345/x.mjs', true],
  ['apps/e2e/.capture-staging-12345-1760000000000extra/x.mjs', true],
  ['apps/e2e/.capture-staging/x.mjs', true],
  ['apps/e2e/x.capture-staging-12345-1760000000000/x.mjs', true],
  ['apps/e2e/.baselines-oldish-12345-1760000000000/x.mjs', true],
  ['apps/e2e/.diagnostic-staging-12345-1760000000000-extra/x.mjs', true],
  //  (d) real path-component boundary: NOT immediately under apps/e2e → measured
  ['apps/e2e/sub/.capture-staging-12345-1760000000000/x.mjs', true],
  //  (e) real public + shared + onboarding source stays measured
  ['apps/web/public/brand.svg', true],
  ['apps/web/public/fonts/inter.woff2', true],
  ['packages/shared/src/contracts/visual.ts', true],
  ['apps/onboard-web/src/pages/Register.tsx', true],
  ['apps/onboard-web/public/logo.svg', true],
  ['apps/onboard-web/smoke/onboard.spec.ts', true],
];

let fail = 0;
for (const [p, expected] of CASES) {
  const got = inMeasuredScope(p);
  if (got === expected) console.log(`ok   ${got ? 'IN ' : 'OUT'}  ${p}`);
  else { console.error(`FAIL ${p}: got ${got} want ${expected}`); fail++; }
}

// ── OVERLAP / kernel-provenance controls ────────────────────────────────────
// These drive the REAL walker, verifier and manifest writer on a RETAINED
// fixture tree that mirrors the repo layout: every canonical MEASURED input is
// materialised, so walkSource's REQUIRED check passes AND the overlapping roots
// (`apps/e2e` directory + explicit `apps/e2e/lib/*.mjs` kernel files) genuinely
// coexist on disk. The fixture is written under the excluded `.hermes-scratch`
// prefix, so it can never perturb the real repo's measured fingerprint.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const STAMP = `${process.pid}-${Date.now()}`;
const FIXTURE = path.join(REPO, 'apps', 'e2e', '.hermes-scratch', `source-scope-${STAMP}`);
const KERNEL_FILES = [
  'apps/e2e/lib/renderer-contract.mjs',
  'apps/e2e/lib/render-context.mjs',
  'apps/e2e/lib/playwright-report.mjs',
];

const ctl = (name, ok, detail = '') => {
  if (ok) console.log(`ok   ${name}`);
  else { console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); fail++; }
};
const short = (h) => (typeof h === 'string' ? h.slice(0, 16) : String(h));
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const writeFixture = (rel, data) => {
  const abs = path.join(FIXTURE, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data, 'utf8');
};

const looksLikeFile = (rel) => /\.[a-z0-9]+$/i.test(rel);
for (const rel of MEASURED_INPUTS) {
  if (looksLikeFile(rel)) writeFixture(rel, `fixture file: ${rel}\n`);
  else {
    const abs = path.join(FIXTURE, rel);
    mkdirSync(abs, { recursive: true });
    writeFileSync(path.join(abs, 'index.fixture.txt'), `fixture dir seed: ${rel}\n`, 'utf8');
  }
}
ctl('fixture is OUTSIDE the real measured scope',
  inMeasuredScope(path.relative(REPO, FIXTURE).split(path.sep).join('/')) === false);

// (1) Overlapping directory + explicit roots → each unique path recorded ONCE.
const walked = walkSource(FIXTURE);
const counts = new Map();
for (const f of walked) counts.set(f.path, (counts.get(f.path) || 0) + 1);
const dups = [...counts].filter(([, n]) => n > 1).map(([p]) => p);
ctl('overlapping roots produce no duplicate records', dups.length === 0, dups.join(', '));
ctl('every measured record path is unique', walked.length === counts.size, `${walked.length} records / ${counts.size} unique`);
ctl('measured records stay in canonical path order',
  walked.every((f, i) => i === 0 || comparePaths(walked[i - 1].path, f.path) < 0));
for (const k of KERNEL_FILES) ctl(`kernel input recorded exactly once: ${k}`, counts.get(k) === 1, String(counts.get(k)));

// (2) A manifest of the UNIQUE measured bytes verifies against the actual walker
//     (the exact archive→verifier agreement that failed on the real Linux run).
const doc = writeSourceManifest(walked, path.join(FIXTURE, 'source-manifest.json'),
  { head: 'a'.repeat(40), treeHash: 'b'.repeat(40) });
const verified = verifyManifest(doc, FIXTURE);
ctl('manifest of unique measured bytes verifies against the walker',
  verified.ok === true, JSON.stringify(verified.errors || []));

// (3) Mutating EACH kernel file changes the fingerprint and FAILS verification.
for (const k of KERNEL_FILES) {
  const before = fingerprintOf(walkSource(FIXTURE));
  writeFixture(k, `mutated kernel bytes for ${k} ${STAMP}\n`);
  const after = fingerprintOf(walkSource(FIXTURE));
  ctl(`mutating ${k} changes the fingerprint`, after !== before, `${short(before)} -> ${short(after)}`);
  const v = verifyManifest(doc, FIXTURE);
  ctl(`mutating ${k} fails verification`, v.ok === false && (v.changed || []).includes(k), JSON.stringify(v.errors || []));
  writeFixture(k, `fixture file: ${k}\n`); // restore seeded bytes
}

// (4) A MISSING required kernel input FAILS the walk (never silently skipped).
for (const k of KERNEL_FILES) {
  rmSync(path.join(FIXTURE, k), { force: true });
  ctl(`missing required kernel input fails walkSource: ${k}`, throws(() => walkSource(FIXTURE)));
  writeFixture(k, `fixture file: ${k}\n`); // restore
}

console.log(`\nfixture retained at: ${FIXTURE}`);
console.log(fail ? '\nsource-scope controls: FAILURES' : '\nsource-scope controls: ALL PASS');
process.exit(fail ? 1 : 0);
