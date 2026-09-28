import { render, screen, within } from '@testing-library/react';
import type { ResearchPortfolioAnalyticsDto } from '@capiro/shared';
import { describe, expect, it } from 'vitest';
import { ResearchPortfolioProjectionView } from './ResearchPortfolioAnalyticsPanel.js';

function projection(overrides: Partial<ResearchPortfolioAnalyticsDto> = {}): ResearchPortfolioAnalyticsDto {
  return {
    portfolioId: 'portfolio-1',
    portfolioRevision: 7,
    calculationVersion: 'research-portfolio-analytics-v1',
    availability: 'unavailable',
    totals: [],
    contributions: [{
      contributionId: 'contribution-1',
      memberId: 'member-1',
      targetKind: 'program_element',
      targetId: '0601234N',
      label: 'Autonomy PE',
      basis: null,
      value: null,
      disposition: 'missing',
      reason: 'No published compatible observation',
      sourceObservationId: null,
      sourceRevisionIds: [],
      evidence: [],
      dedupKey: null,
      overlapsContributionId: null,
    }],
    coverage: {
      eligibleMembers: 1,
      supportedMembers: 0,
      includedContributions: 0,
      excludedContributions: 0,
      overlapContributions: 0,
      unavailableMembers: 1,
    },
    limitations: ['No supported current funding observation'],
    observedAt: '2026-09-26T00:00:00.000Z',
    readAt: '2026-09-26T00:00:01.000Z',
    ...overrides,
  };
}

describe('ResearchPortfolioProjectionView', () => {
  it('does not manufacture a zero total when every member is unavailable', () => {
    render(<ResearchPortfolioProjectionView analytics={projection()} />);
    expect(screen.getByText(/No qualified compatible total is available/i)).toBeVisible();
    expect(screen.queryByText('Compatible qualified totals')).not.toBeInTheDocument();
    const ledger = screen.getByRole('table', { name: 'Contribution and exclusion ledger' });
    expect(within(ledger).getByText('—')).toBeVisible();
    expect(within(ledger).getByText('missing')).toBeVisible();
  });

  it('renders exact compatible values and overlap dispositions from the server ledger', () => {
    const basis = {
      requestEdition: 'PB27',
      fundingFiscalYear: 2027,
      stage: 'request',
      metric: 'funding' as const,
      unit: 'usd_millions' as const,
      currency: 'USD' as const,
      priceBasis: null,
      knownAt: '2026-03-01T00:00:00.000Z',
    };
    render(<ResearchPortfolioProjectionView analytics={projection({
      availability: 'partial',
      totals: [{ basis, value: '208.900000', contributionCount: 1 }],
      contributions: [
        { ...projection().contributions[0]!, basis, value: '208.900000', disposition: 'included', reason: 'Qualified canonical fact' },
        { ...projection().contributions[0]!, contributionId: 'overlap-1', basis, value: '208.900000', disposition: 'overlap', reason: 'Parent already included', overlapsContributionId: 'contribution-1' },
      ],
      coverage: { eligibleMembers: 2, supportedMembers: 2, includedContributions: 1, excludedContributions: 0, overlapContributions: 1, unavailableMembers: 0 },
    })} />);
    const totals = screen.getByRole('table', { name: 'Compatible qualified totals' });
    expect(within(totals).getByText('208.900000 usd millions')).toBeVisible();
    expect(screen.getByText('overlap')).toBeVisible();
  });
});


describe('corrected v2 projection compatibility', () => {
  it('keeps partial qualified funding visible with its source limitation', () => {
    const basis = {
      requestEdition: 'PB27', fundingFiscalYear: 2027, stage: 'request', metric: 'funding' as const,
      unit: 'usd_millions' as const, currency: 'USD' as const, priceBasis: null, knownAt: null,
    };
    render(<ResearchPortfolioProjectionView analytics={projection({
      calculationVersion: 'research-portfolio-analytics-v2', availability: 'partial',
      totals: [{ basis, value: '2.5', contributionCount: 1 }],
      contributions: [{ ...projection().contributions[0]!, basis, value: '2.5', disposition: 'included', sourceDisposition: 'partial', reason: 'Included with partial evidence' }],
    })} />);
    expect(screen.getByText('partial')).toBeVisible();
    expect(screen.getByText('Included with partial evidence')).toBeVisible();
    expect(within(screen.getByRole('table', { name: 'Compatible qualified totals' })).getByText('2.5 usd millions')).toBeVisible();
  });

  it('shows retained unit costs without manufacturing a total', () => {
    const basis = {
      requestEdition: 'PB27', fundingFiscalYear: 2027, stage: 'request', metric: 'unit_cost' as const,
      unit: 'usd_millions_per_unit' as const, currency: 'USD' as const, priceBasis: null, knownAt: null,
    };
    render(<ResearchPortfolioProjectionView analytics={projection({
      calculationVersion: 'research-portfolio-analytics-v2', availability: 'partial', totals: [],
      contributions: [
        { ...projection().contributions[0]!, basis, value: '2', disposition: 'incompatible', sourceDisposition: 'observed', reason: 'Unit cost is nonadditive' },
        { ...projection().contributions[0]!, contributionId: 'cost-2', basis, value: '3', disposition: 'incompatible', sourceDisposition: 'observed', reason: 'Unit cost is nonadditive' },
      ],
    })} />);
    expect(screen.queryByRole('table', { name: 'Compatible qualified totals' })).not.toBeInTheDocument();
    const ledger = screen.getByRole('table', { name: 'Contribution and exclusion ledger' });
    expect(within(ledger).getByText('2')).toBeVisible();
    expect(within(ledger).getByText('3')).toBeVisible();
    expect(within(ledger).queryByText('5')).not.toBeInTheDocument();
  });
});
