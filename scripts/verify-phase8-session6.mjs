#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function resolveRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

const root = resolveRepoRoot();
const failures = [];
const notes = [];
const enforceCorpus = process.argv.includes('--enforce-corpus');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));
const fail = (message) => failures.push(message);

const migrationPath =
  'apps/api/prisma/migrations/20261120220000_phase8_session6_federal_funding_events/migration.sql';
if (!exists(migrationPath)) {
  fail(`Missing Session 6 migration: ${migrationPath}`);
} else {
  const sql = read(migrationPath);
  for (const table of [
    'federal_funding_measure',
    'federal_funding_provision',
    'federal_funding_allocation',
  ]) {
    if (!sql.includes(`CREATE TABLE "${table}"`)) fail(`Missing ${table} table`);
    if (!sql.includes(`REVOKE ALL ON TABLE "${table}" FROM PUBLIC`)) {
      fail(`${table} is not revoked from PUBLIC`);
    }
    if (!sql.includes(`GRANT SELECT ON TABLE "${table}" TO "capiro_defense_serve"`)) {
      fail(`${table} is not readable by the defense serve role`);
    }
    if (!sql.includes(`GRANT SELECT, INSERT, UPDATE ON TABLE "${table}" TO "capiro_defense_job"`)) {
      fail(`${table} is not writable by the defense job role`);
    }
  }

  const requiredNegativeControls = [
    'federal_funding_allocation_authoritative_dollars_chk',
    'federal_funding_allocation_inference_money_chk',
    'federal_funding_allocation_capability_money_chk',
    'federal_funding_allocation_unmapped_identity_chk',
    'federal_funding_allocation_obligation_ref_chk',
    "\"mapping_maturity\" IN ('exact_identifier', 'exact_line_item', 'account_level')",
    "\"review_state\" = 'verified'",
    '"inferred_relevance" = FALSE',
  ];
  for (const token of requiredNegativeControls) {
    if (!sql.includes(token)) fail(`Missing Session 6 allocation safety token: ${token}`);
  }

  if (/GRANT\s+[^;]*DELETE[^;]*federal_funding_/i.test(sql)) {
    fail('Session 6 migration grants DELETE on immutable/source-grounded funding facts');
  }
  if (!sql.includes('REFERENCES "source_document"("id")')) {
    fail('Federal funding facts are not evidence-bound to source_document');
  }
}

const authoritativeSchema = read('apps/api/prisma/schema.prisma');
const peYearMatch = /model\s+ProgramElementYear\s*\{([\s\S]*?)\n\}/m.exec(authoritativeSchema);
if (!peYearMatch) {
  fail('Unable to locate ProgramElementYear in authoritative Prisma schema');
} else if (/supplemental|reconciliation|rescission|transfer|reprogramming|continuing.?resolution/i.test(peYearMatch[1])) {
  fail('Alternative funding leaked into ProgramElementYear annual-stage model');
}

// The authoritative apps/api Prisma schema must truthfully model the three
// Session 6 tables the migration ledger creates. This regression (models
// missing from schema.prisma while the migration.sql created the tables)
// happened once during Session 6 closeout; guard against it recurring.
const prismaModelChecks = [
  {
    model: 'FederalFundingMeasure',
    dbTable: 'federal_funding_measure',
    requiredFields: [
      'measureType', 'authorityType', 'fiscalYear', 'publicLawNumber', 'title',
      'sourceDocumentId', 'dedupKey',
    ],
  },
  {
    model: 'FederalFundingProvision',
    dbTable: 'federal_funding_provision',
    requiredFields: [
      'measureId', 'statedAmountUsd', 'purposeText', 'sourceDocumentId',
      'evidenceSha256', 'dedupKey',
    ],
  },
  {
    model: 'FederalFundingAllocation',
    dbTable: 'federal_funding_allocation',
    requiredFields: [
      'provisionId', 'targetType', 'mappingMaturity', 'reviewState',
      'authoritativeAmountUsd', 'inferredRelevance', 'evidenceSourceDocumentId',
      'evidenceSha256', 'dedupKey',
    ],
  },
];
for (const check of prismaModelChecks) {
  const modelMatch = new RegExp(`model\\s+${check.model}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(
    authoritativeSchema,
  );
  if (!modelMatch) {
    fail(
      `Authoritative Prisma schema (apps/api/prisma/schema.prisma) is missing model ${check.model} ` +
        `for migrated table "${check.dbTable}" — migration ledger and Prisma desired schema are inconsistent`,
    );
    continue;
  }
  if (!new RegExp(`@@map\\("${check.dbTable}"\\)`).test(modelMatch[1])) {
    fail(`Prisma model ${check.model} does not @@map to "${check.dbTable}"`);
  }
  for (const field of check.requiredFields) {
    if (!new RegExp(`\\b${field}\\b`).test(modelMatch[1])) {
      fail(`Prisma model ${check.model} is missing expected field ${field}`);
    }
  }
}
if (!/federalFundingMeasures\s+FederalFundingMeasure\[\]/.test(authoritativeSchema)) {
  fail('SourceDocument is missing the FederalFundingMeasure back-relation');
}
if (!/federalFundingProvisions\s+FederalFundingProvision\[\]/.test(authoritativeSchema)) {
  fail('SourceDocument is missing the FederalFundingProvision back-relation');
}
if (!/federalFundingAllocationEvidence\s+FederalFundingAllocation\[\]/.test(authoritativeSchema)) {
  fail('SourceDocument is missing the FederalFundingAllocation evidence back-relation');
}

const defenseApiSchema = read('apps/defense-api/prisma/schema.prisma');
if (/model\s+FederalFunding(Measure|Provision|Allocation)\b/.test(defenseApiSchema)) {
  fail(
    'Session 6 Federal Funding models must not appear in the curated defense-api HTTP Prisma ' +
      'subset yet — Session 6 is the domain/ingestion foundation, not the HTTP/product cutover',
  );
}

const domainPath = 'packages/defense-domain/src/federal-funding/index.ts';
if (!exists(domainPath)) {
  fail('Missing federal funding domain primitives');
} else {
  const domain = read(domainPath);
  for (const token of [
    'assertAuthoritativeFederalFundingAllocation',
    'canContributeToKnownFederalFundingTotal',
    'selectFederalFundingMappingCandidate',
    "maturity: 'capability_inference'",
    "targetType: 'capability'",
  ]) {
    if (!domain.includes(token)) fail(`Missing federal funding domain token: ${token}`);
  }
}

const contractsPath = 'packages/defense-contracts/src/public/federal-funding.ts';
if (!exists(contractsPath)) {
  fail('Missing federal funding public contracts');
} else {
  const contracts = read(contractsPath);
  for (const token of [
    'FederalFundingMeasureDto',
    'FederalFundingProvisionDto',
    'FederalFundingAllocationDto',
    "schemaVersion: 'federal_funding_activity_v1'",
  ]) {
    if (!contracts.includes(token)) fail(`Missing federal funding contract token: ${token}`);
  }
}

const preparePath = 'scripts/prepare-phase8-session6-federal-funding-corpus.mjs';
if (!exists(preparePath)) {
  fail('Missing source acquisition/hash materializer');
} else {
  const prepare = read(preparePath);
  for (const token of [
    "allowedHosts = new Set(['www.govinfo.gov', 'govinfo.gov', 'www.congress.gov', 'congress.gov'])",
    'sourceSha256 && source.sourceSha256 !== downloaded.sha256',
    'Unsafe authoritative allocation',
    'phase8_session6_prepared_federal_funding_corpus_v1',
  ]) {
    if (!prepare.includes(token)) fail(`Source materializer missing fail-closed token: ${token}`);
  }
}

const ingestPath = 'apps/defense-api/scripts/ingest-federal-funding.mjs';
if (!exists(ingestPath)) {
  fail('Missing governed defense-job ingestion command');
} else {
  const ingest = read(ingestPath);
  for (const token of [
    "process.env.PHASE8_SESSION6_COMMIT_AUTHORIZED !== 'true'",
    'DRY_RUN_PASS',
    'superseded_by_document_id IS NULL',
    'Expected exactly one registered live source_document',
    'Unsafe authoritative allocation',
    'federal_funding_measure',
    'federal_funding_provision',
    'federal_funding_allocation',
  ]) {
    if (!ingest.includes(token)) fail(`Ingestion command missing governance token: ${token}`);
  }
  if (ingest.includes('program_element_year')) {
    fail('Session 6 ingestion command writes or references ProgramElementYear');
  }
  // Regression guard: $queryRawUnsafe does not know column types, so every
  // UUID foreign key placeholder MUST be explicitly cast or Postgres will
  // reject the statement (discovered during Session 6 closeout — the
  // measure_id/provision_id/source_document_id placeholders were passed as
  // bare text and every INSERT failed against a real database).
  for (const uuidCast of ['$1::uuid', '$7::uuid', '$13::uuid']) {
    if (!ingest.includes(uuidCast)) {
      fail(`Ingestion command is missing an expected UUID cast (${uuidCast}) on a raw SQL placeholder`);
    }
  }
}

for (const dbGate of ['scripts/verify-phase8-session6-db.mjs', 'scripts/verify-phase8-session6-db.sh']) {
  if (!exists(dbGate)) fail(`Missing Session 6 database negative-control gate: ${dbGate}`);
}

const corpusPath = 'docs/defense-budget/phase8-session6-federal-funding-corpus.json';
if (enforceCorpus) {
  if (!exists(corpusPath)) {
    fail('Session 6 source-grounded corpus is required under --enforce-corpus');
  } else {
    const corpus = JSON.parse(read(corpusPath));
    if (corpus.schemaVersion !== 'phase8_session6_federal_funding_corpus_v1') {
      fail('Unexpected Session 6 corpus schemaVersion');
    }
    if (!Array.isArray(corpus.sources) || corpus.sources.length < 4) {
      fail('Session 6 corpus must contain reconciliation plus at least three supplemental source units');
    }
    const reconciliation = corpus.sources.filter((source) => source.measureType === 'reconciliation');
    const supplementals = corpus.sources.filter((source) => source.measureType === 'emergency_supplemental');
    if (reconciliation.length < 1) fail('Session 6 corpus is missing the 2025 reconciliation defense source');
    if (supplementals.length < 3) fail('Session 6 corpus is missing three supplemental source units');
    for (const source of corpus.sources) {
      if (!source.officialUrl || !source.sourceKey || !source.fiscalYear) {
        fail(`Corpus source is missing official identity: ${source.sourceKey ?? '<unknown>'}`);
      }
      if (!/^https:\/\/(www\.)?(govinfo\.gov|congress\.gov)\//.test(source.officialUrl)) {
        fail(`Corpus source is not an official allowed URL: ${source.sourceKey}`);
      }
      if (!Array.isArray(source.provisions) || source.provisions.length < 1) {
        fail(`Corpus source has no source-grounded provisions: ${source.sourceKey}`);
      }
      for (const provision of source.provisions ?? []) {
        if (!provision.section || !provision.purposeText || !provision.evidencePage) {
          fail(`Corpus provision lacks section/purpose/page: ${source.sourceKey}`);
        }
        if (
          provision.authoritativeAmountUsd !== null &&
          (provision.mappingMaturity === 'capability_inference' ||
            provision.mappingMaturity === 'unmapped' ||
            provision.targetType === 'capability' ||
            provision.inferredRelevance === true ||
            provision.reviewState !== 'verified')
        ) {
          fail(`Unsafe corpus allocation: ${source.sourceKey}/${provision.section}`);
        }
      }
    }
  }
} else {
  notes.push('Real Session 6 source corpus not enforced; rerun with --enforce-corpus before declaring Session 6 complete');
}

for (const note of notes) console.log(`[phase8-session6] ${note}`);
if (failures.length) {
  console.error(`\n[phase8-session6] FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[phase8-session6] SESSION6_FEDERAL_FUNDING_FOUNDATION_PASS');
