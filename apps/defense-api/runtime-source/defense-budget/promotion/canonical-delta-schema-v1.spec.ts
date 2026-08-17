/**
 * Phase 7 Workstream L — the drain and delta migration's guarantees are in the
 * SQL, not only in the runbook.
 *
 * Companion to `canonical-promotion-schema-v1.spec.ts`, which does the same job
 * for Workstream D. The behavioural proof is the disposable-PostgreSQL
 * rehearsal; this is the always-on gate that turns deleting a constraint into a
 * test failure rather than a silent loss of a property.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_DIR = '20260902010000_pe_budget_phase7_outbox_drain';

const migrationSql = readFileSync(
  join(__dirname, '..', '..', '..', 'prisma', 'migrations', MIGRATION_DIR, 'migration.sql'),
  'utf8',
);

const schemaPrisma = readFileSync(
  join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'),
  'utf8',
);

describe('Phase 7 WS L — tables and models', () => {
  it('creates the pause state and the canonical delta', () => {
    expect(migrationSql).toContain('CREATE TABLE "defense_budget_side_effect_drain_pause"');
    expect(migrationSql).toContain('CREATE TABLE "defense_budget_canonical_delta"');
  });

  it('exposes both to Prisma with a matching @@map', () => {
    expect(schemaPrisma).toContain('@@map("defense_budget_side_effect_drain_pause")');
    expect(schemaPrisma).toContain('@@map("defense_budget_canonical_delta")');
  });

  it('gives the outbox the attempt instant its backoff is measured from', () => {
    expect(migrationSql).toContain(
      'ALTER TABLE "defense_budget_promotion_outbox"\n  ADD COLUMN "last_attempted_at" TIMESTAMPTZ(6)',
    );
    expect(schemaPrisma).toContain('@map("last_attempted_at")');
  });

  it('keeps the ALTER out of the additive Workstream D migration', () => {
    // 20260822010000 is gated as purely additive by an architecture test. A
    // column on a table it created belongs in its own migration, exactly as
    // Workstream K's queue link does.
    const additive = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        'prisma',
        'migrations',
        '20260822010000_pe_budget_phase7_canonical_promotion',
        'migration.sql',
      ),
      'utf8',
    );
    expect(additive).not.toContain('last_attempted_at');
  });

  it('performs no data backfill', () => {
    expect(migrationSql).not.toMatch(/\bINSERT\s+INTO\b/i);
  });
});

describe('Phase 7 WS L — the pause state', () => {
  it('permits one state per domain and environment', () => {
    expect(migrationSql).toContain(
      '"defense_budget_side_effect_drain_pause_scope_unique"\n        UNIQUE ("domain", "environment")',
    );
  });

  it('refuses a paused row that claims to have been resumed', () => {
    expect(migrationSql).toContain('"defense_budget_side_effect_drain_pause_resume_check"');
    expect(migrationSql).toContain(
      `CHECK (("paused" = true AND "resumed_at" IS NULL AND "resumed_by" IS NULL)`,
    );
  });

  it('requires a non-empty reason', () => {
    expect(migrationSql).toContain(`CHECK (btrim("reason") <> '')`);
  });
});

describe('Phase 7 WS L — the canonical delta', () => {
  it('permits one delta per outbox row and one per delta key', () => {
    expect(migrationSql).toContain(
      '"defense_budget_canonical_delta_key_unique" UNIQUE ("delta_key")',
    );
    expect(migrationSql).toContain(
      '"defense_budget_canonical_delta_outbox_unique" UNIQUE ("outbox_id")',
    );
  });

  it('stores every value axis as exact NUMERIC and no approximate type anywhere', () => {
    expect(migrationSql).toContain('"old_money_value_millions" NUMERIC(24, 9)');
    expect(migrationSql).toContain('"money_delta_millions" NUMERIC(24, 9)');
    expect(migrationSql).toContain('"old_quantity" NUMERIC(24, 9)');
    expect(migrationSql).toContain('"old_unit_cost_dollars" NUMERIC(24, 9)');
    expect(migrationSql).not.toMatch(/\b(DOUBLE PRECISION|REAL|FLOAT4|FLOAT8)\b/i);
  });

  it('keeps money a pair on each side', () => {
    expect(migrationSql).toContain(
      'num_nonnulls("old_money_original_value", "old_money_value_millions") IN (0, 2)',
    );
    expect(migrationSql).toContain(
      'num_nonnulls("new_money_original_value", "new_money_value_millions") IN (0, 2)',
    );
  });

  it('refuses a difference with only one side to difference from', () => {
    expect(migrationSql).toContain('"defense_budget_canonical_delta_difference_check"');
  });

  it('forbids an alert for hydration, correction, rollback, and unchanged', () => {
    expect(migrationSql).toContain('"defense_budget_canonical_delta_suppression_check"');
    expect(migrationSql).toContain(
      `CHECK ("change_classification" NOT IN ('initial_hydration', 'correction', 'rollback', 'unchanged')\n               OR "alert_eligible" = false)`,
    );
  });

  it('forbids a suppressed row from being alert-eligible whatever its classification', () => {
    expect(migrationSql).toContain(`CHECK ("alert_eligible" = false OR "suppress_alert" = false)`);
  });

  it('repeats the stage-to-field authority table, because this is the last stop before an alert', () => {
    // The F–J review's P1 was that a request-side candidate could assert a
    // congressional mark, and the damage it described was that mark travelling
    // through the delta engine into a client alert. This is that engine's
    // output.
    expect(migrationSql).toContain('"defense_budget_canonical_delta_stage_field_check"');
    const pairs: [string, string][] = [
      ['hasc', 'hascMark'],
      ['sasc', 'sascMark'],
      ['ndaa_conference', 'ndaaConference'],
      ['hac_d', 'hacDMark'],
      ['sac_d', 'sacDMark'],
      ['appropriations_conference', 'conference'],
      ['public_law', 'enacted'],
      ['continuing_resolution', 'enacted'],
      ['reprogramming', 'reprogrammed'],
      ['execution', 'executed'],
    ];
    for (const [stage, field] of pairs) {
      expect(migrationSql).toContain(`("stage" = '${stage}' AND "funding_field" = '${field}')`);
    }
    expect(migrationSql).not.toContain(
      `("stage" = 'ndaa_conference' AND "funding_field" = 'conference')`,
    );
  });

  it('keeps the materiality score inside 0..1 and out of the money columns', () => {
    expect(migrationSql).toContain('"materiality_score" NUMERIC(6, 5)');
    expect(migrationSql).toContain('CHECK ("materiality_score" >= 0 AND "materiality_score" <= 1)');
  });

  it('is append-only, reusing the Workstream D ledger trigger', () => {
    expect(migrationSql).toContain('CREATE TRIGGER defense_budget_canonical_delta_append_only');
    expect(migrationSql).toContain('EXECUTE FUNCTION enforce_promotion_ledger_append_only()');
    expect(migrationSql).toContain(
      'DROP TRIGGER IF EXISTS defense_budget_canonical_delta_append_only',
    );
  });

  it('restricts every reference so history cannot be cascade-deleted', () => {
    expect(migrationSql).not.toContain('ON DELETE CASCADE');
    expect(migrationSql).not.toContain('ON DELETE SET NULL');
    expect((migrationSql.match(/ON DELETE RESTRICT/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('Phase 7 WS L — role boundary', () => {
  it('grants the drainer no UPDATE on a delta and no DELETE anywhere', () => {
    expect(migrationSql).toContain(
      'GRANT SELECT, INSERT ON "defense_budget_canonical_delta" TO capiro_pe_promoter',
    );
    expect(migrationSql).not.toMatch(/GRANT[^;]*DELETE[^;]*TO capiro_pe_promoter/);
    expect(migrationSql).toContain('-- DELETE is granted nowhere here either.');
  });

  it('lets the drainer set and clear the pause', () => {
    expect(migrationSql).toContain(
      'GRANT SELECT, INSERT, UPDATE ON "defense_budget_side_effect_drain_pause" TO capiro_pe_promoter',
    );
  });

  it('revokes writes on both new tables from the general serve role', () => {
    // ALTER DEFAULT PRIVILEGES from 20260502020000 grants capiro_app full DML on
    // every new table, so this revoke is load-bearing rather than decorative.
    expect(migrationSql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON');
    expect(migrationSql).toContain('"defense_budget_canonical_delta"\n  FROM capiro_app;');
  });
});
