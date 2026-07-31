import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Phase 11 governance backfill delete guards', () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260814011000_memory_governance_backfill_delete_guards/migration.sql',
    ),
    'utf8',
  );

  it('blocks direct deletion of prepared jobs and row snapshots', () => {
    expect(sql).toContain('reject_memory_governance_backfill_control_delete');
    expect(sql).toContain('BEFORE DELETE ON memory_governance_backfill_job');
    expect(sql).toContain('BEFORE DELETE ON memory_governance_backfill_row');
    expect(sql).toContain('memory_governance_backfill_control_delete_forbidden');
  });

  it('retains append-only evidence while permitting a nested tenant purge cascade', () => {
    expect(sql).toContain("TG_OP = 'DELETE' AND pg_trigger_depth() > 1");
    expect(sql).toContain('memory_governance_backfill_event_append_only');
    expect(sql).not.toMatch(/UPDATE\s+memory_items/i);
  });
});
