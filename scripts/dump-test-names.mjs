#!/usr/bin/env node
// @cleanup-smoke noArgsExit=1 helpExit=0
/**
 * dump-test-names — the CleanUp1 supporting infrastructure that CleanUp2 §12
 * and CleanUp3 §7 both require.
 *
 * It enumerates every test package at run time, classifies its runner, captures
 * the runner's native report (or imports one the baseline worker already
 * produced), and writes ONE canonical JSON dump of test occurrences with
 * provenance and scope.
 *
 * It NEVER dedupes: two identical fullName tests in the same or different
 * suites are two occurrences in the output array.
 *
 * Usage:
 *   node scripts/dump-test-names.mjs --run --out dump.json
 *   node scripts/dump-test-names.mjs --import manifest.json --out dump.json
 *   node scripts/dump-test-names.mjs --from-report rep.json --runner jest \
 *        --package @capiro/api --package-dir apps/api --out api.json
 *
 * Exit codes:
 *   0  every target produced a passing scope
 *   1  usage error
 *   2  explicit non-passing scope (runner failure / zero tests / unsupported)
 *   3  fatal error (bad JSON, unreadable manifest)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverTargets } from './test-proof/lib/discovery.mjs';
import { buildRun, parseReport } from './test-proof/lib/adapters.mjs';
import { importDump } from './test-proof/lib/importer.mjs';
import { assembleDump, makeTargetRecord, dumpExitCode, nonPassingReasons } from './test-proof/lib/dump.mjs';
import { TARGET_STATUS } from './test-proof/lib/schema.mjs';
import { toPosix } from './test-proof/lib/paths.mjs';

const USAGE = 'Usage: node scripts/dump-test-names.mjs --run|--import <manifest>|--from-report <report> [--out <dump>] (see header for options)';

function parseArgs(argv) {
  const args = { script: 'test', flags: new Set() };
  const valueFlags = new Set(['root', 'out', 'import', 'from-report', 'runner', 'package', 'package-dir', 'tier', 'sha', 'script', 'timeout-ms', 'playwright-cli', 'work-dir']);
  const switchFlags = new Set(['run', 'help', 'all-test-scripts', 'timestamp', 'quiet', 'no-fail-on-scope']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      throw new Error(`Unexpected argument: ${a}`);
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      const name = a.slice(2, eq);
      if (!valueFlags.has(name)) throw new Error(`Unknown option: --${name}`);
      args[name] = a.slice(eq + 1);
      continue;
    }
    const name = a.slice(2);
    if (valueFlags.has(name)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for --${name}`);
      args[name] = argv[i + 1];
      i += 1;
    } else if (switchFlags.has(name)) {
      args.flags.add(name);
      if (name === 'run') args.run = true;
    } else {
      throw new Error(`Unknown option: --${name}`);
    }
  }
  return args;
}

function gitSha(root) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (r.status === 0) return r.stdout.trim();
  return null;
}

function sanitize(p) {
  return toPosix(p).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function runTarget(target, { root, workDir, timeoutMs, playwrightCli }) {
  const rootAbs = path.resolve(root);
  const packageDirAbs = path.resolve(rootAbs, target.packageDir);
  const outFile = path.join(workDir, `${sanitize(target.packageDir)}.${sanitize(target.tier || 'test')}.report.json`);
  let run;
  try {
    run = buildRun(target, { root: rootAbs, packageDirAbs, outFile, playwrightCli });
  } catch (err) {
    return makeTargetRecord({ target, status: TARGET_STATUS.ERROR, statusDetail: err.message, exitCode: 1 });
  }
  const res = spawnSync(run.cmd, {
    cwd: run.cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ...(run.env || {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  const exitCode = typeof res.status === 'number' ? res.status : 1;

  let text = null;
  let reportFile = null;
  if (run.reportFile && fs.existsSync(run.reportFile)) {
    text = fs.readFileSync(run.reportFile, 'utf8');
    reportFile = toPosix(run.reportFile);
  } else if (run.capture === 'stdout') {
    text = res.stdout || '';
  } else if (res.stdout && res.stdout.trim()) {
    text = res.stdout;
  }

  if (text == null) {
    return makeTargetRecord({
      target,
      status: TARGET_STATUS.ERROR,
      statusDetail: `runner produced no report (exit=${exitCode}, signal=${res.signal ?? 'none'})`,
      exitCode,
      command: run.cmd,
    });
  }

  let parsed;
  try {
    parsed = parseReport(target, { text }, { packageDirAbs, packageDirRel: target.packageDir, reportPath: reportFile });
  } catch (err) {
    return makeTargetRecord({
      target,
      status: TARGET_STATUS.ERROR,
      statusDetail: `could not parse ${target.runner} report: ${err.message}`,
      exitCode,
      command: run.cmd,
      reportFile,
    });
  }

  let status;
  let detail = null;
  if (parsed.tests.length === 0) {
    status = TARGET_STATUS.ZERO_TESTS;
    detail = `runner exited ${exitCode} with zero discovered tests`;
  } else if (exitCode !== 0) {
    status = TARGET_STATUS.RUNNER_FAILED;
    detail = `runner exited ${exitCode}`;
  } else {
    status = TARGET_STATUS.OK;
  }

  return makeTargetRecord({
    target,
    tests: parsed.tests,
    status,
    statusDetail: detail,
    exitCode,
    command: run.cmd,
    reportFile,
    reportFormat: parsed.nativeRunner,
    warnings: parsed.warnings,
  });
}

async function main() {
  if (process.argv.length === 2) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${USAGE}\n${error.message}\n`);
    process.exit(1);
  }
  if (args.flags.has('help')) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }

  const root = args.root || process.cwd();
  const rootAbs = path.resolve(root);
  const timeoutMs = args['timeout-ms'] ? Number(args['timeout-ms']) : 30 * 60 * 1000;

  let dump;
  let nonPassing = [];

  if (args.import) {
    let imported;
    try {
      imported = importDump({ manifestPath: args.import, runShaOverride: args.sha || null });
    } catch (err) {
      process.stderr.write(`dump-test-names: cannot read manifest ${args.import}: ${err.message}\n`);
      process.exit(3);
    }
    const scope = { discoveredPackages: imported.targets.map((t) => t.package), unsupported: [], noTestScript: [], aggregators: [], pythonApps: [], playwrightApps: [] };
    dump = assembleDump({ root: imported.root, runSha: imported.runSha, targets: imported.targets, scope, timestamp: args.flags.has('timestamp') });
    nonPassing = imported.importErrors;
  } else if (args['from-report']) {
    const manifest = {
      runSha: args.sha || null,
      root: rootAbs,
      targets: [
        {
          package: args.package,
          packageDir: args['package-dir'] || args.package,
          runner: args.runner,
          tier: args.tier || null,
          reportFile: path.resolve(args['from-report']),
          exitCode: 0,
        },
      ],
    };
    const tmp = path.join(os.tmpdir(), `tp-manifest-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(manifest));
    try {
      const imported = importDump({ manifestPath: tmp, runShaOverride: args.sha || null });
      const scope = { discoveredPackages: [args.package], unsupported: [] };
      dump = assembleDump({ root: rootAbs, runSha: imported.runSha, targets: imported.targets, scope, timestamp: args.flags.has('timestamp') });
      nonPassing = imported.importErrors;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } else {
    // run mode
    // Default tier is the package's own `test` script. `--all-test-scripts`
    // widens to every `test*` script; `--script <name>` narrows to one.
    const scriptNames = args.flags.has('all-test-scripts') ? null : [args.script || 'test'];
    const { targets: allTargets, scope } = discoverTargets({ root: rootAbs, scriptNames });
    let targets = allTargets;
    if (args.package) targets = targets.filter((t) => t.package === args.package || t.packageDir === args.package || t.package.includes(args.package));
    if (args.runner) targets = targets.filter((t) => t.runner === args.runner);

    const workDir = args['work-dir'] ? path.resolve(args['work-dir']) : fs.mkdtempSync(path.join(os.tmpdir(), 'tp-dump-'));
    const records = targets.map((t) => runTarget(t, { root: rootAbs, workDir, timeoutMs, playwrightCli: args['playwright-cli'] }));
    dump = assembleDump({ root: rootAbs, runSha: args.sha || gitSha(rootAbs), targets: records, scope, timestamp: args.flags.has('timestamp') });
  }

  const out = args.out ? path.resolve(args.out) : null;
  const text = JSON.stringify(dump, null, 2) + '\n';
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
  } else {
    process.stdout.write(text);
  }

  const reasons = [...nonPassing, ...nonPassingReasons(dump)];
  if (!args.flags.has('quiet')) {
    process.stderr.write(`dump-test-names: ${dump.targets.length} target(s); ${reasons.length} non-passing scope item(s)\n`);
    for (const r of reasons) process.stderr.write(`  - ${r}\n`);
    if (out) process.stderr.write(`wrote ${out}\n`);
  }

  if (reasons.length > 0 && !args.flags.has('no-fail-on-scope')) process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`dump-test-names: fatal: ${err.stack || err.message}\n`);
  process.exit(3);
});
