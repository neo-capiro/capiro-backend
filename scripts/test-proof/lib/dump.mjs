/**
 * Assemble a canonical dump and compute its scope + exit code.
 *
 * Scope is deliberately explicit. A target that failed, discovered zero tests,
 * or used a runner/command we cannot classify is recorded as NON-PASSING scope
 * — never dropped — so "the suite vanished" can never look like "no change".
 * Only `ok` and `imported` are passing target statuses.
 */

import { DUMP_SCHEMA, SCHEMA_VERSION, NON_PASSING_TARGET_STATUSES, countTests, sortTests } from './schema.mjs';

export function makeTargetRecord({
  target,
  tests = [],
  status,
  statusDetail = null,
  exitCode = 0,
  command = null,
  reportFile = null,
  reportFormat = null,
  warnings = [],
}) {
  return {
    package: target.package,
    packageDir: target.packageDir,
    runner: target.runner,
    tier: target.tier ?? null,
    command: command ?? target.command ?? null,
    reportFile,
    reportFormat,
    exitCode,
    status,
    statusDetail,
    warnings,
    counts: countTests(tests),
    tests: sortTests(tests),
  };
}

export function assembleDump({ root, runSha, targets, scope, timestamp = false }) {
  const scopeOut = {
    discoveredPackages: scope.discoveredPackages || [],
    aggregators: scope.aggregators || [],
    noTestScript: scope.noTestScript || [],
    pythonApps: scope.pythonApps || [],
    playwrightApps: scope.playwrightApps || [],
    unsupported: scope.unsupported || [],
    runnerFailures: [],
    zeroTestTargets: [],
    errors: [],
    acknowledgedScope: scope.acknowledgedScope || [],
  };

  for (const t of targets) {
    if (t.status === 'runner-failed') scopeOut.runnerFailures.push({ package: t.package, runner: t.runner, tier: t.tier, exitCode: t.exitCode });
    if (t.status === 'zero-tests') scopeOut.zeroTestTargets.push({ package: t.package, runner: t.runner, tier: t.tier });
    if (t.status === 'error') scopeOut.errors.push({ package: t.package, runner: t.runner, tier: t.tier, detail: t.statusDetail });
  }

  const dump = {
    schema: DUMP_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    runSha: runSha ?? null,
    root: root ?? null,
    targets,
    scope: scopeOut,
  };
  if (timestamp) dump.generatedAt = new Date().toISOString();
  return dump;
}

export function nonPassingReasons(dump) {
  const reasons = [];
  for (const t of dump.targets || []) {
    if (NON_PASSING_TARGET_STATUSES.has(t.status)) reasons.push(`target ${t.package}[${t.runner}] status=${t.status}${t.statusDetail ? ` (${t.statusDetail})` : ''}`);
  }
  for (const u of dump.scope?.unsupported || []) reasons.push(`unsupported target ${u.package ?? u.packageDir} tier=${u.tier}: ${u.reason}`);
  return reasons;
}

export function dumpExitCode(dump) {
  return nonPassingReasons(dump).length > 0 ? 2 : 0;
}
