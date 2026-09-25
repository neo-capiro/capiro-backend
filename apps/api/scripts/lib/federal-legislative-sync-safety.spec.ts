import { assertFullFederalEvidenceReconciliationSafe } from './federal-legislative-sync-safety.js';

describe('federal legislative full-reconciliation safety', () => {
  it('rejects an accidental nonhistorical first full reconciliation', () => {
    expect(() => assertFullFederalEvidenceReconciliationSafe({
      full: true,
      historical: false,
      hasCompletedFullBaseline: false,
    })).toThrow('FIRST_FULL_FEDERAL_EVIDENCE_RECONCILIATION_REQUIRES_HISTORICAL_MODE');
  });

  it.each([
    { full: true, historical: true, hasCompletedFullBaseline: false },
    { full: true, historical: false, hasCompletedFullBaseline: true },
    { full: false, historical: false, hasCompletedFullBaseline: false },
  ])('permits a safe reconciliation shape: %o', (input) => {
    expect(() => assertFullFederalEvidenceReconciliationSafe(input)).not.toThrow();
  });
});
