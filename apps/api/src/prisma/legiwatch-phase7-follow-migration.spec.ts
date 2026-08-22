import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_DIR = '20261123020000_legiwatch_phase7_following';

function code(): string {
  return readFileSync(
    join(__dirname, '../../prisma/migrations', MIGRATION_DIR, 'migration.sql'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n\r]*/g, '');
}

describe('LegiWatch Phase 7 follow-state migration', () => {
  it('creates a separate tenant follow table instead of overloading capture demand', () => {
    const text = code();
    expect(text).toContain('CREATE TABLE IF NOT EXISTS "hearing_follow"');
    expect(text).not.toContain('ALTER TABLE "hearing_subscription"');
    expect(text).toContain('"hearing_id" TEXT NOT NULL');
    expect(text).toContain('"notify_on_updates" BOOLEAN NOT NULL DEFAULT true');
  });

  it('enforces one follow row per tenant user and canonical hearing', () => {
    expect(code()).toContain(
      'ON "hearing_follow" ("tenant_id", "user_id", "hearing_id")',
    );
  });

  it('forces canonical tenant RLS and cascades tenant deletion', () => {
    const text = code();
    expect(text).toContain('ALTER TABLE "hearing_follow" ENABLE ROW LEVEL SECURITY;');
    expect(text).toContain('ALTER TABLE "hearing_follow" FORCE ROW LEVEL SECURITY;');
    expect(text).toContain('CREATE POLICY "hearing_follow_isolation" ON "hearing_follow"');
    expect(text).toContain('USING (rls_bypass() OR tenant_id = current_tenant_id())');
    expect(text).toContain('WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id())');
    expect(text).toContain(
      'FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE',
    );
  });

  it('is additive and never mutates canonical hearing or capture history', () => {
    const text = code();
    expect(text).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(text).not.toMatch(/\bUPDATE\s+"?(committee_hearing|public_hearing_capture)"?/i);
    expect(text).not.toMatch(/\bDELETE\s+FROM\s+"?(committee_hearing|public_hearing_capture)"?/i);
  });
});
