import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function apiRoot(): string {
  const cwd = process.cwd();
  return existsSync(resolve(cwd, 'prisma')) ? cwd : resolve(cwd, 'apps/api');
}

const root = apiRoot();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Outreach V3 template persistence authority', () => {
  const migration = read('prisma/migrations/20260822010000_outreach_v3_templates/migration.sql');
  const service = read('src/outreach-v3/templates/outreach-template.service.ts');
  const compiler = read('src/outreach-v3/templates/outreach-template.compiler.ts');

  it('uses forced tenant RLS and private-owner isolation', () => {
    expect(migration).toContain('ALTER TABLE outreach_v3_templates FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("current_setting('app.current_firm_id', true)");
    expect(migration).toContain("current_setting('app.current_user_id', true)");
    expect(migration).toContain("scope <> 'private'");
  });

  it('makes published versions immutable in the database', () => {
    expect(migration).toContain('prevent_outreach_v3_published_template_mutation');
    expect(migration).toContain("OLD.lifecycle = 'published'");
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON outreach_v3_template_versions');
  });

  it('records idempotent application and exact session provenance', () => {
    expect(migration).toContain('UNIQUE (tenant_id, applied_by_user_id, request_key)');
    expect(migration).toContain('outreach_v3_session_template_provenance');
    expect(service).toContain('findApplicationByRequestKey');
    expect(service).toContain('recordApplication');
    expect(service).toContain('replayed: true');
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
});
