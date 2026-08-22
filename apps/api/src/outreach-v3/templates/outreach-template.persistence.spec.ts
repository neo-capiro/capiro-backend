import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function apiRoot(): string {
  const cwd = process.cwd();
  return existsSync(resolve(cwd, 'prisma')) ? cwd : resolve(cwd, 'apps/api');
}

const root = apiRoot();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Outreach V3 template persistence authority', () => {
  const migration = read(
    'prisma/migrations/20261219010000_outreach_v3_templates/migration.sql',
  );
  const repository = read('src/outreach-v3/templates/outreach-template.repository.ts');
  const service = read('src/outreach-v3/templates/outreach-template.service.ts');
  const compiler = read('src/outreach-v3/templates/outreach-template.compiler.ts');

  it('never reintroduces the legacy GUC names PrismaService does not set', () => {
    // PrismaService.withTenant()/withTenantUser() (apps/api/src/prisma/
    // prisma.service.ts) set app.current_tenant / app.current_user. A policy
    // written against app.current_firm_id / app.current_user_id never matches
    // any real connection and is a silent no-op — this is a merge-blocking
    // regression if it ever comes back. Checking the functional
    // current_setting(...) call site (rather than banning the substring
    // outright) lets this migration's own header comment keep explaining,
    // by name, which GUCs the earlier draft got wrong.
    expect(migration).not.toContain("current_setting('app.current_firm_id'");
    expect(migration).not.toContain("current_setting('app.current_user_id'");
  });

  it('uses the schema-wide canonical RLS helpers and forces private-owner isolation', () => {
    // current_tenant_id()/current_user_id()/rls_bypass() (defined in
    // 20260501000000_init_identity_tenancy and
    // 20260712030000_memory_items_private_scope_rls) read app.current_tenant /
    // app.current_user / app.bypass_rls — the exact GUCs PrismaService sets.
    // Using them (rather than re-deriving the GUCs inline) is what closes the
    // legacy-name regression AND picks up withSystem()'s bypass flag for free.
    expect(migration).toContain('ALTER TABLE outreach_v3_templates FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('current_tenant_id()');
    expect(migration).toContain('current_user_id()');
    expect(migration).toContain('rls_bypass()');
    expect(migration).toContain("scope <> 'private'");
  });

  it('documents RLS as defense in depth, not the runtime boundary', () => {
    // capiro_app bypasses RLS (see PrismaService's own header comment). The
    // migration must not claim RLS is the primary isolation mechanism for the
    // deployed role, and the repository must carry explicit tenant/owner/
    // scope predicates on every raw query instead of relying on the policy.
    expect(migration).toMatch(/BYPASS(ES)? Postgres row-level security/);
    expect(migration).not.toMatch(/RLS remains the fail-closed tenant\/private-owner boundary/);
  });

  it('enforces private-owner isolation explicitly in application SQL, not only in RLS', () => {
    expect(repository).toContain("t.scope <> 'private'");
    expect(repository).toContain('t.owner_user_id = CAST(${ctx.userId} AS uuid)');
  });

  it('makes published versions immutable in the database', () => {
    expect(migration).toContain('prevent_outreach_v3_published_template_mutation');
    expect(migration).toContain("OLD.lifecycle = 'published'");
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON outreach_v3_template_versions');
  });

  it('makes applications, provenance, and the audit log append-only by trigger and by grant', () => {
    expect(migration).toContain('prevent_outreach_v3_append_only_mutation');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON outreach_v3_template_applications');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON outreach_v3_session_template_provenance');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON outreach_v3_template_audit_log');
    expect(migration).toMatch(/GRANT SELECT, INSERT ON outreach_v3_template_applications/);
    expect(migration).not.toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON outreach_v3_template_applications/);
    expect(migration).not.toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON outreach_v3_session_template_provenance/);
  });

  it('binds version/application/provenance pointers to the same tenant AND template with composite FKs', () => {
    expect(migration).toContain('outreach_v3_template_versions_id_tenant_template_unique');
    expect(migration).toContain('outreach_v3_templates_draft_fk');
    expect(migration).toMatch(
      /FOREIGN KEY \(current_draft_version_id, tenant_id, id\)\s*\n\s*REFERENCES outreach_v3_template_versions\(id, tenant_id, template_id\)/,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \(published_version_id, tenant_id, id\)\s*\n\s*REFERENCES outreach_v3_template_versions\(id, tenant_id, template_id\)/,
    );
    expect(migration).toContain('outreach_v3_template_applications_id_tenant_tv_unique');
    expect(migration).toContain('outreach_v3_template_applications_version_fk');
    expect(migration).toContain('outreach_v3_session_template_provenance_application_fk');
  });

  it('binds client_id and source_session_id to the same tenant with composite FKs', () => {
    expect(migration).toContain('clients_id_tenant_unique');
    expect(migration).toContain('outreach_v3_templates_client_fk');
    expect(migration).toContain('outreach_v3_template_versions_source_session_fk');
    expect(migration).toContain('outreach_v3_template_applications_session_fk');
    expect(migration).toMatch(/REFERENCES outreach_sessions\(id, tenant_id\)/);
  });

  it('records an exact request fingerprint for idempotent replay, not just the template id', () => {
    expect(migration).toContain('request_fingerprint');
    expect(service).toContain('computeTemplateApplicationFingerprint');
    expect(service).toContain('requestFingerprint');
    expect(repository).toContain('isUniqueViolation');
  });

  it('records idempotent application and exact session provenance', () => {
    expect(migration).toContain('UNIQUE (tenant_id, applied_by_user_id, request_key)');
    expect(migration).toContain('outreach_v3_session_template_provenance');
    expect(service).toContain('findApplicationByRequestKey');
    expect(service).toContain('recordApplication');
    expect(service).toContain('replayed:');
  });

  it('routes application through the canonical command engine only', () => {
    expect(service).toContain('parseNormalizeAndValidateBatch');
    expect(service).toContain('applyBatchWithinTx');
    expect(service).not.toContain('INSERT INTO outreach_state_versions');
    expect(compiler).not.toMatch(/ADD_TARGET_REFS|ACCEPT_CONTEXT_REFS|SET_SENDER_REF|REQUEST_.*GENERATION/);
  });

  it('does not touch legacy outreach delivery tables', () => {
    for (const table of [
      'outreach_records',
      'outreach_draft_artifacts',
      'outreach_draft_versions',
      'outreach_send_intents',
      'outreach_deliveries',
    ]) {
      expect(migration).not.toContain(table);
      expect(service).not.toContain(table);
    }
  });

  it('enforces client authorization and source-to-destination scope on the server, not the browser', () => {
    expect(service).toContain('authorizeClient');
    expect(service).toContain('classifySourceScope');
    expect(service).toContain('assertDestinationScopeAllowed');
    expect(service).toContain('assertVersionSourceMatchesTemplateScope');
  });

  it('requires admin authority for firm/client publication and scope changes', () => {
    expect(service).toContain('assertSharedPublicationAuthority');
    expect(repository).toContain('lockManaged');
    // Private-scope rows stay owner-only even for admins in lockManaged().
    expect(repository).toMatch(/scope <> 'private'/);
  });

  it('never returns full template specs or style samples from the list endpoint', () => {
    expect(service).toContain('toTemplateCardSummary');
    expect(service).not.toContain('parseOutreachTemplateSpecV1(row.previewSpecJsonb)');
  });
});
