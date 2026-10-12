#!/usr/bin/env node
/**
 * Native report adapter for the infra/cdk constructs suite.
 *
 * infra/cdk partitions infra/cdk/test into two mutually incompatible styles:
 *   - jest style   — describe()/test() globals, run by `test:jest`.
 *   - node:test    — `import test from 'node:test'`, run by the bespoke
 *                    `scripts/run-construct-tests.cjs` driver.
 *
 * The driver's command carries no runner token, so discovery used to report it
 * as unsupported scope. This adapter removes that waiver: it REUSES the
 * driver's own `--list` partition (so the real spec classification is never
 * re-implemented and can never drift), then runs each selected spec one file
 * per process under the SAME `node --require ts-node/register/transpile-only
 * --test` invocation the driver uses, and writes the canonical node:test report
 * via scripts/test-proof/node-test-reporter.mjs. Every spec file becomes a
 * definite suite identity and every leaf test keeps its full name.
 *
 * NATIVE COMPLETENESS (independent review round 3, item 17): a wrapper exit 0
 * alone does NOT prove every native file was green. The previous guard
 * `if (res.status && res.status !== 0)` treated a null/undefined status (a
 * signal or spawn error) as success whenever a partial report existed. Every
 * spec now requires a DEFINITE integer native status 0 with no signal and no
 * spawn error, AND a complete, non-empty structured report; otherwise the run
 * fails closed and the raw child exit/signal/error/stdout-hash is retained in a
 * native-diagnostics sidecar next to the report.
 *
 * Usage (invoked by scripts/test-proof/lib/adapters.mjs buildRun):
 *   node scripts/test-proof/run-cdk-constructs.mjs \
 *     --package-dir <abs> --out <report.json> [--reporter <path>] [--glob <ignored>]
 * Exit: 0 only if every selected spec terminated with a definite integer status
 *       0 and produced a complete non-empty report; non-zero otherwise.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, withUsage } from './lib/args.mjs';
import { classifyChild } from './lib/native-child.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: node scripts/test-proof/run-cdk-constructs.mjs --package-dir <abs> --out <report.json> [--reporter <path>]';

const ARG_SPEC = {
  packageDir: { flag: 'package-dir', type: 'string', required: true },
  out: { flag: 'out', type: 'string', required: true },
  reporter: { flag: 'reporter', type: 'string', default: null },
  glob: { flag: 'glob', type: 'string', default: null },
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function listConstructSpecs(packageDir) {
  const driver = path.join(packageDir, 'scripts', 'run-construct-tests.cjs');
  if (!fs.existsSync(driver)) throw new Error(`construct driver not found: ${driver}`);
  const res = spawnSync(process.execPath, [driver, '--list'], { cwd: packageDir, encoding: 'utf8' });
  if (res.error) throw new Error(`run-construct-tests.cjs --list spawn error: ${res.error.message}`);
  if (res.signal) throw new Error(`run-construct-tests.cjs --list killed by signal ${res.signal}`);
  if (typeof res.status !== 'number') throw new Error('run-construct-tests.cjs --list produced no exit status');
  if (res.status !== 0) {
    throw new Error(`run-construct-tests.cjs --list exited ${res.status}: ${(res.stderr || '').trim()}`);
  }
  // The driver prints: "  - <relative/spec/path.spec.ts>" for each node:test spec.
  return String(res.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean)
    .map((rel) => path.resolve(packageDir, rel));
}

function main() {
  const args = parseArgs(process.argv.slice(2), ARG_SPEC);
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }
  const packageDir = path.resolve(args.packageDir);
  const outFile = path.resolve(args.out);
  const reporter = path.resolve(args.reporter || path.join(HERE, 'node-test-reporter.mjs'));
  const diagnosticsFile = `${outFile}.native-diagnostics.json`;

  const specFiles = listConstructSpecs(packageDir);
  if (specFiles.length === 0) {
    fs.writeFileSync(diagnosticsFile, JSON.stringify({ error: 'driver reported zero node:test specs', specCount: 0, specs: [] }, null, 2));
    process.stderr.write('run-cdk-constructs: driver reported zero node:test specs\n');
    process.exit(2);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-cdk-'));
  let exitCode = 0;
  const diagnostics = { packageDir, reporter, specCount: specFiles.length, specs: [] };
  const merged = { files: [] };
  try {
    for (const file of specFiles) {
      const rel = path.relative(packageDir, file).split(path.sep).join('/');
      const perFile = path.join(tmpDir, rel.replace(/[\\/]/g, '__') + '.json');
      const childEnv = { ...process.env, TEST_PROOF_OUT_FILE: perFile };
      delete childEnv.NODE_TEST_CONTEXT;

      let res;
      try {
        res = spawnSync(
          process.execPath,
          ['--require', 'ts-node/register/transpile-only', '--test', '--test-reporter', pathToFileURL(reporter).href, file],
          { cwd: packageDir, env: childEnv, encoding: 'utf8' },
        );
      } catch (err) {
        res = { error: err, status: null, signal: null, stdout: '', stderr: '' };
      }

      // A definite integer native status 0 is required — null/undefined (a
      // signal or a spawn error) must never be read as success.
      const cls = classifyChild(res);
      const diag = {
        suite: rel,
        nativeExit: cls.nativeExit,
        signal: cls.signal,
        spawnError: cls.spawnError,
        stdoutSha256: sha256(String(res.stdout || '')),
        stderrSha256: sha256(String(res.stderr || '')),
        stderrHead: String(res.stderr || '').slice(0, 2000),
        failure: cls.failure,
        testCount: 0,
      };
      if (!cls.definiteZero) exitCode = exitCode || cls.failCode;

      // A complete structured report with at least one test identity is required
      // in addition to the exit status, so a wrapper exit 0 cannot stand in for
      // real native evidence.
      let tests = [];
      try {
        tests = JSON.parse(fs.readFileSync(perFile, 'utf8')).tests || [];
      } catch {
        diag.failure = diag.failure || 'no-structured-report';
        exitCode = exitCode || 4;
      }
      if (!Array.isArray(tests) || tests.length === 0) {
        diag.failure = diag.failure || 'empty-report';
        exitCode = exitCode || 7;
      }
      diag.testCount = Array.isArray(tests) ? tests.length : 0;
      diagnostics.specs.push(diag);
      merged.files.push({ suite: rel, native: diag, tests });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  diagnostics.allGreen = diagnostics.specs.length === specFiles.length && diagnostics.specs.every((s) => s.failure === null);
  fs.writeFileSync(diagnosticsFile, JSON.stringify(diagnostics, null, 2) + '\n');
  fs.writeFileSync(outFile, JSON.stringify(merged));
  process.exit(exitCode);
}

withUsage(main, USAGE)();
