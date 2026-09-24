import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Persistence contract for Business Development Phase 1 — source/contract
 * assertions against the migration SQL and the Prisma schema. This does NOT
 * prove runtime RLS behavior (the root orchestrator runs a disposable
 * real-Postgres acceptance harness for that); it pins the shape of the
 * migration so a regression here is caught before it ever reaches a database.
 */

const migrationPath = join(
  __dirname,
  '../../prisma/migrations/20280924010000_business_development_phase1/migration.sql',
);
const migration = readFileSync(migrationPath, 'utf8');

const schemaPath = join(__dirname, '../../prisma/schema.prisma');
const schema = readFileSync(schemaPath, 'utf8');

describe('migration: three new tenant tables', () => {
  for (const table of [
    'business_development_prospects',
    'business_development_prospect_activity',
    'business_development_preferences',
  ]) {
    test(`CREATE TABLE "${table}"`, () => {
      expect(migration).toMatch(new RegExp(`CREATE TABLE "${table}"`));
    });
    test(`tenant_id FK → tenants(id) ON DELETE CASCADE`, () => {
      expect(migration).toMatch(
        new RegExp(
          `CONSTRAINT "${table}_tenant_fkey"[\\s\\S]*?REFERENCES "tenants"\\("id"\\) ON DELETE CASCADE`,
        ),
      );
    });
    test(`FORCE ROW LEVEL SECURITY + isolation policy`, () => {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`CREATE POLICY "${table}_isolation" ON "${table}"`);
      expect(migration).toMatch(
        new RegExp(
          `CREATE POLICY "${table}_isolation"[\\s\\S]*?USING \\(rls_bypass\\(\\) OR tenant_id = current_tenant_id\\(\\)\\)`,
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `CREATE POLICY "${table}_isolation"[\\s\\S]*?WITH CHECK \\(rls_bypass\\(\\) OR tenant_id = current_tenant_id\\(\\)\\)`,
        ),
      );
    });
  }
});

describe('migration: partial unique indexes', () => {
  test('one prospect per (tenant, canonical) INCLUDING dismissed rows', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "business_development_prospects_tenant_canonical_key"',
    );
    expect(migration).toMatch(
      /business_development_prospects_tenant_canonical_key"[\s\S]*?WHERE "canonical_entity_id" IS NOT NULL/,
    );
  });

  test('at most one prospect per linked client', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX "business_development_prospects_client_key"');
    expect(migration).toMatch(
      /business_development_prospects_client_key"[\s\S]*?WHERE "linked_client_id" IS NOT NULL/,
    );
  });

  test('at most one client per (tenant, canonical) when stamped', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX "clients_tenant_canonical_entity_key"');
    expect(migration).toMatch(
      /clients_tenant_canonical_entity_key"[\s\S]*?WHERE "canonical_entity_id" IS NOT NULL/,
    );
  });
});

describe('migration: CHECK constraints', () => {
  test('stage enum check matches BIZDEV_STAGES exactly', () => {
    const match = migration.match(
      /business_development_prospects_stage_check"\s*CHECK \("stage" IN \(([^)]*)\)\)/,
    );
    expect(match).toBeTruthy();
    const values = (match![1] as string).split(',').map((s) => s.trim().replace(/'/g, ''));
    expect([...values].sort()).toEqual(
      [
        'researching',
        'qualified',
        'outreach',
        'meeting',
        'proposal',
        'won',
        'lost',
        'parked',
      ].sort(),
    );
  });

  test('status enum check is active|dismissed', () => {
    expect(migration).toMatch(
      /business_development_prospects_status_check"\s*CHECK \("status" IN \('active', 'dismissed'\)\)/,
    );
  });

  test('dismissed ⇔ dismissed_at consistency check', () => {
    expect(migration).toContain(
      'CHECK (("status" = \'dismissed\') = ("dismissed_at" IS NOT NULL))',
    );
  });

  test('activity kind check includes identity and watch', () => {
    const match = migration.match(
      /business_development_prospect_activity_kind_check"\s*CHECK \("kind" IN \(([^)]*)\)\)/,
    );
    expect(match).toBeTruthy();
    const kinds = (match![1] as string).split(',').map((s) => s.trim().replace(/'/g, ''));
    for (const kind of [
      'note',
      'stage',
      'owner',
      'dismiss',
      'restore',
      'conflict',
      'watch',
      'convert',
      'identity',
    ]) {
      expect(kinds).toContain(kind);
    }
  });
});

describe('migration: grants and additive client column', () => {
  test('capiro_app granted DML on all three tables (guarded)', () => {
    expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON[\s\S]*?TO capiro_app/);
  });

  test('clients.canonical_entity_id added nullable with FK (idempotent guard)', () => {
    expect(migration).toContain('ALTER TABLE "clients"\n  ADD COLUMN "canonical_entity_id" UUID;');
    expect(migration).toContain('clients_canonical_entity_fkey');
  });
});

describe('schema: model/FK consistency with the migration', () => {
  test('BusinessDevelopmentProspect maps tenant FK with cascade', () => {
    expect(schema).toMatch(
      /model BusinessDevelopmentProspect[\s\S]*?tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade\)/,
    );
  });

  test('activity prospect FK cascades (history dies with its prospect)', () => {
    expect(schema).toMatch(
      /prospect BusinessDevelopmentProspect @relation\(fields: \[prospectId\], references: \[id\], onDelete: Cascade, map: "business_development_prospect_activity_prospect_fkey"\)/,
    );
  });

  test('Client.canonicalEntityId exists additively', () => {
    // The (tenant, canonical) uniqueness is SQL-OWNED (partial unique index,
    // not expressible in Prisma) — the schema documents it and maps the FK.
    expect(schema).toMatch(
      /canonicalEntityId\s+String\?\s+@map\("canonical_entity_id"\) @db\.Uuid/,
    );
    expect(schema).toMatch(
      /canonicalEntity\s+CanonicalEntity\?\s+@relation\("ClientCanonicalEntity", fields: \[canonicalEntityId\], references: \[id\], onDelete: Restrict, map: "clients_canonical_entity_fkey"\)/,
    );
    expect(schema).toMatch(/SQL partial unique index clients_tenant_canonical_entity_key/);
  });

  test('prospects partial uniques documented as SQL-owned in the model', () => {
    expect(schema).toMatch(
      /model BusinessDevelopmentProspect[\s\S]*?\/\/ SQL-owned partial uniques: \(tenant_id, canonical_entity_id\) WHERE NOT NULL[\s\S]*?and linked_client_id WHERE NOT NULL\./,
    );
  });

  test('schema column names map 1:1 onto the migration DDL', () => {
    for (const col of [
      'canonical_entity_id',
      'display_name',
      'owner_user_id',
      'dismissed_at',
      'conflict_excluded',
      'conflict_reason',
      'next_action',
      'next_action_due_at',
      'linked_client_id',
      'converted_at',
      'watch_requested',
      'created_by_user_id',
    ]) {
      expect(schema).toContain(`@map("${col}")`);
      expect(migration).toContain(`"${col}"`);
    }
  });
});
