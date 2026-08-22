import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Fill with Meri architecture contract', () => {
  const service = readFileSync(resolve(process.cwd(), 'src/clients/client-profile-fill.service.ts'), 'utf8');
  const controller = readFileSync(resolve(process.cwd(), 'src/clients/client-profile-fill.controller.ts'), 'utf8');
  const migration = readFileSync(
    resolve(process.cwd(), 'prisma/migrations/20261015010000_client_profile_fill_with_meri/migration.sql'),
    'utf8',
  );

  it('is a standalone enrichment workflow, not a chat execution path', () => {
    expect(service).not.toContain('setChatOpen');
    expect(service).not.toContain('clearChatSession');
    expect(service).not.toContain('ClioConversation');
    expect(controller).toContain("@Controller('clients/:clientId/fill-with-meri')");
  });

  it('keeps canonical writes behind an admin review action', () => {
    expect(controller).toMatch(/@Post\('runs\/:runId\/apply'\)[\s\S]{0,120}@Roles\('user_admin'\)/);
    expect(controller).toMatch(/@Post\('findings\/:findingId\/reject'\)[\s\S]{0,120}@Roles\('user_admin'\)/);
    expect(service).toContain('upsertPersonForImport');
    expect(service).toContain('createFacility');
    expect(service).toContain('createCapability');
    expect(service).toContain('createManualMapping');
  });

  it('forces RLS on both new tenant tables and explicitly scopes queries', () => {
    const repairMigration = readFileSync(
      resolve(process.cwd(), 'prisma/migrations/20261015020000_fix_client_profile_fill_rls_guc/migration.sql'),
      'utf8',
    );
    expect(migration).toContain('ALTER TABLE client_profile_fill_run FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE client_profile_fill_finding FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('FOREIGN KEY (run_id, tenant_id, client_id)');
    // Original migration incorrectly used app.tenant_id; live GUC is app.current_tenant.
    // Repair migration must align policies with current_tenant_id()/rls_bypass().
    expect(migration).toContain("current_setting('app.tenant_id', true)");
    expect(repairMigration).toContain('current_tenant_id()');
    expect(repairMigration).toContain('rls_bypass()');
    // Policy bodies must not read the wrong GUC (comments may mention it historically).
    expect(repairMigration).not.toMatch(
      /FOR (SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,120}current_setting\('app\.tenant_id'/,
    );
    expect(service).toContain('tenant_id = $1::uuid');
  });

  it('keeps Program Elements recommendation-only and validates them against the canonical PE table', () => {
    expect(service).toContain('this.prisma.programElement.findMany');
    expect(service).toContain("kind: 'program_element'");
    expect(service).toContain("status: 'informational'");
    expect(service).toContain("This item is informational and is not applied to the client record");
  });

  it('uses persisted synced mail participants when contact harvesting has no explicit client link', () => {
    expect(service).toContain('tx.mailMessage.findMany');
    expect(service).toContain('extractSyncedMailParticipants');
    expect(service).toContain("notes: 'Extracted from synced email participants'");
    expect(service).toContain("source: 'synced_email'");
  });

  it('uses layered public-web queries and tolerates individual provider query failures', () => {
    expect(service).toContain('buildCompanySearchQueries(client)');
    expect(service).toContain('Promise.all(');
    expect(service).toContain('searchPublicWeb(query, 5).catch');
  });

  it('does not let web evidence determine congressional districts', () => {
    expect(service).not.toMatch(/congressionalDistrict:\s*asString\(proposed/);
    expect(service).toContain('this.facilities.createFacility');
  });

  it('accepts a drawer website seed, persists it before enrichment, and crawls linked pages', () => {
    expect(controller).toContain('website?: string');
    expect(service).toContain('seedWebsite');
    expect(service).toContain('maybeSeedWebsite');
    expect(service).toContain('discoverSameOriginPageCandidates');
    expect(service).toContain('fetchPublicPages');
  });

  it('suggests bill tracking recommendations as informational findings from the tracker matcher', () => {
    expect(service).toContain('gatherBillRecommendations');
    expect(service).toContain("kind: 'bill_recommendation'");
    expect(service).toContain("status: 'informational'");
    expect(service).toContain('getRecommendations');
    expect(service).toMatch(/case 'bill_recommendation':[\s\S]{0,120}informational and is not applied/);
  });
});
