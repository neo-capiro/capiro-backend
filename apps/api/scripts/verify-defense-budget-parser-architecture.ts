/**
 * verify-defense-budget-parser-architecture — permanent architecture guards.
 *
 * Fails if:
 *   (a) parser-router code imports/calls canonical writers
 *   (b) apps/api/Dockerfile installs Python/ML parser dependencies
 *   (c) Python runtime imports forbidden packages
 *
 * Exit 0 if all guards pass, 1 if any guard fails.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');
const PARSER_ROUTER_DIR = path.join(API_ROOT, 'src', 'defense-budget', 'parser-router');
const PYTHON_RUNTIME_DIR = path.join(REPO_ROOT, 'apps', 'defense-budget-parser', 'src');
const API_DOCKERFILE = path.join(API_ROOT, 'Dockerfile');

interface GuardResult {
  guard: string;
  passed: boolean;
  violations: string[];
}

const results: GuardResult[] = [];

/* ------------------------------------------------------------------ */
/* Guard 1: No canonical writer imports in parser-router code          */
/* ------------------------------------------------------------------ */

const FORBIDDEN_IMPORTS = [
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

function scanDirectory(dir: string, extensions: string[]): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (extensions.includes(ext)) {
        files.push(path.join(entry.parentPath ?? entry.path, entry.name));
      }
    }
  }
  return files;
}

const guard1: GuardResult = {
  guard: 'No canonical writer imports in parser-router',
  passed: true,
  violations: [],
};

const tsFiles = scanDirectory(PARSER_ROUTER_DIR, ['.ts']);
for (const file of tsFiles) {
  // Skip spec files for import checks (they may reference forbidden names in assertions)
  if (file.endsWith('.spec.ts')) continue;
  const content = fs.readFileSync(file, 'utf8');
  // Only check import/require/from lines, not comments or strings
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const isImportLine =
      trimmed.startsWith('import ') ||
      trimmed.startsWith('export ') ||
      trimmed.startsWith('require(') ||
      trimmed.startsWith('from ');
    if (!isImportLine) continue;
    for (const forbidden of FORBIDDEN_IMPORTS) {
      if (trimmed.includes(forbidden)) {
        guard1.passed = false;
        guard1.violations.push(`${path.basename(file)}: imports '${forbidden}'`);
      }
    }
  }
}
results.push(guard1);

/* ------------------------------------------------------------------ */
/* Guard 2: No Python/ML in API Dockerfile                             */
/* ------------------------------------------------------------------ */

const FORBIDDEN_DOCKER_DEPS = [
  'python',
  'pip',
  'uv',
  'camelot',
  'docling',
  'paddle',
  'paddleocr',
  'torch',
];

const guard2: GuardResult = {
  guard: 'No Python/ML parser deps in apps/api/Dockerfile',
  passed: true,
  violations: [],
};

if (fs.existsSync(API_DOCKERFILE)) {
  const dockerContent = fs.readFileSync(API_DOCKERFILE, 'utf8').toLowerCase();
  for (const dep of FORBIDDEN_DOCKER_DEPS) {
    // Check for install commands containing the dep name
    const installPatterns = [
      `apt-get install`,
      `apt install`,
      `pip install`,
      `npm install`,
      `pnpm add`,
      `uv pip install`,
    ];
    for (const installCmd of installPatterns) {
      if (dockerContent.includes(installCmd) && dockerContent.includes(dep)) {
        // More precise: check if dep appears on same line as install
        const lines = dockerContent.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (
            (line.includes(installCmd) || line.includes('run')) &&
            line.includes(dep)
          ) {
            guard2.passed = false;
            guard2.violations.push(
              `Dockerfile line ${i + 1}: may install '${dep}'`,
            );
          }
        }
      }
    }
  }
}
results.push(guard2);

/* ------------------------------------------------------------------ */
/* Guard 3: No forbidden imports in Python runtime                      */
/* ------------------------------------------------------------------ */

const FORBIDDEN_PYTHON_IMPORTS = [
  'boto3',
  'psycopg',
  'prisma',
  'llama_parse',
  'openai',
  'anthropic',
];

const guard3: GuardResult = {
  guard: 'No forbidden imports in Python runtime',
  passed: true,
  violations: [],
};

const pyFiles = scanDirectory(PYTHON_RUNTIME_DIR, ['.py']);
for (const file of pyFiles) {
  const content = fs.readFileSync(file, 'utf8');
  for (const forbidden of FORBIDDEN_PYTHON_IMPORTS) {
    // Check for import statements
    if (
      content.includes(`import ${forbidden}`) ||
      content.includes(`from ${forbidden}`) ||
      content.includes(`import ${forbidden.replace('-', '_')}`)
    ) {
      guard3.passed = false;
      guard3.violations.push(
        `${path.basename(file)}: imports '${forbidden}'`,
      );
    }
  }
}
results.push(guard3);

/* ------------------------------------------------------------------ */
/* Report                                                               */
/* ------------------------------------------------------------------ */

let allPassed = true;
for (const result of results) {
  const status = result.passed ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${result.guard}`);
  if (!result.passed) {
    allPassed = false;
    for (const v of result.violations) {
      console.error(`  - ${v}`);
    }
  }
}

if (!allPassed) {
  console.error('\nArchitecture guards FAILED');
  process.exit(1);
}

console.log('\nAll architecture guards passed');
process.exit(0);
