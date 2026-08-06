/**

 * Phase 3 mandatory defect-injection controls.

 *

 * Every control mutates the real implementation, requires its named gate to

 * fail, restores the exact original bytes, then requires the same gate green.

 */

import { spawnSync } from 'node:child_process';

import * as fs from 'node:fs';

import * as path from 'node:path';

const API_ROOT = path.resolve(__dirname, '..');

const REPO_ROOT = path.resolve(API_ROOT, '..', '..');

const PYTHON_ROOT = path.join(REPO_ROOT, 'apps', 'defense-budget-parser');

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

type Gate =
  | 'architecture'
  | 'cross-language'
  | 'llamaparse-jest'
  | 'artifact-store-jest'
  | 'runtime-contract-jest'
  | 'compositor-jest'
  | 'route-planner-jest';

interface Control {
  id: number;

  description: string;

  target: string;

  original: string;

  defect: string;

  gate: Gate;
}

function resolvePnpm(): { command: string; prefix: string[]; shell: boolean } {
  const bundledCorepack = path.join(
    path.dirname(process.execPath),

    'node_modules',

    'corepack',

    'dist',

    'pnpm.js',
  );

  if (fs.existsSync(bundledCorepack)) {
    return { command: process.execPath, prefix: [bundledCorepack], shell: false };
  }

  const hermesCorepack =
    'C:/Users/neoma/AppData/Local/hermes/node/node_modules/corepack/dist/pnpm.js';

  if (fs.existsSync(hermesCorepack)) {
    return { command: process.execPath, prefix: [hermesCorepack], shell: false };
  }

  return {
    command: 'pnpm',

    prefix: [],

    shell: process.platform === 'win32',
  };
}

const pnpm = resolvePnpm();

function run(
  command: string,

  args: string[],

  cwd: string,

  options: { shell?: boolean } = {},
) {
  const result = spawnSync(command, args, {
    cwd,

    stdio: 'pipe',

    timeout: 180_000,

    encoding: 'utf8',

    shell: options.shell === true,

    maxBuffer: MAX_OUTPUT_BYTES,
  });

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  if (result.error != null) {
    return { passed: false, output: `${output}\n${result.error.message}` };
  }

  return { passed: result.status === 0, output };
}

function runPnpm(args: string[], cwd: string) {
  return run(pnpm.command, [...pnpm.prefix, ...args], cwd, { shell: pnpm.shell });
}

function jestGate(...files: string[]) {
  return runPnpm(
    ['exec', 'jest', '--runInBand', '--forceExit', ...files],

    API_ROOT,
  );
}

function runGate(gate: Gate) {
  switch (gate) {
    case 'architecture':
      return runPnpm(
        ['exec', 'tsx', 'scripts/verify-defense-budget-parser-architecture.ts'],

        API_ROOT,
      );

    case 'cross-language':
      return runPnpm(
        ['exec', 'tsx', 'scripts/verify-defense-budget-parser-runtime.ts'],

        API_ROOT,
      );

    case 'llamaparse-jest':
      return jestGate('src/defense-budget/parser-router/llamaparse-page-executor.spec.ts');

    case 'artifact-store-jest':
      return jestGate(
        'src/defense-budget/parser-router/parser-artifact-store.spec.ts',

        'src/defense-budget/parser-router/s3-parser-artifact-store.spec.ts',
      );

    case 'runtime-contract-jest':
      return jestGate('src/defense-budget/parser-router/parser-runtime-contract-v1.spec.ts');

    case 'compositor-jest':
      return jestGate('src/defense-budget/parser-router/page-result-compositor.spec.ts');

    case 'route-planner-jest':
      return jestGate(
        'src/defense-budget/parser-router/route-planner.spec.ts',

        'src/defense-budget/parser-router/route-planner-closeout.spec.ts',

        'src/defense-budget/parser-router/escalation-planner.spec.ts',
      );
  }
}

const controls: Control[] = [
  {
    id: 1,

    description: 'Convert one-based page 1 to provider page 1 instead of 0',

    target: 'apps/api/src/defense-budget/parser-router/llamaparse-page-executor.ts',

    original: 'return oneBasedPages.map((p) => p - 1);',

    defect: 'return oneBasedPages.map((p) => p);',

    gate: 'llamaparse-jest',
  },

  {
    id: 2,

    description: 'Permit paid parsing without a positive page cap',

    target: 'apps/api/src/defense-budget/parser-router/llamaparse-page-executor.ts',

    original: 'if (auth.allowPaidParse && (!auth.maxPaidPages || auth.maxPaidPages <= 0))',

    defect: 'if (false)',

    gate: 'llamaparse-jest',
  },

  {
    id: 3,

    description: 'Allow a paid plan to exceed the operator page cap',

    target: 'apps/api/src/defense-budget/parser-router/llamaparse-page-executor.ts',

    original: 'assertPaidPageCap(opts.requestedPages, opts.authorization);',

    defect: '// DEFECT: paid page-cap assertion removed',

    gate: 'llamaparse-jest',
  },

  {
    id: 4,

    description: 'Reuse a cached output after one-byte corruption',

    target: 'apps/api/src/defense-budget/parser-router/parser-artifact-store.ts',

    original: 'byteSha256 !== descriptor.byteSha256',

    defect: 'false',

    gate: 'artifact-store-jest',
  },

  {
    id: 5,

    description: 'Reuse parser output across different source SHAs',

    target: 'apps/api/src/defense-budget/parser-router/parser-runtime-contract-v1.ts',

    original: 'sourceSha256: identity.sourceSha256,',

    defect: "sourceSha256: '0'.repeat(64),",

    gate: 'runtime-contract-jest',
  },

  {
    id: 6,

    description: 'Accept a local parser result relabeled as another method',

    target: 'apps/api/src/defense-budget/parser-router/local-parser-runtime-client.ts',

    original: 'if (result.engine !== job.engine) {',

    defect: 'if (false) {',

    gate: 'architecture',
  },

  {
    id: 7,

    description: 'Fabricate a whole-page cell bounding box',

    target: 'apps/defense-budget-parser/src/capiro_defense_budget_parser/pdfplumber_engine.py',

    original: '                bbox = None',

    defect:
      "                bbox = BoundingBoxV1(x0='0', y0='0', x1=_to_decimal_string(float(page.width)), y1=_to_decimal_string(float(page.height)))  # FABRICATED_WHOLE_PAGE_BBOX",

    gate: 'architecture',
  },

  {
    id: 8,

    description: 'Allow a requested page to disappear without explicit failure',

    target: 'apps/api/src/defense-budget/parser-router/page-result-compositor.ts',

    original: 'if (successful.length === 0) {',

    defect: 'if (false) {',

    gate: 'compositor-jest',
  },

  {
    id: 9,

    description: 'Select two winners for the same physical page',

    target: 'apps/api/src/defense-budget/parser-router/page-result-compositor.ts',

    original: '  const pages = sortedUniquePages(options.requestedPages).map((page) =>',

    defect:
      '  const pages = [...sortedUniquePages(options.requestedPages), ...sortedUniquePages(options.requestedPages)].map((page) => // selectedParserRunIds DEFECT',

    gate: 'compositor-jest',
  },

  {
    id: 10,

    description: 'Make LlamaParse automatically outrank local output',

    target: 'apps/api/src/defense-budget/parser-router/page-result-compositor.ts',

    original: '    if (leftEscalation !== rightEscalation) return leftEscalation ? -1 : 1;',

    defect:
      "    if (left.entry.method === 'llamaparse' || right.entry.method === 'llamaparse') return left.entry.method === 'llamaparse' ? -1 : 1; // PAID_ALWAYS_WINS",

    gate: 'compositor-jest',
  },

  {
    id: 11,

    description: 'Submit an automatic second paid provider job',

    target: 'apps/api/src/defense-budget/parser-router/llamaparse-page-executor.ts',

    original: '  const startTime = Date.now();',

    defect:
      "  await client.parse({ file: opts.sourcePdfBuffer, filename: opts.sourceFilename, mode, resultType: 'both', targetPages }); // AUTO_RETRY_PAID_PROVIDER_JOB\n  const startTime = Date.now();",

    gate: 'architecture',
  },

  {
    id: 12,

    description: 'Treat source SHA mismatch as parser-correctable',

    target: 'apps/api/src/defense-budget/parser-router/route-planner.ts',

    original: "  'missing_required_source_fact',",

    defect: "  'missing_required_source_fact',\n  'source_sha_mismatch',",

    gate: 'route-planner-jest',
  },

  {
    id: 13,

    description: 'Repeat the same engine/page run in a later round',

    target: 'apps/api/src/defense-budget/parser-router/route-planner.ts',

    original: '(engine) => !attempted.includes(engine),',

    defect: '(engine) => true,',

    gate: 'route-planner-jest',
  },

  {
    id: 14,

    description: 'Remove maximum escalation-round enforcement',

    target: 'apps/api/src/defense-budget/parser-router/route-planner.ts',

    original: 'if (input.currentRound >= maxRounds) {',

    defect: 'if (false) {',

    gate: 'route-planner-jest',
  },

  {
    id: 15,

    description: 'Import a canonical Program Element writer into Phase 3',

    target: 'apps/api/src/defense-budget/parser-router/router-state-machine.ts',

    original:
      "import {\n  PARSER_STATE_TRANSITIONS,\n  assertValidTransition,\n  type ParserDocumentStateV1,\n} from './parser-runtime-contract-v1.js';",

    defect:
      "import { ProgramElementWriterService } from '../../program-element/program-element-writer.service.js';\nimport {\n  PARSER_STATE_TRANSITIONS,\n  assertValidTransition,\n  type ParserDocumentStateV1,\n} from './parser-runtime-contract-v1.js';",

    gate: 'architecture',
  },

  {
    id: 16,

    description: 'Install Python parser dependencies in the API Dockerfile',

    target: 'apps/api/Dockerfile',

    original: 'FROM node:${NODE_VERSION}-bookworm-slim AS base',

    defect:
      'FROM node:${NODE_VERSION}-bookworm-slim AS base\nRUN apt-get update && apt-get install -y python3',

    gate: 'architecture',
  },

  {
    id: 17,

    description: 'Import AWS or database access into the isolated Python runtime',

    target: 'apps/defense-budget-parser/src/capiro_defense_budget_parser/contracts.py',

    original: 'from __future__ import annotations',

    defect: 'from __future__ import annotations\n\nimport boto3',

    gate: 'architecture',
  },

  {
    id: 18,

    description: 'Produce different canonical hashes in TypeScript and Python',

    target: 'apps/defense-budget-parser/src/capiro_defense_budget_parser/canonical_json.py',

    original: "return hashlib.sha256(canonical_json_stringify(value).encode('utf-8')).hexdigest()",

    defect: "return hashlib.sha256(b'cross-language-defect').hexdigest()",

    gate: 'cross-language',
  },

  {
    id: 19,

    description: 'Route a clean embedded-text page directly to OCR',

    target: 'apps/api/src/defense-budget/parser-router/route-planner.ts',

    original: "return profile.hasEmbeddedTextLayer ? 'deterministic_pdfplumber' : 'paddleocr';",

    defect: "return 'paddleocr';",

    gate: 'route-planner-jest',
  },

  {
    id: 20,

    description: 'Continue toward verification pass without paid authorization',

    target: 'apps/api/src/defense-budget/parser-router/route-planner.ts',

    original: 'if (paidPages.length > 0 && !input.allowPaidParse) {',

    defect: 'if (false) {',

    gate: 'route-planner-jest',
  },
];

interface ControlResult {
  id: number;

  description: string;

  defectDetected: boolean;

  restoredGreen: boolean;

  detail: string;
}

/** Map LF needles onto the target file's actual newline style (CRLF checkouts). */

function withFileNewlines(source: string, needle: string): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';

  return needle.replace(/\r\n/g, '\n').split('\n').join(eol);
}

const results: ControlResult[] = [];

for (const control of controls) {
  const targetPath = path.join(REPO_ROOT, control.target);

  const originalBytes = fs.readFileSync(targetPath);

  try {
    const source = originalBytes.toString('utf8');

    const originalNeedle = withFileNewlines(source, control.original);

    const defectNeedle = withFileNewlines(source, control.defect);

    if (!source.includes(originalNeedle)) {
      results.push({
        id: control.id,

        description: control.description,

        defectDetected: false,

        restoredGreen: false,

        detail: `injection point missing in ${control.target}`,
      });

      continue;
    }

    fs.writeFileSync(
      targetPath,

      source.replace(originalNeedle, defectNeedle),

      'utf8',
    );

    const injected = runGate(control.gate);

    const defectDetected = !injected.passed;

    fs.writeFileSync(targetPath, originalBytes);

    const restored = runGate(control.gate);

    results.push({
      id: control.id,

      description: control.description,

      defectDetected,

      restoredGreen: restored.passed,

      detail: defectDetected
        ? restored.passed
          ? 'defect failed the gate; exact source restored and gate returned green'
          : `defect detected, but restored gate failed: ${restored.output.slice(-1000)}`
        : `SAFETY GAP: injected defect passed: ${injected.output.slice(-1000)}`,
    });
  } finally {
    fs.writeFileSync(targetPath, originalBytes);
  }
}

let allPassed = true;

console.log('Phase 3 — 20 Mandatory Negative Controls');

console.log('========================================');

for (const result of results) {
  const passed = result.defectDetected && result.restoredGreen;

  allPassed &&= passed;

  console.log(`[${passed ? 'PASS' : 'FAIL'}] #${result.id}: ${result.description}`);

  console.log(`       ${result.detail}`);
}

console.log(
  `\n${results.filter((result) => result.defectDetected && result.restoredGreen).length}/${controls.length} controls passed`,
);

if (!allPassed || results.length !== controls.length) {
  console.error('Phase 3 negative controls FAILED');

  process.exit(1);
}

console.log('All Phase 3 negative controls passed');

process.exit(0);
