import { researchPortfolioAnalyticsInternals } from './research-portfolio-analytics.service.js';
import { researchPortfolioOutputInternals } from './research-portfolio-output.service.js';

describe('Research Portfolio Phase 9 financial and output invariants', () => {
  it('adds decimal strings exactly without converting missing values to zero', () => {
    expect(researchPortfolioAnalyticsInternals.sumDecimals(['208.9', '2.5', '-0.4'])).toBe('211');
    expect(researchPortfolioAnalyticsInternals.sumDecimals(['0', '0.0001'])).toBe('0.0001');
  });

  it('builds stable identities independently of object key order', () => {
    expect(researchPortfolioAnalyticsInternals.hash({ b: 2, a: 1 }))
      .toBe(researchPortfolioAnalyticsInternals.hash({ a: 1, b: 2 }));
  });

  it('neutralizes spreadsheet formulas in every exported cell', () => {
    for (const value of ['=1+1', '+SUM(A:A)', '-2+3', '@cmd', '\tformula']) {
      expect(researchPortfolioOutputInternals.formulaSafe(value)).toBe(`"'${value.replace(/"/g, '""')}"`);
    }
    expect(researchPortfolioOutputInternals.formulaSafe('ordinary')).toBe('"ordinary"');
  });

  it('emits deterministic CSV containing explicit unavailable rows', () => {
    const projection = {
      portfolioId: 'p', portfolioRevision: 1, calculationVersion: 'research-portfolio-analytics-v1' as const,
      availability: 'unavailable' as const, totals: [],
      contributions: [{
        contributionId: 'c', memberId: 'm', targetKind: 'award' as const, targetId: '=bad', label: null,
        basis: null, value: null, disposition: 'unavailable' as const, reason: 'No qualified reader',
        sourceObservationId: null, sourceRevisionIds: [], evidence: [], dedupKey: null, overlapsContributionId: null,
      }],
      coverage: { eligibleMembers: 1, supportedMembers: 0, includedContributions: 0, excludedContributions: 0, overlapContributions: 0, unavailableMembers: 1 },
      limitations: ['missing is not zero'], observedAt: '2026-09-26T00:00:00.000Z', readAt: '2026-09-26T00:00:00.000Z',
    };
    const csv = researchPortfolioOutputInternals.projectionCsv(projection).toString('utf8');
    expect(csv).toContain('"unavailable"');
    expect(csv).toContain('"\'=bad"');
    expect(csv).not.toContain('undefined');
    const summaryOnly = researchPortfolioOutputInternals
      .projectionCsv(projection, ['analytics'], false)
      .toString('utf8');
    expect(summaryOnly).toContain('"analytics","summary"');
    expect(summaryOnly).not.toContain('"contributions"');
    expect(summaryOnly).not.toContain('"sources"');
  });
});
