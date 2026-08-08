/**
 * Phase 7 Workstream O — permanent architecture and closeout safety scan.
 *
 * Runs the scoped gates from `phase7-closeout-gates-v1.ts` over the real tree,
 * then checks three things a source scan cannot see:
 *
 *   * the promoter credential is confined to the two verbs that may promote;
 *   * `execute` and `rollback` never fall back to the composed serve DSN;
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
 * The legacy budget loaders, by the dispatcher verb that invokes them. Listed
 * explicitly rather than globbed: a glob over `scripts/` would silently start
 * policing new scripts under rules written for the old ones, and the point of
 * this scope is a frozen inventory.
 */
const LEGACY_LOADER_SCRIPTS = [
  'scripts/sync-comptroller-jbooks.ts',
  'scripts/sync-jbook-r2.ts',
  'scripts/sync-jbook-performers.ts',
  'scripts/sync-report-provisions.ts',
  'scripts/load-defense-budget-package.ts',
  'scripts/parse-hasc-sasc-reports.ts',
  'scripts/parse-defense-approps-reports.ts',
  'scripts/parse-ndaa-conference.ts',
  'scripts/parse-defense-approps-public-law.ts',
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
