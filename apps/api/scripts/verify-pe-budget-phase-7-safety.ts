/**
 * Phase 7 Workstream O — permanent architecture and closeout safety scan.
 *
 * Runs the scoped gates from `phase7-closeout-gates-v1.ts` over the real tree,
 * then checks things a source scan cannot see:
 *
 *   * the promoter credential is confined to the verbs that may promote;
 *   * `execute` and `rollback` never fall back to the composed serve DSN;
 *   * every direct legacy dollar loader is independently guarded against a
 *     dispatcher bypass;
 *   * the five closeout documents exist.
 *
 * The document check belongs in a gate rather than a checklist because
 * "documentation matches the implementation" is a definition-of-done item, and
 * the failure mode it guards against — shipping the code and writing the runbook
 * "next session" — is exactly the one a checklist does not catch.
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

/**
 * Legacy budget loaders are an explicit frozen inventory. The exact-SHA dollar
 * list is authoritative for direct money/enrichment entrypoints; provisions are
 * added because they are part of Phase 6's legacy report-language path even
 * though they do not write a dollar field.
 */
const LEGACY_LOADER_SCRIPTS = [
  ...PE_EXACT_SHA_DOLLAR_LOADERS.map((file) => `scripts/${file}`),
  'scripts/sync-report-provisions.ts',
];

/** Only these may read the promoter credential. */
const PROMOTER_CREDENTIAL_ALLOWLIST = new Set([
  'scripts/execute-defense-budget-promotion-v1.ts',
  'scripts/rollback-defense-budget-snapshot-v1.ts',
  'scripts/pe-budget-phase7-engine-rehearsal.ts',
  'scripts/pe-budget-phase7-drain-rehearsal.ts',
  // Names the variable in order to prove nothing else names it.
  'scripts/verify-pe-budget-phase-7-safety.ts',
]);

/**
 * Files that define the banned patterns rather than committing them. The gate
 * module contains the literal string `LlamaParseClient` inside a regex, and this
 * runner contains `PROMOTER_DATABASE_URL` inside its containment check — so both
 * match rules they exist to enforce.
 *
 * Exempting them is safe for a specific reason, not merely convenient: in both
 * files the banned token appears only as *data* inside a `RegExp` or a `Set`.
 * Neither file imports a vendor SDK, constructs a client, or opens a database
 * connection, so there is no way for the thing the rule prohibits to actually
 * happen here. The alternative — obfuscating the patterns so they do not match
 * themselves — makes the rules unreadable and is how a gate quietly stops
 * matching what it claims to.
 */
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

/**
 * `execute` and `rollback` must NOT call `compose_database_url` in the
 * entrypoint — falling back to the serve DSN is precisely the boundary
 * Workstream D exists to enforce, and it would fail as an opaque permission
 * error rather than as a refusal.
 */
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
