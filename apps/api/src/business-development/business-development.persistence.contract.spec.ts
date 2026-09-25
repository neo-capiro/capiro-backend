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

const phase3MigrationPath = join(
  __dirname,
  '../../prisma/migrations/20280925010000_business_development_phase3_jev/migration.sql',
);
const phase3Migration = readFileSync(phase3MigrationPath, 'utf8');

const recoveryMigrationPath = join(
  __dirname,
  '../../prisma/migrations/20280926010000_business_development_phase3_shadow_null_recovery/migration.sql',
);
const recoveryMigration = readFileSync(recoveryMigrationPath, 'utf8');

const phase4MigrationPath = join(
  __dirname,
  '../../prisma/migrations/20280927010000_business_development_phase4_brief/migration.sql',
);
const phase4Migration = readFileSync(phase4MigrationPath, 'utf8');

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

// ── Phase 3 shadow SQL-NULL hotfix (20260926010000) ──────────────────────────

describe('migration: Phase 3 shadow invisibility CHECK is unchanged', () => {
  test('shadow_invisible_check still requires database NULL (mode=shadow ⇒ visible_effect_jsonb IS NULL)', () => {
    expect(phase3Migration).toContain(
      'CONSTRAINT "business_development_jev_decisions_shadow_invisible_check"',
    );
    expect(phase3Migration).toMatch(
      /business_development_jev_decisions_shadow_invisible_check"\s*CHECK \("mode" <> 'shadow' OR "visible_effect_jsonb" IS NULL\)/,
    );
  });
});

describe('migration: shadow SQL-NULL recovery scope is narrow', () => {
  test('recovery UPDATE targets ONLY the Jev decision trace table', () => {
    // Exactly one UPDATE statement, on the trace table, and no other table is
    // read or written (no FROM/JOIN against a user table, no second UPDATE;
    // catalog guards against pg_tables/pg_constraint are allowed).
    expect(recoveryMigration.match(/UPDATE "/g)).toHaveLength(1);
    expect(recoveryMigration).toContain('UPDATE "business_development_jev_decisions"');
    expect(recoveryMigration).not.toMatch(/\bFROM\s+"/);
    expect(recoveryMigration).not.toMatch(/\bJOIN\b/i);
    expect(recoveryMigration).not.toMatch(/\bINSERT INTO\b|\bDELETE FROM\b|\bTRUNCATE\b/i);
  });

  test('recovers ONLY sufficiently old shadow + pending rows', () => {
    expect(recoveryMigration).toMatch(/"mode" = 'shadow'/);
    expect(recoveryMigration).toMatch(/"status" = 'pending'/);
    // Sufficiently old guard: 10 minutes is far beyond the 8s provider
    // timeout plus the in-process completion write, so any older pending
    // shadow row is stranded, not in-flight.
    expect(recoveryMigration).toMatch(/"requested_at" < now\(\) - INTERVAL '10 minutes'/);
    // No status/mode value other than shadow/pending is targeted or written.
    expect(recoveryMigration).not.toMatch(/'internal_canary'/);
    expect(recoveryMigration).not.toMatch(/'completed'/);
  });

  test('recovery marks rows failed with an honest reason and stamps completion', () => {
    expect(recoveryMigration).toMatch(/"status"\s*=\s*'failed'/);
    expect(recoveryMigration).toMatch(/'completion_write_failed_shadow_sql_null'/);
    expect(recoveryMigration).toMatch(/"completed_at"\s*=\s*now\(\)/);
    expect(recoveryMigration).toMatch(/"updated_at"\s*=\s*now\(\)/);
  });

  test('idempotency keys move to a deterministic unique recovery namespace under 400 chars', () => {
    // Deterministic (depends only on the row id), unique, and namespace-
    // prefixed so a post-hotfix open can insert a fresh decision row.
    expect(recoveryMigration).toMatch(/"idempotency_key"\s*=\s*'[^']*'\s*\|\|\s*"id"::text/);
    // Recovery namespace prefix must differ from the live-key format
    // (tenant|task|mode|versions|hashes joined by '|', no fixed prefix).
    const prefixMatch = recoveryMigration.match(/'(shadow-null-completion-recovery-[0-9]+)\|'/);
    expect(prefixMatch).toBeTruthy();
    // prefix + '|' + uuid(36) stays far under VARCHAR(400).
    expect((prefixMatch?.[1]?.length ?? 400) + 1 + 36).toBeLessThan(400);
  });

  test('recovery is idempotent and guarded', () => {
    // Re-run is a no-op: recovered rows no longer match status = 'pending'.
    expect(recoveryMigration).toMatch(/WHERE "mode" = 'shadow'\s+AND "status" = 'pending'/);
    // Guarded by pg_tables/pg_constraint existence checks like the parent migration.
    expect(recoveryMigration).toMatch(
      /pg_tables WHERE tablename = 'business_development_jev_decisions'/,
    );
    expect(recoveryMigration).toMatch(
      /pg_constraint[\s\S]*?business_development_jev_decisions_shadow_invisible_check/,
    );
    expect(recoveryMigration).not.toMatch(/DELETE|DROP|TRUNCATE|INSERT|CREATE TABLE/i);
  });

  test('recovery never mutates prompts/source text (redaction invariant untouched)', () => {
    // The trace table stores only hashes/ids; the recovery must not widen it.
    for (const banned of [
      'envelope_hash',
      'source_ids',
      'source_hashes_jsonb',
      'candidate_inventory_hash',
    ]) {
      expect(recoveryMigration).not.toContain(`"${banned}"`);
    }
  });
});

describe('migration: Phase 4 versioned prospect briefs', () => {
  for (const table of ['business_development_briefs', 'business_development_brief_versions']) {
    test(`${table} is tenant isolated with forced RLS`, () => {
      expect(phase4Migration).toContain(`CREATE TABLE "${table}"`);
      expect(phase4Migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(phase4Migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(phase4Migration).toContain(`CREATE POLICY "${table}_isolation" ON "${table}"`);
    });
  }

  test('prospect and version relationships are tenant-safe', () => {
    expect(phase4Migration).toMatch(
      /FOREIGN KEY \("tenant_id", "prospect_id"\)[\s\S]*?REFERENCES "business_development_prospects"\("tenant_id", "id"\)/,
    );
    expect(phase4Migration).toMatch(
      /FOREIGN KEY \("tenant_id", "brief_id"\)[\s\S]*?REFERENCES "business_development_briefs"\("tenant_id", "id"\)/,
    );
  });

  test('current version must belong to the same brief', () => {
    expect(phase4Migration).toContain('UNIQUE ("tenant_id", "id", "brief_id")');
    expect(phase4Migration).toMatch(
      /FOREIGN KEY \("tenant_id", "current_version_id", "id"\)[\s\S]*?REFERENCES "business_development_brief_versions"\("tenant_id", "id", "brief_id"\)/,
    );
  });

  test('versions are insert-only for the application role and idempotent', () => {
    expect(phase4Migration).toContain(
      'GRANT SELECT, INSERT ON "business_development_brief_versions" TO capiro_app',
    );
    expect(phase4Migration).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON "business_development_brief_versions" FROM capiro_app',
    );
    expect(phase4Migration).toContain(
      'ON "business_development_brief_versions"("tenant_id", "brief_id", "idempotency_key")',
    );
    expect(phase4Migration).toMatch(/CHECK \("idempotency_op" IN \('create', 'edit', 'accept'\)\)/);
  });

  test('Prisma schema maps the stable root and immutable versions', () => {
    expect(schema).toContain('model BusinessDevelopmentBrief {');
    expect(schema).toContain('model BusinessDevelopmentBriefVersion {');
    expect(schema).toContain('@@unique([tenantId, id, briefId]');
    expect(schema).toContain('idempotencyFingerprint');
  });
});
