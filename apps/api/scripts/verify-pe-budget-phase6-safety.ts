/** Phase 6 Workstream O — permanent architecture and closeout safety scan. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PHASE6_NEGATIVE_CONTROL_IDS,
  scanPhase6ArchitectureSourceV1,
} from '../src/defense-budget/phase6/phase6-closeout-gates-v1.js';

const API_ROOT = path.resolve(process.cwd());
const PRODUCTION_ROOTS = [
  'src/defense-budget/stages/authorization',
  'src/defense-budget/stages/appropriations',
  'src/defense-budget/stages/enacted',
  'src/defense-budget/stages/post-enactment',
];
const EXTRA_FILES = [
  'src/defense-budget/stages/congressional-table-v1.ts',
  'src/defense-budget/stages/stage-row-emitter-v1.ts',
  'src/defense-budget/stages/line-reference-resolver.ts',
  'scripts/parse-defense-approps-public-law.ts',
];

function walk(root: string): string[] {
  const absolute = path.join(API_ROOT, root);
  if (!fs.existsSync(absolute)) return [];
  const output: string[] = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) output.push(...walk(path.relative(API_ROOT, child)));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      output.push(child);
    }
  }
  return output;
}

function fail(message: string): never {
  console.error(`PHASE6_SAFETY_FAIL: ${message}`);
  process.exit(2);
}

function migrationFiles(): string[] {
  const root = path.join(API_ROOT, 'prisma/phase6-projection/migrations');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, 'migration.sql'))
    .filter((file) => fs.existsSync(file))
    .sort();
}

function main(): void {
  if (PHASE6_NEGATIVE_CONTROL_IDS.length !== 24) {
    fail(`negative-control registry count is ${PHASE6_NEGATIVE_CONTROL_IDS.length}, expected 24`);
  }
  const productionFiles = [
    ...new Set([
      ...PRODUCTION_ROOTS.flatMap(walk),
      ...EXTRA_FILES.map((file) => path.join(API_ROOT, file)),
    ]),
  ];
  const violations: string[] = [];
  for (const file of productionFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const violation of scanPhase6ArchitectureSourceV1(source)) {
      violations.push(`${path.relative(API_ROOT, file)}: ${violation.code}: ${violation.message}`);
    }
  }
  if (violations.length > 0) fail(violations.join('\n'));

  const migrations = migrationFiles();
  if (migrations.length < 3) fail('expected the complete Phase 6 projection migration chain');
  for (const file of migrations) {
    const migration = fs.readFileSync(file, 'utf8');
    if (/\bprogram_element(?:_year)?\b/i.test(migration)) {
      fail(`${path.relative(API_ROOT, file)} references canonical program_element tables`);
    }
  }

  const publicLawFacade = fs.readFileSync(
    path.join(API_ROOT, 'scripts/parse-defense-approps-public-law.ts'),
    'utf8',
  );
  if (!publicLawFacade.includes('canonical enacted commit is disabled in Phase 6')) {
    fail('public-law legacy bypass containment message is missing');
  }

  const golden = JSON.parse(
    fs.readFileSync(
      path.join(API_ROOT, 'src/defense-budget/phase6/__fixtures__/golden-phase6-cycle.json'),
      'utf8',
    ),
  ) as { lineKinds?: unknown[]; stages?: unknown[] };
  const edges = JSON.parse(
    fs.readFileSync(
      path.join(API_ROOT, 'src/defense-budget/phase6/__fixtures__/golden-phase6-edge-cases.json'),
      'utf8',
    ),
  ) as { nativeRows?: unknown[]; reviewCases?: unknown[] };
  if (golden.lineKinds?.length !== 4 || golden.stages?.length !== 9) {
    fail('golden corpus must cover four native line kinds and nine Phase 6 lifecycle stages');
  }
  if (edges.nativeRows?.length !== 4 || (edges.reviewCases?.length ?? 0) < 5) {
    fail('golden edge corpus must cover four native line kinds plus review/blocking cases');
  }

  const requiredDocs = [
    '../../docs/defense-budget/CONGRESSIONAL-TO-ENACTED-INGESTION-V1.md',
    '../../docs/runbooks/defense-budget-stage-cycle-v1.md',
    '../../docs/runbooks/defense-budget-enactment-proof-v1.md',
    '../../docs/phase7-handoff.md',
  ];
  for (const relative of requiredDocs) {
    if (!fs.existsSync(path.resolve(API_ROOT, relative))) fail(`required Phase 6 documentation missing: ${relative}`);
  }

  const probeFiles = [
    '.git-object-probe',
    '.git-object-probe2',
    '.tree-probe',
    '.tree-probe-2',
    '.ref-resolution-probe',
  ];
  for (const file of probeFiles) {
    if (fs.existsSync(path.join(API_ROOT, 'src/defense-budget/phase6', file))) {
      fail(`temporary staging probe must not ship: ${file}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        negativeControls: 24,
        architectureFilesScanned: productionFiles.length,
        projectionMigrationsScanned: migrations.length,
        canonicalWrites: false,
        paidParserDirectCalls: false,
        goldenLineKinds: 4,
        goldenStages: 9,
        goldenReviewCases: edges.reviewCases?.length ?? 0,
      },
      null,
      2,
    ),
  );
}

main();
