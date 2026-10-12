#!/usr/bin/env node
/**
 * coverage:cleanup1 — measured coverage baseline (plan §5.2, §10).
 *
 * Runs each configured package's own `test:coverage` script (jest / vitest v8)
 * and the Python pytest-cov run, then records the REAL summary numbers
 * (statements / branches / functions / lines), the runner exit code, the SOURCE
 * provenance (measured commit + a fingerprint of the coverage-relevant
 * source/config files) and a sha256 of the raw report into
 * docs/plans/cleanup1-coverage-baseline.json.
 *
 * Raw reports are copied byte-for-byte into a COMMITTED evidence directory
 * (docs/plans/cleanup1-coverage-evidence/) so a historical baseline can point
 * at a real, hash-verifiable report from a fresh checkout — the generated
 * `coverage/` dirs are gitignored and do not survive.
 *
 * Hard rules (plan §5.2, §10):
 *   - No threshold, no --cov-fail-under, no enforcement. Numbers are recorded.
 *   - A suite that fails is recorded with status `diagnostic`, never green.
 *   - A missing summary is a failure (fail-closed), not a silent 0%.
 *   - Nothing is fabricated: a package that did not run is `not-run`.
 *
 * Usage:
 *   node scripts/cleanup-gates/coverage.mjs --measure
 *        [--only apps/web,apps/onboard-web] [--json docs/plans/cleanup1-coverage-baseline.json]
 *        [--kind current-run|historical-floor] [--no-python] [--quiet]
 *
 * Bare no-argument mode only prints usage; --measure keeps the original default
 * output and coverage run when invoked through the package command.
 * @cleanup-smoke noArgsExit=2 helpExit=0
 *
 * Exit: 0 every configured target produced a summary AND its suite exited 0
 *       (full green measurement); 1 a suite failed or a summary is missing
 *       (the baseline json is still written, marked diagnostic); 2 usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run, capture } from './lib/runner.mjs';
import { parseArgs, withUsage } from './lib/cli.mjs';
import { readMetrics, sha256File } from './lib/metrics.mjs';
import { provenancePaths, fingerprintAt, FINGERPRINT_ALGORITHM } from './lib/provenance.mjs';
import { COVERAGE_TARGETS, PYTHON_COVERAGE, COVERAGE_EVIDENCE_DIR } from './gate-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const USAGE =
  'Usage: node scripts/cleanup-gates/coverage.mjs --measure [--only dirs] [--json path] [--kind current-run|historical-floor] [--no-python] [--quiet]';
const ARG_SPEC = {
  measure: { flag: 'measure', type: 'flag', default: false },
  json: { flag: 'json', type: 'string', default: 'docs/plans/cleanup1-coverage-baseline.json' },
  only: { flag: 'only', type: 'csv', default: null },
  kind: { flag: 'kind', type: 'string', default: 'current-run', choices: ['current-run', 'historical-floor'] },
  noPython: { flag: 'no-python', type: 'flag', default: false },
  quiet: { flag: 'quiet', type: 'flag', default: false },
};

const toPosix = (p) => p.split(path.sep).join('/');

function main() {
  if (process.argv.length === 2) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2), ARG_SPEC);
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }
  const includePython = !args.noPython;

  const summary = capture('git rev-parse HEAD', { cwd: ROOT });
  const runSha = summary.ok ? summary.stdout : null;
  const artifactDir = path.join(ROOT, '.artifacts', 'cleanup1-coverage');
  const evidenceDir = path.join(ROOT, COVERAGE_EVIDENCE_DIR);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });

  const targets = COVERAGE_TARGETS.filter((t) => !args.only || args.only.includes(t.packageDir));
  const results = [];

  // Prereq build (documented setup): api/workspace/web/onboard-web import the
  // built `dist` of these workspace library packages. Build just these (turbo
  // dedupes and builds their own deps), NOT the packages under test.
  let prereqBuildExitCode = null;
  const PREREQ_BUILD_PACKAGES = [
    '@capiro/shared',
    '@capiro/strategy-verifier',
    '@capiro/defense-contracts',
    '@capiro/defense-domain',
    '@capiro/meriv2-core',
    '@capiro/auth',
  ];
  if (targets.length) {
    const filterArgs = PREREQ_BUILD_PACKAGES.map((p) => `--filter=${p}`).join(' ');
    prereqBuildExitCode = run(`pnpm turbo run build ${filterArgs}`, { cwd: ROOT, label: 'prereq build (workspace libs)' });
    if (prereqBuildExitCode !== 0) {
      process.stderr.write('[coverage] WARNING: prereq build failed; coverage numbers may be unreliable (recorded diagnostic).\n');
    }
  }

  /**
   * Copy a raw report into the committed evidence directory and return the
   * repo-relative posix path. Deterministic name; byte-for-byte copy so the
   * recorded sha256 is stable and re-derivable.
   */
  function publishEvidence(packageDir, rawAbs, suffix) {
    const name = `${packageDir.replace(/\//g, '_')}.${suffix}`;
    const destAbs = path.join(evidenceDir, name);
    fs.copyFileSync(rawAbs, destAbs);
    return toPosix(path.relative(ROOT, destAbs));
  }

  for (const t of targets) {
    const pkgDir = path.join(ROOT, t.packageDir);
    const summaryPath = path.join(pkgDir, t.summary);
    fs.rmSync(summaryPath, { force: true });
    const logFile = path.join(artifactDir, `${t.packageDir.replace(/\//g, '_')}.coverage.log`);
    const cmd = `pnpm --filter ${t.package} test:coverage`;
    const exitCode = run(cmd, { cwd: ROOT, label: `${t.package} test:coverage` });
    fs.writeFileSync(logFile, `# ${cmd}\n# exit=${exitCode}\n# summary=${t.summary}\n`);
    const rec = {
      package: t.package,
      packageDir: t.packageDir,
      runner: t.runner,
      command: cmd,
      suiteExitCode: exitCode,
      reportPath: null,
    };
    if (fs.existsSync(summaryPath)) {
      try {
        rec.metrics = readMetrics(t.runner, summaryPath);
        rec.reportPath = publishEvidence(t.packageDir, summaryPath, 'report.json');
        rec.reportSha256 = sha256File(path.join(ROOT, rec.reportPath));
      } catch (err) {
        rec.error = `unreadable summary: ${err.message}`;
      }
    } else {
      rec.error = 'coverage summary not produced (the runner did not emit json-summary)';
    }
    rec.status = exitCode === 0 && rec.metrics ? 'measured-green' : 'diagnostic';
    results.push(rec);
    if (!args.quiet) process.stdout.write(`[coverage] ${t.package}: ${rec.status} (exit=${exitCode})\n`);
  }

  if (includePython) {
    const pkgDir = path.join(ROOT, PYTHON_COVERAGE.packageDir);
    const reportPath = path.join(pkgDir, PYTHON_COVERAGE.report);
    fs.rmSync(reportPath, { force: true });
    const cmd = `uv run --frozen pytest --cov=capiro_defense_budget_parser --cov-branch --cov-report=json --cov-report=term`;
    const exitCode = run(cmd, { cwd: pkgDir, label: 'python pytest coverage' });
    const rec = {
      package: PYTHON_COVERAGE.package,
      packageDir: PYTHON_COVERAGE.packageDir,
      runner: 'pytest-cov',
      command: cmd,
      suiteExitCode: exitCode,
      reportPath: null,
    };
    if (fs.existsSync(reportPath)) {
      try {
        rec.metrics = readMetrics('pytest-cov', reportPath);
        rec.reportPath = publishEvidence(PYTHON_COVERAGE.packageDir, reportPath, 'report.json');
        rec.reportSha256 = sha256File(path.join(ROOT, rec.reportPath));
      } catch (err) {
        rec.error = `unreadable report: ${err.message}`;
      }
    } else {
      rec.error = 'coverage.json not produced';
    }
    rec.status = exitCode === 0 && rec.metrics ? 'measured-green' : 'diagnostic';
    results.push(rec);
    if (!args.quiet) process.stdout.write(`[coverage] ${PYTHON_COVERAGE.package}: ${rec.status} (exit=${exitCode})\n`);
  }

  // ---- Source provenance ---------------------------------------------------
  let measuredSource = null;
  if (runSha) {
    const paths = provenancePaths(ROOT);
    const fp = fingerprintAt(ROOT, runSha, paths);
    measuredSource = {
      sha: runSha,
      fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
      fingerprint: fp.ok ? fp.fingerprint : null,
      paths,
      note: fp.ok
        ? 'Fingerprint over the COMPLETE measured-source input set (all workspace source roots apps/packages/infra, the root dependency/workspace/turbo/tsconfig contracts, the runner/gate scripts and the CI workflows) at the measured commit; re-derivable from git and stable across later evidence-only commits.'
        : `fingerprint could not be derived: ${fp.error}`,
    };
  }

  const green = results.every((r) => r.status === 'measured-green');
  const out = {
    schema: 'capiro.cleanup1-coverage-baseline',
    schemaVersion: 2,
    kind: args.kind,
    runSha,
    measuredSource,
    generatedAt: new Date().toISOString(),
    enforcement: 'none (measured only — no threshold, no --cov-fail-under; CleanUp1 §5.2)',
    prereqBuildExitCode,
    green,
    // Tamper hash over the recorded results. verify-baseline.mjs recomputes it
    // as defence in depth; the real immutability anchor is measuredSource.
    resultsSha256: crypto.createHash('sha256').update(JSON.stringify(results)).digest('hex'),
    note: green
      ? 'Every configured coverage target ran and its suite exited 0.'
      : 'One or more suites failed or produced no summary. These are DIAGNOSTIC measurements, not green acceptance; the CleanUp1 coverage baseline remains explicitly pending until the baseline repairs integrate.',
    results,
  };
  const outPath = path.resolve(ROOT, args.json);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(`[coverage] wrote ${outPath} (green=${green})\n`);
  process.exit(green ? 0 : 1);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) withUsage(main, USAGE)();
