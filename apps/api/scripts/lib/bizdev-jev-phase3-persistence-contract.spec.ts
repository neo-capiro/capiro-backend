import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';

/**
 * Business Development Phase 3 — persistence contract for the
 * `business_development_jev_decisions` tenant decision-trace table.
 *
 * Locks, at the migration-SQL level: no prompt/passage/private payload
 * columns, tenant FK, status/mode/usage/review CHECK constraints, the
 * shadow-visible-effect CHECK, the tenant+idempotency-key uniqueness, FORCE
 * RLS with the tenant isolation policy, and the conditional app-role grant.
 * The contract is string-anchored on the exact committed migration so any
 * drift (dropped constraint, renamed policy, weakened RLS) fails the suite.
 */

const apiRoot = new URL('../../', `file://${__dirname}/`);
const migration = readFileSync(
  new URL(
    'prisma/migrations/20280925010000_business_development_phase3_jev/migration.sql',
    apiRoot,
  ),
  'utf8',
);

/** Column names permitted in the trace — anything else is a contract breach. */
const ALLOWED_COLUMNS = new Set([
  'id', 'tenant_id', 'subject_type', 'subject_id', 'prospect_id',
  'canonical_entity_id', 'task', 'mode', 'status', 'operational_state',
  'provider_name', 'model_version', 'registry_version', 'question_version',
  'envelope_hash', 'candidate_inventory_hash', 'source_ids',
  'source_hashes_jsonb', 'deterministic_outcome', 'outcome',
  'probabilities_jsonb', 'confidence', 'reason_codes', 'input_tokens',
  'output_tokens', 'estimated_cost_usd', 'latency_ms', 'visible_effect_jsonb',
  'review_status', 'reviewed_outcome', 'reviewed_by_user_id', 'reviewed_at',
  'idempotency_key', 'requested_at', 'completed_at', 'created_at', 'updated_at',
]);

describe('business development Phase 3 Jev persistence contract', () => {
  it('declares exactly the permitted redacted columns — no prompt/passage/private payload', () => {
    const declared = [...migration.matchAll(/^\s*"([a-z0-9_]+)"\s+(?:UUID|VARCHAR|TEXT|JSONB|INTEGER|DECIMAL|TIMESTAMPTZ)/gm)]
      .map((m) => m[1]!)
      .filter((name) => !name.startsWith('business_development_jev_decisions'));
    expect(new Set(declared)).toEqual(ALLOWED_COLUMNS);
    for (const banned of [
      'prompt', 'passage', 'note', 'reason_text', 'contact', 'preference',
      'pdl', 'body', 'content', 'text', 'raw', 'payload',
    ]) {
      if (declared.some((c) => c.includes(banned))) {
        throw new Error(`banned column substring in trace: ${banned}`);
      }
    }
    // The redaction intent is stated in the migration header itself.
    expect(migration).toMatch(/no prompts, passages, notes, conflict/i);
  });

  it('binds every row to the tenants table with cascade delete', () => {
    expect(migration).toContain(
      'FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE',
    );
  });

  it('constrains status, mode, task, subject, review status, usage and confidence', () => {
    for (const [fragment, why] of [
      ['CHECK ("subject_type" IN (\'prospect\', \'company\', \'signal\'))', 'subject types'],
      ['CHECK ("task" IN (\'bd_entity\', \'bd_signal\', \'bd_fit\', \'bd_timing\', \'bd_evidence\', \'bd_claim\'))', 'task allow-list'],
      ['CHECK ("mode" IN (\'shadow\', \'internal_canary\'))', 'mode allow-list (no off rows are persisted)'],
      ['CHECK ("status" IN (\'pending\', \'completed\', \'failed\', \'skipped\'))', 'status allow-list'],
      ['CHECK ("review_status" IN (\'unreviewed\', \'accepted\', \'corrected\', \'rejected\'))', 'review status allow-list'],
      ['CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1))', 'confidence range'],
      ['("input_tokens" IS NULL OR "input_tokens" >= 0)', 'input token usage'],
      ['("output_tokens" IS NULL OR "output_tokens" >= 0)', 'output token usage'],
      ['("latency_ms" IS NULL OR "latency_ms" >= 0)', 'latency usage'],
      ['("estimated_cost_usd" IS NULL OR "estimated_cost_usd" >= 0)', 'cost usage'],
      ['CHECK (("review_status" = \'unreviewed\' AND "reviewed_at" IS NULL)\n       OR ("review_status" <> \'unreviewed\' AND "reviewed_at" IS NOT NULL))', 'review-status/reviewed-at coherence'],
    ] as const) {
      if (!migration.includes(fragment)) throw new Error(`migration lost ${why}`);
    }
  });

  it('enforces the shadow-visible-effect CHECK: shadow rows can never carry a visible effect', () => {
    expect(migration).toContain(
      'CHECK ("mode" <> \'shadow\' OR "visible_effect_jsonb" IS NULL)',
    );
  });

  it('enforces tenant-scoped idempotency uniqueness', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "business_development_jev_decisions_tenant_idempotency_key"\n  ON "business_development_jev_decisions"("tenant_id", "idempotency_key")',
    );
  });

  it('FORCEs row level security with a tenant isolation policy on USING and WITH CHECK', () => {
    expect(migration).toContain('ALTER TABLE "business_development_jev_decisions" ENABLE ROW LEVEL SECURITY;');
    expect(migration).toContain('ALTER TABLE "business_development_jev_decisions" FORCE ROW LEVEL SECURITY;');
    expect(migration).toContain(
      'CREATE POLICY "business_development_jev_decisions_isolation" ON "business_development_jev_decisions"\n  USING (rls_bypass() OR tenant_id = current_tenant_id())\n  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id())',
    );
  });

  it('grants the app role only inside the role-existence guard', () => {
    expect(migration).toContain(`IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN`);
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "business_development_jev_decisions" TO capiro_app;',
    );
    // The grant must live inside the DO block, not at top level.
    const doBlock = migration.slice(migration.indexOf('DO $$'));
    expect(doBlock).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON "business_development_jev_decisions" TO capiro_app;');
  });
});
