/**
 * export-native-payload.ts — Export accounts-backend/native-payload.json
 *
 * Uses the action fixture award keys:
 *   usaspending|award|CONT_AWD_0001_2100_-NONE-_-NONE-  (reported: negative/null/zero + historical periods)
 *   usaspending|award|CONT_AWD_0001_9700_-NONE-_-NONE-  (unavailable: no observation inserted)
 *
 * Real native read: knownAt comes from actual DB statement_timestamp().
 * This is synthetic local evidence only — NOT production data or deployed serving.
 * Runs entirely inside a transaction and ROLLBACKs; leaves DB unchanged.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { Client } from 'pg';

const DIRECTORY = 'C:/ProgramData/Hermes/profiles/kanbanqa/cache/scratch/pg16-fixture/data';
const MIGRATION = 'C:/dev/defproc-release1-backend/apps/api/prisma/migrations/20281104030000_defproc_account_reports/migration.sql';
const EVIDENCE = 'C:/dev/defproc-release1-evidence/accounts-backend';

// Action fixture award keys as specified by operator.
const AWARD_KEY_REPORTED = 'usaspending|award|CONT_AWD_0001_2100_-NONE-_-NONE-';   // synthetic observation inserted
const AWARD_KEY_UNAVAILABLE = 'usaspending|award|CONT_AWD_0001_9700_-NONE-_-NONE-'; // no observation → unavailable

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function stripMigrationWrappers(sql: string): string {
  return sql
    .replace(/^\s*BEGIN\s*;\s*/m, '')
    .replace(/\s*COMMIT\s*;\s*$/m, '');
}

/**
 * Synthetic funding response matching USAspending source shape.
 * Includes:
 *   - Positive obligation
 *   - Negative obligation (de-obligation)
 *   - Null obligation with positive outlay
 *   - Zero outlay (distinct from null)
 *   - Null outlay
 *   - Historical report periods (FY2021, FY2022, FY2023, FY2024 — NOT FY2025-26)
 *   - disaster_emergency_fund_code as STRING "Q" and null
 *   - duplicate-looking rows preserved with distinct sourceRowIndex
 */
function makeSyntheticFundingResponse(): string {
  const results = [
    // Row 0: positive obligation, null outlay, FY2024, DEFC string "Q"
    {
      transaction_obligated_amount: 1700000.0,
      gross_outlay_amount: null,
      disaster_emergency_fund_code: 'Q',
      federal_account: '021-8076',
      account_title: 'Research, Development, Test and Evaluation, Army',
      funding_agency_name: 'Department of Defense',
      awarding_agency_name: 'Department of Defense',
      object_class: '25.1',
      object_class_name: 'Advisory and assistance services',
      program_activity_code: '0001',
      program_activity_name: 'RDTE-BASIC RESEARCH',
      reporting_fiscal_year: 2024,
      reporting_fiscal_quarter: 4,
      reporting_fiscal_month: 12,
      is_quarterly_submission: false,
    },
    // Row 1: negative obligation (de-obligation), null outlay, FY2024, DEFC "Q"
    {
      transaction_obligated_amount: -500000.0,
      gross_outlay_amount: null,
      disaster_emergency_fund_code: 'Q',
      federal_account: '021-8076',
      account_title: 'Research, Development, Test and Evaluation, Army',
      funding_agency_name: 'Department of Defense',
      awarding_agency_name: 'Department of Defense',
      object_class: '25.1',
      object_class_name: 'Advisory and assistance services',
      program_activity_code: '0001',
      program_activity_name: 'RDTE-BASIC RESEARCH',
      reporting_fiscal_year: 2024,
      reporting_fiscal_quarter: 2,
      reporting_fiscal_month: 6,
      is_quarterly_submission: false,
    },
    // Row 2: null obligation, positive outlay, FY2023, DEFC null
    {
      transaction_obligated_amount: null,
      gross_outlay_amount: 37690.0,
      disaster_emergency_fund_code: null,
      federal_account: '021-8010',
      account_title: 'Other Procurement, Army',
      funding_agency_name: 'Department of Defense',
      awarding_agency_name: 'Department of Defense',
      object_class: '35.0',
      object_class_name: 'Acquisition of major equipment',
      program_activity_code: '0020',
      program_activity_name: 'OTHER PROCUREMENT',
      reporting_fiscal_year: 2023,
      reporting_fiscal_quarter: 4,
      reporting_fiscal_month: 12,
      is_quarterly_submission: false,
    },
    // Row 3: zero outlay (distinct from null), null obligation, FY2022
    {
      transaction_obligated_amount: null,
      gross_outlay_amount: 0.0,
      disaster_emergency_fund_code: null,
      federal_account: '021-8076',
      account_title: 'Research, Development, Test and Evaluation, Army',
      funding_agency_name: 'Department of Defense',
      awarding_agency_name: 'Department of Defense',
      object_class: '25.1',
      object_class_name: 'Advisory and assistance services',
      program_activity_code: '0001',
      program_activity_name: 'RDTE-BASIC RESEARCH',
      reporting_fiscal_year: 2022,
      reporting_fiscal_quarter: 4,
      reporting_fiscal_month: 12,
      is_quarterly_submission: true,
    },
    // Row 4: nullable period fields (FY2021, quarterly submission)
    {
      transaction_obligated_amount: 500000.0,
      gross_outlay_amount: 500000.0,
      disaster_emergency_fund_code: null,
      federal_account: '021-8076',
      account_title: 'Research, Development, Test and Evaluation, Army',
      funding_agency_name: 'Department of Defense',
      awarding_agency_name: 'Department of Defense',
      object_class: '25.1',
      object_class_name: 'Advisory and assistance services',
      program_activity_code: '0001',
      program_activity_name: 'RDTE-BASIC RESEARCH',
      reporting_fiscal_year: 2021,
      reporting_fiscal_quarter: 4,
      reporting_fiscal_month: 12,
      is_quarterly_submission: true,
    },
    // Row 5: duplicate-looking row (same account/class as row 4 but different period) — must be preserved
    {
      transaction_obligated_amount: 500000.0,
      gross_outlay_amount: 500000.0,
      disaster_emergency_fund_code: null,
      federal_account: '021-8076',
      account_title: 'Research, Development, Test and Evaluation, Army',
      funding_agency_name: 'Department of Defense',
      awarding_agency_name: 'Department of Defense',
      object_class: '25.1',
      object_class_name: 'Advisory and assistance services',
      program_activity_code: '0001',
      program_activity_name: 'RDTE-BASIC RESEARCH',
      reporting_fiscal_year: 2021,
      reporting_fiscal_quarter: 3,
      reporting_fiscal_month: 9,
      is_quarterly_submission: false,
    },
  ];
  return JSON.stringify({
    results,
    page_metadata: { page: 1, hasNext: false, hasPrevious: false, next: null, previous: null },
  });
}

async function main(): Promise<void> {
  assert.equal(process.env['DEFPROC_LOCAL_ACCOUNT_TEST'], '1', 'explicit DEFPROC_LOCAL_ACCOUNT_TEST=1 required');
  assert(!process.env['DATABASE_URL'], 'unset DATABASE_URL before this fixture');

  const client = new Client({
    host: '127.0.0.1', port: 5558, user: 'capiro_master', database: 'capiro_fixture',
    ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 120000,
  });
  await client.connect();

  try {
    // Verify fixture identity.
    const identity = (await client.query(
      `SELECT current_setting('data_directory') directory, current_database() db, current_user role, host(inet_server_addr()) address`,
    )).rows[0] as { directory: string; db: string; role: string; address: string };
    assert.equal(identity.directory.replaceAll('\\', '/'), DIRECTORY, 'wrong data_directory');
    assert.equal(identity.db, 'capiro_fixture', 'wrong database');
    assert.equal(identity.role, 'capiro_master', 'wrong role');
    assert.equal(identity.address, '127.0.0.1', 'wrong address');

    // Run entirely inside a transaction — ROLLBACK at end leaves DB unchanged.
    await client.query('BEGIN');
    try {
      // Install migration DDL.
      const migrationSql = stripMigrationWrappers(readFileSync(MIGRATION, 'utf-8'));
      await client.query(migrationSql);

      // Build synthetic observation body.
      const obsBody = makeSyntheticFundingResponse();
      const obsSha = sha256(obsBody);
      // Use a historical source observed instant (not a future clock).
      const obsSourceAt = '2026-11-01T12:00:00.000000Z';

      // Append under capiro_defense_job role.
      await client.query('SET LOCAL ROLE capiro_defense_job');
      const appendR = await client.query(
        'SELECT public.defproc_append_account_report_v1($1,$2,$3,$4) AS result',
        [AWARD_KEY_REPORTED, obsSourceAt, obsBody, obsSha],
      );
      const appendResult = appendR.rows[0]?.result as { snapshotId: string; inserted: boolean };
      assert(appendResult?.inserted === true, `append failed: ${JSON.stringify(appendResult)}`);
      console.log(`Appended observation snapshotId=${appendResult.snapshotId}`);
      await client.query('RESET ROLE');

      // Capture the real DB knownAt AFTER insertion (statement_timestamp() is the same throughout the txn).
      // We use statement_timestamp() via the scope function's default (knownAt=NULL → statement_timestamp()).
      // But we also capture it explicitly for the export.
      const tsRow = (await client.query('SELECT defproc_v2_private.utc(statement_timestamp()) ts')).rows[0] as { ts: string };
      const knownAt = tsRow.ts;
      console.log(`Real DB knownAt: ${knownAt}`);

      // Read the scope under capiro_app.
      await client.query('SET LOCAL ROLE capiro_app');
      const scopeR = await client.query(
        'SELECT public.defproc_account_reports_scope_v1($1,$2) AS result',
        [[AWARD_KEY_REPORTED, AWARD_KEY_UNAVAILABLE], knownAt],
      );
      await client.query('RESET ROLE');

      const scopeResult = scopeR.rows[0]?.result;
      assert(scopeResult, 'scope returned null');
      assert.equal(scopeResult.contract, 'defproc-account-reports/v1', 'wrong contract');
      assert.equal(scopeResult.knownAt, knownAt, 'knownAt mismatch');

      const reports = scopeResult.reports as Array<Record<string, unknown>>;
      assert.equal(reports.length, 2, `expected 2 reports, got ${reports.length}`);

      const repReported = reports.find((r) => r['awardIdentityKey'] === AWARD_KEY_REPORTED);
      const repUnavailable = reports.find((r) => r['awardIdentityKey'] === AWARD_KEY_UNAVAILABLE);
      assert(repReported, 'missing reported award report');
      assert(repUnavailable, 'missing unavailable award report');
      assert.equal(repReported['state'], 'reported', `expected reported, got ${repReported['state']}`);
      assert.equal(repUnavailable['state'], 'unavailable', `expected unavailable, got ${repUnavailable['state']}`);

      const rows = repReported['rows'] as Array<Record<string, unknown>>;
      assert.equal(rows.length, 6, `expected 6 rows, got ${rows.length}`);

      // Verify specific contracts:
      // Row 0: positive obligation
      assert(rows[0]!['reportedObligationUsd'] !== null, 'row 0 obligation should not be null');
      assert(String(rows[0]!['reportedObligationUsd']).includes('1700000'), `row 0 obligation: ${rows[0]!['reportedObligationUsd']}`);
      // Row 1: negative obligation
      assert(String(rows[1]!['reportedObligationUsd']).startsWith('-'), `row 1 should be negative: ${rows[1]!['reportedObligationUsd']}`);
      // Row 2: null obligation, positive outlay
      assert.equal(rows[2]!['reportedObligationUsd'], null, 'row 2 obligation should be null');
      assert(rows[2]!['reportedGrossOutlayUsd'] !== null, 'row 2 outlay should not be null');
      // Row 3: zero outlay (distinct from null)
      assert.equal(rows[3]!['reportedObligationUsd'], null, 'row 3 obligation should be null');
      assert(rows[3]!['reportedGrossOutlayUsd'] !== null, 'row 3 outlay should be present (zero)');
      // Row 4 & 5: duplicate-looking rows both preserved
      assert.equal(rows[4]!['sourceRowIndex'], 4, 'row 4 sourceRowIndex');
      assert.equal(rows[5]!['sourceRowIndex'], 5, 'row 5 sourceRowIndex');
      // treasuryAccountSymbol always null
      assert.equal(rows[0]!['treasuryAccountSymbol'], null, 'treasuryAccountSymbol always null');
      // disasterEmergencyFundCode: string "Q" and null
      assert.equal(rows[0]!['disasterEmergencyFundCode'], 'Q', 'row 0 DEFC should be Q');
      assert.equal(rows[2]!['disasterEmergencyFundCode'], null, 'row 2 DEFC should be null');
      // Historical periods only
      const years = rows.map((r) => r['reportingFiscalYear'] as number | null).filter(Boolean);
      const maxYear = Math.max(...(years as number[]));
      assert(maxYear <= 2024, `latest period should be <=2024, got ${maxYear}`);

      console.log(`All assertions passed. rows=${rows.length}`);
      console.log(`  Row 0 obligation: ${rows[0]!['reportedObligationUsd']}`);
      console.log(`  Row 1 obligation (negative): ${rows[1]!['reportedObligationUsd']}`);
      console.log(`  Row 2 obligation (null): ${rows[2]!['reportedObligationUsd']}, outlay: ${rows[2]!['reportedGrossOutlayUsd']}`);
      console.log(`  Row 3 outlay (zero): ${rows[3]!['reportedGrossOutlayUsd']}`);

      // Build the export payload.
      const payload = {
        _comment: 'Synthetic local evidence only. NOT real serving data. Generated from native PostgreSQL fixture.',
        _awardKeysUsed: [AWARD_KEY_REPORTED, AWARD_KEY_UNAVAILABLE],
        _sourceAwardIds: [
          'CONT_AWD_0001_2100_-NONE-_-NONE-', // reported
          'CONT_AWD_0001_9700_-NONE-_-NONE-',  // unavailable
        ],
        _snapshotId: appendResult.snapshotId,
        _sourceObservedAt: obsSourceAt,
        _sourcePayloadSha256: obsSha,
        _sourceUrl: 'https://api.usaspending.gov/api/v2/awards/funding/',
        ...scopeResult,
      };

      mkdirSync(EVIDENCE, { recursive: true });
      const payloadPath = `${EVIDENCE}/native-payload.json`;
      writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
      console.log(`Exported to ${payloadPath}`);

    } finally {
      // Always rollback — fixture DB must be unchanged after this script.
      await client.query('ROLLBACK');
      console.log('Transaction rolled back — DB unchanged.');
    }

  } finally {
    await client.end();
  }
}

void main().catch((err: unknown) => {
  console.error('[export-native-payload] FATAL', err);
  process.exit(1);
});
