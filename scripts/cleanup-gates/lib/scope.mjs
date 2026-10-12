/**
 * Dynamic, fail-closed scope for the CleanUp1 gate.
 *
 * There is NO hand-maintained package allowlist anywhere in the gate. The
 * workspace globs (`apps/*`, `packages/*`, `infra/*`) are walked at run time by
 * the reviewed `scripts/test-proof/lib/discovery.mjs`, so a package another
 * author adds is INCLUDED, and a test script whose runner cannot be classified
 * is surfaced (and, if not a registered quirk, treated as a hard failure)
 * rather than silently dropped.
 */

import { discoverTargets, splitSegments, resolveSegment, classifyRunner } from '../../test-proof/lib/discovery.mjs';
import { UNCLASSIFIED_RUNNER_QUIRKS } from './quirks.mjs';

/**
 * @param {string} root absolute repo root
 * @returns {{
 *   targets: Array, scope: Object,
 *   packages: Array<{package:string, packageDir:string, runners:string[], tiers:string[]}>,
 *   testBearingPackages: string[],
 *   unexplainedUnsupported: Array,
 *   pythonApps: Array, playwrightApps: Array,
 *   ok: boolean, problems: string[],
 * }}
 */
export function buildScope(root) {
  // The default tier is each package's own `test` script — exactly what
  // `pnpm turbo run test` executes. `test:*` sub-tiers are inspected only to
  // explain composite scripts; turbo drives the same top-level `test` script.
  const { targets, scope } = discoverTargets({ root, scriptNames: ['test'] });

  const byPackage = new Map();
  for (const t of targets) {
    const key = t.packageDir;
    if (!byPackage.has(key)) {
      byPackage.set(key, { package: t.package, packageDir: t.packageDir, runners: new Set(), tiers: new Set() });
    }
    const entry = byPackage.get(key);
    entry.runners.add(t.runner);
    entry.tiers.add(t.tier);
  }
  const packages = [...byPackage.values()]
    .map((e) => ({ ...e, runners: [...e.runners].sort(), tiers: [...e.tiers].sort() }))
    .sort((a, b) => (a.packageDir < b.packageDir ? -1 : 1));

  const noTest = new Set(scope.noTestScript.map((p) => p.packageDir));
  const testBearingPackages = packages.filter((p) => !noTest.has(p.packageDir)).map((p) => p.package);

  // A discovery "unsupported" segment is only tolerated if it is a registered
  // quirk (matched by package + exact command). Anything else is a new bespoke
  // runner and must be triaged — the gate fails closed.
  const unsupported = scope.unsupported || [];
  const unexplainedUnsupported = unsupported.filter(
    (u) => !UNCLASSIFIED_RUNNER_QUIRKS.some((q) => q.package === u.package && q.command === u.command),
  );

  const problems = [];
  if (packages.length === 0) problems.push('discovery found zero test-bearing packages — workspace globs or discovery are broken');
  if (unexplainedUnsupported.length > 0) {
    problems.push(
      `${unexplainedUnsupported.length} unclassified runner segment(s): ` +
        unexplainedUnsupported.map((u) => `${u.package}:${u.tier} -> ${u.command}`).join(', '),
    );
  }
  // Every registered quirk must still correspond to a live package script, so
  // the document cannot drift away from source.
  for (const q of UNCLASSIFIED_RUNNER_QUIRKS) {
    if (![...byPackage.values()].some((e) => e.package === q.package)) {
      problems.push(`quirk references package ${q.package} that discovery did not find`);
    }
  }

  return {
    targets,
    scope,
    packages,
    testBearingPackages,
    unexplainedUnsupported,
    pythonApps: scope.pythonApps || [],
    playwrightApps: scope.playwrightApps || [],
    ok: problems.length === 0,
    problems,
  };
}

export { splitSegments, resolveSegment, classifyRunner };
