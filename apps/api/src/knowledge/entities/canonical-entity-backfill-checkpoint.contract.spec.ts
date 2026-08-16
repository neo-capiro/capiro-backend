import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';

function repositoryPath(relativePath: string): string {
  const candidates = [
    join(process.cwd(), relativePath),
    join(process.cwd(), 'apps/api', relativePath),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Could not resolve repository path: ${relativePath}`);
  return found;
}

const repository = readFileSync(
  repositoryPath('src/knowledge/entities/canonical-entity-backfill-checkpoint.repository.ts'),
  'utf8',
);
const migration = readFileSync(
  repositoryPath(
    'prisma/migrations/20261120143000_canonical_entity_backfill_checkpoints/migration.sql',
  ),
  'utf8',
);

describe('canonical entity backfill checkpoint contract', () => {
  test('every mutation goes through the RLS-bypass system scope, never a bare query', () => {
    const withSystemCount = (repository.match(/this\.prisma\.withSystem/g) ?? []).length;
    expect(withSystemCount).toBeGreaterThanOrEqual(3); // find, startOrResume, recordPage
  });

  test('accumulates counters instead of overwriting them, so resumed pages add on top of prior progress', () => {
    expect(repository).toContain('scanned = scanned + ${page.scanned}');
    expect(repository).toContain('created = created + ${page.created}');
    expect(repository).toContain('failed = failed + ${page.failed}');
  });

  test('starting a run is idempotent and never clobbers an in-flight or terminal checkpoint', () => {
    expect(repository).toContain('DO NOTHING');
    expect(repository).not.toMatch(/ON CONFLICT[^;]*DO UPDATE/i);
  });

  test('distinguishes the global (NULL tenant) scope from a tenant scope in every query', () => {
    expect(repository).toContain('tenant_id IS NULL');
    expect(repository).toContain('tenant_id = ${tenantId}::uuid');
  });

  test('the migration enforces terminal-state integrity and resumable uniqueness in SQL, not just app code', () => {
    expect(migration).toMatch(/CHECK\s*\(\s*"status"\s+IN\s*\('running',\s*'completed',\s*'failed'\)\s*\)/);
    expect(migration).toContain('canonical_entity_backfill_checkpoints_terminal_state_check');
    expect(migration).toContain('reject_completed_canonical_entity_backfill_checkpoint_mutation');
    expect(migration).toContain('canonical_entity_backfill_checkpoints_global_source_unique');
    expect(migration).toContain('canonical_entity_backfill_checkpoints_tenant_source_unique');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
  });

  test('the migration never allows deleting checkpoint evidence', () => {
    expect(migration).toContain('canonical_entity_backfill_checkpoints_no_delete');
    expect(migration).toMatch(/FOR DELETE\s*\n\s*USING \(false\)/);
  });
});
