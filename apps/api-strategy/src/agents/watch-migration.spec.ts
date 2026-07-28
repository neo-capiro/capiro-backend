import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Scenario 20 (plan §8): "migration/RLS isolation". No local Postgres/Docker
 * is available in this environment (same constraint the Phase 2 migration
 * hit — see its own commit message), so this is NOT a live proof that RLS
 * actually isolates tenants. It is a static, best-effort guard: the migration
 * file that ships MUST contain the tenant-isolation policy for the new table,
 * matching every other sp_* migration's idiom exactly, and must not silently
 * drop it in a future edit. Real isolation is (and remains) the withTenant
 * query hook — see prisma.service.ts's own header comment.
 */

const MIGRATION_PATH = join(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20260727010000_sp_watch_consistency',
  'migration.sql',
);

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, 'utf8');
}

describe('20260727010000_sp_watch_consistency migration — static RLS/schema guard', () => {
  it('enables and FORCES row-level security on sp_watch_dismissal, with a tenant-isolation policy matching every prior sp_* migration', () => {
    const sql = readMigration();
    expect(sql).toMatch(/ALTER TABLE "sp_watch_dismissal" ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE "sp_watch_dismissal" FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(
      /CREATE POLICY "sp_watch_dismissal_isolation" ON "sp_watch_dismissal"\s+USING \(rls_bypass\(\) OR tenant_id = current_tenant_id\(\)\)\s+WITH CHECK \(rls_bypass\(\) OR tenant_id = current_tenant_id\(\)\)/,
    );
  });

  it('adds the permanent-suppression unique constraint scoped to (tenant, strategy, watch_key) — the invariant SpWatchDismissal.dismiss() relies on', () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "sp_watch_dismissal_tenant_id_strategy_id_watch_key_key" ON "sp_watch_dismissal"\("tenant_id", "strategy_id", "watch_key"\)/,
    );
  });

  it('adds the sp_change_set lineage columns and the superseded enum value additively (no DROP/ALTER of existing columns)', () => {
    const sql = readMigration();
    expect(sql).toMatch(/ALTER TYPE "sp_change_set_status" ADD VALUE IF NOT EXISTS 'superseded'/);
    for (const column of [
      'watch_key',
      'replaces_change_set_id',
      'superseded_by_change_set_id',
      'recheck_status',
      'superseded_reason',
    ]) {
      expect(sql).toContain(`"${column}"`);
    }
    // The rollback note documents DROP statements IN A COMMENT (matching
    // every other sp_* migration's idiom) — only the executable statements
    // must never drop anything.
    const executableSql = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(executableSql).not.toMatch(/DROP (TABLE|COLUMN)/);
  });
});
