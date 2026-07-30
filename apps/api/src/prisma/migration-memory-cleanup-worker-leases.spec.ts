import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260812020000_memory_cleanup_worker_leases/migration.sql',
  ),
  'utf8',
);

describe('memory cleanup worker lease migration', () => {
  test('adds expiring lease and terminal dead-letter columns', () => {
    expect(migration).toContain('lease_owner varchar(80)');
    expect(migration).toContain('lease_expires_at timestamptz');
    expect(migration).toContain('dead_lettered_at timestamptz');
    expect(migration).toContain("'dead_letter'");
  });

  test('enforces that only running rows may hold a lease', () => {
    expect(migration).toContain('memory_cleanup_lease_state_check');
    expect(migration).toContain("status = 'running' AND lease_owner IS NOT NULL");
    expect(migration).toContain("status <> 'running' AND lease_owner IS NULL");
  });

  test('indexes due, stale-running, and dead-letter scans', () => {
    expect(migration).toContain('memory_cleanup_outbox_worker_due_idx');
    expect(migration).toContain("status IN ('pending','failed','running')");
    expect(migration).toContain('memory_cleanup_outbox_dead_letter_idx');
  });
});
