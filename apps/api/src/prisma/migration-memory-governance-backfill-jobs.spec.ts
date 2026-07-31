import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Phase 11 governance backfill migration', () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260814010000_memory_governance_backfill_jobs/migration.sql',
    ),
    'utf8',
  );

  it('adds a tenant-scoped prepared-job header and exact row snapshots', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS memory_governance_backfill_job');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS memory_governance_backfill_row');
    expect(sql).toContain('before_state_jsonb jsonb NOT NULL');
    expect(sql).toContain('expected_post_state_jsonb jsonb NOT NULL');
    expect(sql).toContain('before_hash varchar(64) NOT NULL');
    expect(sql).toContain('expected_post_hash varchar(64) NOT NULL');
    expect(sql).toContain("'execute_blocked_drift'");
    expect(sql).toContain("'rollback_partial'");
  });

  it('keeps backfill evidence append-only and bounded', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS memory_governance_backfill_event');
    expect(sql).toContain('reject_memory_governance_backfill_event_mutation');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON memory_governance_backfill_event');
    expect(sql).toContain('memory_governance_backfill_event_metadata_size_check');
    expect(sql).toContain("'row_skipped_drift'");
    expect(sql).toContain("'later_changes_preserved'").toBe(false);
  });

  it('forces row-level tenant isolation on every Phase 11 control table', () => {
    for (const table of [
      'memory_governance_backfill_job',
      'memory_governance_backfill_row',
      'memory_governance_backfill_event',
    ]) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`CREATE POLICY ${table}_tenant_isolation`);
    }
  });

  it('is additive and does not perform a backfill during migration replay', () => {
    expect(sql).not.toMatch(/UPDATE\s+memory_items/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+memory_items/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+memory_items/i);
  });
});
