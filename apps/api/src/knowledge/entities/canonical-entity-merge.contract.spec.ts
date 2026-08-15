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

const migration = readFileSync(
  repositoryPath(
    'prisma/migrations/20261120120000_canonical_entity_merge_ledger/migration.sql',
  ),
  'utf8',
);
const repository = readFileSync(
  repositoryPath('src/knowledge/entities/canonical-entity-registration.repository.ts'),
  'utf8',
);
const rehearsal = readFileSync(
  repositoryPath('../../scripts/verify-entity-resolution-migration.sh'),
  'utf8',
);

describe('canonical entity merge lineage contract', () => {
  test('creates an append-only tenant-scoped merge ledger', () => {
    expect(migration).toContain('CREATE TABLE "canonical_entity_merges"');
    expect(migration).toContain(
      'ALTER TABLE "canonical_entity_merges" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain('canonical_entity_merges_reject_mutation');
    expect(migration).toContain('REVOKE UPDATE, DELETE, TRUNCATE');
  });

  test('requires a valid same-type visible target and recorded lineage', () => {
    expect(migration).toContain(
      'Merge source must be an active tenant-private entity in this tenant',
    );
    expect(migration).toContain(
      'Merge target must be an active entity visible to this tenant',
    );
    expect(migration).toContain(
      'Canonical entity merge requires matching entity types',
    );
    expect(migration).toContain(
      'Canonical entity merge requires append-only merge lineage',
    );
  });

  test('withdraws and re-appends source identity links rather than retargeting history', () => {
    expect(repository).toContain("SET status = 'withdrawn'");
    expect(repository).toContain('INSERT INTO entity_aliases');
    expect(repository).toContain('INSERT INTO entity_identifiers');
    expect(repository).toContain('INSERT INTO canonical_entity_merges');
    expect(repository).toContain("SET status = 'merged'");
    expect(repository).not.toMatch(/UPDATE entity_(aliases|identifiers)[\s\S]{0,200}SET entity_id/i);
  });

  test('rehearses missing-lineage, cross-type, cross-tenant, and immutability failures', () => {
    expect(rehearsal).toContain('merge without lineage unexpectedly committed');
    expect(rehearsal).toContain('cross-type merge unexpectedly committed');
    expect(rehearsal).toContain('cross-tenant merge unexpectedly committed');
    expect(rehearsal).toContain('immutable merge lineage unexpectedly updated');
    expect(rehearsal).toContain('immutable merge lineage unexpectedly deleted');
  });
});
