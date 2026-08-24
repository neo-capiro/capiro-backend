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
  const correctionMigration = readFileSync(
    resolve(process.cwd(), 'prisma/migrations/20271231050000_advocacy_matter_correction_ux/migration.sql'),
    'utf8',
  );
  const directEvidenceMigration = readFileSync(
    resolve(process.cwd(), 'prisma/migrations/20271231060000_advocacy_matter_direct_evidence_links/migration.sql'),
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

  it('exposes the record correction UX (reassign/detach/not-advocacy) admin-gated', () => {
    expect(controller).toMatch(/@Post\('records\/:recordId\/reassign'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
    expect(controller).toMatch(/@Post\('records\/:recordId\/detach'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
    expect(controller).toMatch(/@Post\('records\/:recordId\/not-advocacy'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
  });

  it('protects a human-corrected record from automatic re-clustering via matter_locked', () => {
    expect(correctionMigration).toContain('matter_locked');
    expect(service).toContain('matter_locked');
    expect(service).toMatch(/assignMatterForRecord[\s\S]{0,2000}locked/);
  });

  it('requires evidence or explicit confirmation before an outcome-claim status', () => {
    expect(service).toContain('confirmOutcome');
    expect(service).toMatch(/OUTCOME_STATUSES[\s\S]{0,600}outcome_event/);
  });

  it('supports the full product lifecycle status set in the correction migration constraint', () => {
    expect(correctionMigration).toContain("'planning'");
    expect(correctionMigration).toContain("'outcome_observed'");
    expect(correctionMigration).toContain("'successful'");
    expect(correctionMigration).toContain("'partially_successful'");
    expect(correctionMigration).toContain("'unsuccessful'");
    expect(correctionMigration).toContain("'withdrawn'");
    expect(correctionMigration).toContain("'archived'");
  });

  it('marks not_advocacy records excluded from Matter record/outcome rollups', () => {
    expect(correctionMigration).toContain('not_advocacy');
    expect(service).toMatch(/matter_id IS NOT NULL AND not_advocacy = false/);
    expect(service).toMatch(/matter_id = \$3::uuid AND not_advocacy = false/);
  });

  it('supports the four direct-evidence link types (meeting/mail_thread/outreach/strategy), admin-gated', () => {
    expect(directEvidenceMigration).toContain("'meeting'");
    expect(directEvidenceMigration).toContain("'mail_thread'");
    expect(directEvidenceMigration).toContain("'outreach'");
    expect(directEvidenceMigration).toContain("'strategy'");
    expect(controller).toMatch(/@Post\(':matterId\/link-meeting'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
    expect(controller).toMatch(/@Post\(':matterId\/link-mail-thread'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
    expect(controller).toMatch(/@Post\(':matterId\/link-outreach'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
    expect(controller).toMatch(/@Post\(':matterId\/link-strategy'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
  });

  it('only links a SHARED meeting into a Matter — a private meeting can never leak in', () => {
    expect(service).toMatch(/linkMeeting[\s\S]{0,800}visibility: 'shared'/);
  });

  it('validates mail thread and outreach links through the canonical EngagementService access gates, not a re-derived check', () => {
    expect(service).toContain('this.engagement.listMailThreads');
    expect(service).toContain('this.engagement.getOutreachRecord');
  });

  it('distinguishes planned_action from completed_action for Strategy links and never claims causation', () => {
    expect(directEvidenceMigration).toContain('planned_action');
    expect(directEvidenceMigration).toContain('completed_action');
    expect(service).toMatch(/linkStrategy[\s\S]{0,3000}causationClaimed: false/);
  });

  it('treats a missing sp_strategy table as source-unavailable, not a hard crash — api-strategy owns that table', () => {
    expect(service).toMatch(/linkStrategy[\s\S]{0,3000}catch/);
    expect(service).toContain('sp_strategy read failed');
  });

  it('every new link column stays nullable so existing PR #1253 link rows are unaffected', () => {
    expect(directEvidenceMigration).toContain('ADD COLUMN IF NOT EXISTS relationship_type VARCHAR(32) NULL');
    expect(directEvidenceMigration).toContain('ADD COLUMN IF NOT EXISTS confidence NUMERIC(5,4) NULL');
    expect(directEvidenceMigration).toContain('ADD COLUMN IF NOT EXISTS provenance TEXT NULL');
  });
});
