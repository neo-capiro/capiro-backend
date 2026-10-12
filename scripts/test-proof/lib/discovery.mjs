/**
 * Dynamic package/target discovery for dump-test-names.
 *
 * Nothing here is a checked-in list of packages. Every run walks the workspace
 * globs (apps/*, packages/*, infra/*) plus:
 *   - Python apps discovered by a `pyproject.toml` that configures pytest:
 *   - Playwright suites discovered by a `playwright.config.*` file:
 *
 * so a package another author adds is INCLUDED rather than silently skipped
 * (CleanUp1 §2 R7 / CleanUp3 §7.1). A package that cannot be classified is
 * reported as explicit non-passing scope, never dropped.
 */

import fs from 'node:fs';
import path from 'node:path';
import { toPosix, packageDirRelative } from './paths.mjs';

const WORKSPACE_GLOBS = ['apps', 'packages', 'infra'];
const RUNNER_TOKEN = [
  ['vitest', /\bvitest\b/],
  ['jest', /\bjest\b/],
  ['node:test', /\b(?:(?:tsx|node)\s+[^\n]*--test(?:=|\s|$)|node\s+--test(?:=|\s))/],
  ['pytest', /\bpytest\b/],
  ['playwright', /\bplaywright\s+test\b/],
];

/**
 * Native runner adapters: bespoke driver commands that do not carry a runner
 * token but DO run a known runner natively. Each is classified as its real
 * runner (never waived as "unsupported") so it participates in whole-scope
 * proof, and `adapter` names the module that produces the canonical report.
 *
 * These are NOT exclusions: registration means the target is represented with
 * its real runner and every one of its test identities is dumped.
 */
export const NATIVE_RUNNER_ADAPTERS = [
  {
    package: '@capiro/infra-cdk',
    packageDir: 'infra/cdk',
    match: /(?:^|\s)scripts\/run-construct-tests\.cjs(?:\s|$)/,
    runner: 'node:test',
    adapter: 'cdk-constructs',
    note:
      'Bespoke CommonJS driver that runs the node:test partition of infra/cdk/test via ' +
      '`node --require ts-node/register/transpile-only --test <spec>`. The specs are CommonJS with ' +
      'extensionless relative imports, so ts-node/register is required (plain --test misloads them as ESM). ' +
      'scripts/test-proof/run-cdk-constructs.mjs reuses the driver\'s own --list partition and the canonical ' +
      'node:test reporter, preserving the real spec classification and every test identity.',
  },
  {
    package: '@capiro/e2e',
    packageDir: 'apps/e2e',
    // SOURCE-BOUND and narrow: the WHOLE command must be the package's own
    // Playwright launcher invoked with `test`. A wrong package (guarded by the
    // package/packageDir equality in matchNativeAdapter), a lookalike path
    // (other/run-playwright.mjs) or a different command cannot match.
    match: /^\s*node\s+scripts\/run-playwright\.mjs(?:\s+test)?\s*$/,
    runner: 'playwright',
    adapter: 'e2e-playwright-wrapper',
    note:
      'Bespoke ESM launcher (apps/e2e/scripts/run-playwright.mjs) that resolves the SHARED EXTERNAL ' +
      '@playwright/test runtime (fail-closed, never a monorepo dependency) and runs the real visual suite; ' +
      'the command carries no raw runner token, so discovery would otherwise report it as unsupported scope. ' +
      'lib/adapters.mjs routes this target back through that SAME launcher with `--list --reporter=json`, so the ' +
      'external pinned CLI resolution and the package\u2019s own Playwright config are preserved verbatim, and the ' +
      'canonical Playwright JSON parser keeps every per-test case identity AND its project multiplicity.',
  },
];

/** Match a bespoke command against the native adapter registry. */
export function matchNativeAdapter(packageName, packageDir, command) {
  return (
    NATIVE_RUNNER_ADAPTERS.find(
      (a) => a.package === packageName && (!a.packageDir || a.packageDir === packageDir) && a.match.test(String(command)),
    ) || null
  );
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listDirs(parent) {
  if (!isDir(parent)) return [];
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => path.join(parent, e.name));
}

/** Split a package script on top-level `&&`. Our scripts never quote `&&`. */
export function splitSegments(cmd) {
  return String(cmd)
    .split('&&')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve a `pnpm [run] <name>` (or bare script name) reference one level into
 * the underlying command, bounded by depth so a self-referential script cannot
 * loop. Returns the resolved command plus the tier name it resolved to.
 */
export function resolveSegment(segment, scripts, depth = 0) {
  if (depth > 4) return { command: segment, tier: null };
  const pnpmRun = segment.match(/^pnpm\s+(?:-C\s+\S+\s+)?(?:--filter\s+\S+\s+)?(?:run\s+)?([\w:@/.-]+)\s*$/);
  if (pnpmRun) {
    const name = pnpmRun[1];
    if (scripts && Object.prototype.hasOwnProperty.call(scripts, name)) {
      const nested = resolveSegment(scripts[name], scripts, depth + 1);
      return { command: nested.command, tier: nested.tier ?? name };
    }
    return { command: segment, tier: name };
  }
  return { command: segment, tier: null };
}

export function classifyRunner(command) {
  for (const [runner, re] of RUNNER_TOKEN) {
    if (re.test(command)) return runner;
  }
  return null;
}

/**
 * Discover every test target in the repository.
 *
 * @returns {{ targets: Array, scope: Object }}
 */
export function discoverTargets({ root, scriptNames = ['test'] }) {
  const rootAbs = path.resolve(root);
  const targets = [];
  const scope = {
    root: toPosix(rootAbs),
    discoveredPackages: [],
    aggregators: [],
    noTestScript: [],
    pythonApps: [],
    playwrightApps: [],
    unsupported: [],
    notes: [],
  };

  const packageDirs = [];
  for (const glob of WORKSPACE_GLOBS) {
    for (const dir of listDirs(path.join(rootAbs, glob))) {
      if (fs.existsSync(path.join(dir, 'package.json'))) packageDirs.push(dir);
    }
  }

  // The root package itself is an aggregator (`turbo run test`), not a suite.
  if (fs.existsSync(path.join(rootAbs, 'package.json'))) {
    const rootPkg = readJson(path.join(rootAbs, 'package.json'));
    if (rootPkg.scripts && /\bturbo\b/.test(String(rootPkg.scripts.test || ''))) {
      scope.aggregators.push({ package: rootPkg.name || '<root>', command: rootPkg.scripts.test, reason: 'delegates to turbo; not a leaf suite' });
    }
  }

  for (const dir of packageDirs.sort()) {
    const dirRel = packageDirRelative(dir, rootAbs);
    let pkg;
    try {
      pkg = readJson(path.join(dir, 'package.json'));
    } catch (err) {
      scope.unsupported.push({ packageDir: dirRel, runner: null, tier: null, command: null, reason: `unreadable package.json: ${err.message}` });
      continue;
    }
    const name = pkg.name || dirRel;
    scope.discoveredPackages.push(name);
    const scripts = pkg.scripts || {};
    const requested = Array.isArray(scriptNames) ? scriptNames : Object.keys(scripts).filter((k) => k === 'test' || k.startsWith('test:'));

    const { targets: pkgTargets, unsupported } = targetsFromScripts({
      name,
      dirRel,
      scripts,
      scriptNames: requested,
    });
    targets.push(...pkgTargets);
    scope.unsupported.push(...unsupported);

    if (!scripts.test) {
      scope.noTestScript.push({ package: name, packageDir: dirRel });
    }
  }

  // Python (non-pnpm) apps.
  for (const glob of WORKSPACE_GLOBS) {
    for (const dir of listDirs(path.join(rootAbs, glob))) {
      const py = path.join(dir, 'pyproject.toml');
      if (!fs.existsSync(py)) continue;
      const text = fs.readFileSync(py, 'utf8');
      if (!/\[tool\.pytest\.ini_options\]/.test(text) && !isDir(path.join(dir, 'tests'))) continue;
      const dirRel = packageDirRelative(dir, rootAbs);
      const nameMatch = text.match(/^\s*name\s*=\s*"([^"]+)"/m);
      const name = nameMatch ? nameMatch[1] : dirRel;
      if (!scope.discoveredPackages.includes(name)) scope.discoveredPackages.push(name);
      scope.pythonApps.push({ package: name, packageDir: dirRel });
      targets.push({
        package: name,
        packageDir: dirRel,
        runner: 'pytest',
        tier: 'pytest-collect',
        command: 'uv run pytest',
        source: 'pyproject.toml',
      });
    }
  }

  // Playwright suites.
  const candidateDirs = [];
  for (const glob of WORKSPACE_GLOBS) candidateDirs.push(...listDirs(path.join(rootAbs, glob)));
  if (fs.existsSync(rootAbs)) candidateDirs.push(rootAbs);
  for (const dir of candidateDirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const config = entries.find((e) => /^playwright\.config\.(ts|js|mjs|cjs)$/.test(e));
    if (!config) continue;
    const dirRel = packageDirRelative(dir, rootAbs);
    let name = dirRel;
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      try {
        name = readJson(path.join(dir, 'package.json')).name || dirRel;
      } catch {
        /* keep dirRel */
      }
    }
    if (!scope.discoveredPackages.includes(name)) scope.discoveredPackages.push(name);
    scope.playwrightApps.push({ package: name, packageDir: dirRel });
    targets.push({
      package: name,
      packageDir: dirRel,
      runner: 'playwright',
      tier: 'playwright-list',
      command: 'playwright test --list --reporter=json',
      source: 'playwright.config',
    });
  }

  targets.sort((a, b) => (a.packageDir === b.packageDir ? String(a.tier).localeCompare(String(b.tier)) : a.packageDir < b.packageDir ? -1 : 1));
  return { targets, scope };
}

/**
 * Derive jest/vitest/node:test targets for a single package.
 * The `test` script is the default tier; composite scripts are split so both
 * tiers of a hybrid package (e.g. infra/cdk jest + constructs) are represented.
 */
export function targetsFromScripts({ name, dirRel, scripts, scriptNames = ['test'] }) {
  const targets = [];
  const unsupported = [];
  for (const scriptName of scriptNames) {
    if (!Object.prototype.hasOwnProperty.call(scripts, scriptName)) continue;
    const segments = splitSegments(scripts[scriptName]);
    for (const segment of segments) {
      const { command, tier } = resolveSegment(segment, scripts);
      const runner = classifyRunner(command);
      const effectiveTier = tier || scriptName;
      if (!runner) {
        const adapter = matchNativeAdapter(name, dirRel, command);
        if (adapter) {
          // Classified natively via a registered adapter — full scope, real runner.
          targets.push({
            package: name,
            packageDir: dirRel,
            runner: adapter.runner,
            tier: effectiveTier,
            command,
            source: `package.json#scripts.${scriptName}`,
            adapter: adapter.adapter,
            adapterNote: adapter.note,
          });
          continue;
        }
        unsupported.push({
          package: name,
          packageDir: dirRel,
          runner: null,
          tier: effectiveTier,
          command,
          reason: 'no known runner token in command and no registered native adapter',
        });
        continue;
      }
      targets.push({
        package: name,
        packageDir: dirRel,
        runner,
        tier: effectiveTier,
        command,
        source: `package.json#scripts.${scriptName}`,
      });
    }
  }
  return { targets, unsupported };
}
