import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * STATIC guard for the assurance-persistence migrations.
 *
 * There is no database in this checkout, so nothing here proves the SQL RUNS. What
 * it does prove is the set of properties that are easy to get wrong and impossible
 * to notice later: a table shipped without FORCE ROW LEVEL SECURITY looks fine in
 * every test and leaks across tenants for its owner role forever, and a table
 * shipped with an explicit GRANT quietly diverges from the ALTER DEFAULT PRIVILEGES
 * convention the rest of this schema relies on.
 *
 * It also pins the DB-level restatements of the in-code policy guards. Once
 * compliance_policy_pack is writable, validatePolicyPack / canPublishPolicyPack /
 * evaluatePolicyPack / selectPolicyPack stop being the only defence only if these
 * CHECK constraints actually exist.
 */

const MIGRATIONS = join(__dirname, '../../prisma/migrations');

const FILES = {
  policyPacks: '20260811010000_assurance_policy_packs',
  evalRuns: '20260811020000_assurance_eval_runs',
  feedbackFixtures: '20260811030000_assurance_feedback_fixtures',
} as const;

function sql(dir: string): string {
  return readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
}

/** Strip SQL comments — the prose in these files quotes DDL and CHECK names. */
function code(dir: string): string {
  return sql(dir)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n\r]*/g, '');
}

const ALL_TABLES: Array<{ file: keyof typeof FILES; table: string }> = [
  { file: 'policyPacks', table: 'compliance_policy_pack' },
  { file: 'policyPacks', table: 'compliance_policy_pack_event' },
  { file: 'policyPacks', table: 'compliance_policy_decision' },
  { file: 'evalRuns', table: 'assurance_eval_run' },
  { file: 'evalRuns', table: 'assurance_eval_result' },
  { file: 'evalRuns', table: 'assurance_eval_domain_gate' },
  { file: 'feedbackFixtures', table: 'assurance_feedback_candidate' },
  { file: 'feedbackFixtures', table: 'assurance_eval_fixture' },
];

describe('assurance persistence migrations', () => {
  it('creates every expected table', () => {
    for (const { file, table } of ALL_TABLES) {
      expect(code(FILES[file])).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
    expect(ALL_TABLES).toHaveLength(8);
  });

  it('ENABLEs and FORCEs row level security on every new table', () => {
    for (const { file, table } of ALL_TABLES) {
      const text = code(FILES[file]);
      expect(text).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      // FORCE is the one that matters for capiro_master: without it, the table
      // owner bypasses the policy entirely.
      expect(text).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    }
  });

  it('gives every new table a tenant-isolation policy on app.current_tenant', () => {
    for (const { file, table } of ALL_TABLES) {
      const text = code(FILES[file]);
      expect(text).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
      // Both directions: USING guards reads, WITH CHECK guards writes. A policy
      // with only USING lets a row be INSERTed for another tenant.
      const policy = text.slice(text.indexOf(`CREATE POLICY ${table}_tenant_isolation`));
      const body = policy.slice(0, policy.indexOf(';') + 1);
      expect(body).toMatch(
        /USING \(tenant_id = current_setting\('app\.current_tenant', true\)::uuid\)/,
      );
      expect(body).toMatch(
        /WITH CHECK \(tenant_id = current_setting\('app\.current_tenant', true\)::uuid\)/,
      );
    }
  });

  it('every new table is tenant-scoped with a cascading FK to tenants', () => {
    for (const { file, table } of ALL_TABLES) {
      const text = code(FILES[file]);
      const create = text.slice(text.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`));
      const body = create.slice(0, create.indexOf('\n);'));
      expect(body).toContain('tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE');
    }
  });

  it('adds NO explicit GRANT (capiro_app rides ALTER DEFAULT PRIVILEGES)', () => {
    for (const file of Object.values(FILES)) {
      expect(code(file)).not.toMatch(/\bGRANT\b/i);
    }
  });

  it('is purely ADDITIVE — no DROP TABLE, no DROP COLUMN, no data mutation', () => {
    for (const file of Object.values(FILES)) {
      const text = code(file);
      expect(text).not.toMatch(/DROP\s+TABLE/i);
      expect(text).not.toMatch(/DROP\s+COLUMN/i);
      expect(text).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
      expect(text).not.toMatch(/\bDELETE\s+FROM\b/i);
      // DROP POLICY IF EXISTS before CREATE POLICY is the established idempotency
      // idiom in this repo and is the ONLY DROP allowed here.
      for (const drop of text.match(/DROP\s+\w+/gi) ?? []) {
        expect(drop.toUpperCase()).toBe('DROP POLICY');
      }
    }
  });

  /**
   * Persisting policy packs creates a NEW activation surface for legal rules.
   * Today "no sample legal rule is activatable" holds partly because the packs are
   * immutable in-code constants. These CHECKs are what keeps it holding once rows
   * are writable.
   */
  it('restates the load-bearing policy-pack guards as DB CHECK constraints', () => {
    const text = code(FILES.policyPacks);
    // validatePolicyPack: a non-production pack cannot be published.
    expect(text).toContain('compliance_policy_pack_non_production_check');
    expect(text).toMatch(/NOT \(non_production AND status = 'published'\)/);
    // validatePolicyPack: a published pack must carry review + publication
    // attribution and an approved (or explicitly not-required) legal review.
    expect(text).toContain('compliance_policy_pack_published_attribution_check');
    // validatePolicyPack: four-eyes needs two DISTINCT named reviewers.
    expect(text).toContain('compliance_policy_pack_four_eyes_check');
    expect(text).toMatch(/reviewed_by_user_id <> second_approved_by_user_id/);
    // At most ONE live version per pack, enforced by the database.
    expect(text).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS compliance_policy_pack_published_unique[\s\S]*?WHERE status = 'published'/,
    );
    // Fail safe: an unmatched action WARNs rather than PASSes, and a new pack is
    // non-production until someone says otherwise.
    expect(text).toContain("fallback_outcome varchar(8) NOT NULL DEFAULT 'WARN'");
    expect(text).toContain('non_production boolean NOT NULL DEFAULT true');
  });

  it('never seeds a policy pack from a migration (RLS FORCE would no-op it anyway)', () => {
    const text = code(FILES.policyPacks);
    expect(text).not.toMatch(/INSERT\s+INTO\s+compliance_policy_pack/i);
    // And most of all: never seed the disabled legal examples.
    expect(sql(FILES.policyPacks)).not.toMatch(/example-(gifts|travel|fara-lda|pay-to-play)/);
  });

  it('restates the feedback-fixture review + anonymization invariants as CHECKs', () => {
    const text = code(FILES.feedbackFixtures);
    // A decided candidate must name its reviewer, time, and reason.
    expect(text).toContain('assurance_feedback_candidate_review_attribution_check');
    // An accepted candidate must be anonymized under a named version.
    expect(text).toContain('assurance_feedback_candidate_anonymized_check');
    expect(text).toMatch(
      /status <> 'accepted' OR \(anonymized AND anonymization_version IS NOT NULL\)/,
    );
    // Segregation of duties: you cannot promote your own feedback to golden truth.
    expect(text).toContain('assurance_feedback_candidate_reviewer_distinct_check');
    expect(text).toMatch(/reviewed_by_user_id <> created_by_user_id/);
    // Reviewer-facing summary is bounded; bodies are not stored at all.
    expect(text).toContain('assurance_feedback_candidate_summary_size_check');
    // A fixture must never become unattributable.
    expect(text).toMatch(
      /source_candidate_id uuid NOT NULL\s*\n?\s*REFERENCES assurance_feedback_candidate\(id\) ON DELETE RESTRICT/,
    );
  });

  it('constrains feedback reason codes to the CANONICAL apps/api vocabulary', () => {
    const text = code(FILES.feedbackFixtures);
    expect(text).toContain('assurance_feedback_candidate_reason_codes_check');
    // The live spellings — the ones already inside clio_message.metadata.feedback.
    expect(text).toContain("'wrong_tone_or_format'");
    expect(text).toContain("'tool_or_action_failed'");
    // The legacy meriv2-core spellings must NOT be storable: they are normalized
    // away before they ever reach the database.
    expect(text).not.toContain("'wrong_tone_format'");
    expect(text).not.toContain("'tool_action_failed'");
    expect(text).toMatch(/array_length\(reason_codes, 1\) >= 1/);
  });

  it('stores the thresholds an eval run actually used, so history cannot be rewritten', () => {
    const text = code(FILES.evalRuns);
    expect(text).toContain('thresholds_jsonb jsonb NOT NULL');
    // Idempotent re-runs rather than duplicated history.
    expect(text).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS assurance_eval_run_provenance_unique\s*\n?\s*ON assurance_eval_run \(tenant_id, provenance_hash\)/,
    );
    // Sign-off exists for cost/latency ONLY — there is deliberately no generic
    // override column, because a safety or scope invariant is not waivable.
    expect(text).toContain('cost_latency_signoff_by_user_id');
    expect(text).not.toMatch(/\boverride_by_user_id\b/);
    // The category-specific verdict is stored, not re-derived.
    expect(text).toContain('critical_failed integer NOT NULL');
  });

  it('has every new table modelled in schema.prisma (no repeat of the governance drift)', () => {
    const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    for (const { table } of ALL_TABLES) {
      expect(schema).toContain(`@@map("${table}")`);
    }
  });
});
