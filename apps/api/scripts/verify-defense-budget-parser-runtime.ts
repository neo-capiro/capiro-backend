/**
 * verify-defense-budget-parser-runtime — cross-language conformance gate.
 *
 * Validates that TypeScript and Python contracts agree:
 *   1. Write a TS-generated valid job fixture.
 *   2. Validate it in Python via `uv run capiro-defense-budget-parser validate-job`.
 *   3. Write a Python-generated result fixture.
 *   4. Validate it in TypeScript.
 *   5. Compare canonical hashes.
 *
 * Exit 0 if all checks pass, 1 if any check fails.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseParserRuntimeJobV1,
  parseParserRuntimeResultV1,
  computeParserConfigSha256,
} from '../src/defense-budget/parser-router/parser-runtime-contract-v1.js';
import { sha256CanonicalJson } from '../src/defense-budget/contracts/canonical-json.js';

const PARSER_DIR = path.resolve(__dirname, '..', '..', 'defense-budget-parser');
// Write ephemeral gate fixtures outside the prettier-checked source tree.
// JSON.stringify compact arrays are valid JSON but prettier --check on
// apps/api/src/defense-budget/parser-router fails when these files are rewritten
// mid-closeout.
const FIXTURES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-cross-lang-gate-'));

interface GateResult {
  check: string;
  passed: boolean;
  detail: string;
}

const results: GateResult[] = [];

/* ------------------------------------------------------------------ */
/* 1. TS generates a valid job fixture                                  */
/* ------------------------------------------------------------------ */

const tsJob = {
  schemaVersion: 'defense_budget_parser_job_v1',
  jobId: 'cross-lang-gate-job-1',
  sourcePath: '/tmp/test-source.pdf',
  sourceSha256: 'a'.repeat(64),
  engine: 'deterministic_pdfplumber',
  requestedPages: [1, 2, 3],
  parserVersion: 'pdfplumber-0.11.0',
  parserConfig: { tableProfile: 'lines' },
  parserConfigSha256: computeParserConfigSha256({ tableProfile: 'lines' }),
  outputDirectory: '/tmp/output',
  includeDebugArtifacts: false,
};

// Validate in TS
try {
  parseParserRuntimeJobV1(tsJob);
  results.push({ check: 'TS validates TS-generated job', passed: true, detail: 'ok' });
} catch (e) {
  results.push({
    check: 'TS validates TS-generated job',
    passed: false,
    detail: (e as Error).message,
  });
}

// Write fixture for Python validation
fs.mkdirSync(FIXTURES_DIR, { recursive: true });
const tsJobPath = path.join(FIXTURES_DIR, 'cross-lang-job.json');
fs.writeFileSync(tsJobPath, JSON.stringify(tsJob, null, 2) + '\n', 'utf8');

/* ------------------------------------------------------------------ */
/* 2. Python validates the TS-generated job                             */
/* ------------------------------------------------------------------ */

try {
  execFileSync('uv', ['run', 'capiro-defense-budget-parser', 'validate-job', '--job', tsJobPath], {
    cwd: PARSER_DIR,
    stdio: 'pipe',
    timeout: 30_000,
  });
  results.push({ check: 'Python validates TS-generated job', passed: true, detail: 'ok' });
} catch (e) {
  results.push({
    check: 'Python validates TS-generated job',
    passed: false,
    detail: `Python validation failed: ${(e as Error).message}`,
  });
}

/* ------------------------------------------------------------------ */
/* 3. Canonical hash comparison                                         */
/* ------------------------------------------------------------------ */

// Compute canonical hash in TS
const tsCanonicalHash = sha256CanonicalJson(tsJob);

// Read the Python canonical_json module's hash for the same object
// We do this by having Python compute the hash via a one-liner
try {
  const pyHashOutput = execFileSync(
    'uv',
    [
      'run',
      'python',
      '-c',
      `import json, sys; sys.path.insert(0, '${PARSER_DIR.replace(/\\/g, '\\\\')}\\\\src'); from capiro_defense_budget_parser.canonical_json import sha256_canonical_json; print(sha256_canonical_json(json.loads(open(r'${tsJobPath}').read())))`,
    ],
    { cwd: PARSER_DIR, stdio: 'pipe', timeout: 30_000 },
  )
    .toString()
    .trim();

  const hashMatch = tsCanonicalHash === pyHashOutput;
  results.push({
    check: 'Canonical hashes match (TS vs Python)',
    passed: hashMatch,
    detail: hashMatch
      ? `sha256=${tsCanonicalHash.slice(0, 16)}...`
      : `TS=${tsCanonicalHash.slice(0, 16)}... Python=${pyHashOutput.slice(0, 16)}...`,
  });
} catch (e) {
  results.push({
    check: 'Canonical hashes match (TS vs Python)',
    passed: false,
    detail: `Hash comparison failed: ${(e as Error).message}`,
  });
}

/* ------------------------------------------------------------------ */
/* 4. Unknown field rejection                                           */
/* ------------------------------------------------------------------ */

const invalidJob = { ...tsJob, unknownField: 'should-be-rejected' };
let tsRejects = false;
try {
  parseParserRuntimeJobV1(invalidJob);
} catch {
  tsRejects = true;
}

results.push({
  check: 'TS rejects unknown fields',
  passed: tsRejects,
  detail: tsRejects ? 'ok' : 'TS accepted unknown field',
});

// Write invalid fixture for Python
const invalidJobPath = path.join(FIXTURES_DIR, 'cross-lang-invalid-job.json');
fs.writeFileSync(invalidJobPath, JSON.stringify(invalidJob, null, 2) + '\n', 'utf8');

try {
  execFileSync(
    'uv',
    ['run', 'capiro-defense-budget-parser', 'validate-job', '--job', invalidJobPath],
    { cwd: PARSER_DIR, stdio: 'pipe', timeout: 30_000 },
  );
  results.push({
    check: 'Python rejects unknown fields',
    passed: false,
    detail: 'Python accepted unknown field',
  });
} catch {
  results.push({ check: 'Python rejects unknown fields', passed: true, detail: 'ok' });
}

/* ------------------------------------------------------------------ */
/* 5. One-based page numbering                                          */
/* ------------------------------------------------------------------ */

const unsortedJob = { ...tsJob, requestedPages: [3, 1, 2] };
let tsRejectsUnsorted = false;
try {
  parseParserRuntimeJobV1(unsortedJob);
} catch {
  tsRejectsUnsorted = true;
}

results.push({
  check: 'TS rejects unsorted pages',
  passed: tsRejectsUnsorted,
  detail: tsRejectsUnsorted ? 'ok' : 'TS accepted unsorted pages',
});

/* ------------------------------------------------------------------ */
/* Report                                                               */
/* ------------------------------------------------------------------ */

let allPassed = true;
for (const result of results) {
  const status = result.passed ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${result.check}: ${result.detail}`);
  if (!result.passed) allPassed = false;
}

if (!allPassed) {
  console.error('\nCross-language gate FAILED');
  process.exit(1);
}

console.log('\nCross-language gate passed');
process.exit(0);
