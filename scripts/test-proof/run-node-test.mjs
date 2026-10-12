#!/usr/bin/env node
/**
 * Run a package's node:test suites ONE FILE PER PROCESS and merge the
 * structured per-file reports into one canonical report.
 *
 * Per-file spawning is deliberate: Node's test-runner event stream does not
 * carry the test FILE on a leaf event, so a single multi-file process cannot
 * attribute an occurrence to a suite. One process per file makes the file
 * (a package-relative path) the definite suite identity, and matches how the
 * other adapters present jest/vitest "testResults[].name".
 *
 * Uses `node --import tsx --test` so `--test-reporter` is definitely passed to
 * Node itself (not filtered by a tsx CLI shim), and so TypeScript spec files
 * load. No dependencies beyond Node builtins and the package's own tsx.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyChild } from './lib/native-child.mjs';

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    out[k.slice(2)] = argv[i + 1];
  }
  return out;
}

function globToRegExp(pattern) {
  // Minimal, deterministic glob: ** crosses directories, * stays within one.
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
}

function expandGlob(packageDir, pattern) {
  const files = [];
  walk(packageDir, files);
  const re = globToRegExp(pattern);
  return files
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => re.test(f.slice(packageDir.replace(/\\/g, '/').length + 1)))
    .sort();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageDir = path.resolve(args['package-dir']);
  const reporter = path.resolve(args.reporter || path.join(path.dirname(fileURLToPath(import.meta.url)), 'node-test-reporter.mjs'));
  const outFile = path.resolve(args.out);
  const glob = args.glob || 'src/**/*.spec.ts';

  const files = expandGlob(packageDir, glob);
  const merged = { files: [] };
  // Additive diagnostics sidecar (owned report area): retains the real child
  // stdout/stderr bytes, exit/signal/spawn classification and any reporter
  // error/cause detail per suite, so a failed native run is never reduced to an
  // uninformative status. The canonical report shape/identity is unchanged.
  const diagnostics = { packageDir, glob, files: [] };
  let exitCode = 0;

  if (files.length === 0) {
    fs.writeFileSync(outFile, JSON.stringify(merged));
    process.stderr.write(`run-node-test: no files matched ${JSON.stringify(glob)} under ${packageDir}\n`);
    process.exit(2);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-node-'));
  try {
    for (const file of files) {
      const rel = file.slice(packageDir.replace(/\\/g, '/').length + 1);
      const perFile = path.join(tmpDir, rel.replace(/[\\/]/g, '__') + '.json');
      const childEnv = { ...process.env, TEST_PROOF_OUT_FILE: perFile };
      // Strip an inherited node:test context so a nested invocation is not
      // refused ("run() is being called recursively").
      delete childEnv.NODE_TEST_CONTEXT;
      let res;
      try {
        res = spawnSync(
          process.execPath,
          ['--import', 'tsx', '--test', '--test-reporter', pathToFileURL(reporter).href, file],
          // NO `encoding`: keep the child's ACTUAL raw stdout/stderr BYTES so an
          // invalid-UTF8 diagnostic is never silently lossy. Decoded previews are
          // additive only (see diag below).
          { cwd: packageDir, env: childEnv },
        );
      } catch (err) {
        res = { error: err, status: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      // Definite integer status 0 required — a null status (signal/spawn error)
      // must never be read as success (independent review round 3, item 17).
      const cls = classifyChild(res);
      if (!cls.definiteZero) exitCode = exitCode || cls.failCode;
      let tests = [];
      let reportedDiagnostics = null;
      try {
        const parsed = JSON.parse(fs.readFileSync(perFile, 'utf8'));
        tests = parsed.tests || [];
        reportedDiagnostics = parsed.diagnostics || null;
      } catch {
        exitCode = exitCode || 4;
        process.stderr.write(`run-node-test: no structured report produced for ${rel}\n`);
      }
      if (!Array.isArray(tests) || tests.length === 0) {
        exitCode = exitCode || 7;
        process.stderr.write(`run-node-test: empty structured report for ${rel}\n`);
      }
      // Retain the ACTUAL raw bytes: base64 + sha256 over the bytes (identity),
      // with additive decoded previews. `String(res.stdout)` would corrupt an
      // invalid-UTF8 diagnostic, so bytes are the source of truth here.
      const toBytes = (v) =>
        Buffer.isBuffer(v) ? v : v === null || v === undefined ? Buffer.alloc(0) : Buffer.from(String(v));
      const stdoutBuf = toBytes(res.stdout);
      const stderrBuf = toBytes(res.stderr);
      const diag = {
        suite: rel,
        nativeExit: cls.nativeExit,
        signal: cls.signal,
        spawnError: cls.spawnError,
        failure: cls.failure,
        testCount: Array.isArray(tests) ? tests.length : 0,
        stdoutBytes: stdoutBuf.length,
        stderrBytes: stderrBuf.length,
        stdoutSha256: sha256(stdoutBuf),
        stderrSha256: sha256(stderrBuf),
        stdoutBase64: stdoutBuf.toString('base64'),
        stderrBase64: stderrBuf.toString('base64'),
        stdoutPreview: stdoutBuf.toString('utf8').slice(0, 4000),
        stderrPreview: stderrBuf.toString('utf8').slice(0, 4000),
        reportedDiagnostics,
      };
      // Diagnostics live in the SIDECAR only; the canonical merged report keeps
      // only suite/native/tests (its identity is unchanged and NOT duplicated).
      diagnostics.files.push(diag);
      merged.files.push({ suite: rel, native: cls, tests });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  fs.writeFileSync(`${outFile}.native-diagnostics.json`, JSON.stringify(diagnostics, null, 2) + '\n');
  fs.writeFileSync(outFile, JSON.stringify(merged));
  process.exit(exitCode);
}

main();
