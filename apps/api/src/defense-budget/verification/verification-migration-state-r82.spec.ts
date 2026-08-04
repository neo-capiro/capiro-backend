/**
 * R8.2 Workstream A — migration-state safety guard.
 *
 * On 2026-08-03 the first application of
 * `20260816010000_budget_verification_v1` failed on the shared capiro-dev
 * database with PostgreSQL error 42601: the original SQL contained a stray
 * duplicate `ON "budget_review_decision_v1" (...)` clause immediately after
 * the `budget_v1_review_one_terminal_per_candidate` partial unique index.
 * The failed row was resolved `--rolled-back` and the corrected migration
 * re-applied successfully (finished, 1 step) — see
 * docs/program-elements/enrichment/PHASE-2-R8.2-A-MIGRATION-STATE.md.
 *
 * This spec pins the corrected migration content so the exact defect cannot
 * silently return, and pins the additive / non-canonical properties that the
 * Phase 2 decision table depends on:
 *
 *   - the migration is finished in the only authorized environment, so its
 *     SQL must not be edited further; any future database change is a new
 *     forward migration;
 *   - the partial unique index is exactly one well-formed statement;
 *   - all six V1 audit tables are created with ON DELETE RESTRICT FKs;
 *   - no canonical Program Element table is touched.
 */
import { readFileSync } from 'node:fs';

const MIGRATION = 'prisma/migrations/20260816010000_budget_verification_v1/migration.sql';

describe('R8.2-A budget_verification_v1 migration safety guard', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('creates all six Phase 2 V1 audit tables', () => {
    for (const table of [
      'budget_extraction_candidate_v1',
      'budget_verification_run_v1',
      'budget_verification_check_v1',
      'budget_verification_proof',
      'budget_verification_discrepancy_v1',
      'budget_review_decision_v1',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it('keeps the one-terminal-review partial unique index as a single well-formed statement', () => {
    // The exact defect that caused the 42601 failure: the CREATE UNIQUE INDEX
    // statement was followed by a stray second ON clause, which PostgreSQL
    // rejected with "syntax error at or near CREATE".
    const matches = [
      ...sql.matchAll(
        /CREATE UNIQUE INDEX "budget_v1_review_one_terminal_per_candidate"\s*\n\s*ON "budget_review_decision_v1" \("candidate_id"\)\s*\n\s*WHERE "decision" IN \('accept', 'reject'\);/g,
      ),
    ];
    expect(matches.length).toBe(1);

    // No stray duplicate ON clause for the same index.
    const indexStart = sql.indexOf(
      'CREATE UNIQUE INDEX "budget_v1_review_one_terminal_per_candidate"',
    );
    expect(indexStart).toBeGreaterThanOrEqual(0);
    const afterIndex = sql.slice(indexStart, sql.indexOf(';', indexStart) + 1);
    expect((afterIndex.match(/ON "budget_review_decision_v1"/g) ?? []).length).toBe(1);
    expect(afterIndex).not.toContain('"created_at"');
  });

  it('protects audit evidence with ON DELETE RESTRICT foreign keys', () => {
    const restrictCount = (sql.match(/ON DELETE RESTRICT ON UPDATE CASCADE/g) ?? []).length;
    // candidate->source_document, run->candidate, check->run, proof->run,
    // discrepancy->candidate + run, review->candidate + run = 8 FKs.
    expect(restrictCount).toBe(8);
    expect(sql).not.toContain('ON DELETE CASCADE');
    expect(sql).not.toContain('ON DELETE SET NULL');
  });

  it('installs append-only update and delete triggers for every audit table', () => {
    for (const entity of ['run', 'check', 'proof', 'discrepancy', 'review']) {
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION prevent_budget_v1_${entity}_update()`);
      expect(sql).toContain(`CREATE TRIGGER budget_v1_${entity}_no_update`);
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION prevent_budget_v1_${entity}_delete()`);
      expect(sql).toContain(`CREATE TRIGGER budget_v1_${entity}_no_delete`);
    }
  });

  it('alters no canonical Program Element table', () => {
    expect(sql).not.toMatch(/ALTER TABLE\s+"?program_element/i);
    expect(sql).not.toMatch(/INSERT INTO\s+"?program_element/i);
    expect(sql).not.toMatch(/UPDATE\s+"?program_element/i);
    expect(sql).not.toMatch(/DROP TABLE\s+"?program_element/i);
  });
});
