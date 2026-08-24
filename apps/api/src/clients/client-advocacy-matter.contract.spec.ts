import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Advocacy Matter architecture contract', () => {
  const controller = readFileSync(
    resolve(process.cwd(), 'src/clients/client-advocacy-matter.controller.ts'),
    'utf8',
  );
  const service = readFileSync(resolve(process.cwd(), 'src/clients/client-advocacy-matter.service.ts'), 'utf8');
  const completion = readFileSync(
    resolve(process.cwd(), 'src/clients/client-profile-fill-completion.service.ts'),
    'utf8',
  );
  const migration = readFileSync(
    resolve(process.cwd(), 'prisma/migrations/20271231040000_client_advocacy_matter/migration.sql'),
    'utf8',
  );

  it('exposes the Matter read/manage surface under the client route, review-gated for mutations', () => {
    expect(controller).toContain("@Controller('clients/:clientId/advocacy-matters')");
    expect(controller).toMatch(/@Patch\(':matterId'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
    expect(controller).toMatch(/@Post\(':matterId\/merge'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
  });

  it('forces RLS on both new tables with rls_bypass/current_tenant_id policies', () => {
    expect(migration).toContain('ALTER TABLE client_advocacy_matter FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE client_advocacy_matter_link FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('rls_bypass() OR tenant_id = current_tenant_id()');
  });

  it('links a record to its Matter via a nullable, SET-NULL-on-delete matter_id', () => {
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS matter_id UUID NULL REFERENCES client_advocacy_matter(id) ON DELETE SET NULL',
    );
  });

  it('assigns a Matter as a side effect of applying an advocacy record, never blocking the apply on failure', () => {
    expect(completion).toContain('this.advocacyMatters.assignMatterForRecord');
    expect(completion).toMatch(/applyAdvocacyRecord[\s\S]{0,4000}assignMatterForRecord/);
  });

  it('links observed outcomes into the same Matter as their advocacy record without claiming causation', () => {
    expect(completion).toContain("linkType: 'outcome_event'");
    expect(completion).toContain('causationClaimed: false');
  });

  it('clusters by Program Element / bill / issue code before falling back to title overlap', () => {
    expect(service).toContain('computeMatterClue');
    expect(service).toContain('TITLE_OVERLAP_THRESHOLD');
  });
});
