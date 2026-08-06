/** Permanent Phase 3 architecture and safety-contract gate. */
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');
const ROUTER_ROOT = path.join(API_ROOT, 'src', 'defense-budget', 'parser-router');
const PYTHON_ROOT = path.join(REPO_ROOT, 'apps', 'defense-budget-parser', 'src');

interface Finding {
  name: string;
  passed: boolean;
  detail?: string;
}
const findings: Finding[] = [];

function filesUnder(root: string, extensions: readonly string[]): string[] {
  const output: string[] = [];
  if (!fs.existsSync(root)) return output;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(absolute, extensions));
    else if (extensions.includes(path.extname(entry.name))) output.push(absolute);
  }
  return output;
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function requireText(name: string, relativePath: string, text: string): void {
  const source = read(relativePath);
  const passed = source.includes(text);
  findings.push({
    name,
    passed,
    ...(!passed ? { detail: `missing required invariant in ${relativePath}` } : {}),
  });
}

function forbidText(name: string, relativePath: string, text: string): void {
  const source = read(relativePath);
  const passed = !source.includes(text);
  findings.push({
    name,
    passed,
    ...(!passed ? { detail: `forbidden text found in ${relativePath}` } : {}),
  });
}

function requireCount(name: string, relativePath: string, text: string, count: number): void {
  const source = read(relativePath);
  const actual = source.split(text).length - 1;
  findings.push({
    name,
    passed: actual === count,
    ...(actual !== count ? { detail: `${relativePath}: expected ${count}, found ${actual}` } : {}),
  });
}

const forbiddenRouterSymbols = [
  'ProgramElementWriterService',
  'upsertProgramElement',
  'upsertProgramElementYear',
  'programElementYear.create',
  'programElementYear.update',
  'programElementYear.upsert',
  'assertPromotionReady',
  'getCanonicalPromotionRecords',
  'promotionReady',
  'canonicalEligible',
];
const productionTs = filesUnder(ROUTER_ROOT, ['.ts']).filter((file) => !file.endsWith('.spec.ts'));
const operatorFiles = [
  'apps/api/scripts/profile-defense-budget-document.ts',
  'apps/api/scripts/plan-defense-budget-parse.ts',
  'apps/api/scripts/extract-defense-budget-cycle.ts',
  'apps/api/scripts/replay-defense-budget-parser-artifact.ts',
].map((relative) => path.join(REPO_ROOT, relative));
const canonicalViolations: string[] = [];
for (const file of [...productionTs, ...operatorFiles]) {
  const source = fs.readFileSync(file, 'utf8');
  for (const symbol of forbiddenRouterSymbols) {
    if (source.includes(symbol)) {
      canonicalViolations.push(`${path.relative(REPO_ROOT, file)}:${symbol}`);
    }
  }
}
findings.push({
  name: 'No canonical writer or promotion dependency',
  passed: canonicalViolations.length === 0,
  ...(canonicalViolations.length ? { detail: canonicalViolations.join(', ') } : {}),
});

const dockerSource = read('apps/api/Dockerfile').toLowerCase();
const forbiddenDockerLines = dockerSource.split('\n').filter((line) =>
  // python3 / python3.x must match: \bpython\b does not (digit continues the word).
  /\b(apt|apt-get|pip|uv|pnpm|npm)\b.*\b(python\d*(?:\.\d+)*|camelot|docling|paddle|paddleocr|torch)\b/.test(
    line,
  ),
);
findings.push({
  name: 'API Dockerfile contains no Python or parser-ML installation',
  passed: forbiddenDockerLines.length === 0,
  ...(forbiddenDockerLines.length ? { detail: forbiddenDockerLines.join(' | ') } : {}),
});

const forbiddenPythonImports = ['boto3', 'psycopg', 'prisma', 'llama_parse', 'openai', 'anthropic'];
const pythonViolations: string[] = [];
for (const file of filesUnder(PYTHON_ROOT, ['.py'])) {
  const source = fs.readFileSync(file, 'utf8');
  for (const moduleName of forbiddenPythonImports) {
    if (
      new RegExp(`(^|\\n)\\s*(from\\s+${moduleName}\\b|import\\s+${moduleName}\\b)`).test(source)
    ) {
      pythonViolations.push(`${path.relative(REPO_ROOT, file)}:${moduleName}`);
    }
  }
}
findings.push({
  name: 'Python runtime contains no AWS, database, LLM, or LlamaParse imports',
  passed: pythonViolations.length === 0,
  ...(pythonViolations.length ? { detail: pythonViolations.join(', ') } : {}),
});

requireText(
  'One-based pages convert to LlamaParse zero-based exactly once',
  'apps/api/src/defense-budget/parser-router/llamaparse-page-executor.ts',
  'return oneBasedPages.map((p) => p - 1);',
);
requireText(
  'Paid authorization requires a positive page cap',
  'apps/api/src/defense-budget/parser-router/llamaparse-page-executor.ts',
  'if (auth.allowPaidParse && (!auth.maxPaidPages || auth.maxPaidPages <= 0))',
);
requireText(
  'Paid page cap is asserted before provider construction',
  'apps/api/src/defense-budget/parser-router/llamaparse-page-executor.ts',
  'assertPaidPageCap(opts.requestedPages, opts.authorization);',
);
requireText(
  'Replay binds actual serialized output bytes',
  'apps/api/src/defense-budget/parser-router/parser-artifact-store.ts',
  'byteSha256 !== descriptor.byteSha256',
);
requireText(
  'Parser cache identity includes source SHA',
  'apps/api/src/defense-budget/parser-router/parser-runtime-contract-v1.ts',
  'sourceSha256: identity.sourceSha256',
);
requireText(
  'Local runtime rejects parser method relabeling',
  'apps/api/src/defense-budget/parser-router/local-parser-runtime-client.ts',
  'result.engine !== job.engine',
);
forbidText(
  'Parser runtime contains no fabricated whole-page geometry marker',
  'apps/defense-budget-parser/src/capiro_defense_budget_parser/pdfplumber_engine.py',
  'FABRICATED_WHOLE_PAGE_BBOX',
);
requireText(
  'Compositor makes missing/all-failed pages explicit',
  'apps/api/src/defense-budget/parser-router/page-result-compositor.ts',
  'if (successful.length === 0) {',
);
forbidText(
  'Compositor cannot expose multiple selected winners',
  'apps/api/src/defense-budget/parser-router/page-result-compositor.ts',
  'selectedParserRunIds',
);
requireText(
  'Compositor derives active escalation runs from the plan',
  'apps/api/src/defense-budget/parser-router/page-result-compositor.ts',
  'deriveEscalationRunIds(options.plan, options.parserRunEntries)',
);
requireText(
  'Paid output does not automatically outrank local output',
  'apps/api/src/defense-budget/parser-router/page-result-compositor.ts',
  'PAID_DOES_NOT_OUTRANK',
);
requireCount(
  'LlamaParse executor submits one provider job',
  'apps/api/src/defense-budget/parser-router/llamaparse-page-executor.ts',
  'client.parse({',
  1,
);
forbidText(
  'LlamaParse executor contains no automatic retry marker',
  'apps/api/src/defense-budget/parser-router/llamaparse-page-executor.ts',
  'AUTO_RETRY_PAID_PROVIDER_JOB',
);
requireText(
  'Persisted paid output is parsed as a strict normalized result',
  'apps/api/src/defense-budget/verification/trusted-proof/parser-output-proof-adapters.ts',
  'parseParserRuntimeResultV1(',
);
requireText(
  'Persisted paid content SHA is independently recomputed',
  'apps/api/src/defense-budget/verification/trusted-proof/parser-output-proof-adapters.ts',
  'verifyResultContentSha256(normalizedResult)',
);
requireText(
  'S3 cache misses return null rather than blocking first execution',
  'apps/api/src/defense-budget/parser-router/s3-parser-artifact-store.ts',
  'if (isMissingObject(error)) return null;',
);

const routeSource = read('apps/api/src/defense-budget/parser-router/route-planner.ts');
const correctableSection = routeSource.slice(
  routeSource.indexOf('export const PARSER_CORRECTABLE_FINDING_CODES'),
  routeSource.indexOf('export const NON_PARSER_CORRECTABLE_FINDING_CODES'),
);
const nonCorrectableSection = routeSource.slice(
  routeSource.indexOf('export const NON_PARSER_CORRECTABLE_FINDING_CODES'),
  routeSource.indexOf('export function isParserCorrectable'),
);
findings.push({
  name: 'Source SHA mismatch is terminal and non-parser-correctable',
  passed:
    !correctableSection.includes("'source_sha_mismatch'") &&
    nonCorrectableSection.includes("'source_sha_mismatch'"),
});
requireText(
  'Escalation never repeats an attempted engine/page',
  'apps/api/src/defense-budget/parser-router/route-planner.ts',
  '!attempted.includes(engine)',
);
requireText(
  'Maximum escalation rounds are enforced',
  'apps/api/src/defense-budget/parser-router/route-planner.ts',
  'input.currentRound >= maxRounds',
);
requireText(
  'Cross-language canonical hash gate remains wired',
  'apps/api/scripts/verify-defense-budget-parser-runtime.ts',
  'Canonical hashes match (TS vs Python)',
);
requireText(
  'OCR policy prefers embedded text on clean digital pages',
  'apps/api/src/defense-budget/parser-router/route-planner.ts',
  "return profile.hasEmbeddedTextLayer ? 'deterministic_pdfplumber' : 'paddleocr';",
);
requireText(
  'Missing paid authorization becomes terminal',
  'apps/api/src/defense-budget/parser-router/route-planner.ts',
  'paidPages.length > 0 && !input.allowPaidParse',
);
requireText(
  'Native structured policy cannot fall back to PDF parsing',
  'apps/api/src/defense-budget/parser-router/route-planner.ts',
  'native_structured requires an explicitly supplied structured companion',
);
requireText(
  'Extraction command documents canonical-write isolation',
  'apps/api/scripts/extract-defense-budget-cycle.ts',
  'canonical writes',
);

let allPassed = true;
for (const finding of findings) {
  console.log(`[${finding.passed ? 'PASS' : 'FAIL'}] ${finding.name}`);
  if (!finding.passed) {
    allPassed = false;
    console.error(`  ${finding.detail ?? 'invariant failed'}`);
  }
}
if (!allPassed) {
  console.error('\nPhase 3 architecture/safety gate FAILED');
  process.exit(1);
}
console.log('\nPhase 3 architecture/safety gate passed');
process.exit(0);
