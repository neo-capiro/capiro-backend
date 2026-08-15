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
    'prisma/migrations/20261120100000_universal_entity_resolution/migration.sql',
  ),
  'utf8',
);

describe('Universal Entity Resolution migration contract', () => {
  test('creates one canonical registry and append-only resolution ledger', () => {
    expect(migration).toContain('CREATE TABLE "canonical_entities"');
    expect(migration).toContain('CREATE TABLE "entity_aliases"');
    expect(migration).toContain('CREATE TABLE "entity_identifiers"');
    expect(migration).toContain('CREATE TABLE "entity_resolutions"');
    expect(migration).toContain('EntityResolution is append-only; record a correction instead');
    expect(migration).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "entity_resolutions"');
  });

  test('separates reusable public identity from tenant-private identity', () => {
    expect(migration).toContain('"identity_scope" = \'global_public\' AND "tenant_id" IS NULL');
    expect(migration).toContain('"identity_scope" = \'tenant_private\' AND "tenant_id" IS NOT NULL');
    expect(migration).toContain('Tenant-private identity links cannot cross tenants');
    expect(migration).toContain('Selected canonical entity is not visible to this tenant');
  });

  test('supports deterministic identifiers without forcing names to be unique', () => {
    expect(migration).toContain('entity_identifiers_global_identity_unique');
    expect(migration).toContain('entity_identifiers_tenant_identity_unique');
    expect(migration).toContain('"identifier_type"');
    expect(migration).toContain('"normalized_value"');
    expect(migration).not.toContain('UNIQUE ("normalized_name")');
  });

  test('forces RLS and retains explicit tenant predicates in the repository', () => {
    for (const table of [
      'canonical_entities',
      'entity_aliases',
      'entity_identifiers',
      'entity_resolutions',
    ]) {
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }

    const repository = readFileSync(
      repositoryPath('src/knowledge/entities/canonical-entity.repository.ts'),
      'utf8',
    );
    expect(repository).toContain('entity.tenant_id = ${tenantId}::uuid');
    expect(repository).toContain('identifier.tenant_id = ${tenantId}::uuid');
    expect(repository).toContain('WHERE tenant_id = ${tenantId}::uuid');
    expect(repository).not.toMatch(/\n\s+async\s+(delete|remove)\s*\(/);
  });

  test('keeps actor identity as an audit UUID rather than a mutable user relation', () => {
    expect(migration).toContain('"actor_user_id" UUID');
    expect(migration).not.toContain('entity_resolutions_actor_user_fkey');
  });
});
