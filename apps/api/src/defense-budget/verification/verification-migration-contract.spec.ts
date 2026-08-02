import { readFileSync } from 'node:fs';

const ORIGINAL = 'prisma/migrations/20260802050000_budget_verification_audit/migration.sql';
const CONTAINMENT =
  'prisma/migrations/20260802180000_budget_verification_containment/migration.sql';

describe('budget verification migration contract', () => {
  it('keeps the original audit migration unchanged and noncanonical', () => {
    const sql = readFileSync(ORIGINAL, 'utf8');
    for (const table of [
      'budget_extraction_candidate',
      'budget_extraction_cell',
      'budget_verification_run',
      'budget_verification_check',
      'budget_verification_discrepancy',
      'budget_review_decision',
      'budget_golden_example',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(sql).not.toMatch(/ALTER TABLE\s+"?program_element_year"?/i);
    expect(sql).not.toMatch(/INSERT INTO\s+"?program_element_year"?/i);
    expect(sql).not.toMatch(/UPDATE\s+"?program_element_year"?/i);
  });

  it('adds an additive containment migration that refuses existing CANONICAL rows', () => {
    const sql = readFileSync(CONTAINMENT, 'utf8');
    expect(sql).toContain("WHERE status = 'CANONICAL'");
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain('SET "status" = \'STRUCTURALLY_VALIDATED\'');
    expect(sql).toContain('SET "status" = \'REVIEW_ACCEPTED\'');
    expect(sql).toContain("'STRUCTURALLY_VALIDATED'");
    expect(sql).toContain("'REVIEW_ACCEPTED'");
    expect(sql).toContain('budget_verification_run_status_check');
    expect(sql).toContain('budget_verification_run_route_check');
    expect(sql).toContain('Structural-validation audit records only');
  });

  it('excludes prohibited statuses from the final candidate constraint', () => {
    const sql = readFileSync(CONTAINMENT, 'utf8');
    const matches = [
      ...sql.matchAll(/ADD CONSTRAINT "budget_extraction_candidate_status_check"[\s\S]*?\)\);/g),
    ];
    expect(matches.length).toBeGreaterThan(0);
    const finalBody = matches[matches.length - 1]![0];
    expect(finalBody).not.toContain("'CANONICAL'");
    expect(finalBody).not.toContain("'VERIFIED_AUTOMATIC'");
    expect(finalBody).not.toContain("'VERIFIED_REVIEWED'");
    expect(finalBody).toContain("'STRUCTURALLY_VALIDATED'");
    expect(finalBody).toContain("'REVIEW_ACCEPTED'");
  });

  it('alters no canonical Program Element table', () => {
    const sql = readFileSync(CONTAINMENT, 'utf8');
    expect(sql).not.toMatch(/ALTER TABLE\s+"?program_element/i);
    expect(sql).not.toMatch(/INSERT INTO\s+"?program_element/i);
    expect(sql).not.toMatch(/UPDATE\s+"?program_element_year"?/i);
  });
});
