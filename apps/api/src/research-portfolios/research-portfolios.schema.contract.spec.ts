import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20280929010000_research_portfolios_phase1/migration.sql',
  ),
  'utf8',
);

describe('Research Portfolios Phase 1 persistence contract', () => {
  test.each([
    'ResearchPortfolio',
    'ResearchPortfolioGrant',
    'ResearchPortfolioClientLink',
    'ResearchPortfolioMember',
    'ResearchPortfolioEvent',
  ])('declares Prisma model %s', (model) => {
    expect(schema).toContain(`model ${model} {`);
  });

  test.each([
    ['research_portfolio_mode', ['manual', 'rules', 'hybrid']],
    ['research_portfolio_lifecycle', ['active', 'archived']],
    ['research_portfolio_grant_role', ['owner', 'editor', 'viewer']],
    ['research_portfolio_member_kind', ['program', 'program_element', 'project', 'budget_line', 'award']],
    ['research_portfolio_member_disposition', ['included', 'excluded', 'unresolved']],
  ] as const)('creates exact enum %s', (enumName, values) => {
    expect(migration).toContain(
      `CREATE TYPE "${enumName}" AS ENUM (${values.map((value) => `'${value}'`).join(', ')});`,
    );
  });

  it('uses composite tenant-parent foreign keys for every portfolio child', () => {
    for (const table of [
      'research_portfolio_grants',
      'research_portfolio_client_links',
      'research_portfolio_members',
      'research_portfolio_events',
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE "${table}"[\\s\\S]*?FOREIGN KEY \\(\"tenant_id\", \"portfolio_id\"\\) REFERENCES \"research_portfolios\"\\(\"tenant_id\", \"id\"\\)`,
        ),
      );
    }
  });

  it('pins client links to a client in the same tenant', () => {
    expect(schema).toContain('@@unique([tenantId, id], map: "clients_tenant_id_key")');
    expect(migration).toContain(
      'FOREIGN KEY ("tenant_id", "client_id") REFERENCES "clients"("tenant_id", "id")',
    );
  });

  it('stores user grants only and requires active team support to be added later as a real identity', () => {
    const grantModel = schema.match(/model ResearchPortfolioGrant \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(grantModel).toContain('principalUserId');
    expect(grantModel).not.toMatch(/team|displayLabel|principalLabel/i);
  });

  it('keeps event history append-only and idempotent', () => {
    const eventModel = schema.match(/model ResearchPortfolioEvent \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(eventModel).not.toContain('updatedAt');
    expect(eventModel).toContain('idempotencyKey');
    expect(eventModel).toContain('payloadFingerprint');
    expect(migration).toContain('research_portfolio_events_append_only_trigger');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "research_portfolio_events"');
    expect(migration).not.toMatch(/"research_portfolio_events"[\s\S]*?"updated_at"/);
  });
});

describe('Research Portfolios Phase 7 persistence contract', () => {
  const migrationPhase7 = readFileSync(
    resolve(
      process.cwd(),
      'prisma/migrations/20280930010000_research_portfolios_phase7_reviews_imports_continuity/migration.sql',
    ),
    'utf8',
  );

  test.each([
    'ResearchPortfolioReview',
    'ResearchPortfolioDecision',
    'ResearchPortfolioContinuityLedger',
    'ResearchPortfolioImportJob',
    'ResearchPortfolioImportRow',
    'ResearchPortfolioImportMappingVersion',
    'ResearchPortfolioImportAttempt',
    'ResearchPortfolioImportEffect',
    'ResearchPortfolioImportCompensationReceipt',
  ])('declares Prisma model %s', (model) => {
    expect(schema).toContain(`model ${model} {`);
  });

  test.each([
    ['research_portfolio_review_status', ['open', 'assigned', 'deferred', 'resolved', 'cancelled']],
    ['research_portfolio_review_trigger', ['rule_change', 'annual_continuity', 'import', 'dispute', 'manual']],
    ['research_portfolio_review_target_kind', ['program', 'program_element', 'project', 'budget_line', 'award', 'rule', 'portfolio']],
    ['research_portfolio_decision_type', ['include', 'exclude', 'defer', 'reopen', 'dispute']],
    ['research_portfolio_continuity_status', ['unchanged', 'changed', 'expired', 'renamed', 'renumbered', 'split', 'merged', 'unresolved', 'new']],
    ['research_portfolio_import_job_status', ['created', 'mapped', 'previewed', 'applying', 'paused', 'completed', 'partial', 'failed', 'cancelled', 'unknown', 'needs_reconciliation', 'compensated']],
    ['research_portfolio_import_worksheet_kind', ['membership', 'rules', 'reviews']],
    ['research_portfolio_import_row_outcome', ['applied', 'skipped', 'conflict', 'failed', 'unknown']],
    ['research_portfolio_import_row_preview_classification', ['resolved', 'duplicate', 'invalid', 'ambiguous', 'unresolved', 'inaccessible']],
  ] as const)('creates exact enum %s', (enumName, values) => {
    expect(migrationPhase7.replace(/,\s*/g, ',')).toContain(
      `CREATE TYPE "${enumName}" AS ENUM (${values.map((value) => `'${value}'`).join(',')});`,
    );
  });

  it('uses composite tenant-parent foreign keys for every portfolio child', () => {
    for (const table of [
      'research_portfolio_reviews',
      'research_portfolio_decisions',
      'research_portfolio_continuity_ledger',
      'research_portfolio_import_jobs',
      'research_portfolio_import_rows',
      'research_portfolio_import_mapping_versions',
      'research_portfolio_import_attempts',
      'research_portfolio_import_effects',
      'research_portfolio_import_compensation_receipts',
    ]) {
      const tableStart = migrationPhase7.indexOf(`CREATE TABLE "${table}"`);
      const tableEnd = migrationPhase7.indexOf('\n);', tableStart);
      expect(tableStart).toBeGreaterThan(-1);
      expect(migrationPhase7.slice(tableStart, tableEnd)).toMatch(
        /FOREIGN KEY \("tenant_id",\s*"portfolio_id"\) REFERENCES "research_portfolios"\("tenant_id",\s*"id"\)/,
      );
    }
  });

  it('enforces RLS isolation policies', () => {
    for (const table of [
      'research_portfolio_reviews',
      'research_portfolio_decisions',
      'research_portfolio_continuity_ledger',
      'research_portfolio_import_jobs',
      'research_portfolio_import_rows',
      'research_portfolio_import_mapping_versions',
      'research_portfolio_import_attempts',
      'research_portfolio_import_effects',
      'research_portfolio_import_compensation_receipts',
    ]) {
      expect(migrationPhase7).toContain(`'${table}'`);
    }
    expect(migrationPhase7).toContain("EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY'");
    expect(migrationPhase7).toContain("EXECUTE format('CREATE POLICY %I ON %I USING");
  });

  it('makes decisions, mappings, attempts, effects, and compensation receipts append-only', () => {
    for (const table of [
      'decisions',
      'import_mappings',
      'import_attempts',
      'import_effects',
      'import_receipts',
    ]) {
      expect(migrationPhase7).toContain(`research_portfolio_${table}_append_only_trigger`);
    }
    expect(migrationPhase7.match(/BEFORE UPDATE OR DELETE ON/g)).toHaveLength(5);
  });
});

describe('Research Portfolios Phase 9 persistence contract', () => {
  const migrationPhase9 = readFileSync(
    resolve(
      process.cwd(),
      'prisma/migrations/20281001010000_research_portfolios_phase9_analytics_outputs/migration.sql',
    ),
    'utf8',
  );

  test.each([
    'ResearchPortfolioEventRecipientState',
    'ResearchPortfolioSubscription',
    'ResearchPortfolioSnapshot',
    'ResearchPortfolioOutputRequest',
    'ResearchPortfolioOutputJob',
    'ResearchPortfolioOutputAttempt',
    'ResearchPortfolioOutputArtifact',
    'ResearchPortfolioOutputClientFileReceipt',
  ])('declares Prisma model %s', (model) => {
    expect(schema).toContain(`model ${model} {`);
  });

  it('keeps output-unknown distinct from failure and success', () => {
    expect(migrationPhase9.replace(/\s+/g, ' ')).toContain(
      `'queued','running','completed','partial','failed','cancelled','outcome_unknown'`,
    );
  });

  it('uses tenant-parent keys and RLS for every phase 9 table', () => {
    for (const table of [
      'research_portfolio_event_recipient_states',
      'research_portfolio_subscriptions',
      'research_portfolio_snapshots',
      'research_portfolio_output_requests',
      'research_portfolio_output_jobs',
      'research_portfolio_output_attempts',
      'research_portfolio_output_artifacts',
      'research_portfolio_output_client_file_receipts',
    ]) {
      expect(migrationPhase9).toContain(`CREATE TABLE "${table}"`);
      expect(migrationPhase9).toContain(`'${table}'`);
      const start = migrationPhase9.indexOf(`CREATE TABLE "${table}"`);
      const end = migrationPhase9.indexOf('\n);', start);
      expect(migrationPhase9.slice(start, end)).toMatch(
        /FOREIGN KEY \("tenant_id",\s*"portfolio_id"\) REFERENCES "research_portfolios"\("tenant_id",\s*"id"\)/,
      );
    }
  });

  it('makes snapshots, attempts, artifacts, and filing receipts append-only', () => {
    for (const trigger of ['snapshots', 'output_attempts', 'output_artifacts', 'output_receipts']) {
      expect(migrationPhase9).toContain(`research_portfolio_${trigger}_append_only_trigger`);
    }
    expect(migrationPhase9.match(/BEFORE UPDATE OR DELETE ON/g)).toHaveLength(4);
  });

  it('pins exact output bytes and enforces CSV-only configured delivery', () => {
    expect(migrationPhase9).toContain('"bytes" BYTEA NOT NULL');
    expect(migrationPhase9).toContain('CHECK ("format" = \'csv\')');
    expect(migrationPhase9).toContain('"content_hash" CHAR(64) NOT NULL');
    expect(migrationPhase9).toContain(
      'CREATE INDEX "research_portfolio_output_artifacts_hash_idx"',
    );
    expect(migrationPhase9).not.toContain(
      'CREATE UNIQUE INDEX "research_portfolio_output_artifacts_hash',
    );
  });
});
