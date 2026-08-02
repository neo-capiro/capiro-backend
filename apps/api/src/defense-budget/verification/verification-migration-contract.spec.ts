import { readFileSync } from 'node:fs';

describe('budget verification migration contract', () => {
  it('creates every handoff audit table and never alters canonical PE-year tables', () => {
    const sql = readFileSync(
      'prisma/migrations/20260802050000_budget_verification_audit/migration.sql',
      'utf8',
    );
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
    expect(sql).toContain("'VERIFIED_AUTOMATIC'");
    expect(sql).toContain("'VERIFIED_REVIEWED'");
    expect(sql).toContain('approved_sha256');
  });
});

export {};
