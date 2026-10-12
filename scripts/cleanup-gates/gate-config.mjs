/**
 * CleanUp1 gate configuration — the single source of truth for what the gate
 * runs. Kept as data (not inline in the driver) so the guard config test can
 * assert it against live source and so reviewers can see the whole scope.
 *
 * Every entry here maps a CleanUp1 plan requirement to the concrete gate check
 * that satisfies it (plan §5.3, §7, §9, §10).
 */

import fs from 'node:fs';
import path from 'node:path';
import { validateSmokeEvidence } from './lib/smoke-evidence.mjs';

/** The four architecture bypass guards (plan §5.3.4). All four must run. */
export const ARCHITECTURE_GUARDS = [
  'scripts/check-context-plane-new-bypasses.mjs',
  'scripts/check-evaluation-new-bypasses.mjs',
  'scripts/check-learning-signal-new-bypasses.mjs',
  'scripts/check-quality-telemetry-new-bypasses.mjs',
];

/** Structural mirror verifier (plan §9): defense-api/runtime-source must stay
 * a byte-identical copy of parts of apps/api, enforced by git tree-SHA. */
export const MIRROR_VERIFIER = 'scripts/verify-phase8-session4.mjs';

/** Playwright visual regression package (plan §8), owned by the visual worker.
 * The gate invokes its `test` script; if the package is absent the gate FAILS
 * CLOSED (pending integration is never reported as green). */
export const E2E_PACKAGE = '@capiro/e2e';
export const E2E_PACKAGE_DIR = 'apps/e2e';

/**
 * Pinned portable visual REGRESSION evidence (OWNED_LIVE_RUNTIME, round-13).
 *
 * The e2e requirement is satisfied ONLY by evidence the visual lane's portable
 * PINNED runner produced (apps/e2e/linux/run-linux-capture.sh regression →
 * apps/e2e/scripts/regression.mjs). A bare-host `pnpm --filter @capiro/e2e test`
 * run is NOT the pinned image, so it is NOT pinned-image evidence and the gate
 * fails closed without this file. The path lives in the gitignored reports/
 * tree so a run never dirties the measured source.
 */
export const PINNED_VISUAL_EVIDENCE = 'apps/e2e/reports/regression-evidence.json';

/**
 * Gate-owned pinned visual lane inputs (round 60). The GATE — not the workflow
 * and not `core`'s bare `turbo run test` — owns the fresh immutable source
 * archive and the pinned portable regression invocation. `@capiro/e2e` is
 * EXCLUDED from the turbo test graph (so it never renders on the bare host) and
 * its ENTIRE discovered suite is run through the pinned owner exactly once.
 */
export const E2E_TURBO_TEST_FILTER = '!@capiro/e2e';
export const E2E_SOURCE_ARCHIVE_MAKER = 'apps/e2e/scripts/make-source-archive.mjs';
export const E2E_ARCHIVE_DIR = 'apps/e2e/.source-archive';
export const E2E_BASELINE_DIR = 'apps/e2e/baselines';
export const E2E_REPORTS_DIR = 'apps/e2e/reports';
export const E2E_ROUTE_GUARD = 'apps/e2e/scripts/guard-route-coverage.mjs';

/** Python parser app (plan §7). */
export const PYTHON_APP_DIR = 'apps/defense-budget-parser';
export const PYTHON_APP_PACKAGE = 'capiro-defense-budget-parser';
/** Install with the frozen lock plus the declared `dev` test extra, then lint,
 * type-check and run pytest with coverage. `--frozen` everywhere so CI cannot
 * mutate the lock. */
export const PYTHON_SYNC_ARGS = ['sync', '--frozen', '--extra', 'dev'];
export const PYTHON_CHECKS = [
  { name: 'ruff', args: ['run', '--frozen', 'ruff', 'check', '.'] },
  { name: 'mypy', args: ['run', '--frozen', 'mypy', 'src'] },
  {
    name: 'pytest',
    args: [
      'run',
      '--frozen',
      'pytest',
      '--cov=capiro_defense_budget_parser',
      '--cov-branch',
      '--cov-report=json',
      '--cov-report=term',
    ],
  },
];

/** Base ref the diff-scoped guards compare against. */
export const DEFAULT_BASE_REF = 'origin/main';

/**
 * Untracked INPUT detection (independent review round 3, item 2).
 *
 * The clean-source precondition must see untracked production/test/config files
 * even when they sit inside a NEW directory (which plain
 * `git status --porcelain` collapses to `?? dir/`). The gate therefore uses
 * `git status --porcelain -z -uall` and flags every untracked file with a
 * source/config extension. Only genuinely non-source, non-executed scratch
 * trees are excluded — and `docs/` is deliberately NOT excluded blanketly,
 * because docs carries executable operator scripts that can be real execution
 * inputs.
 */
export const UNTRACKED_SOURCE_EXCLUSIONS = [
  '.artifacts/',
  'node_modules/',
  'coverage/',
  '.cache/',
  // Owned OUTPUT trees of the pinned visual lane (the SAME set
  // lib/source-identity.mjs EXCLUDE_RELPREFIXES treats as generated, NOT source).
  // The pinned regression lane writes its archive/evidence/reports here during a
  // run; these are never source inputs, so a pinned run must not look "dirty".
  'apps/e2e/.source-archive/',
  'apps/e2e/reports/',
  'apps/e2e/baselines/',
  'apps/e2e/test-results/',
  'apps/e2e/playwright-report/',
  // Match the onboarding output exclusion in lib/source-identity.mjs.
  'apps/e2e/smoke-onboard/test-results/',
];

/** Extensions that make an untracked file a relevant (executable/config) input. */
export const RELEVANT_SOURCE_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|py|sql|ya?ml|toml|prisma|sh|ps1)$/i;

/**
 * The COMPLETE measured-source input set for the coverage baseline
 * (independent review round 3, item 4). The fingerprint must change exactly
 * when measured source changes, so it must cover every production/test source
 * input, workspace/transitive contract and runner/config input — not just the
 * root manifests and per-package `package.json`.
 *
 * Each entry is a path SPEC accepted by `git ls-tree -r <sha> -- <spec>`:
 *   - a DIRECTORY spec resolves recursively to every tracked file beneath it
 *     (so any production/test source addition/rename/serialization change is
 *     captured, and the tree-SHA-derived fingerprint changes);
 *   - a FILE spec captures a single manifest/contract.
 *
 * The set is a fixed constant (not derived from a mutable directory read) so
 * the same list is reproducible from any checkout, and the verifier re-derives
 * it from THIS constant rather than trusting the manifest's own `paths` list
 * (a manifest must not be its own completeness proof).
 */
export const MEASURED_SOURCE_SPECS = [
  // Workspace source roots — all app and package production/test source.
  'apps',
  'packages',
  'infra',
  // Transitive dependency + workspace contract inputs.
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
  'tsconfig.base.json',
  // The runner/gate implementation that determines how the measurement runs.
  'scripts/cleanup-gates',
  'scripts/test-proof',
  // The CI definitions that decide the acceptance environment.
  '.github/workflows',
];

/**
 * Reviewed five-runner multiset/name proof fixtures (scripts/test-proof/**).
 * The gate runs them as fixture/scanner evidence: a red fixture or a missing
 * runner adapter is a hard failure, not a skip.
 */
export const TEST_PROOF_FIXTURES = 'scripts/test-proof/run-fixtures.mjs';

/** Measured coverage baseline manifest + its fail-closed verifier. */
export const BASELINE_JSON = 'docs/plans/cleanup1-coverage-baseline.json';
export const BASELINE_VERIFIER = 'scripts/cleanup-gates/verify-baseline.mjs';

/**
 * Evidence MODES (review round 6). Acceptance distinguishes two genuinely
 * different evidence classes so neither can masquerade as the other:
 *   - IMMUTABLE_BASELINE — a committed, historical-floor measurement anchored
 *     to its measured source; it is NEVER re-run at acceptance time and is only
 *     trusted after `verify-baseline.mjs` re-derives it from git.
 *   - OWNED_LIVE_RUNTIME — evidence the owning lane (PR2224 emitter) must
 *     PRODUCE during the current, contained run over CURRENT source; a stale
 *     or cached artifact is not accepted, and the CI adapter only re-validates
 *     the emitter's fresh output (`run-script-smoke.mjs`).
 */
export const EVIDENCE_MODES = {
  IMMUTABLE_BASELINE: 'immutable-baseline',
  OWNED_LIVE_RUNTIME: 'owned-live-runtime',
};

/**
 * Evidence produced by OTHER lanes that the acceptance gate depends on. Each
 * entry is a NONPASSING dependency: if the artifact is absent OR fails its
 * declared contract the gate fails closed and names the owner — it never
 * reports an infrastructure-only green, and never accepts existence alone.
 *
 * `validate` is a pure predicate over the parsed JSON; it returns a list of
 * problems (empty = valid). The gate runs it against the real file.
 */
export const REQUIRED_EVIDENCE = [
  {
    id: 'script-smoke',
    mode: EVIDENCE_MODES.OWNED_LIVE_RUNTIME,
    path: 'docs/plans/cleanup1-script-smoke-evidence.json',
    owner: 'execution lane (script-smoke packet PR2224)',
    note:
      'Runtime-generated script inventory under real no-network / disposable-filesystem isolation. Contract v5 (PR2309 context/WorkingDir + PR2310 gate usage): schema+version, a run ' +
      'declared complete, a SUPPORTED source fingerprint algorithm whose digest is RE-COMPUTED from the actual measured source, a COMPLETE current-source discovery set ' +
      're-derived by the gate (exactly equal to the per-entrypoint result set), per-entrypoint DOCUMENTED no-args/--help contracts derived from current source with a ' +
      'DEFINITE termination (timedOut:false) and empty forbidden-attempt audits, a per-entrypoint source sha256 verified against the actual bytes at the measured commit, ' +
      'an EXERCISED isolation proof backed by a PARSED raw self-test record, and — the v5 correction — an independently re-derived COMPLETE canonical CURRENT-SOURCE context ' +
      'set (context key/cwdRel/kind/fingerprint/declaration refs/manifest hashes) with ONE physical result identity per subject that carries EVERY context, each context ' +
      'executing all three smoke modes under the strace attempt audit with the EXACT absolute native subject, a real returned 64-hex run CID equal to the inspected exact CID, ' +
      'a lossless inspected WorkingDir proof, and BOTH prestart AND final lifecycle receipts (identity/order/ownership/completeness) — the raw strace trace is read only through ' +
      'the canonical STREAMING parser in bounded buffers. Missing/extra/duplicate/wrong-subject/wrong-cwd/partial-reference/stale-manifest contexts, a forged/cleaned audit, an ' +
      'unexecuted mode, a foreign-prefix subject, an inconsistent native exit, or a fabricated summary are all rejected. See scripts/cleanup-gates/lib/smoke-evidence.mjs.',
    schema: 'capiro.cleanup1-script-smoke-evidence',
    schemaVersion: 5,
    validate: (ev, ctx) => validateSmokeEvidence(ev, ctx),
  },
];

/** The CI-side adapter that INVOKES the ONE runtime emitter owned by the
 * execution lane (PR2224: scripts/cleanup-script-smoke/emit-evidence.mjs) and
 * re-validates its artifact against current source. There is no duplicate CI
 * syscall runtime (independent review round 5); a missing emitter fails closed. */
export const SMOKE_RUNNER = 'scripts/cleanup-gates/run-script-smoke.mjs';
export const SMOKE_EMITTER = 'scripts/cleanup-script-smoke/emit-evidence.mjs';


/**
 * Coverage measurement targets (plan §5.2, §10). Coverage is MEASURED, never
 * enforced: no threshold, no --cov-fail-under. Each target runs its own
 * `test:coverage` script and the driver records the real summary numbers with
 * the source SHA and raw-report hash. A red suite is recorded as diagnostic,
 * never as green acceptance.
 */
export const COVERAGE_TARGETS = [
  { package: '@capiro/api', packageDir: 'apps/api', runner: 'jest', summary: 'coverage/coverage-summary.json' },
  { package: '@capiro/web', packageDir: 'apps/web', runner: 'vitest', summary: 'coverage/coverage-summary.json' },
  { package: '@capiro/workspace', packageDir: 'apps/workspace', runner: 'jest', summary: 'coverage/coverage-summary.json' },
  { package: '@capiro/onboard-web', packageDir: 'apps/onboard-web', runner: 'vitest', summary: 'coverage/coverage-summary.json' },
];

/** Python coverage produced by the gate's python phase (pytest-cov json). */
export const PYTHON_COVERAGE = {
  package: 'capiro-defense-budget-parser',
  packageDir: 'apps/defense-budget-parser',
  report: 'coverage.json',
};

/** Where raw coverage reports are copied as COMMITTED evidence, so a historical
 * baseline can reference a real, hash-verifiable raw report from a fresh
 * checkout (the generated `coverage/` dirs are gitignored and do not survive).
 * Not matched by the `.gitignore` `coverage/` rule. */
export const COVERAGE_EVIDENCE_DIR = 'docs/plans/cleanup1-coverage-evidence';

/**
 * Resolve the EXACT required coverage scope from current source.
 *
 * The required set is not a free-form list: it is the configured targets, each
 * re-verified against the live checkout so a moved/renamed package is surfaced
 * (and must be re-resolved) rather than silently dropped. It also detects NEW
 * uncovered scope: any workspace package that declares a `test:coverage` script
 * but is not one of the configured targets is a hard failure — coverage scope
 * cannot silently shrink AND cannot silently grow past the accepted baseline.
 *
 * @returns {{ required: Array<{package:string,packageDir:string,runner:string,reportName:string}>,
 *            extra: string[], problems: string[] }}
 */
export function resolveRequiredCoverageScope(root) {
  const problems = [];
  const required = [];
  const requiredDirs = new Set();

  for (const t of COVERAGE_TARGETS) {
    const pkgPath = path.join(root, t.packageDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      problems.push(`coverage target ${t.package} (${t.packageDir}) has no package.json — the package moved/renamed and this scope must be re-resolved`);
      continue;
    }
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (err) {
      problems.push(`coverage target ${t.package} package.json is unreadable: ${err.message}`);
      continue;
    }
    if (pkg.name !== t.package) problems.push(`coverage target dir ${t.packageDir} declares package ${JSON.stringify(pkg.name)} but config expects ${t.package}`);
    if (!pkg.scripts || typeof pkg.scripts['test:coverage'] !== 'string') {
      problems.push(`coverage target ${t.package} has no test:coverage script — it cannot produce the required measurement`);
    }
    required.push({ package: t.package, packageDir: t.packageDir, runner: t.runner, reportName: t.summary });
    requiredDirs.add(t.packageDir);
  }

  const pyDir = path.join(root, PYTHON_COVERAGE.packageDir);
  if (!fs.existsSync(path.join(pyDir, 'pyproject.toml'))) {
    problems.push(`python coverage target ${PYTHON_COVERAGE.package} has no pyproject.toml — scope must be re-resolved`);
  }
  required.push({
    package: PYTHON_COVERAGE.package,
    packageDir: PYTHON_COVERAGE.packageDir,
    runner: 'pytest-cov',
    reportName: PYTHON_COVERAGE.report,
  });
  requiredDirs.add(PYTHON_COVERAGE.packageDir);

  // Detect NEW uncovered scope: a workspace package with test:coverage that we
  // do not measure.
  const extra = [];
  for (const glob of ['apps', 'packages', 'infra']) {
    const parent = path.join(root, glob);
    if (!fs.existsSync(parent)) continue;
    for (const ent of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const dirRel = `${glob}/${ent.name}`;
      if (requiredDirs.has(dirRel)) continue;
      const pkgPath = path.join(parent, ent.name, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts && typeof pkg.scripts['test:coverage'] === 'string') extra.push(pkg.name || dirRel);
      } catch {
        /* ignore unreadable */
      }
    }
  }
  if (extra.length > 0) {
    problems.push(`new uncovered coverage scope: package(s) declare test:coverage but are not measured: ${extra.join(', ')}`);
  }

  return { required, extra, problems };
}

/**
 * Plan-command → gate-check mapping (explicit, so "do not duplicate huge
 * suites" is auditable). The gate NEVER re-implements a suite; it runs the
 * repo's own commands.
 */
export const PLAN_MAPPING = [
  { plan: '§2 Step 0 / §9 `pnpm turbo run test`', gate: 'core: `pnpm turbo run test --filter=!@capiro/e2e` (every test-bearing package except @capiro/e2e, which is excluded ONLY because it is run in its entirety through the pinned visual owner)' },
  { plan: '§9 `pnpm turbo run typecheck`', gate: 'core: `pnpm turbo run typecheck`' },
  { plan: '§5.3.1 api jest step', gate: 'turbo test + ci-pr.yml `Test apps/api` step' },
  { plan: '§5.3.2 web vitest step', gate: 'turbo test + ci-pr.yml `Test apps/web` step' },
  { plan: '§5.3.3 defense-api tsx --test step', gate: 'turbo test + ci-pr.yml `Test apps/defense-api` step' },
  { plan: '§5.3.4 four guards', gate: 'core: guards phase (all four, diff-scoped vs base ref)' },
  { plan: '§7 python (ruff+mypy+pytest)', gate: 'python phase' },
  { plan: '§8 e2e visual', gate: 'e2e phase: the GATE builds a fresh immutable archive and runs the pinned portable Linux runner (apps/e2e/linux/run-linux-capture.sh regression) via the positional argv bridge, then re-validates the evidence against a ROOT-built context by scripts/cleanup-gates/lib/pinned-visual.mjs — bare-host pnpm visual is NOT pinned-image evidence' },
  { plan: '§9 mirror verifier', gate: 'core: `node scripts/verify-phase8-session4.mjs`' },
  { plan: '§10 coverage baseline', gate: 'per-package `test:coverage` scripts → docs/plans/cleanup1-coverage-baseline.json' },
];
