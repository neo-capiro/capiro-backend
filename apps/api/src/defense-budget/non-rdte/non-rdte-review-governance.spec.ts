import * as fs from 'node:fs';
import * as path from 'node:path';

const API_ROOT = path.resolve(__dirname, '..', '..', '..');
const OPERATOR_FILES = [
  'scripts/inspect-defense-budget-non-rdte.ts',
  'scripts/extract-defense-budget-non-rdte.ts',
  'scripts/verify-defense-budget-non-rdte.ts',
  'scripts/certify-defense-budget-non-rdte.ts',
  'scripts/plan-defense-budget-non-rdte-projection.ts',
] as const;

function read(relative: string): string {
  return fs.readFileSync(path.join(API_ROOT, relative), 'utf8');
}

describe('Phase 5 governed-review boundary', () => {
  it('no Phase 5 operator accepts a caller-supplied review acceptance', () => {
    const source = OPERATOR_FILES.map(read).join('\n');
    expect(source).not.toContain('--review-acceptances');
    expect(source).not.toContain('allowedReviewedAcceptances');
  });

  it('the exported proof-bound planner rejects the legacy review-acceptance escape hatch', () => {
    const source = read(
      'src/defense-budget/non-rdte/non-rdte-proof-bound-projection-planner-v1.ts',
    );
    /* Whitespace-tolerant: prettier may break the type arguments across lines.
     * The construct asserted is unchanged — Omit of exactly that one key. */
    expect(source).toMatch(
      /Omit<\s*NonRdteProjectionPlannerInput,\s*'allowedReviewedAcceptances'\s*>/,
    );
    expect(source).toContain("'review_acceptance_bypass'");
    expect(source).toContain('accepts only a Phase 2 VERIFICATION_PASSED result');
    expect(source).not.toContain('allowedReviewedAcceptances: input.allowedReviewedAcceptances');
  });

  it('certification explicitly preserves Phase 2 NEEDS_REVIEW', () => {
    const source = read('scripts/certify-defense-budget-non-rdte.ts');
    expect(source).toContain('A Phase 2 NEEDS_REVIEW result remains NEEDS_REVIEW');
    expect(source).not.toMatch(/review.*allowlist|allowlist.*review/i);
  });

  it('projection is driven only by a certified bundle and exact verification results', () => {
    const source = read('scripts/plan-defense-budget-non-rdte-projection.ts');
    expect(source).toContain('CERTIFIED_NON_RDTE_READY_FOR_PROJECTION');
    expect(source).toContain('verificationResultsByRunId');
    expect(source).not.toContain('reviewAcceptances');
  });

  it('the runbook documents no review-acceptance command-line bypass', () => {
    const source = read('../../docs/runbooks/defense-budget-non-rdte-cycle.md');
    expect(source).not.toContain('--review-acceptances');
    /* The runbook writes NEEDS_REVIEW as a markdown code span, so match the
     * documented statement rather than one exact rendering of it. */
    expect(source).toMatch(/`?NEEDS_REVIEW`?[^.]*?remains non-projectable/);
  });
});
