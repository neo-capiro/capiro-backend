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
    'prisma/migrations/20261120140000_entity_identity_governance/migration.sql',
  ),
  'utf8',
);
const concurrencyMigration = readFileSync(
  repositoryPath(
    'prisma/migrations/20261120141000_entity_governance_concurrency/migration.sql',
  ),
  'utf8',
);
const repository = readFileSync(
  repositoryPath(
    'src/knowledge/entities/entity-identity-governance.repository.ts',
  ),
  'utf8',
);

describe('entity identity governance contract', () => {
  test('adds an append-only tenant-scoped governance ledger', () => {
    expect(migration).toContain(
      'CREATE TABLE "entity_identity_governance_events"',
    );
    expect(migration).toContain(
      'ALTER TABLE "entity_identity_governance_events" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain('Entity identity governance events are append-only');
    expect(migration).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE\n  ON TABLE "entity_identity_governance_events" FROM capiro_app',
    );
  });

  test('removes direct application mutation of aliases and identifiers', () => {
    expect(migration).toContain(
      'REVOKE UPDATE ON TABLE "entity_aliases" FROM capiro_app',
    );
    expect(migration).toContain(
      'REVOKE UPDATE ON TABLE "entity_identifiers" FROM capiro_app',
    );
    expect(migration).toContain('govern_entity_alias');
    expect(migration).toContain('govern_entity_identifier');
  });

  test('governance functions fail closed to tenant-private links', () => {
    expect(migration).toContain("identity_scope = 'tenant_private'");
    expect(migration).toContain('Entity governance action cannot cross tenants');
    expect(migration).toContain('Only an active entity alias may be governed');
    expect(migration).toContain('Only an active entity identifier may be governed');
  });

  test('serializes duplicate simultaneous governance retries', () => {
    expect(concurrencyMigration).toContain('pg_advisory_xact_lock');
    expect(concurrencyMigration).toContain(
      "p_tenant_id::text || ':' || p_idempotency_key",
    );
    expect(concurrencyMigration.match(/pg_advisory_xact_lock/g)?.length).toBe(2);
  });

  test('resolution rejection is append-only and repeats tenant predicates', () => {
    expect(repository).toContain("'rejected'");
    expect(repository).toContain("'user_rejected'");
    expect(repository).toContain('WHERE tenant_id = ${tenantId}::uuid');
    expect(repository).not.toMatch(/\n\s+async\s+(update|delete|remove)\s*\(/);
  });
});
