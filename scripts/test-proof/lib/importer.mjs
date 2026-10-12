/**
 * Read-existing-report mode.
 *
 * The baseline worker's runner already produced native reports (jest/vitest
 * JSON, a pytest collect listing, playwright list JSON, or our node:test
 * structured report). Re-running a whole monorepo suite purely to verify the
 * diff tooling would be wasteful, so this module turns those reports into a
 * canonical dump directly.
 *
 * A manifest maps each target to the report file the runner produced:
 *   {
 *     "runSha": "<sha>",
 *     "root": "<original checkout root>",          // provenance only
 *     "targets": [
 *       { "package":"@capiro/api", "packageDir":"apps/api", "runner":"jest",
 *         "tier":"test", "reportFile":"reports/api.json", "exitCode":0 }
 *     ]
 *   }
 *
 * Report paths are resolved relative to the manifest file (or absolute).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseReport } from './adapters.mjs';
import { makeTargetRecord } from './dump.mjs';
import { TARGET_STATUS, NON_PASSING_TARGET_STATUSES } from './schema.mjs';
import { toPosix } from './paths.mjs';

function resolveReport(manifestDir, reportFile) {
  if (!reportFile) return null;
  return path.isAbsolute(reportFile) ? reportFile : path.resolve(manifestDir, reportFile);
}

export function importDump({ manifestPath, runShaOverride = null }) {
  const abs = path.resolve(manifestPath);
  const manifestDir = path.dirname(abs);
  const manifest = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const rootAbs = manifest.root ? path.resolve(manifest.root) : path.resolve(manifestDir);
  const specs = Array.isArray(manifest.targets) ? manifest.targets : [];
  const targets = [];
  const errors = [];

  for (const spec of specs) {
    const target = {
      package: spec.package,
      packageDir: spec.packageDir,
      runner: spec.runner,
      tier: spec.tier ?? null,
      command: spec.command ?? `import:${spec.reportFile ?? ''}`,
    };
    const packageDirAbs = path.resolve(rootAbs, spec.packageDir);
    const reportFile = resolveReport(manifestDir, spec.reportFile);
    let record;
    try {
      const text = fs.readFileSync(reportFile, 'utf8');
      const parsed = parseReport(target, { text }, { packageDirAbs, packageDirRel: spec.packageDir, reportPath: reportFile });
      const exitCode = typeof spec.exitCode === 'number' ? spec.exitCode : 0;
      const counts = parsed.counts || { failed: 0, total: parsed.tests.length };
      const collectionFailure = (parsed.warnings || []).some((w) => w.kind === 'collection-failure');

      // Report failure semantics are RETAINED: a report that shows failed tests,
      // a failed collection, or a nonzero exit is NOT a passing import. It is a
      // non-passing target so the dump's exit code (and the diff) fail closed.
      let status;
      let statusDetail = null;
      if (parsed.tests.length === 0) {
        status = TARGET_STATUS.ZERO_TESTS;
        statusDetail = `imported report ${spec.reportFile ?? ''} contained zero tests`;
      } else if (exitCode !== 0) {
        status = TARGET_STATUS.RUNNER_FAILED;
        statusDetail = `imported report ${spec.reportFile ?? ''} declares exitCode=${exitCode}`;
      } else if ((counts.failed || 0) > 0) {
        status = TARGET_STATUS.RUNNER_FAILED;
        statusDetail = `imported report ${spec.reportFile ?? ''} contains ${counts.failed} failed test(s)`;
      } else if (collectionFailure) {
        status = TARGET_STATUS.RUNNER_FAILED;
        statusDetail = `imported report ${spec.reportFile ?? ''} shows a suite collection failure`;
      } else {
        status = TARGET_STATUS.IMPORTED;
      }

      record = makeTargetRecord({
        target,
        tests: parsed.tests,
        status,
        statusDetail,
        command: target.command,
        reportFile: toPosix(reportFile),
        reportFormat: parsed.nativeRunner,
        warnings: parsed.warnings,
        exitCode,
      });
      if (NON_PASSING_TARGET_STATUSES.has(status)) errors.push(statusDetail);
    } catch (err) {
      record = makeTargetRecord({
        target,
        tests: [],
        status: TARGET_STATUS.ERROR,
        statusDetail: `could not read/parse report ${spec.reportFile}: ${err.message}`,
        command: target.command,
        reportFile: reportFile ? toPosix(reportFile) : null,
        exitCode: spec.exitCode ?? 1,
      });
      errors.push(record.statusDetail);
    }
    targets.push(record);
  }

  return {
    runSha: runShaOverride ?? manifest.runSha ?? null,
    root: manifest.root ?? null,
    targets,
    importErrors: errors,
  };
}
