import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Advocacy Matter architecture contract', () => {
  const controller = readFileSync(
    resolve(process.cwd(), 'src/clients/client-advocacy-matter.controller.ts'),
    'utf8',
  );
  const service = readFileSync(resolve(process.cwd(), 'src/clients/client-advocacy-matter.service.ts'), 'utf8');
  const completion = readFileSync(
    resolve(process.cwd(), 'src/clients/client-profile-fill-completion-persistence.ts'),
    'utf8',
  );
  const tenantHistory = readFileSync(
    resolve(process.cwd(), 'src/clients/client-profile-fill-tenant-history-discovery.ts'),
    'utf8',
  );
  const history = readFileSync(
    resolve(process.cwd(), 'src/clients/client-profile-fill-advocacy-history.ts'),
    'utf8',
  );
  const recordApplication = readFileSync(
    resolve(process.cwd(), 'src/clients/client-profile-fill-advocacy-record-application.ts'),
    'utf8',
  );
  const outcomeApplication = readFileSync(
    resolve(process.cwd(), 'src/clients/client-profile-fill-outcome-application.ts'),
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
  const publicSourceMigration = readFileSync(
    resolve(process.cwd(), 'prisma/migrations/20271231070000_advocacy_matter_public_source_links/migration.sql'),
    'utf8',
  );

  it('exposes the Matter read/manage surface under the client route, review-gated for mutations', () => {
    expect(controller).toContain("@Controller('clients/:clientId/advocacy-matters')");
    expect(controller).toMatch(/@Patch\(':matterId'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
    expect(controller).toMatch(/@Post\(':matterId\/merge'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
  });

  it('supports §25 "Add advocacy record" — review-gated, exactly one of an existing/new Matter or unassigned', () => {
    expect(controller).toMatch(/@Post\('records'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
    expect(controller).toContain('createManualRecord');
    // The full §25 type vocabulary, not a narrowed subset.
    for (const type of [
      'advocacy_ask', 'meeting', 'submission', 'congressional_request',
      'regulatory_comment', 'testimony', 'outreach', 'government_action', 'outcome', 'other',
    ]) {
      expect(controller).toContain(type);
    }
    // §25: "CLIENT_VERIFIED unless backed by a separately attached official
    // public source" — never inferred from record type alone, only from an
    // actually-supplied sourceUrl.
    expect(service).toMatch(/sourceUrl\s*\?\s*'PUBLIC_VERIFIED'\s*:\s*'CLIENT_VERIFIED'/);
    // Choosing both an existing Matter and a new one in the same call is
    // rejected, not silently resolved by picking one.
    expect(service).toContain('Choose an existing Matter or a new one, not both');
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
    expect(recordApplication).toContain('this.advocacyMatters.assignMatterForRecord');
    expect(recordApplication).toMatch(/applyAdvocacyRecord[\s\S]{0,4000}assignMatterForRecord/);
  });

  it('links observed outcomes into the same Matter as their advocacy record without claiming causation', () => {
    expect(outcomeApplication).toContain("linkType: 'outcome_event'");
    expect(outcomeApplication).toContain('causationClaimed: false');
  });

  it('§26 incremental refresh: client-submission and private-candidate advocacy discovery both filter by a stored watermark, not a full re-scan every run', () => {
    // Confirmed by audit before this was added: LDA already filtered by
    // `dt_posted > watermark`; client submissions and private-relationship
    // candidates did not, re-scanning the same LIMIT-capped window every
    // single run with no watermark at all — a real bug for any client with
    // more history than the cap, not just wasted work.
    expect(tenantHistory).toMatch(/s\.created_at\s*>\s*\$3::timestamptz/);
    expect(tenantHistory).toMatch(/applied_at\s*>\s*\$3::timestamptz/);
    // Both new watermark fields merge into the SAME 'advocacy_history'
    // cursor the LDA watermark already uses (JSONB `||` merge in
    // recordCursor — see below), rather than each source inventing its own
    // separate cursor row.
    expect(history).toContain('lastClientSubmissionAt');
    expect(history).toContain('lastRelationshipLinkAppliedAt');
    expect(history).toMatch(/recordCursor\(ctx\.tenantId, clientId, 'advocacy_history'/);
    expect(completion).toContain(
      'watermark_jsonb = client_profile_fill_source_cursor.watermark_jsonb || EXCLUDED.watermark_jsonb',
    );
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
    expect(service).toMatch(/OUTCOME_STATUSES[\s\S]{0,1200}outcome_event/);
    // The gate is scoped to actual transitions INTO an outcome status —
    // an ordinary edit re-submitting the unchanged status must not be
    // re-challenged. See the correction service spec's
    // "an ordinary edit re-submitting the UNCHANGED outcome status" test.
    expect(service).toContain('isTransition');
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
    expect(service).toMatch(/linkStrategy[\s\S]{0,3000}readLinkSourceOrUnavailable\('sp_strategy'/);
    expect(service).toMatch(/private async readLinkSourceOrUnavailable[\s\S]{0,400}BadRequestException/);
  });

  it('every new link column stays nullable so existing PR #1253 link rows are unaffected', () => {
    expect(directEvidenceMigration).toContain('ADD COLUMN IF NOT EXISTS relationship_type VARCHAR(32) NULL');
    expect(directEvidenceMigration).toContain('ADD COLUMN IF NOT EXISTS confidence NUMERIC(5,4) NULL');
    expect(directEvidenceMigration).toContain('ADD COLUMN IF NOT EXISTS provenance TEXT NULL');
  });

  it('supports the five public-source link types (regulatory_docket/regulatory_document/hearing/testimony/fara_record), admin-gated, PUBLIC_VERIFIED', () => {
    expect(publicSourceMigration).toContain("'regulatory_docket'");
    expect(publicSourceMigration).toContain("'regulatory_document'");
    expect(publicSourceMigration).toContain("'hearing'");
    expect(publicSourceMigration).toContain("'testimony'");
    expect(publicSourceMigration).toContain("'fara_record'");
    expect(publicSourceMigration).toContain('PUBLIC_VERIFIED');
    expect(controller).toMatch(/@Post\(':matterId\/link-regulatory-docket'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
    expect(controller).toMatch(/@Post\(':matterId\/link-regulatory-document'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
    expect(controller).toMatch(/@Post\(':matterId\/link-hearing'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
    expect(controller).toMatch(/@Post\(':matterId\/link-testimony'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
    expect(controller).toMatch(/@Post\(':matterId\/link-fara-record'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
  });

  it('does not fabricate CPF/CDS coverage — confirmed absent from the repo, deliberately not added', () => {
    expect(publicSourceMigration).toMatch(/CPF[\s\S]{0,200}NOT added|deliberately NOT added[\s\S]{0,200}CPF/);
    expect(publicSourceMigration).not.toContain("'cpf_request'");
    expect(publicSourceMigration).not.toContain("'cds_request'");
  });

  it('hearing links require a deterministic committee-code match OR an explicit manual rationale — never silent auto-classification', () => {
    expect(service).toMatch(/linkHearing[\s\S]{0,2500}confirmedByCommitteeCode/);
    expect(service).toMatch(/confirmedByCommitteeCode[\s\S]{0,500}manualRationale/);
  });

  it('testimony links never fabricate a witness organization or document — honest about the coverage gap', () => {
    expect(service).toMatch(/linkTestimony[\s\S]{0,2500}organization: null/);
    expect(service).toMatch(/linkTestimony[\s\S]{0,2500}documentUrl: null/);
  });

  it('every public-source read failure is source-unavailable (400), never confused with a real zero-result (404)', () => {
    expect(service).toContain('readLinkSourceOrUnavailable');
    expect(service).toMatch(/readLinkSourceOrUnavailable\('regulatory_docket'/);
    expect(service).toMatch(/readLinkSourceOrUnavailable\('federal_register_document'/);
    expect(service).toMatch(/readLinkSourceOrUnavailable\('fara_registration'/);
    expect(service).toMatch(/private async readLinkSourceOrUnavailable[\s\S]{0,400}BadRequestException/);
  });
});
