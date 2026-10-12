#!/usr/bin/env node
/**
 * FINGERPRINT-level controls for the owned capture/publish OUTPUT scope
 * (round-35). Companion to source-scope-controls.mjs (which is a pure predicate
 * decision table); this one drives the ACTUAL exported walker:
 *
 *   node apps/e2e/linux/tests/capture-output-fingerprint-controls.mjs
 *
 * It builds a FRESH, RETAINED fixture tree that mirrors the repo layout and
 * contains EVERY canonical REQUIRED/MEASURED input, then:
 *   A. establishes a baseline fingerprint with the REAL walkSource/fingerprintOf;
 *   B. creates + MODIFIES the owned generated-output dirs the capture pipeline
 *      writes DURING a run (.capture-staging-* / .diagnostic-staging-* /
 *      .baselines-old-* / .baselines-failed-*) and proves the measured source
 *      fingerprint is UNCHANGED — the round-31 self-induced before≠after bug;
 *   C. proves a MALFORMED/non-numeric lookalike under apps/e2e (ordinary source)
 *      and a real Web/public/shared/onboard/harness source mutation DO change it;
 *   D. proves the Git dirtiness filter (gitMeasuredDirty) reuses the same scope
 *      and never reports generated output as source dirt.
 *
 * Round-36: section D now drives a REAL git repository created INSIDE the
 * retained fixture (porcelain v2 -z protocol, the exact args the library uses)
 * — first unstaged tracked modification, a space+Unicode+quote path, renames
 * INTO and OUT OF measured roots, and generated outputs vs real source — plus
 * pure parser-protocol probes (NUL records) and fail-closed checks for malformed
 * records. The trimming contract of the real callers (`stdout.trim()`) is applied
 * by `realGit`. This fixes the round-35 fixture ENOENT (the `apps/e2e/scripts`
 * parent was never created) by writing every fixture file through `writeFixture`.
 *
 * NO application, browser or container is executed here. The fixture is RETAINED
 * (never recursively deleted) and its path is printed for inspection. Exit code
 * is 0 only when every control passes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  walkSource,
  fingerprintOf,
  inMeasuredScope,
  isOwnedOutputRel,
  gitMeasuredDirty,
  MEASURED_INPUTS,
  REQUIRED_INPUTS,
} from '../../lib/source-identity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..'); // apps/e2e/linux/tests -> repo root
const STAMP = `${process.pid}-${Date.now()}`;
const OUT_STAMP = `${process.pid}-${Date.now()}`;
// Retained, and deliberately under an EXCLUDED prefix (.hermes-scratch) so the
// fixture can never perturb the REAL repo's measured source fingerprint.
const FIXTURE = path.join(REPO, 'apps', 'e2e', '.hermes-scratch', `fingerprint-controls-${STAMP}`);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`ok   ${name}`);
  else { console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
};
const short = (h) => (typeof h === 'string' ? h.slice(0, 16) : String(h));

// ── fixture construction ────────────────────────────────────────────────────
const looksLikeFile = (rel) => /\.[a-z0-9]+$/i.test(rel);
function seedInput(rel) {
  const abs = path.join(FIXTURE, rel);
  if (looksLikeFile(rel)) {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, `fixture file: ${rel}\n`, 'utf8');
  } else {
    mkdirSync(abs, { recursive: true });
    writeFileSync(path.join(abs, 'index.fixture.txt'), `fixture dir seed: ${rel}\n`, 'utf8');
  }
}
mkdirSync(FIXTURE, { recursive: true });
for (const rel of MEASURED_INPUTS) seedInput(rel);

// Write a fixture file, creating EVERY missing parent directory first. The
// round-35 control wrote `apps/e2e/scripts/mutated-*.mjs` directly and stopped
// with ENOENT because the `apps/e2e/scripts` parent was never seeded (only the
// bare `apps/e2e` dir is in MEASURED_INPUTS). Every fixture write goes through
// here so no fixture exception can recur.
const writeFixture = (rel, data) => {
  const abs = path.join(FIXTURE, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data, 'utf8');
};

const relFixture = path.relative(REPO, FIXTURE).split(path.sep).join('/');
check('fixture is OUTSIDE the real measured scope', inMeasuredScope(relFixture) === false, relFixture);

// ── A. baseline fingerprint via the REAL walker ─────────────────────────────
// (walkSource throws if any REQUIRED_INPUT is absent, so this also proves the
//  fresh fixture contains every canonical required input before we proceed.)
const baseFiles = walkSource(FIXTURE);
const baseFp = fingerprintOf(baseFiles);
check('baseline manifest non-empty', baseFiles.length > 0, `${baseFiles.length} files`);
check('baseline fingerprint is 64-hex', /^[0-9a-f]{64}$/.test(baseFp), short(baseFp));
check('every required input present in fixture', REQUIRED_INPUTS.every((rel) => baseFiles.some((f) => f.path === rel || f.path.startsWith(`${rel}/`))));

let current = baseFp;
const fpNow = () => fingerprintOf(walkSource(FIXTURE));

// ── B. owned generated output created/modified DURING capture → NO change ───
const ownedDirs = [
  `.capture-staging-${OUT_STAMP}`,
  `.diagnostic-staging-${OUT_STAMP}`,
  `.baselines-old-${OUT_STAMP}`,
  `.baselines-failed-${OUT_STAMP}`,
];
for (const name of ownedDirs) {
  const dir = path.join(FIXTURE, 'apps', 'e2e', name);
  mkdirSync(path.join(dir, 'desktop-1440'), { recursive: true });
  writeFileSync(path.join(dir, 'desktop-1440', 'route-x.png'), Buffer.from(`PNG ${name}\n`, 'utf8'));
  writeFileSync(path.join(dir, 'manifest.json'), `{"staging":"${name}"}\n`, 'utf8');
  writeFileSync(path.join(dir, 'source-manifest.json'), `{"staging":"${name}"}\n`, 'utf8');
}
// The previous-tree receipt sits next to the owned dir (baselines-old-*.receipt.json).
writeFileSync(path.join(FIXTURE, 'apps', 'e2e', `.baselines-old-${OUT_STAMP}.receipt.json`), '{"ownedSnapshot":true}\n', 'utf8');

const fpAfterCreate = fpNow();
check('creating owned output dirs leaves fingerprint unchanged', fpAfterCreate === current, `${short(current)} -> ${short(fpAfterCreate)}`);

// Every walked path must be OUTSIDE the owned output scope (nothing leaked in).
const walkedPaths = walkSource(FIXTURE).map((f) => f.path);
check('no walked path is inside an owned output dir', walkedPaths.every((p) => isOwnedOutputRel(p) === false));
check('representative output path is out of scope', inMeasuredScope(`apps/e2e/.capture-staging-${OUT_STAMP}/desktop-1440/route-x.png`) === false);
check('representative output path is recognised as owned', isOwnedOutputRel(`apps/e2e/.capture-staging-${OUT_STAMP}/desktop-1440/route-x.png`) === true);

// Modify the generated output (re-write PNGs + manifest) → still NO change.
for (const name of ownedDirs) {
  const dir = path.join(FIXTURE, 'apps', 'e2e', name);
  writeFileSync(path.join(dir, 'desktop-1440', 'route-x.png'), Buffer.from(`PNG MODIFIED ${name} ${STAMP}\n`, 'utf8'));
  writeFileSync(path.join(dir, 'manifest.json'), `{"staging":"${name}","modified":true}\n`, 'utf8');
}
const fpAfterModify = fpNow();
check('modifying owned output files leaves fingerprint unchanged', fpAfterModify === current, `${short(current)} -> ${short(fpAfterModify)}`);

// ── B2. SEPARATE onboard smoke gate's OWNED generated output → NO change ────
// The onboard smoke config (smoke-onboard/playwright.onboard.config.ts) writes
// its OWN generated output dir `smoke-onboard/test-results` (Playwright
// `.last-run.json` etc.). It is GENERATED DIAGNOSTIC OUTPUT of an owned
// onboarding run — not source — so creating AND modifying it must leave the
// measured fingerprint unchanged (the diagnosed drift: added
// apps/e2e/smoke-onboard/test-results/.last-run.json).
const ONBOARD_OUT_REL = 'apps/e2e/smoke-onboard/test-results';
writeFixture(`${ONBOARD_OUT_REL}/.last-run.json`, '{"status":"passed","run":1}\n');
writeFixture(`${ONBOARD_OUT_REL}/onboard-smoke-desktop/trace.zip`, 'ZIP v1\n');
const fpAfterOnboardCreate = fpNow();
check('creating onboard generated output leaves fingerprint unchanged', fpAfterOnboardCreate === current, `${short(current)} -> ${short(fpAfterOnboardCreate)}`);

// Modify it (rewrite .last-run.json + trace) → STILL no change.
writeFixture(`${ONBOARD_OUT_REL}/.last-run.json`, '{"status":"passed","run":2,"rerun":true}\n');
writeFixture(`${ONBOARD_OUT_REL}/onboard-smoke-desktop/trace.zip`, 'ZIP v2 MODIFIED\n');
const fpAfterOnboardModify = fpNow();
check('modifying onboard generated output leaves fingerprint unchanged', fpAfterOnboardModify === current, `${short(current)} -> ${short(fpAfterOnboardModify)}`);
check('onboard output path is out of the measured scope', inMeasuredScope(`${ONBOARD_OUT_REL}/.last-run.json`) === false);
check('no walked path is inside the onboard generated output dir', walkSource(FIXTURE).every((f) => !f.path.startsWith(`${ONBOARD_OUT_REL}/`)));

// ── C. lookalikes + real source mutation MUST change the fingerprint ────────
const expectChange = (name, mutate) => {
  const before = current;
  mutate();
  const after = fpNow();
  check(name, after !== before, `${short(before)} -> ${short(after)}`);
  current = after;
};

// (C1) malformed/non-numeric + deeper-nested lookalikes are ORDINARY measured
//      e2e source, so writing them MUST change the fingerprint.
expectChange('non-numeric lookalike dir under apps/e2e is measured', () => {
  const d = path.join(FIXTURE, 'apps', 'e2e', `.capture-staging-${OUT_STAMP}extra`);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'leak.mjs'), 'export const leak = 1;\n', 'utf8');
});
expectChange('lookalike nested one level below apps/e2e is measured', () => {
  const d = path.join(FIXTURE, 'apps', 'e2e', 'sub', `.capture-staging-${OUT_STAMP}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'nested.mjs'), 'export const nested = 1;\n', 'utf8');
});
// (C2) product source under an identically named folder OUTSIDE apps/e2e.
expectChange('same-named product folder under apps/web/src is measured', () => {
  const d = path.join(FIXTURE, 'apps', 'web', 'src', `.capture-staging-${OUT_STAMP}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'Page.tsx'), 'export const Page = () => null;\n', 'utf8');
});
// (C3) the real rendered inputs.
expectChange('apps/web/src mutation is measured', () => {
  writeFixture(`apps/web/src/mutated-${STAMP}.ts`, 'export const w = 1;\n');
});
expectChange('apps/web/public asset mutation is measured', () => {
  writeFixture(`apps/web/public/mutated-${STAMP}.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
});
expectChange('packages/shared/src mutation is measured', () => {
  writeFixture(`packages/shared/src/mutated-${STAMP}.ts`, 'export const s = 1;\n');
});
expectChange('apps/onboard-web/src mutation is measured', () => {
  writeFixture(`apps/onboard-web/src/mutated-${STAMP}.tsx`, 'export const O = () => null;\n');
});
expectChange('apps/e2e harness source mutation is measured', () => {
  writeFixture(`apps/e2e/scripts/mutated-${STAMP}.mjs`, 'export const h = 1;\n');
});
// (C4) the REAL onboard smoke spec/config are nearby smoke source (only the
//      generated test-results OUTPUT subtree is excluded) → mutation measured.
expectChange('apps/e2e/smoke-onboard spec source mutation is measured', () => {
  writeFixture('apps/e2e/smoke-onboard/onboard-smoke.spec.ts', `export const spec = ${STAMP};\n`);
});
expectChange('apps/e2e/smoke-onboard config source mutation is measured', () => {
  writeFixture('apps/e2e/smoke-onboard/playwright.onboard.config.ts', `export default { stamp: ${STAMP} };\n`);
});

// ── D. Git dirtiness filter reuses the ONE scope predicate ─────────────────
// A REAL git repository is created INSIDE the retained fixture (already an
// excluded .hermes-scratch path) so the parser is exercised against ACTUAL
// `git status --porcelain=v2 -z` output — not a hand-written fake. `realGit`
// applies the EXACT contract of the production callers (`stdout.trim()`), which
// is what silently corrupted the old v1 `slice(3)` parse.
const runGit = (args) => {
  const r = spawnSync('git', args, { cwd: FIXTURE, encoding: 'utf8' });
  if (r.error || typeof r.status !== 'number') throw new Error(`git ${args.join(' ')} could not run: ${r.error ? r.error.message : 'no exit code'}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
};
const realGit = (args) => { // production-caller contract: trim stdout
  const r = spawnSync('git', args, { cwd: FIXTURE, encoding: 'utf8' });
  if (r.error || typeof r.status !== 'number') return null;
  return r.status === 0 ? r.stdout.trim() : null;
};

runGit(['init', '-q']);
runGit(['config', 'user.email', 'fixture@example.invalid']);
runGit(['config', 'user.name', 'Fixture Control']);
runGit(['config', 'commit.gpgsign', 'false']);
runGit(['config', 'core.autocrlf', 'false']);
runGit(['config', 'core.safecrlf', 'false']);
runGit(['config', 'core.longpaths', 'true']); // deep fixture paths on Windows
runGit(['config', 'status.renames', 'true']); // deterministic rename records
runGit(['add', '-A']);
runGit(['commit', '-qm', 'fixture baseline']);

// (D1) FIRST unstaged tracked modification — the exact case that broke v1:
// `git status` prints ` M apps/web/src/main.tsx`, the caller trims to
// `M apps/web/src/main.tsx`, and the old slice(3) dropped the leading `a`.
writeFixture('apps/web/src/main.tsx', 'export const main = 2;\n');
runGit(['add', '--', 'apps/web/src/main.tsx']);
runGit(['commit', '-qm', 'track main']);
writeFixture('apps/web/src/main.tsx', 'export const main = 3;\n'); // unstaged now

// (D2) space + Unicode path (v1 would C-quote it; v2 -z keeps it verbatim).
const WEIRD = 'apps/web/src/dir with space/файл-ünïcode name.ts';
writeFixture(WEIRD, 'export const w = 1;\n');
runGit(['add', '--', WEIRD]);
runGit(['commit', '-qm', 'track weird']);
writeFixture(WEIRD, 'export const w = 2;\n'); // unstaged now

// Track the SOURCES of the three renames first, then perform the renames, so
// every staged rename is still UNCOMMITTED when we measure the dirtiness.
writeFixture('docs/moved-in-source.ts', 'export const mi = 1;\n');
runGit(['add', '--', 'docs/moved-in-source.ts']);
runGit(['commit', '-qm', 'track moved-in source']);
writeFixture('apps/web/src/moved-out-source.ts', 'export const mo = 1;\n');
runGit(['add', '--', 'apps/web/src/moved-out-source.ts']);
runGit(['commit', '-qm', 'track moved-out source']);
writeFixture('apps/web/src/within-a.ts', 'export const wa = 1;\n');
runGit(['add', '--', 'apps/web/src/within-a.ts']);
runGit(['commit', '-qm', 'track within-a']);

// (D3) rename INTO the measured roots (old path OUT of scope, new path IN).
runGit(['mv', 'docs/moved-in-source.ts', 'apps/web/src/moved-in-source.ts']);
// (D4) rename OUT of the measured roots (old path IN, new path OUT).
runGit(['mv', 'apps/web/src/moved-out-source.ts', 'docs/moved-out-source.ts']);
// (D4b) rename WITHIN the measured roots (both sides IN) — a deterministic
// real type-2 record that must preserve BOTH paths.
runGit(['mv', 'apps/web/src/within-a.ts', 'apps/web/src/within-b.ts']);

// (D5) generated output the pipeline writes DURING capture → NEVER dirt.
const GEN_STAMP = `${process.pid}-${Date.now()}`;
writeFixture(`apps/e2e/.capture-staging-${GEN_STAMP}/desktop-1440/route-x.png`, 'PNG\n');
writeFixture(`apps/e2e/.capture-staging-${GEN_STAMP}/manifest.json`, '{"staging":true}\n');
writeFixture('apps/e2e/reports/generated.json', '{"report":true}\n');
// The onboard smoke gate's OWNED generated output (committed at the baseline
// commit above, then modified here) → a real dirty record OUTSIDE the measured
// scope, so it must be filtered out of the reported source dirt.
writeFixture('apps/e2e/smoke-onboard/test-results/.last-run.json', `{"status":"passed","mod":${GEN_STAMP}}\n`);

const dirty = gitMeasuredDirty(FIXTURE, realGit);
const hasPath = (list, p) => Array.isArray(list) && list.some((e) => e.includes(p));
check('git dirtiness is known (array) with a real repo', Array.isArray(dirty), JSON.stringify(dirty));
check('real git: first unstaged tracked modification is reported', hasPath(dirty, 'apps/web/src/main.tsx'), JSON.stringify(dirty));
check('real git: space+Unicode path reported VERBATIM', hasPath(dirty, WEIRD), JSON.stringify(dirty));
check('real git: rename INTO measured roots is reported', hasPath(dirty, 'apps/web/src/moved-in-source.ts'), JSON.stringify(dirty));
check('real git: rename OUT of measured roots is reported', hasPath(dirty, 'apps/web/src/moved-out-source.ts'), JSON.stringify(dirty));
check('real git: within-measured rename keeps BOTH old and new paths',
  dirty.some((e) => e.includes('apps/web/src/within-a.ts') && e.includes('apps/web/src/within-b.ts')), JSON.stringify(dirty));
check('real git: generated output dir is NOT dirt', dirty.every((e) => !e.includes('.capture-staging-')), JSON.stringify(dirty));
check('real git: generated report file is NOT dirt', dirty.every((e) => !e.includes('apps/e2e/reports/')), JSON.stringify(dirty));
check('real git: onboard generated output dir is NOT dirt', dirty.every((e) => !e.includes('smoke-onboard/test-results')), JSON.stringify(dirty));
check('real git: exactly the 5 measured changes are reported', dirty.length === 5, JSON.stringify(dirty));
check('git dirtiness unknown (null) when Git absent', gitMeasuredDirty(FIXTURE, () => null) === null);

// ── D2. pure parser-protocol probes (v2 -z NUL records, no Git needed) ──────
const H = 'a'.repeat(40);
const v2z = (records) => `${records.join('\0')}\0`;
const probe = (raw) => gitMeasuredDirty(FIXTURE, () => raw);
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

check('v2: untracked + worktree-modified both kept',
  JSON.stringify(probe(v2z([
    '? apps/e2e/lib/new-harness.mjs',
    `1 .M N... 100644 100644 100644 ${H} ${H} apps/web/src/main.tsx`,
  ]))) === JSON.stringify(['?? apps/e2e/lib/new-harness.mjs', '.M apps/web/src/main.tsx']));
check('v2: rename record carries old -> new (new path measured)',
  JSON.stringify(probe(v2z([
    `2 R. N... 100644 100644 100644 ${H} ${H} R100 apps/web/src/renamed-in.ts`,
    'docs/original.ts',
  ]))) === JSON.stringify(['R. docs/original.ts -> apps/web/src/renamed-in.ts']));
check('v2: rename OUT of measured roots keeps the old (measured) path',
  JSON.stringify(probe(v2z([
    `2 R. N... 100644 100644 100644 ${H} ${H} R100 docs/renamed-out.ts`,
    'apps/web/src/renamed-out.ts',
  ]))) === JSON.stringify(['R. apps/web/src/renamed-out.ts -> docs/renamed-out.ts']));
check('v2: path with spaces/Unicode survives NUL-delimited parsing',
  JSON.stringify(probe(v2z([
    `1 .M N... 100644 100644 100644 ${H} ${H} apps/web/src/dir with space/файл name.ts`,
  ]))) === JSON.stringify(['.M apps/web/src/dir with space/файл name.ts']));
check('v2: internal newline in a path is preserved',
  probe(v2z([`? apps/e2e/lib/two\nlines.mjs`])).length === 1 && probe(v2z([`? apps/e2e/lib/two\nlines.mjs`]))[0].includes('two\nlines.mjs'));
check('v2: generated output dropped by the ONE scope predicate', JSON.stringify(probe(v2z([`? apps/e2e/.capture-staging-1-2/route.png`]))) === JSON.stringify([]));
check('v2: unknown record type FAILS CLOSED', throws(() => probe(v2z(['X not-a-valid-record']))));
check('v2: missing fields FAIL CLOSED', throws(() => probe(v2z(['1 .M']))));
check('v2: absolute path FAILS CLOSED', throws(() => probe(v2z([`1 .M N... 100644 100644 100644 ${H} ${H} /etc/passwd`]))));
check('v2: rename without original path FAILS CLOSED', throws(() => probe(v2z([`2 R. N... 100644 100644 100644 ${H} ${H} R100 apps/web/src/x.ts`]))));
check('v2: truncated out-of-scope record FAILS CLOSED', throws(() => probe('? docs/x.md')));
check('v2: non-string output FAILS CLOSED', throws(() => probe(undefined)));
check('v2: empty intermediate record FAILS CLOSED', throws(() => probe('? docs/x.md\0\0')));
check('v2: unknown status columns FAIL CLOSED', throws(() => probe(v2z([`1 QQ N... 100644 100644 100644 ${H} ${H} docs/x.md`]))));
check('v2: invalid submodule metadata FAILS CLOSED', throws(() => probe(v2z([`1 .M BAD! 100644 100644 100644 ${H} ${H} docs/x.md`]))));
check('v2: invalid mode metadata FAILS CLOSED', throws(() => probe(v2z([`1 .M N... badmode 100644 100644 ${H} ${H} docs/x.md`]))));
check('v2: invalid object hash FAILS CLOSED', throws(() => probe(v2z([`1 .M N... 100644 100644 100644 not-a-hash ${H} docs/x.md`]))));
check('v2: invalid rename score FAILS CLOSED', throws(() => probe(v2z([`2 R. N... 100644 100644 100644 ${H} ${H} R101 docs/x.md`, 'docs/old.md']))));
check('v2: parent traversal FAILS CLOSED', throws(() => probe(v2z(['? ../outside.ts']))));
check('v2: drive-relative path FAILS CLOSED', throws(() => probe(v2z(['? C:outside.ts']))));

// ── E. isOwnedOutputRel strictness (numeric spelling + component boundary) ──
const owned = (p) => isOwnedOutputRel(p);
check('owned: capture-staging numeric', owned(`apps/e2e/.capture-staging-1-2/x`) === true);
check('owned: dir itself', owned('apps/e2e/.capture-staging-1-2') === true);
check('owned: diagnostic-staging numeric', owned('apps/e2e/.diagnostic-staging-1-2/x') === true);
check('owned: baselines-old numeric', owned('apps/e2e/.baselines-old-1-2/x') === true);
check('owned: baselines-failed numeric', owned('apps/e2e/.baselines-failed-1-2/x') === true);
check('reject: non-numeric pid', owned('apps/e2e/.capture-staging-abc-2/x') === false);
check('reject: non-numeric timestamp', owned('apps/e2e/.capture-staging-1-abc/x') === false);
check('reject: extra dash component', owned('apps/e2e/.capture-staging-1-2-3/x') === false);
check('reject: trailing chars', owned('apps/e2e/.capture-staging-1-2extra/x') === false);
check('reject: nested below apps/e2e', owned('apps/e2e/sub/.capture-staging-1-2/x') === false);
check('reject: same name outside apps/e2e', owned('apps/web/src/.capture-staging-1-2/x') === false);
check('reject: basename lookalike without dot', owned('apps/e2e/x.capture-staging-1-2/y') === false);

// ── report ─────────────────────────────────────────────────────────────────
console.log(`\nfixture retained at: ${FIXTURE}`);
console.log(`baseline fingerprint: ${baseFp}`);
console.log(failures ? `\ncapture-output fingerprint controls: ${failures} FAILURE(S)` : '\ncapture-output fingerprint controls: ALL PASS');
process.exit(failures ? 1 : 0);
