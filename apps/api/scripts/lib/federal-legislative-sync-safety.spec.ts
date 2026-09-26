import {
  assertFederalEvidenceOutboxDrainEnabled,
  assertFullFederalEvidenceReconciliationSafe,
} from './federal-legislative-sync-safety.js';

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

describe('federal evidence outbox drain safety', () => {
  it('rejects a committed drain unless Package 4 is explicitly enabled', () => {
    expect(() =>
      assertFederalEvidenceOutboxDrainEnabled({ commit: true, featureEnabled: 'false' }),
    ).toThrow('FEDERAL_LEGISLATIVE_EVIDENCE_DISABLED');
    expect(() =>
      assertFederalEvidenceOutboxDrainEnabled({ commit: true, featureEnabled: undefined }),
    ).toThrow('FEDERAL_LEGISLATIVE_EVIDENCE_DISABLED');
  });

  it('allows committed delivery when Package 4 is explicitly enabled', () => {
    expect(() =>
      assertFederalEvidenceOutboxDrainEnabled({ commit: true, featureEnabled: 'true' }),
    ).not.toThrow();
  });

  it('preserves dry-run behavior while Package 4 is disabled', () => {
    expect(() =>
      assertFederalEvidenceOutboxDrainEnabled({ commit: false, featureEnabled: 'false' }),
    ).not.toThrow();
  });
});
