#!/usr/bin/env node
/**
 * gate:cleanup1 — the CleanUp1 acceptance gate (plan §9, §10), as a
 * cross-platform Node driver instead of a fragile `&&` chain.
 *
 * It runs, fail-closed:
 *   core   — full `pnpm turbo run typecheck` + `pnpm turbo run test` with ONLY
 *            @capiro/e2e excluded (every OTHER dynamically discovered
 *            test-bearing package is covered), the structural mirror verifier,
 *            the reviewed five-runner test-proof fixtures, all four architecture
 *            guards, and the GATE-OWNED pinned visual lane (below) so core's
 *            full-test claim includes e2e without rendering it on the host.
 *   e2e    — the Playwright visual package, satisfied ONLY by a FRESH pinned
 *            portable regression the gate itself produces: the gate builds a
 *            fresh immutable source archive and invokes
 *            apps/e2e/linux/run-linux-capture.sh regression through the
 *            shell-safe positional argv bridge, then re-validates the emitted
 *            apps/e2e/reports/regression-evidence.json against a ROOT-built
 *            context (current source, verified archive, baseline manifest + all
 *            PNG bytes before/after, raw --list/run reports for BOTH stages,
 *            host-observed route guard) via
 *            scripts/cleanup-gates/lib/pinned-visual.mjs. A bare-host
 *            `pnpm --filter @capiro/e2e test` run is NOT the pinned image and is
 *            NEVER mapped to the e2e requirement. A missing package or a
 *            missing/malformed/incomplete evidence object is a FAILURE, never a
 *            skip, and there is no host rendering fallback. The lane runs ONCE
 *            per gate invocation (all/e2e/core reuse it — no double invocation).
 *   python — ruff + mypy + pytest (with coverage) against the frozen uv lock.
 *   all    — core + e2e + python.
 *
 * Scope is discovered at run time from the workspace globs. An unclassified
 * runner segment, zero discovered packages, a missing required result, a dirty
 * working tree, a stale/mutable coverage baseline, or missing cross-lane
 * evidence are all hard failures (exit 1). No step is ever skipped silently and
 * no non-zero exit is swallowed.
 *
 * Usage:
 *   node scripts/cleanup-gates/gate.mjs --phase all|core|guards|python|e2e
 *        [--base origin/main] [--json <path>] [--allow-dirty] [--quiet]
 *
 * Exit: 0 all requested steps passed; 1 a step failed, scope was incomplete, or
 *       a required artifact/setup was missing; 2 usage error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, runArgv, capture, captureArgv } from './lib/runner.mjs';
import { buildScope } from './lib/scope.mjs';
import { SETUP_NOTES } from './lib/quirks.mjs';
import { parseArgs, guardRef, withUsage } from './lib/cli.mjs';
import {
  ARCHITECTURE_GUARDS,
  MIRROR_VERIFIER,
  E2E_PACKAGE,
  E2E_PACKAGE_DIR,
  PYTHON_APP_DIR,
  PYTHON_SYNC_ARGS,
  PYTHON_CHECKS,
  DEFAULT_BASE_REF,
  PLAN_MAPPING,
  TEST_PROOF_FIXTURES,
  BASELINE_JSON,
  BASELINE_VERIFIER,
  REQUIRED_EVIDENCE,
  SMOKE_RUNNER,
  EVIDENCE_MODES,
  UNTRACKED_SOURCE_EXCLUSIONS,
  RELEVANT_SOURCE_EXT_RE,
  E2E_TURBO_TEST_FILTER,
  E2E_SOURCE_ARCHIVE_MAKER,
  E2E_ARCHIVE_DIR,
  E2E_BASELINE_DIR,
  E2E_REPORTS_DIR,
  E2E_ROUTE_GUARD,
} from './gate-config.mjs';
import { parsePorcelainZ, trackedDirtyFiles, relevantUntrackedFiles } from './lib/worktree.mjs';
import { sha256File, sha256Buffer } from './lib/metrics.mjs';
import { commitExists, isAncestor, headSha, fingerprintAt, provenancePaths, FINGERPRINT_ALGORITHM, trackedAndClean } from './lib/provenance.mjs';
import { contractFor } from './lib/script-contract.mjs';
import { readAndParseTraceFileSync } from '../cleanup-script-smoke/attempt-audit.mjs';
import { TS_RUNTIME_CLI_REL } from '../cleanup-script-smoke/ts-runtime.mjs';
import { discoverStandaloneNodeSuites } from './lib/standalone-node.mjs';
import { validateRegressionEvidence, pinnedImageRef, pinnedImageDigest, buildPortableRunnerArgv, pinnedVisualRunner } from './lib/pinned-visual.mjs';
import { walkSource as walkVisualSource, fingerprintOf as visualSourceFingerprint } from '../../apps/e2e/lib/source-identity.mjs';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const USAGE =
  'usage: node scripts/cleanup-gates/gate.mjs --phase all|core|guards|python|e2e [--base ref] [--json path] [--allow-dirty] [--quiet]';

const ARG_SPEC = {
  phase: { flag: 'phase', type: 'string', default: 'all', choices: ['all', 'core', 'guards', 'python', 'e2e'] },
  base: { flag: 'base', type: 'string', default: DEFAULT_BASE_REF },
  json: { flag: 'json', type: 'string', default: null },
  allowDirty: { flag: 'allow-dirty', type: 'flag', default: false },
  quiet: { flag: 'quiet', type: 'flag', default: false },
};

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function head() {
  const sha = capture('git rev-parse HEAD', { cwd: ROOT });
  const branch = capture('git branch --show-current', { cwd: ROOT });
  const node = process.version;
  let pnpm = 'unknown';
  const p = capture('pnpm --version', { cwd: ROOT });
  if (p.ok) pnpm = p.stdout;
  return { sha: sha.ok ? sha.stdout : null, branch: branch.ok ? branch.stdout : null, node, pnpm };
}

function printScope(scope) {
  log('[gate] discovered package/runner map (dynamic, no allowlist):');
  for (const p of scope.packages) {
    log(`        ${p.packageDir.padEnd(34)} ${p.package.padEnd(28)} runners=[${p.runners.join(',')}] tiers=[${p.tiers.join(',')}]`);
  }
  log(`[gate] test-bearing packages: ${scope.testBearingPackages.length}`);
  if (scope.pythonApps.length) log(`[gate] python apps: ${scope.pythonApps.map((a) => a.package).join(', ')}`);
  if (scope.playwrightApps.length) log(`[gate] playwright apps: ${scope.playwrightApps.map((a) => a.package).join(', ')}`);
}

// ---- Gate-owned pinned visual lane (round 60) ------------------------------
// The GATE (not the workflow, not core's bare `turbo run test`) owns a FRESH
// immutable source archive and the pinned portable regression invocation, so
// @capiro/e2e NEVER renders on the bare host. The evidence is validated against
// a ROOT-built context re-derived from ACTUAL files: the current source
// fingerprint, the current verified archive, the baseline manifest + every PNG
// byte hash before/after, the raw --list/run reports for BOTH stages, and the
// host-observed route-coverage guard.

function gitTreeSha(root) {
  const r = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function currentSourceContext() {
  let fingerprint = null;
  try {
    fingerprint = visualSourceFingerprint(walkVisualSource(ROOT));
  } catch {
    fingerprint = null;
  }
  return { head: headSha(ROOT), treeHash: gitTreeSha(ROOT), fingerprint };
}

function readArchiveContext(dirAbs) {
  const p = path.join(dirAbs, 'source-manifest.json');
  if (!fs.existsSync(p)) return { ok: false, reason: `missing archive manifest ${p}` };
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ok: true, head: doc.head, treeHash: doc.treeHash, fingerprint: doc.fingerprint, fileCount: doc.fileCount };
  } catch (err) {
    return { ok: false, reason: `unreadable archive manifest: ${err.message}` };
  }
}

function baselineBytesContext(dirAbs) {
  const manifestPath = path.join(dirAbs, 'manifest.json');
  const manifestExists = fs.existsSync(manifestPath);
  const manifestSha256 = manifestExists ? sha256File(manifestPath) : null;
  // Independently read the ACTUAL baseline manifest runtime + historical source
  // identity (capturingSha/fingerprint). Never defaulted/guessed: an unreadable
  // or malformed manifest leaves these null so the validator fails closed.
  let manifestRuntime = null;
  let capturingSha = null;
  let sourceFingerprint = null;
  if (manifestExists) {
    try {
      const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifestRuntime = doc && typeof doc === 'object' ? doc.runtime ?? null : null;
      const src = doc && typeof doc.source === 'object' && doc.source ? doc.source : {};
      capturingSha = typeof src.capturingSha === 'string' ? src.capturingSha : null;
      sourceFingerprint = typeof src.sourceFingerprint === 'string' ? src.sourceFingerprint : null;
    } catch {
      /* leave nulls → fail closed in the validator */
    }
  }
  const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files[path.relative(dirAbs, p).split(path.sep).join('/')] = sha256File(p);
    }
  };
  if (fs.existsSync(dirAbs)) walk(dirAbs);
  const pngLines = Object.entries(files)
    .filter(([rel]) => rel.toLowerCase().endsWith('.png'))
    .map(([rel, sha]) => `${rel}\u0000${sha}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { manifestSha256, manifestRuntime, capturingSha, sourceFingerprint, pngCount: pngLines.length, pngDigest: sha256Buffer(Buffer.from(pngLines.join('\n'))) };
}

function runHostRouteGuard() {
  const guard = path.join(ROOT, E2E_ROUTE_GUARD);
  if (!fs.existsSync(guard)) return false;
  const r = spawnSync(process.execPath, [guard], { cwd: ROOT, windowsHide: true });
  return typeof r.status === 'number' && r.status === 0;
}

function runPinnedVisualOnce() {
  const archiveDir = path.join(ROOT, E2E_ARCHIVE_DIR);
  const goldenDir = path.join(ROOT, E2E_BASELINE_DIR);
  // FRESH, task-owned output directory for THIS native run. The lane writes its
  // evidence + raw --list/run reports here (the positional OUT_DIR), so a stale
  // same-commit report from a previous partial run can NEVER be reused: only
  // THIS run's files exist under this unique path.
  const reportsDir = path.join(ROOT, E2E_REPORTS_DIR, `.run-${Date.now()}-${process.pid}`);
  const maker = path.join(ROOT, E2E_SOURCE_ARCHIVE_MAKER);
  if (!fs.existsSync(maker)) return { code: 1, note: `missing ${E2E_SOURCE_ARCHIVE_MAKER}` };

  const mk = runArgv(process.execPath, [maker, '--write'], { cwd: ROOT, label: 'fresh immutable source archive (pinned visual owner)' });
  if (mk !== 0) return { code: 1, note: 'fresh immutable source archive build FAILED (fail closed)' };
  const arch = readArchiveContext(archiveDir);
  if (!arch.ok) return { code: 1, note: arch.reason };

  const current = currentSourceContext();
  const baselineBefore = baselineBytesContext(goldenDir);
  const guardBefore = runHostRouteGuard();

  const argv = buildPortableRunnerArgv({
    script: pinnedVisualRunner(ROOT),
    mode: 'regression',
    positional: [archiveDir, goldenDir, reportsDir],
  });
  const laneCode = runArgv(argv.file, argv.args, { cwd: ROOT, env: argv.env, label: 'pinned portable visual regression lane (gate-owned)' });

  const baselineAfter = baselineBytesContext(goldenDir);
  const guardAfter = runHostRouteGuard();
  const sourceAfter = currentSourceContext();

  const evPath = path.join(reportsDir, 'regression-evidence.json');
  if (!fs.existsSync(evPath)) return { code: 1, note: `missing fresh pinned visual evidence in this run's output dir (lane rc=${laneCode})` };
  let ev = null;
  try {
    ev = JSON.parse(fs.readFileSync(evPath, 'utf8'));
  } catch (err) {
    return { code: 1, note: `pinned visual evidence is not valid JSON: ${err.message}` };
  }

  const ctx = {
    expectedImageRef: pinnedImageRef(),
    expectedImageDigest: pinnedImageDigest(),
    reportDir: reportsDir,
    readText: (p) => fs.readFileSync(p, 'utf8'),
    exists: (p) => fs.existsSync(p),
    sha256: (p) => sha256File(p),
    archive: arch,
    baselineBefore,
    baselineAfter,
    sourceBefore: current,
    sourceAfter,
    current,
    guard: { before: guardBefore, after: guardAfter },
  };
  const problems = validateRegressionEvidence(ev, ctx);
  if (laneCode !== 0) problems.unshift(`pinned portable regression lane exited ${laneCode} (no host rendering fallback)`);
  if (problems.length === 0) {
    return {
      code: 0,
      note: `[${EVIDENCE_MODES.OWNED_LIVE_RUNTIME}] fresh immutable archive + pinned portable regression valid (raw reports + immutable baseline PNGs + complete renderer + independent identity)`,
    };
  }
  process.stderr.write(`[gate] PINNED VISUAL EVIDENCE failed its contract (${problems.length} problem(s)):\n`);
  for (const p of problems.slice(0, 30)) process.stderr.write(`        - ${p}\n`);
  return { code: 1, note: `${problems.length} pinned visual problem(s)` };
}

let pinnedVisualState = null;
function ensurePinnedVisual() {
  if (!pinnedVisualState) pinnedVisualState = runPinnedVisualOnce();
  return pinnedVisualState;
}

function main() {
  const args = parseArgs(process.argv.slice(2), ARG_SPEC);
  if (args.help) {
    log(USAGE);
    process.exit(0);
  }
  args.base = guardRef(args.base, { name: '--base' });

  const meta = head();
  log(`[gate] CleanUp1 gate — phase=${args.phase} base=${args.base}`);
  log(`[gate] HEAD=${meta.sha ?? '(none)'} branch=${meta.branch ?? '(none)'} node=${meta.node} pnpm=${meta.pnpm}`);

  const results = [];
  const notes = [];
  const record = (name, code, note) => {
    if (note) notes.push(`${name}: ${note}`);
    results.push({ name, exitCode: code, status: code === 0 ? 'PASS' : 'FAIL', note: note || null });
    return code;
  };

  // ---- Preconditions -------------------------------------------------------
  // A dirty tracked tree means the gate would be measuring uncommitted source:
  // reject it (acceptance runs on a clean checkout). Untracked RELEVANT source
  // can also influence execution while invisible to `--untracked-files=no`, so
  // it is detected with `git status --porcelain -z -uall` — a whole new source
  // directory (`?? dir/` in the default form) is expanded to every file inside
  // it, and whitespace/quoted paths are parsed exactly. `docs/` is NOT excluded
  // blanketly because it carries executable operator scripts; only declared
  // scratch/evidence trees are excluded.
  //
  // `--allow-dirty` is a development escape hatch: it may satisfy DIAGNOSTIC
  // phase runs (guards/core/python/e2e) but can NEVER satisfy the full
  // acceptance gate (`--phase all`), which fails closed on any uncommitted
  // input. The result is carried in an explicit `acceptance` predicate, not a
  // prose note.
  const acceptanceRequested = args.phase === 'all';
  const status = captureArgv('git', ['status', '--porcelain', '-z', '-uall'], { cwd: ROOT });
  // Parse the RAW bytes (`.stdoutRaw`), never the trimmed `.stdout`: the NUL
  // protocol's first tracked-only record is ` M path`, and a whole-output trim
  // drops that leading status-column space, shifting the columns and truncating
  // the path (independent review round 4, finding 1). A malformed protocol is a
  // fail-closed condition, not a silent clean tree.
  let statusRecords = [];
  let statusParseError = null;
  if (status.ok) {
    try {
      statusRecords = parsePorcelainZ(status.stdoutRaw);
    } catch (err) {
      statusParseError = err;
    }
  }
  const trackedDirty = statusParseError ? [] : trackedDirtyFiles(statusRecords);
  const relevantUntracked = statusParseError
    ? []
    : relevantUntrackedFiles(statusRecords, {
        exclusions: UNTRACKED_SOURCE_EXCLUSIONS,
        extRe: RELEVANT_SOURCE_EXT_RE,
      });
  const cleanTree = !statusParseError && trackedDirty.length === 0 && relevantUntracked.length === 0;
  const dirtyFiles = [...trackedDirty, ...relevantUntracked.map((p) => `?? ${p}`)];
  if (!status.ok || statusParseError) {
    // Git status itself failed or returned an unparseable protocol — we cannot
    // prove the tree is clean, so fail closed BEFORE any "clean" claim.
    process.stderr.write(
      `[gate] could not determine working-tree status (${statusParseError ? `malformed porcelain: ${statusParseError.message}` : 'git status failed'}) — fail closed.\n`,
    );
    record('precondition:clean-tree', 1, statusParseError ? 'malformed porcelain status output — cannot prove a clean source tree' : 'git status failed — cannot prove a clean source tree');
  } else if (cleanTree) {
    record('precondition:clean-tree', 0, 'clean');
  } else if (!args.allowDirty) {
    process.stderr.write(
      `[gate] DIRTY SOURCE: ${trackedDirty.length} tracked change(s) and ${relevantUntracked.length} relevant untracked input(s). ` +
        `The acceptance gate must run on committed source; commit/stash first, or pass --allow-dirty for a dev run (explicitly NON-acceptance).\n`,
    );
    for (const f of dirtyFiles.slice(0, 20)) process.stderr.write(`        ${f}\n`);
    record('precondition:clean-tree', 1, `${trackedDirty.length} tracked + ${relevantUntracked.length} untracked input(s) on disk`);
  } else if (acceptanceRequested) {
    process.stderr.write(
      `[gate] --allow-dirty cannot satisfy FULL ACCEPTANCE (--phase all): ${trackedDirty.length} tracked + ${relevantUntracked.length} uncommitted input(s) present.\n` +
        `[gate] Commit the source, or run --allow-dirty with a diagnostic phase (core|guards|python|e2e) only.\n`,
    );
    for (const f of dirtyFiles.slice(0, 20)) process.stderr.write(`        ${f}\n`);
    record('precondition:clean-tree', 1, `full acceptance requires committed source; ${dirtyFiles.length} uncommitted input(s)`);
  } else {
    notes.push(`precondition:clean-tree: --allow-dirty accepted ${trackedDirty.length} tracked + ${relevantUntracked.length} untracked input(s) — DIAGNOSTIC, NON-ACCEPTANCE`);
    record('precondition:clean-tree', 0, `${dirtyFiles.length} input(s) allowed by --allow-dirty (diagnostic, NON-ACCEPTANCE)`);
  }

  // The `--base` ref must resolve in this checkout.
  const baseOk = captureArgv('git', ['rev-parse', '--verify', '--quiet', `${args.base}^{commit}`], { cwd: ROOT });
  record('precondition:base-ref', baseOk.ok ? 0 : 1, baseOk.ok ? `resolved ${args.base}` : `cannot resolve ${args.base}`);

  const scope = buildScope(ROOT);
  if (!args.quiet) printScope(scope);
  log('[gate] runner/setup scope notes:');
  for (const n of SETUP_NOTES) log(`        - [${n.subject}] ${n.note}`);

  if (!scope.ok) {
    for (const p of scope.problems) process.stderr.write(`[gate] SCOPE FAILURE: ${p}\n`);
    const summary = {
      phase: args.phase,
      base: args.base,
      head: meta,
      scopeOk: false,
      problems: scope.problems,
      acceptance: { requested: acceptanceRequested, eligible: false, cleanTree, reasons: scope.problems.slice() },
      results,
      green: false,
      accepted: false,
    };
    writeSummary(args.json, summary);
    process.exit(1);
  }

  const doCore = args.phase === 'all' || args.phase === 'core';
  const doGuards = args.phase === 'all' || args.phase === 'core' || args.phase === 'guards';
  const doE2e = args.phase === 'all' || args.phase === 'e2e';
  const doPython = args.phase === 'all' || args.phase === 'python';

  if (doCore) {
    // Reviewed five-runner dump/diff/adapters fixture + scanner proof. Pure and
    // dependency-free; a red fixture is a hard failure.
    if (fs.existsSync(path.join(ROOT, TEST_PROOF_FIXTURES))) {
      record('core:test-proof-fixtures', runArgv(process.execPath, [TEST_PROOF_FIXTURES], { cwd: ROOT, label: 'test-proof fixtures' }));
    } else {
      record('core:test-proof-fixtures', 1, `missing ${TEST_PROOF_FIXTURES}`);
    }

    // Pinned-visual PURE controls: prove the pinned visual regression validator
    // and the shell-safe portable-runner argv builder fail closed on malformed/
    // foreign/missing evidence and that failures propagate (no mock of
    // Playwright/Docker results as native acceptance).
    const pvControls = path.join(ROOT, 'scripts', 'cleanup-gates', 'pinned-visual-controls.mjs');
    if (fs.existsSync(pvControls)) {
      record('core:pinned-visual-controls', runArgv(process.execPath, [pvControls], { cwd: ROOT, label: 'pinned-visual controls' }));
    } else {
      record('core:pinned-visual-controls', 1, 'missing scripts/cleanup-gates/pinned-visual-controls.mjs');
    }

    // Render-context PURE controls: prove the ACTUAL-observation aggregator
    // refuses a missing project/onboarding context, a disagreement between
    // projects, a malformed profile and a substituted clock (round 73).
    const rcControls = path.join(ROOT, 'apps', 'e2e', 'lib', 'render-context-controls.mjs');
    if (fs.existsSync(rcControls)) {
      record('core:render-context-controls', runArgv(process.execPath, [rcControls], { cwd: ROOT, label: 'render-context controls' }));
    } else {
      record('core:render-context-controls', 1, 'missing apps/e2e/lib/render-context-controls.mjs');
    }

    // Standalone Node-suite discovery controls: prove the ACTUAL discovery helper
    // over real temporary fixtures (manifest-less discovery, later-added app,
    // manifest-bearing app left to Turbo, no zero-test success, symlink/containment
    // refusal). The helper itself is run below to execute the standalone suites.
    const standaloneControls = path.join(ROOT, 'scripts', 'cleanup-gates', 'standalone-node.test.mjs');
    if (fs.existsSync(standaloneControls)) {
      record('core:standalone-node-controls', runArgv(process.execPath, ['--test', standaloneControls], { cwd: ROOT, label: 'standalone node discovery controls' }));
    } else {
      record('core:standalone-node-controls', 1, 'missing scripts/cleanup-gates/standalone-node.test.mjs');
    }

    record('core:turbo-typecheck', run('pnpm turbo run typecheck', { cwd: ROOT, label: 'turbo typecheck' }));
    // SETUP-BUILD-1 (documented quirk): @capiro/defense-api's node:test suite
    // spawns scripts/job.mjs which requires the package's own dist output.
    // turbo `test` dependsOn `^build` (dependencies), not the package's own
    // build, so build it explicitly here rather than weaken/skip the suite.
    record('core:prereq-build-defense-api', run('pnpm turbo run build --filter=@capiro/defense-api', { cwd: ROOT, label: 'defense-api prereq build' }));
    // @capiro/e2e is EXCLUDED from the turbo test graph (its `test` script renders
    // on the host — which is NOT pinned-image evidence). EVERY OTHER dynamically
    // discovered test-bearing package stays in scope; there is no allowlist and
    // no host rendering fallback. The excluded e2e package is run in its ENTIRETY
    // through the pinned visual owner below (core's full-test claim).
    record('core:turbo-test', run(`pnpm turbo run test --filter=${E2E_TURBO_TEST_FILTER}`, { cwd: ROOT, label: 'turbo test (every test-bearing package except the pinned-lane-owned @capiro/e2e)' }));
    // Standalone Node suites live in apps WITHOUT a `package.json`, so the Turbo
    // graph above never sees them. Their COMPLETE suites are invoked here with the
    // same process.execPath/runArgv/record style. Discovery is source-driven with
    // no allowlist: every supported suite runs, and any malformed/unsupported/
    // refused standalone scope is a hard failure — never a silent skip.
    {
      const standalone = discoverStandaloneNodeSuites(ROOT);
      for (const suite of standalone.suites) {
        record(`core:standalone-node:${suite.packageDir}`, runArgv(process.execPath, suite.argv, { cwd: ROOT, label: `standalone node:test suite (${suite.packageDir})` }));
      }
      for (const problem of standalone.problems) {
        process.stderr.write(`[gate] STANDALONE NODE SCOPE FAILURE (${problem.app}): ${problem.message}\n`);
        record(`core:standalone-node-scope:${problem.app}`, 1, problem.message);
      }
    }
    {
      const pv = ensurePinnedVisual();
      record('core:e2e-pinned-visual', pv.code, pv.note);
    }
    record('core:mirror-verifier', runArgv(process.execPath, [MIRROR_VERIFIER], { cwd: ROOT, label: 'mirror verifier' }));
  }
  if (doGuards) {
    for (const guard of ARCHITECTURE_GUARDS) {
      // argv spawning (no shell): the `--base` ref is never interpolated.
      record(`guard:${guard}`, runArgv(process.execPath, [guard, args.base], { cwd: ROOT, label: `guard ${guard}` }));
    }
  }
  if (doE2e) {
    const e2ePkgPath = path.join(ROOT, E2E_PACKAGE_DIR, 'package.json');
    if (!fs.existsSync(e2ePkgPath)) {
      process.stderr.write(
        `[gate] MISSING E2E PACKAGE: ${E2E_PACKAGE_DIR}/package.json not found.\n` +
          `[gate] The visual regression package (${E2E_PACKAGE}) is owned by the visual workstream and\n` +
          `[gate] must land before the gate can be accepted. This is a FAILURE, not a skip.\n`,
      );
      record('e2e:package', 1, 'missing visual package (pending visual lane)');
    } else {
      const e2ePkg = readJson(e2ePkgPath);
      const hasTest = typeof (e2ePkg.scripts || {}).test === 'string';
      record('e2e:package', hasTest ? 0 : 1, hasTest ? `present (${E2E_PACKAGE})` : 'visual package has no test script');
    }

    // The GATE owns the pinned portable visual lane: it builds a fresh immutable
    // source archive and invokes apps/e2e/linux/run-linux-capture.sh regression
    // through buildPortableRunnerArgv (argv only, no shell interpolation). When
    // the phase is `all`, core already ran the SAME single invocation, so this
    // reuses it — there is NO double invocation. Bare-host pnpm visual execution
    // is NOT pinned-image evidence and is never mapped to this requirement.
    const pv = ensurePinnedVisual();
    record('e2e:pinned-visual', pv.code, pv.note);
  }
  if (doPython) {
    const appDir = path.join(ROOT, PYTHON_APP_DIR);
    let code = run(`uv ${PYTHON_SYNC_ARGS.join(' ')}`, { cwd: appDir, label: 'uv sync (frozen)' });
    record('python:sync', code);
    if (code === 0) {
      for (const chk of PYTHON_CHECKS) {
        record(`python:${chk.name}`, run(`uv ${chk.args.join(' ')}`, { cwd: appDir, label: `python ${chk.name}` }));
      }
    } else {
      process.stderr.write('[gate] uv sync (frozen) failed; skipping python checks (fail-closed, not green).\n');
      for (const chk of PYTHON_CHECKS) record(`python:${chk.name}`, 1);
    }
  }

  // ---- Baseline + cross-lane evidence (acceptance-only) --------------------
  if (args.phase === 'all') {
    // Fresh current-source runtime smoke (CleanUp1 §6.2; independent review
    // round 4). Cached metadata cannot replace re-running the behaviour: the
    // gate INVOKES the real runner, which performs a fresh runtime discovery
    // over current source and executes each entrypoint under bounded Docker
    // containment. The evidence is validated below against that same source.
    if (fs.existsSync(path.join(ROOT, SMOKE_RUNNER))) {
      const code = runArgv(process.execPath, [SMOKE_RUNNER], { cwd: ROOT, label: 'current-source runtime smoke (§6.2)' });
      record('acceptance:script-smoke:runtime', code, code === 0 ? `[${EVIDENCE_MODES.OWNED_LIVE_RUNTIME}] fresh contained runtime smoke produced` : 'runtime smoke failed or containment unproven');
    } else {
      record('acceptance:script-smoke:runtime', 1, `missing ${SMOKE_RUNNER}`);
    }
    // Historical floor: anchored to its measured source, committed and
    // unmodified. Deliberately NOT compared to HEAD — requiring
    // runSha === HEAD is the self-reference error the review called out
    // (it would break every later evidence-only or refactor commit).
    if (fs.existsSync(path.join(ROOT, BASELINE_VERIFIER)) && fs.existsSync(path.join(ROOT, BASELINE_JSON))) {
      const code = runArgv(
        process.execPath,
        [BASELINE_VERIFIER, '--baseline', BASELINE_JSON, '--kind', 'historical-floor', '--require-tracked'],
        { cwd: ROOT, label: 'coverage baseline (historical floor) verification' },
      );
      record('acceptance:coverage-baseline:floor', code, code === 0 ? `[${EVIDENCE_MODES.IMMUTABLE_BASELINE}] immutable, complete, green, anchored to measured source` : 'missing/untracked/stale/diagnostic/incomplete baseline');
    } else {
      record('acceptance:coverage-baseline:floor', 1, `missing ${BASELINE_JSON} or ${BASELINE_VERIFIER}`);
    }
    for (const ev of REQUIRED_EVIDENCE) {
      const evAbs = path.join(ROOT, ev.path);
      let code = 1;
      let note = `pending ${ev.owner}`;
      if (!fs.existsSync(evAbs)) {
        process.stderr.write(`[gate] MISSING EVIDENCE (${ev.id}): ${ev.path} — owner: ${ev.owner}\n[gate] ${ev.note}\n`);
      } else {
        // Never accept existence alone: validate the declared contract against
        // the REAL filesystem (raw logs/audits are hashed, source bytes at the
        // measured commit are re-hashed, discovery is re-derived from current
        // source, and commits are checked).
        let parsed = null;
        try {
          parsed = JSON.parse(fs.readFileSync(evAbs, 'utf8'));
        } catch (err) {
          process.stderr.write(`[gate] EVIDENCE (${ev.id}) is not valid JSON: ${err.message} — owner: ${ev.owner}\n`);
        }
        if (parsed) {
          const evidenceCtx = {
            root: ROOT,
            // Forward the declared EVALUATION MODE (gate-config EVIDENCE_MODES)
            // so a live emitter's fresh, task-owned raw artifacts are validated
            // as fresh runtime evidence from the just-completed run rather than
            // as committed+clean historical records. This uses the ONE declared
            // mode (ev.mode) — never a hardcoded literal — so the config stays
            // the single source. Unknown/non-live modes still take the strict
            // committed+clean (historical-floor) branch in the checker; the
            // separate historical coverage-floor verification above remains
            // strict and unchanged.
            evidenceMode: ev.mode,
            resolve: (p) => path.resolve(ROOT, p),
            existsSync: (p) => fs.existsSync(p),
            sha256File,
            readFile: (p) => fs.readFileSync(p, 'utf8'),
            // v5 streaming trace capability (bounded buffers): the raw strace trace
            // is ONLY ever read/hashed/parsed through this — never a whole-file read.
            readAndParseTraceFileSync: (abs) => readAndParseTraceFileSync(abs),
            commitExists: (sha) => commitExists(ROOT, sha),
            isAncestorOfHead: (sha) => {
              const h = headSha(ROOT);
              return Boolean(h) && isAncestor(ROOT, sha, h);
            },
            fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
            fingerprintAt: (sha) => fingerprintAt(ROOT, sha, Array.isArray(parsed.source && parsed.source.specs) ? parsed.source.specs : []),
            specExistsAtCommit: (sha, p) => spawnSync('git', ['cat-file', '-e', `${sha}:${p}`], { cwd: ROOT, windowsHide: true }).status === 0,
            contractFor: (p) => contractFor(ROOT, p, fs, path),
            sourceShaAt: (p, sha) => {
              const r = spawnSync('git', ['show', `${sha}:${p}`], { cwd: ROOT, encoding: null, windowsHide: true });
              return r.status === 0 ? sha256Buffer(r.stdout) : null;
            },
            trackedAndClean: (p) => trackedAndClean(ROOT, p),
            contained: (p) => {
              const abs = path.resolve(ROOT, p);
              return abs === ROOT || abs.startsWith(ROOT + path.sep);
            },
            // The CONTROLLED native-bind topology (installed-checkout default): the
            // verifier independently derives the exact absolute native subject/cwd +
            // `/tsruntime/<TS_RUNTIME_CLI_REL>` loader from CURRENT source + this bound
            // capability — never from an untrusted invocation self-report.
            nativeTopology: { mode: 'native-bind', tsRuntimeCliRel: TS_RUNTIME_CLI_REL },
          };
          const evProblems = typeof ev.validate === 'function' ? ev.validate(parsed, evidenceCtx) : [];
          if (evProblems.length === 0) {
            code = 0;
            note = `[${ev.mode || 'unclassified'}] valid`;
          } else {
            process.stderr.write(`[gate] EVIDENCE (${ev.id}) failed its contract (${evProblems.length} problem(s)) — owner: ${ev.owner}\n[gate] ${ev.note}\n`);
            for (const p of evProblems.slice(0, 20)) process.stderr.write(`        - ${p}\n`);
            note = `${evProblems.length} contract problem(s)`;
          }
        }
      }
      record(`acceptance:evidence:${ev.id}`, code, note);
    }
  }

  const failed = results.filter((r) => r.exitCode !== 0);
  // Explicit acceptance predicate: a full-gate run is only ACCEPTED when the
  // phase is `all`, the tree is clean, scope resolved, and every required step
  // (including the acceptance-only baseline/evidence checks) passed. Diagnostic
  // phases can be green without being acceptance.
  const acceptanceReasons = [];
  if (!acceptanceRequested) acceptanceReasons.push('phase is not the full acceptance gate (--phase all)');
  if (acceptanceRequested && !cleanTree) acceptanceReasons.push(`${dirtyFiles.length} uncommitted source input(s) present`);
  if (failed.length) acceptanceReasons.push(`${failed.length} failing step(s)`);
  const accepted = acceptanceRequested && cleanTree && failed.length === 0;
  const green = failed.length === 0 && (!acceptanceRequested || accepted);

  log('\n[gate] -------- summary --------');
  for (const r of results) log(`[gate] ${r.status.padEnd(4)} ${r.name}${r.note ? `  (${r.note})` : ''}`);
  if (notes.length) {
    log('[gate] notes:');
    for (const n of notes) log(`        - ${n}`);
  }
  log(
    `[gate] ${
      green
        ? accepted
          ? 'GATE GREEN — ACCEPTED (full acceptance)'
          : 'GATE GREEN (diagnostic — NOT full acceptance)'
        : `GATE RED (${failed.length} failing step(s))`
    }`,
  );
  if (acceptanceRequested) log(`[gate] acceptance: ${accepted ? 'ELIGIBLE' : `NOT ELIGIBLE — ${acceptanceReasons.join('; ')}`}`);

  const summary = {
    phase: args.phase,
    base: args.base,
    head: meta,
    scopeOk: true,
    acceptance: { requested: acceptanceRequested, eligible: accepted, cleanTree, reasons: acceptanceReasons },
    results,
    green,
    accepted,
  };
  writeSummary(args.json, summary);
  process.exit(failed.length === 0 ? 0 : 1);
}

function writeSummary(jsonPath, summary) {
  if (jsonPath) {
    const out = path.resolve(ROOT, jsonPath);
    // --json must stay INSIDE the repo root. `path.resolve` happily escapes via
    // `../`, so an operator typo or a hostile value could write the summary
    // outside the checkout; fail closed instead of writing outside root.
    const rel = path.relative(ROOT, out);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      process.stderr.write(`[gate] --json ${JSON.stringify(jsonPath)} escapes the repository root — refused\n`);
      process.exit(2);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ ...summary, planMapping: PLAN_MAPPING }, null, 2) + '\n');
    process.stdout.write(`[gate] wrote ${out}\n`);
  }
}

// ---- Zero-argument fast path ------------------------------------------------
// The gate is itself a smoke subject: its bare no-argument invocation must be a
// documented usage exit (2), not a full acceptance run. This top-level zero-argv
// branch fires before any version probe, package discovery, child spawn, raw/
// artifact write or check invocation: it prints the USAGE text and exits 2.
// Every nonempty-argv path is unchanged — an explicit `--phase`, `--help`, an
// unknown flag, and any option-only invocation (which keeps the `phase` default
// `all`) still reach the main entry statement below.
if (process.argv.length <= 2) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(2);
}

withUsage(main, USAGE)();
