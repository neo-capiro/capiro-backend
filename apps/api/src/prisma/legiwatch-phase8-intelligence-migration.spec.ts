import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_DIR = '20261123030000_legiwatch_phase8_live_intelligence';

function sql(): string {
  return readFileSync(
    join(__dirname, '../../prisma/migrations', MIGRATION_DIR, 'migration.sql'),
    'utf8',
  );
}

function code(): string {
  return sql()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n\r]*/g, '');
}

describe('LegiWatch Phase 8 live-intelligence migration', () => {
  it('creates a tenant-free global public insight rail', () => {
    const text = code();
    expect(text).toContain('CREATE TABLE IF NOT EXISTS "public_hearing_insight"');
    const start = text.indexOf('CREATE TABLE IF NOT EXISTS "public_hearing_insight"');
    const end = text.indexOf('\n);', start);
    expect(text.slice(start, end)).not.toContain('"tenant_id"');
    expect(text).not.toContain(
      'ALTER TABLE "public_hearing_insight" ENABLE ROW LEVEL SECURITY',
    );
    expect(text).toContain(
      'FOREIGN KEY ("segment_id") REFERENCES "public_hearing_transcript_segment"("id") ON DELETE CASCADE',
    );
  });

  it('pins the complete supported insight vocabulary and confidence range', () => {
    const text = code();
    for (const type of [
      'QUESTION',
      'COMMITMENT',
      'DEADLINE',
      'FUNDING_AMOUNT',
      'BILL_REFERENCE',
      'PROGRAM_ELEMENT_REFERENCE',
      'AGENCY_REFERENCE',
      'POLICY_POSITION',
      'KEY_QUOTE',
      'MENTION',
    ]) {
      expect(text).toContain(`'${type}'`);
    }
    expect(text).toContain('confidence >= 0 AND confidence <= 1');
  });

  it('creates separate durable public and tenant queues with bounded lease state', () => {
    const text = code();
    expect(text).toContain('CREATE TABLE IF NOT EXISTS "public_hearing_intelligence_job"');
    expect(text).toContain('CONSTRAINT "public_hearing_intelligence_job_segment_key" UNIQUE ("segment_id")');
    expect(text).toContain('CREATE INDEX IF NOT EXISTS "public_hearing_intelligence_job_claim_idx"');
    expect(text).toContain('CREATE TABLE IF NOT EXISTS "tenant_hearing_relevance_job"');
    expect(text).toContain('CREATE INDEX IF NOT EXISTS "tenant_hearing_relevance_job_claim_idx"');
    expect(text.match(/status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL/g)?.length).toBe(2);
  });

  it('enqueues only final canonical transcript segments and backfills existing finals', () => {
    const text = code();
    expect(text).toContain('IF NEW.is_final IS DISTINCT FROM true THEN');
    expect(text).toContain('public_hearing_transcript_segment_intelligence_enqueue');
    expect(text).toContain('WHERE s.is_final = true');
    expect(text).toContain('ON CONFLICT (segment_id) DO NOTHING');
  });

  it('never steals an active public extraction lease when a transcript revision arrives', () => {
    const text = code();
    expect(text).toContain("WHEN public_hearing_intelligence_job.status = 'leased'");
    expect(text).toContain("THEN 'leased'");
    expect(text).toContain(
      'public_hearing_intelligence_job.segment_revision <> EXCLUDED.segment_revision',
    );
    expect(text).toContain('THEN public_hearing_intelligence_job.lease_owner');
    expect(text).toContain('THEN public_hearing_intelligence_job.lease_expires_at');
  });

  it('FORCEs tenant isolation on relevance and tenant jobs', () => {
    const text = code();
    for (const table of ['tenant_hearing_relevance', 'tenant_hearing_relevance_job']) {
      expect(text).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(text).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      expect(text).toContain(`CREATE POLICY "${table}_isolation" ON "${table}"`);
    }
    expect(text.match(/USING \(rls_bypass\(\) OR tenant_id = current_tenant_id\(\)\)/g)?.length).toBe(2);
    expect(text.match(/WITH CHECK \(rls_bypass\(\) OR tenant_id = current_tenant_id\(\)\)/g)?.length).toBe(2);
  });

  it('keeps public truth and tenant relevance structurally separate', () => {
    const text = code();
    expect(text).toContain(
      'FOREIGN KEY ("insight_id") REFERENCES "public_hearing_insight"("id") ON DELETE CASCADE',
    );
    expect(text).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "tenant_hearing_relevance_tenant_client_insight_key"',
    );
    expect(text).not.toMatch(/ALTER TABLE\s+"public_hearing_insight"[\s\S]*tenant_id/i);
  });

  it('is additive and never mutates canonical transcript content', () => {
    const text = code();
    expect(text).not.toMatch(/DROP\s+TABLE/i);
    expect(text).not.toMatch(/DROP\s+COLUMN/i);
    expect(text).not.toMatch(/UPDATE\s+"public_hearing_transcript_segment"/i);
    expect(text).not.toMatch(/DELETE\s+FROM\s+"public_hearing_transcript_segment"/i);
  });
});
