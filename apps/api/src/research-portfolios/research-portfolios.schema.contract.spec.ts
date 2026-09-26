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
