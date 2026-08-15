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

  it('does not let web evidence determine congressional districts', () => {
    expect(service).not.toMatch(/congressionalDistrict:\s*asString\(proposed/);
    expect(service).toContain('this.facilities.createFacility');
  });
});
