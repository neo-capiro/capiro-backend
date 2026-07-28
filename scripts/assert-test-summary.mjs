#!/usr/bin/env node
/**
 * Gate V c-2 — enforce "zero in-scope failures and zero skips", not the
 * repo-wide "no new failures vs. baseline".
 *
 * The repo-wide policy is the right default for 4,300 tests carrying real
 * pre-existing debt. It is the wrong bar for a release gate: apps/api is 12
 * suites red and apps/intel-api is 9, so a LegiWatch regression that lands in
 * an already-red suite passes "no new failures" untouched. c-2 replaces that
 * bar inside LegiWatch scope.
 *
 * It also enforces two things a plain exit code does not:
 *
 *  - ZERO SKIPS. A `.skip` or `.todo` inside the scope silently shrinks the
 *    gate. Jest and vitest both exit 0 with skipped tests.
 *  - MINIMUM COUNTS. The suite list is enumerated explicitly so the bar cannot
 *    shrink silently (c-2), but an explicit list still degrades quietly if a
 *    path stops matching after a rename — the run would pass with fewer files.
 *    A floor turns that into a failure.
 *
 * Reads the jest/vitest `--json` summary, which share these field names.
 * One difference worth knowing when setting floors: jest's numTotalTestSuites
 * counts FILES, vitest's counts `describe` BLOCKS. Pick the floor accordingly —
 * the test count is the tighter signal in both.
 *
 * Raising a floor is expected when suites are added. LOWERING one should be a
 * conscious act recorded in the PR, because it is indistinguishable from the
 * gate quietly shrinking.
 *
 * Usage:
 *   node scripts/assert-test-summary.mjs <summary.json> <label> <minSuites> <minTests>
 */
import { readFileSync } from 'node:fs';

const [, , file, label, minSuitesRaw, minTestsRaw] = process.argv;
if (!file || !label) {
  console.error('usage: assert-test-summary.mjs <summary.json> <label> <minSuites> <minTests>');
  process.exit(2);
}
const minSuites = Number(minSuitesRaw ?? 0);
const minTests = Number(minTestsRaw ?? 0);

let s;
try {
  s = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
} catch (e) {
  console.error(`[${label}] could not read the test summary at ${file}: ${e.message}`);
  console.error('A missing summary means the runner died before writing one — treat as failure.');
  process.exit(1);
}

const n = (k) => (typeof s[k] === 'number' ? s[k] : 0);
const failedTests = n('numFailedTests');
const failedSuites = n('numFailedTestSuites');
const pending = n('numPendingTests');
const todo = n('numTodoTests');
const totalTests = n('numTotalTests');
const totalSuites = n('numTotalTestSuites');

const problems = [];
if (failedTests > 0 || failedSuites > 0) {
  problems.push(`${failedTests} failing test(s) across ${failedSuites} suite(s) — the in-scope bar is ZERO, not "no new failures"`);
}
if (pending > 0) problems.push(`${pending} skipped test(s) — a .skip inside LegiWatch scope shrinks the gate`);
if (todo > 0) problems.push(`${todo} todo test(s) — same reason`);
if (totalSuites < minSuites) {
  problems.push(`only ${totalSuites} suite(s) ran, expected at least ${minSuites} — a path filter probably stopped matching after a rename`);
}
if (totalTests < minTests) {
  problems.push(`only ${totalTests} test(s) ran, expected at least ${minTests} — see above`);
}

if (problems.length) {
  console.error(`\n[${label}] FAILED the LegiWatch in-scope bar:`);
  for (const p of problems) console.error(`  - ${p}`);
  if (failedSuites > 0) {
    for (const r of s.testResults ?? []) {
      if (r.status === 'failed' || (r.numFailingTests ?? 0) > 0) {
        console.error(`    FAIL ${r.name ?? r.testFilePath ?? '(unknown file)'}`);
      }
    }
  }
  process.exit(1);
}

console.log(`[${label}] OK — ${totalSuites} suites / ${totalTests} tests, 0 failed, 0 skipped, 0 todo.`);
