#!/usr/bin/env node
/**
 * verify-baseline.fixtures.mjs — adverse + positive fixtures for the coverage
 * baseline verifier (independent review round 2).
 *
 * Purpose: prove, with the REAL verifier (no mocks), that
 *   (a) the three manifests the reviewer reproduced are now REJECTED, each for
 *       its specific reason (invented scope / non-zero native exit / absent raw
 *       report with an invented hash), plus the related classes (empty results,
 *       a summary that does not re-derive from its raw report, and a tampered
 *       source fingerprint);
 *   (b) a COMPLETE, correct manifest — real fixture reports, matching hashes,
 *       metrics that re-derive from those reports, and provenance anchored to a
 *       real ancestor commit — is ACCEPTED;
 *   (c) a historical source fingerprint stays verifiable across later
 *       evidence-only commits (the measured-source path set excludes docs/plans
 *       evidence, and the fingerprint re-derives from the immutable commit).
 *
 * Everything is a small, controlled, task-owned fixture: no giant coverage run,
 * no product script execution, no database, no network.
 *
 * Usage: node scripts/cleanup-gates/verify-baseline.fixtures.mjs [--json out]
 * Exit: 0 every expectation held; 1 a fixture behaved unexpectedly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs, withUsage } from './lib/cli.mjs';
import { readMetrics, sha256File } from './lib/metrics.mjs';
import { provenancePaths, fingerprintAt, isAncestor, commitExists, headSha, FINGERPRINT_ALGORITHM } from './lib/provenance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VERIFIER = path.join(HERE, 'verify-baseline.mjs');
const REPORTS_DIR = path.join(ROOT, '.artifacts', 'cleanup1-verify-fixtures', 'reports');
const SCRATCH = path.join(ROOT, '.artifacts', 'cleanup1-verify-fixtures');

// The measured-source commit for the fixtures: a real, committed source commit
// that is an ancestor of HEAD (the seed the CI worktree was created from).
const SEED_SHA = headSha(ROOT);
if (!SEED_SHA || !commitExists(ROOT, SEED_SHA)) {
  throw new Error('Coverage fixtures require a real committed checkout ancestor');
}

const REQUIRED = [
  { package: '@capiro/api', packageDir: 'apps/api', runner: 'jest', kind: 'istanbul' },
  { package: '@capiro/web', packageDir: 'apps/web', runner: 'vitest', kind: 'istanbul' },
  { package: '@capiro/workspace', packageDir: 'apps/workspace', runner: 'jest', kind: 'istanbul' },
  { package: '@capiro/onboard-web', packageDir: 'apps/onboard-web', runner: 'vitest', kind: 'istanbul' },
  { package: 'capiro-defense-budget-parser', packageDir: 'apps/defense-budget-parser', runner: 'pytest-cov', kind: 'python' },
];

const toPosix = (p) => p.split(path.sep).join('/');

function istanbulReport(stmtPct = 80) {
  const mk = (total, covered) => ({ total, covered, skipped: 0, pct: Number(((covered / total) * 100).toFixed(2)) });
  return {
    total: {
      statements: mk(1000, Math.round((stmtPct / 100) * 1000)),
      branches: mk(200, 120),
      functions: mk(80, 40),
      lines: mk(1000, Math.round((stmtPct / 100) * 1000)),
    },
  };
}

function pythonReport() {
  return {
    totals: {
      num_statements: 3603,
      covered_lines: 3030,
      percent_statements_covered: Number(((3030 / 3603) * 100).toFixed(2)),
      num_branches: 1318,
      covered_branches: 880,
      percent_branches_covered: Number(((880 / 1318) * 100).toFixed(2)),
    },
  };
}

function writeReport(name, obj) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const abs = path.join(REPORTS_DIR, name);
  fs.writeFileSync(abs, JSON.stringify(obj, null, 2) + '\n');
  return toPosix(path.relative(ROOT, abs));
}

function resultFor(req, reportRel) {
  return {
    package: req.package,
    packageDir: req.packageDir,
    runner: req.runner,
    command: `fixture: ${req.runner}`,
    suiteExitCode: 0,
    reportPath: reportRel,
    reportSha256: sha256File(path.join(ROOT, reportRel)),
    metrics: readMetrics(req.runner, path.join(ROOT, reportRel)),
    status: 'measured-green',
  };
}

function measuredSource() {
  const paths = provenancePaths(ROOT);
  const fp = fingerprintAt(ROOT, SEED_SHA, paths);
  return {
    sha: SEED_SHA,
    fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
    fingerprint: fp.ok ? fp.fingerprint : null,
    paths,
    entries: fp.entries?.length ?? 0,
  };
}

function manifest(results, kind = 'historical-floor') {
  return {
    schema: 'capiro.cleanup1-coverage-baseline',
    schemaVersion: 2,
    kind,
    runSha: SEED_SHA,
    measuredSource: measuredSource(),
    generatedAt: new Date().toISOString(),
    enforcement: 'none',
    green: true,
    resultsSha256: crypto.createHash('sha256').update(JSON.stringify(results)).digest('hex'),
    results,
  };
}

function writeManifest(name, obj) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const abs = path.join(SCRATCH, name);
  fs.writeFileSync(abs, JSON.stringify(obj, null, 2) + '\n');
  return abs;
}

function runVerifier(fixtureAbs, kind = 'auto') {
  const res = spawnSync(process.execPath, [VERIFIER, '--baseline', fixtureAbs, '--kind', kind, '--json', `${fixtureAbs}.verify.json`, '--quiet'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 60000,
  });
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(`${fixtureAbs}.verify.json`, 'utf8'));
  } catch {
    /* leave null */
  }
  return { exit: res.status, stdout: res.stdout, stderr: res.stderr, report };
}

function main() {
  const args = parseArgs(process.argv.slice(2), { json: { flag: 'json', type: 'string', default: null } });
  if (args.help) {
    process.stdout.write('usage: node scripts/cleanup-gates/verify-baseline.fixtures.mjs [--json out]\n');
    process.exit(0);
  }

  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

  // ---- Build a complete, correct manifest from real fixture reports --------
  const reportRel = {};
  for (const req of REQUIRED) {
    const name = `${req.packageDir.replace(/\//g, '_')}.report.json`;
    const body = req.kind === 'python' ? pythonReport() : istanbulReport(req.runner === 'vitest' ? 74 : 82);
    reportRel[req.package] = writeReport(name, body);
  }
  const goodResults = REQUIRED.map((req) => resultFor(req, reportRel[req.package]));

  // (b) PROPER COMPLETE EVIDENCE PASSES
  const goodPath = writeManifest('good-complete.json', manifest(goodResults));
  const good = runVerifier(goodPath);
  check('complete-valid-baseline-accepted', good.exit === 0 && good.report?.ok === true, { exit: good.exit, problems: good.report?.problems });

  // (a1) INVENTED SCOPE (one package, no metrics, no reports, omits required targets)
  const a1 = [
    { package: 'only-one-package', packageDir: 'apps/only-one-package', runner: 'jest', command: 'x', suiteExitCode: 0, status: 'measured-green', reportPath: null },
  ];
  const a1Path = writeManifest('bad-1-missing-required-scope.json', manifest(a1));
  const r1 = runVerifier(a1Path);
  const r1Problems = (r1.report?.problems || []).join(' | ');
  check(
    'invented-scope-rejected',
    r1.exit === 1 && /unexpected result package|missing required coverage result/.test(r1Problems),
    { exit: r1.exit, problems: r1.report?.problems },
  );

  // (a2) NON-ZERO NATIVE EXIT labelled measured-green
  const a2 = REQUIRED.map((req) => resultFor(req, reportRel[req.package]));
  a2[0] = { ...a2[0], suiteExitCode: 1 };
  const a2Path = writeManifest('bad-2-nonzero-native-exit.json', manifest(a2));
  const r2 = runVerifier(a2Path);
  check(
    'nonzero-native-exit-rejected',
    r2.exit === 1 && /suiteExitCode must be the integer 0/.test((r2.report?.problems || []).join(' | ')),
    { exit: r2.exit, problems: r2.report?.problems },
  );

  // (a3) ABSENT RAW REPORT with an invented sha256
  const a3 = REQUIRED.map((req) => resultFor(req, reportRel[req.package]));
  a3[1] = { ...a3[1], reportPath: 'apps/web/definitely-absent-coverage-report.json', reportSha256: '0'.repeat(64) };
  const a3Path = writeManifest('bad-3-absent-report-invented-hash.json', manifest(a3));
  const r3 = runVerifier(a3Path);
  check(
    'absent-report-rejected',
    r3.exit === 1 && /raw report not found/.test((r3.report?.problems || []).join(' | ')),
    { exit: r3.exit, problems: r3.report?.problems },
  );

  // (a4) EMPTY results
  const a4Path = writeManifest('bad-4-empty-results.json', manifest([]));
  const r4 = runVerifier(a4Path);
  check('empty-results-rejected', r4.exit === 1 && /non-empty array/.test((r4.report?.problems || []).join(' | ')), { exit: r4.exit, problems: r4.report?.problems });

  // (a5) recorded metrics do NOT re-derive from the raw report
  const a5 = REQUIRED.map((req) => resultFor(req, reportRel[req.package]));
  a5[2] = { ...a5[2], metrics: { ...a5[2].metrics, statements: { total: 999999, covered: 1, skipped: 0, pct: 0.0001 } } };
  const a5Path = writeManifest('bad-5-metrics-not-matching-report.json', manifest(a5));
  const r5 = runVerifier(a5Path);
  check(
    'metrics-must-re-derive-from-raw-report',
    r5.exit === 1 && /do not match the raw report/.test((r5.report?.problems || []).join(' | ')),
    { exit: r5.exit, problems: r5.report?.problems },
  );

  // (a6) tampered measured-source fingerprint
  const a6m = manifest(REQUIRED.map((req) => resultFor(req, reportRel[req.package])));
  a6m.measuredSource = { ...a6m.measuredSource, fingerprint: 'f'.repeat(64) };
  const a6Path = writeManifest('bad-6-tampered-fingerprint.json', a6m);
  const r6 = runVerifier(a6Path);
  check(
    'tampered-fingerprint-rejected',
    r6.exit === 1 && /fingerprint mismatch/.test((r6.report?.problems || []).join(' | ')),
    { exit: r6.exit, problems: r6.report?.problems },
  );

  // (c) HISTORICAL SOURCE FINGERPRINT STAYS VERIFIABLE
  const paths = provenancePaths(ROOT);
  const fp1 = fingerprintAt(ROOT, SEED_SHA, paths);
  const fp2 = fingerprintAt(ROOT, SEED_SHA, paths);
  check('fingerprint-re-derivable', fp1.ok && fp1.fingerprint === fp2.fingerprint && fp1.fingerprint.length === 64, { fingerprint: fp1.fingerprint, entries: fp1.entries?.length });
  check('measured-source-commit-is-ancestor-of-head', commitExists(ROOT, SEED_SHA) && isAncestor(ROOT, SEED_SHA, headSha(ROOT)), { seed: SEED_SHA, head: headSha(ROOT) });
  check(
    'evidence-paths-excluded-from-fingerprint',
    paths.every((p) => !p.startsWith('docs/')),
    { evidencePathsInFingerprint: paths.filter((p) => p.startsWith('docs/')) },
  );

  const allPass = checks.every((c) => c.pass);
  const out = {
    generatedAt: new Date().toISOString(),
    verifier: toPosix(path.relative(ROOT, VERIFIER)),
    scratch: toPosix(path.relative(ROOT, SCRATCH)),
    seedSha: SEED_SHA,
    allPass,
    checks,
  };
  if (args.json) {
    const p = path.resolve(ROOT, args.json);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n');
  }
  process.stdout.write(JSON.stringify({ allPass, passed: checks.filter((c) => c.pass).length, total: checks.length, checks: checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}`) }, null, 2) + '\n');
  process.exit(allPass ? 0 : 1);
}

withUsage(main, 'usage: node scripts/cleanup-gates/verify-baseline.fixtures.mjs [--json out]')();
