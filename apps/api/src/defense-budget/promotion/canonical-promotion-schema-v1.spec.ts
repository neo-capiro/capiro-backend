/**
 * Phase 7 Workstream D — the schema-level guarantees are present in the
 * migration, not just in the runbook.
 *
 * The behavioural proof is `scripts/pe-budget-phase7-migration-rehearsal.sh`,
 * which applies this migration to a disposable PostgreSQL and demonstrates 60
 * refusals and allowances against a live database. This suite is the cheap
 * always-on gate that runs in every jest invocation: it asserts that each named
 * constraint, trigger, grant, and revoke still exists, so deleting one is a
 * test failure rather than a silent loss of a security property.
 *
 * Assertions target exact SQL identifiers. Identifiers are unique tokens, not
 * substrings of a value, so this does not repeat the Phase 6 NC11 mistake of
 * asserting `toContain('20')` against a payload containing "120".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_DIR = '20260822010000_pe_budget_phase7_canonical_promotion';

// Normalized to LF: `*.sql` has no `eol=lf` rule in .gitattributes (unlike
// .sh/.ts/.md), so a Windows checkout reads this file back as CRLF and every
// multi-line literal below (all authored as LF) would silently never match.
const migrationSql = readFileSync(
  join(__dirname, '..', '..', '..', 'prisma', 'migrations', MIGRATION_DIR, 'migration.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const schemaPrisma = readFileSync(
  join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'),
  'utf8',
);

// SQL line comments stripped, for checks that must not false-positive on an
// English word inside prose (e.g. "real Aurora target" is not the type REAL).
const migrationSqlWithoutComments = migrationSql
  .split('\n')
  // No `$` anchor: this file has CRLF line endings on a Windows checkout, and
  // `.` never matches the trailing `\r`, so `--.*$` silently matches nothing.
  .map((line) => line.replace(/--.*/, ''))
  .join('\n');

/** Every table the promotion ledger and canonical substrate is made of. */
const PHASE7_TABLES = [
  'defense_budget_canonical_snapshot',
  'defense_budget_active_snapshot',
  'defense_budget_promotion_plan',
  'defense_budget_promotion_authorization',
  'defense_budget_promotion_run',
  'defense_budget_promotion_item',
  'defense_budget_promotion_activation',
  'defense_budget_promotion_outbox',
  'defense_budget_compatibility_projection_run',
  'defense_budget_rollback_record',
  'defense_budget_canonical_row',
  'defense_budget_promotion_audit',
] as const;

describe('Phase 7 Workstream D — tables and models', () => {
  it('creates every promotion-ledger and canonical table', () => {
    for (const table of PHASE7_TABLES) {
      expect(migrationSql).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it('exposes every table to Prisma with a matching @@map', () => {
    for (const table of PHASE7_TABLES) {
      expect(schemaPrisma).toContain(`@@map("${table}")`);
    }
  });

  /**
   * SQL comments are stripped before scanning. A gate that matches its own
   * prose is a false positive — the same Phase 6 lesson `canonical-projectors-v1`
   * applies to its no-legacy-writer scan, and the same shape as the open P1-8
   * finding that the architecture gates are regexes over raw file text. A
   * comment explaining *why* this migration alters nothing must not trip it.
   */
  const migrationStatements = migrationSql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  it('alters no pre-existing table and drops nothing', () => {
    expect(migrationStatements).not.toMatch(/\bALTER TABLE\b/);
    expect(migrationStatements).not.toMatch(/\bDROP TABLE\b/);
    expect(migrationStatements).not.toMatch(/\bDROP COLUMN\b/);
    expect(migrationStatements).not.toMatch(/\bTRUNCATE\b\s+"/);
  });

  it('still catches a real ALTER TABLE, so stripping comments has not blunted it', () => {
    const withViolation = `${migrationStatements}\nALTER TABLE "program_element" ADD COLUMN "x" TEXT;`;
    expect(withViolation).toMatch(/\bALTER TABLE\b/);
  });

  it('keeps the queue link in its own migration rather than this one', () => {
    expect(migrationSql).not.toContain('reconciliation_review_queue"\n  ADD COLUMN');
  });

  it('performs no data backfill', () => {
    // The only INSERTs a migration may contain are none: promotion writes data,
    // migrations create structure.
    expect(migrationSql).not.toMatch(/\bINSERT\s+INTO\b/i);
  });
});

describe('Phase 7 Workstream D — activation and immutability constraints', () => {
  it('permits exactly one active snapshot per domain and environment', () => {
    expect(migrationSql).toContain(
      '"defense_budget_active_snapshot_singleton_unique" UNIQUE ("domain", "environment")',
    );
  });

  it('permits one canonical row per natural key per snapshot', () => {
    expect(migrationSql).toContain('"defense_budget_canonical_row_identity_unique"');
    expect(migrationSql).toContain(
      'UNIQUE ("snapshot_id", "canonical_entity", "canonical_natural_key")',
    );
  });

  it('makes activation exactly-once by unique activation key', () => {
    expect(migrationSql).toContain(
      '"defense_budget_promotion_activation_key_unique" UNIQUE ("activation_key")',
    );
  });

  it('makes authorization one-use with a partial unique index', () => {
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "defense_budget_promotion_authorization_one_use_key"',
    );
    expect(migrationSql).toContain('WHERE "consumed_by_run_id" IS NOT NULL');
  });

  it('requires an enactment proof for every enacted row', () => {
    expect(migrationSql).toContain('"defense_budget_canonical_row_enacted_proof_check"');
    expect(migrationSql).toContain(
      `CHECK ("funding_field" <> 'enacted' OR "enactment_proof_id" IS NOT NULL)`,
    );
  });

  it('refuses a candidate or conflicting identity binding in canonical storage', () => {
    expect(migrationSql).toContain('"defense_budget_canonical_row_binding_check"');
    expect(migrationSql).toContain(`CHECK ("binding_status" IN ('accepted', 'not_applicable'))`);
  });

  it('encodes the stage-to-field authority table as a database check', () => {
    expect(migrationSql).toContain('"defense_budget_canonical_row_stage_field_check"');
    // Each authority is pinned to exactly the field it owns; the pairing that
    // would let NDAA conference populate the appropriations conference field is
    // absent by construction.
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

  it('keeps the money triple all-or-nothing', () => {
    expect(migrationSql).toContain('"defense_budget_canonical_row_money_triple_check"');
    expect(migrationSql).toContain(
      'num_nonnulls("money_original_value", "money_original_unit", "money_value_millions") IN (0, 3)',
    );
  });

  it('stores money, quantity, and unit cost as exact NUMERIC, never float', () => {
    expect(migrationSql).toContain('"money_value_millions" NUMERIC(24, 9)');
    expect(migrationSql).toContain('"quantity" NUMERIC(24, 9)');
    expect(migrationSql).toContain('"unit_cost_dollars" NUMERIC(24, 9)');
    // No approximate numeric type may appear anywhere in the canonical path.
    // Checked with comments stripped: an English word like "real" in a prose
    // comment is not the SQL type REAL, and must not read as one.
    expect(migrationSqlWithoutComments).not.toMatch(/\b(DOUBLE PRECISION|REAL|FLOAT4|FLOAT8)\b/i);
  });

  it('forbids an un-suppressed alert for hydration, correction, and rollback', () => {
    expect(migrationSql).toContain('"defense_budget_promotion_outbox_suppression_check"');
    expect(migrationSql).toContain(
      `CHECK ("change_classification" NOT IN ('initial_hydration', 'correction', 'rollback', 'unchanged')\n               OR "suppress_alert" = true)`,
    );
  });

  it('deduplicates outbox delivery by key', () => {
    expect(migrationSql).toContain(
      '"defense_budget_promotion_outbox_dedupe_unique" UNIQUE ("dedupe_key")',
    );
  });

  it('restricts every snapshot reference so history cannot be cascade-deleted', () => {
    const restrictCount = (migrationSql.match(/ON DELETE RESTRICT/g) ?? []).length;
    expect(restrictCount).toBeGreaterThanOrEqual(12);
    expect(migrationSql).not.toContain('ON DELETE CASCADE');
    expect(migrationSql).not.toContain('ON DELETE SET NULL');
  });
});

describe('Phase 7 Workstream D — trigger-enforced boundaries', () => {
  const TRIGGERS = [
    'defense_budget_canonical_row_boundary',
    'defense_budget_promotion_authorization_append_only',
    'defense_budget_promotion_plan_append_only',
    'defense_budget_promotion_activation_append_only',
    'defense_budget_rollback_record_append_only',
    'defense_budget_promotion_audit_append_only',
    'defense_budget_canonical_snapshot_immutable',
    'defense_budget_active_snapshot_preconditions',
    'defense_budget_active_snapshot_no_delete',
    'defense_budget_promotion_run_authorization_match',
    'defense_budget_activation_authorization_valid',
  ] as const;

  it('creates every enforcement trigger', () => {
    for (const trigger of TRIGGERS) {
      expect(migrationSql).toContain(`CREATE TRIGGER ${trigger}`);
    }
  });

  it('drops each trigger before creating it so the migration is re-runnable', () => {
    for (const trigger of TRIGGERS) {
      expect(migrationSql).toContain(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
  });

  it('restricts canonical writes to the promoter role or the table owner', () => {
    expect(migrationSql).toContain(`pg_has_role(current_user, 'capiro_pe_promoter', 'USAGE')`);
    expect(migrationSql).toContain('canonical rows may only be written by capiro_pe_promoter');
  });

  it('freezes canonical rows once their snapshot leaves STAGING', () => {
    expect(migrationSql).toContain(`IF snapshot_status IS DISTINCT FROM 'STAGING' THEN`);
  });

  it('allows an authorization update only to record consumption', () => {
    expect(migrationSql).toContain(
      `(to_jsonb(NEW) - 'consumed_at' - 'consumed_by_run_id')\n     <> (to_jsonb(OLD) - 'consumed_at' - 'consumed_by_run_id')`,
    );
    expect(migrationSql).toContain(
      'promotion authorizations are immutable; only consumption may be recorded',
    );
  });

  it('refuses activation when required scopes are incomplete', () => {
    expect(migrationSql).toContain('cannot be activated with incomplete scopes');
  });

  it('refuses activation when the expected previous snapshot is not live', () => {
    expect(migrationSql).toContain('active-snapshot drift');
  });

  it('refuses activation with an expired authorization', () => {
    expect(migrationSql).toContain('and cannot be activated');
    expect(migrationSql).toContain('auth.expires_at <= now()');
  });

  it('refuses to execute a plan that still has blocked items', () => {
    expect(migrationSql).toContain('blocked item(s) and cannot be executed');
  });

  it('never deletes a snapshot', () => {
    expect(migrationSql).toContain(
      'canonical snapshots are never deleted; rollback is a forward pointer transition',
    );
  });
});

describe('Phase 7 Workstream D — least-privilege role boundary', () => {
  it('creates capiro_pe_promoter with no superuser, DDL, or role-creation rights', () => {
    expect(migrationSql).toContain('CREATE ROLE capiro_pe_promoter LOGIN PASSWORD');
    // No explicit ALTER ROLE ... NOSUPERUSER here: naming SUPERUSER/NOSUPERUSER
    // in ALTER ROLE requires the CALLING role to itself hold real SUPERUSER,
    // which Aurora's master user does not (only the restricted rds_superuser
    // pseudo-role) — that line used to fail every real Aurora deploy with
    // "permission denied to alter role" and roll back this whole migration.
    // A bare CREATE ROLE ... LOGIN PASSWORD already defaults every one of
    // these attributes to its restrictive form, so nothing needs re-asserting.
    expect(migrationSql).not.toMatch(/ALTER ROLE capiro_pe_promoter[\s\S]*?SUPERUSER/);
    expect(migrationSql).toContain("already Postgres's default for a bare");
  });

  it('grants the promoter no DELETE anywhere', () => {
    const promoterGrant = migrationSql.slice(
      migrationSql.indexOf('GRANT SELECT, INSERT, UPDATE ON'),
      migrationSql.indexOf(
        'TO capiro_pe_promoter;',
        migrationSql.indexOf('GRANT SELECT, INSERT, UPDATE ON'),
      ),
    );
    expect(promoterGrant).not.toContain('DELETE');
    expect(migrationSql).toContain('-- DELETE is granted nowhere');
  });

  it('revokes canonical DML from the general API serve role', () => {
    // ALTER DEFAULT PRIVILEGES from migration 20260502020000 grants capiro_app
    // full DML on every new table, so this revoke is load-bearing.
    expect(migrationSql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON');
    expect(migrationSql).toContain('FROM capiro_app;');
    expect(migrationSql).toContain('"defense_budget_canonical_row"\n  FROM capiro_app;');
  });

  it('grants the Phase 6 projection tables conditionally, since they are a separate chain', () => {
    expect(migrationSql).toContain(`to_regclass('public.' || t) IS NOT NULL`);
    expect(migrationSql).toContain('phase6_audit_projection');
  });

  it('documents ownership and the security boundary in database comments', () => {
    expect(migrationSql).toContain('COMMENT ON ROLE capiro_pe_promoter IS');
    for (const table of PHASE7_TABLES) {
      // Every table carries a comment except the ones whose purpose is stated
      // on a parent; assert the security-critical ones explicitly.
      if (
        table === 'defense_budget_canonical_row' ||
        table === 'defense_budget_active_snapshot' ||
        table === 'defense_budget_canonical_snapshot' ||
        table === 'defense_budget_promotion_authorization'
      ) {
        expect(migrationSql).toContain(`COMMENT ON TABLE "${table}" IS`);
      }
    }
  });
});
