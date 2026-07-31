import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Phase 13 memory candidate withdrawal migration', () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260815010000_memory_candidate_withdrawal/migration.sql',
    ),
    'utf8',
  );

  it('adds withdrawn as a distinct legacy candidate status', () => {
    expect(sql).toContain("'withdrawn'");
    expect(sql).toContain('memory_candidate_status_check');
    expect(sql).toContain('auto_committed');
    expect(sql).toContain('withdrawn is proposer-initiated');
  });

  it('drops only the legacy status check and leaves governed status untouched', () => {
    expect(sql).toContain("pg_get_constraintdef(oid) ILIKE '%auto_committed%'");
    expect(sql).not.toMatch(/DROP\s+CONSTRAINT\s+memory_candidate_governed_status_check/i);
  });

  it('adds a proposer pending index and performs no candidate or memory rewrite', () => {
    expect(sql).toContain('memory_candidate_proposer_pending_idx');
    expect(sql).toContain("WHERE status = 'pending'");
    expect(sql).not.toMatch(/UPDATE\s+memory_candidate/i);
    expect(sql).not.toMatch(/UPDATE\s+memory_items/i);
  });
});
