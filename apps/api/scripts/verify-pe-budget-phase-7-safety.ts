/**
 * Phase 7 Workstream O — permanent architecture and closeout safety scan.
 *
 * Runs the scoped gates from `phase7-closeout-gates-v1.ts` over the real tree,
 * then checks things a source scan cannot see:
 *
 *   * the promoter credential is confined to the verbs that may promote;
 *   * `execute` and `rollback` never fall back to the composed serve DSN;
 *   * planning and execution reload the exact producer plans named by eligibility;
 *   * every direct legacy dollar loader is independently guarded against a
 *     dispatcher bypass;
 *   * the five closeout documents exist.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PHASE7_NEGATIVE_CONTROL_COUNT,
  PHASE7_NEGATIVE_CONTROL_IDS,
  scanPhase7ArchitectureSourceV1,
  type Phase7GateScopeV1,
} from '../src/defense-budget/promotion/phase7-closeout-gates-v1.js';
import { PE_EXACT_SHA_DOLLAR_LOADERS } from './lib/pe-exact-sha-loader-contract.js';

const API_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');

const SCOPE_ROOTS: Array<{ scope: Phase7GateScopeV1; roots: string[] }> = [
  { scope: 'promotion', roots: ['src/defense-budget/promotion'] },
  {
    scope: 'parser_verifier',
    roots: ['src/defense-budget/parser-router', 'src/defense-budget/verification'],
  },
  { scope: 'serve_read', roots: ['src/program-element'] },
];

const LEGACY_LOADER_SCRIPTS = [
  ...PE_EXACT_SHA_DOLLAR_LOADERS.map((file) => `scripts/${file}`),
  'scripts/sync-report-provisions.ts',
];

const PROMOTER_CREDENTIAL_ALLOWLIST = new Set([
  'scripts/execute-defense-budget-promotion-v1.ts',
  'scripts/rollback-defense-budget-snapshot-v1.ts',
  'scripts/pe-budget-phase7-engine-rehearsal.ts',
  'scripts/pe-budget-phase7-drain-rehearsal.ts',
  'scripts/verify-pe-budget-phase-7-safety.ts',
]);

const RULE_DEFINITION_FILES = new Set(['src/defense-budget/promotion/phase7-closeout-gates-v1.ts']);

const REQUIRED_DOCS = [
  'docs/defense-budget/CANONICAL-PROMOTION-V1.md',
  'docs/runbooks/defense-budget-promotion-v1.md',
  'docs/runbooks/defense-budget-snapshot-rollback-v1.md',
  'docs/runbooks/defense-budget-legacy-cutover-v1.md',
  'docs/architecture/program-elements-fargate-phase-8-handoff.md',
];

const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

function walk(relativeRoot: string): string[] {
  const absolute = path.join(API_ROOT, relativeRoot);
  if (!fs.existsSync(absolute)) return [];
  const output: string[] = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(relativeRoot, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) output.push(...walk(child));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      output.push(child);
    }
  }
  return output;
}

function scanScopes(): void {
  let scanned = 0;
  const groups: Array<{ scope: Phase7GateScopeV1; files: string[] }> = [
    ...SCOPE_ROOTS.map(({ scope, roots }) => ({ scope, files: roots.flatMap(walk) })),
    {
      scope: 'legacy_loader' as const,
      files: LEGACY_LOADER_SCRIPTS.filter((file) => fs.existsSync(path.join(API_ROOT, file))),
    },
  ];

  for (const { scope, files } of groups) {
    if (files.length === 0) fail(`scope ${scope} matched no files — the roots are probably stale`);
    for (const file of files) {
      if (RULE_DEFINITION_FILES.has(file)) continue;
      scanned += 1;
      const source = fs.readFileSync(path.join(API_ROOT, file), 'utf8');
      for (const violation of scanPhase7ArchitectureSourceV1({
        scope,
        relativePath: file,
        source,
      })) {
        fail(`${file} [${scope}] ${violation.code}: ${violation.message}`);
      }
    }
  }
  console.log(`architecture scan: ${scanned} production files across 4 scopes`);
}

function checkPromoterCredentialContainment(): void {
  const offenders: string[] = [];
  for (const file of walk('scripts')) {
    if (PROMOTER_CREDENTIAL_ALLOWLIST.has(file)) continue;
    const source = fs.readFileSync(path.join(API_ROOT, file), 'utf8');
    if (/\bPROMOTER_DATABASE_URL\b/.test(source.replace(/\/\/.*$/gm, ''))) offenders.push(file);
  }
  for (const file of offenders) {
    fail(`${file} reads PROMOTER_DATABASE_URL but is not an authorized promoting verb`);
  }
  console.log(
    `promoter credential: confined to ${PROMOTER_CREDENTIAL_ALLOWLIST.size} files, ${offenders.length} offender(s)`,
  );
}

/**
 * Eligibility's exact producer-plan IDs/hashes must remain load-bearing in BOTH
 * plan construction and execution. The old source selects raw projection rows
 * by fiscal year and is intentionally retained only for diagnostics/legacy
 * comparison; re-importing it here would silently reopen the cycle-mixing bug.
 */
function checkExactProducerPlanBoundary(): void {
  const criticalScripts = [
    'scripts/plan-defense-budget-promotion-v1.ts',
    'scripts/execute-defense-budget-promotion-v1.ts',
  ];
  for (const relative of criticalScripts) {
    const source = fs.readFileSync(path.join(API_ROOT, relative), 'utf8');
    if (!/PrismaEligibilityBoundProjectionSourceV1/.test(source)) {
      fail(`${relative} does not use the eligibility-bound producer-plan source`);
    }
    if (/PrismaPromotionProjectionSourceV1/.test(source)) {
      fail(`${relative} imports the broad fiscal-year projection source`);
    }
  }

  const exactSourcePath = path.join(
    API_ROOT,
    'src/defense-budget/promotion/eligibility-bound-projection-source-prisma-v1.ts',
  );
  if (!fs.existsSync(exactSourcePath)) {
    fail('eligibility-bound producer-plan source is missing');
    return;
  }
  const exactSource = fs.readFileSync(exactSourcePath, 'utf8');
  for (const required of [
    'projectionPlanIds',
    'projectionPlanHashes',
    'defense_budget_projection_plan',
    'phase6_cycle_certification_projection',
    'promotionEligibilityHashV1',
  ]) {
    if (!exactSource.includes(required)) {
      fail(`eligibility-bound projection source no longer verifies ${required}`);
    }
  }
  console.log('producer plans: plan + execute are bound to exact persisted eligibility inputs');
}

/**
 * A dispatcher guard is not enough: `pnpm parse:*` and raw `tsx` invocation can
 * reach the scripts directly. Every exact-SHA legacy dollar loader must carry a
 * guard at its own posture boundary, or permanently reject commit.
 */
function checkDirectLegacyCommitContainment(): void {
  const generalizedModePath = path.join(API_ROOT, 'scripts/lib/defense-budget-ingest-mode.ts');
  const generalizedMode = fs.existsSync(generalizedModePath)
    ? fs.readFileSync(generalizedModePath, 'utf8')
    : '';
  if (!/assertLegacyBudgetWriteGateForLoaderV1\s*\(/.test(generalizedMode)) {
    fail(
      'scripts/lib/defense-budget-ingest-mode.ts does not invoke the Phase 7 legacy-write gate',
    );
  }

  for (const fileName of PE_EXACT_SHA_DOLLAR_LOADERS) {
    const relative = `scripts/${fileName}`;
    const absolute = path.join(API_ROOT, relative);
    if (!fs.existsSync(absolute)) {
      fail(`legacy dollar-loader inventory points at a missing file: ${relative}`);
      continue;
    }
    const source = fs.readFileSync(absolute, 'utf8');

    if (fileName === 'parse-defense-approps-public-law.ts') {
      if (
        !/process\.argv\.includes\(['"]--commit['"]\)/.test(source) ||
        !/canonical enacted commit is disabled/i.test(source)
      ) {
        fail(`${relative} no longer permanently refuses its legacy enacted --commit path`);
      }
      continue;
    }

    if (fileName === 'ingest-defense-budget-pdf.ts') {
      if (!/resolveDefenseBudgetIngestPosture\s*\(\s*process\.argv\s*\)/.test(source)) {
        fail(`${relative} does not route commit intent through the guarded generalized posture`);
      }
      continue;
    }

    if (!/resolvePeDollarLoaderPosture\s*\(\s*process\.argv\s*\)/.test(source)) {
      fail(`${relative} can bypass the Phase 7 legacy-write gate on direct invocation`);
    }
  }
  console.log(
    `legacy direct commits: ${PE_EXACT_SHA_DOLLAR_LOADERS.length} dollar loaders checked for in-script containment`,
  );
}

function checkEntrypointPromoterIsolation(): void {
  const entrypoint = path.join(API_ROOT, 'scripts/entrypoint.sh');
  if (!fs.existsSync(entrypoint)) {
    fail('scripts/entrypoint.sh is missing');
    return;
  }
  const source = fs.readFileSync(entrypoint, 'utf8');
  for (const verb of [
    'execute-defense-budget-promotion-v1',
    'rollback-defense-budget-snapshot-v1',
  ]) {
    const caseStart = source.indexOf(`\n  ${verb})`);
    if (caseStart < 0) {
      fail(`entrypoint.sh does not wire ${verb}`);
      continue;
    }
    const caseEnd = source.indexOf(';;', caseStart);
    const body = source.slice(caseStart, caseEnd < 0 ? source.length : caseEnd);
    if (/^\s*compose_database_url\s*$/m.test(body)) {
      fail(`${verb} calls compose_database_url; it must use PROMOTER_DATABASE_URL only`);
    }
  }
  console.log('entrypoint: execute/rollback do not fall back to the serve DSN');
}

function checkNegativeControlRegistry(): void {
  if (PHASE7_NEGATIVE_CONTROL_IDS.length !== PHASE7_NEGATIVE_CONTROL_COUNT) {
    fail(
      `negative-control registry count is ${PHASE7_NEGATIVE_CONTROL_IDS.length}, expected ${PHASE7_NEGATIVE_CONTROL_COUNT}`,
    );
  }
  if (new Set(PHASE7_NEGATIVE_CONTROL_IDS).size !== PHASE7_NEGATIVE_CONTROL_IDS.length) {
    fail('negative-control registry contains duplicate IDs');
  }
  console.log(`negative-control registry: ${PHASE7_NEGATIVE_CONTROL_IDS.length} controls`);
}

function checkRequiredDocs(): void {
  for (const doc of REQUIRED_DOCS) {
    const absolute = path.join(REPO_ROOT, doc);
    if (!fs.existsSync(absolute)) {
      fail(`required Phase 7 document is missing: ${doc}`);
      continue;
    }
    if (fs.statSync(absolute).size < 512) fail(`Phase 7 document is a stub: ${doc}`);
  }
  console.log(`documentation: ${REQUIRED_DOCS.length} required documents present`);
}

function main(): void {
  checkNegativeControlRegistry();
  scanScopes();
  checkPromoterCredentialContainment();
  checkExactProducerPlanBoundary();
  checkDirectLegacyCommitContainment();
  checkEntrypointPromoterIsolation();
  checkRequiredDocs();

  if (failures.length > 0) {
    console.error('\nPHASE7_SAFETY_FAIL');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(2);
  }
  console.log('\nPhase 7 safety scan passed');
}

main();
