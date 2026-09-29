import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FundingOpportunityResultRow } from './FundingOpportunityV2ResultCard.js';
import { FundingOpportunityV2ResultCard } from './FundingOpportunityV2ResultCard.js';

const baseRow = (
  overrides: Partial<FundingOpportunityResultRow> = {},
): FundingOpportunityResultRow => ({
  id: 'sam_gov:notice-1',
  source: 'sam_gov',
  sourceRecordId: 'notice-1',
  title: 'Autonomous systems sustainment',
  agency: 'Department of the Army',
  sourceUrl: 'https://sam.gov/opp/notice-1',
  type: 'solicitation',
  lifecycle: 'active',
  postedDate: '2026-08-01',
  deadline: '2026-09-24T17:00:00-04:00',
  closeOrArchiveDate: null,
  isPursuable: true,
  summary: 'Source-backed sustainment and integration work.',
  naicsCodes: ['541715'],
  pscCodes: [],
  setAside: null,
  applicantTypes: [],
  geography: ['Warren, MI'],
  value: 48000000,
  valueBasis: 'source_backed',
  sourceFacts: {
    provenance: 'cached source record',
    responseDeadLine: 'Sep 24, 2026 17:00 ET',
    solicitation: 'W911QY-26-R-0148',
    sourceReference: 'W911QY-26-R-0148',
    responseDeadline: {
      value: '2026-09-24T17:00:00-04:00',
      precision: 'timestamp',
      timezone: 'America/New_York',
      sourceRaw: 'Sep 24, 2026 17:00 ET',
      unavailableReason: null,
    },
    postedDate: '2026-08-01',
    sourceUpdated: '2026-08-19',
    ceiling: '$48,000,000',
  },
  relevanceScore: 78,
  matchedSignals: [
    { signal: 'naicsExact', strength: 'strong', matchedOn: '541715 — Research and development' },
    { signal: 'agencyHistory', strength: 'strong', matchedOn: 'ACC-DTA · 2 awards since FY24' },
    { signal: 'capabilityKeyword', strength: 'moderate', matchedOn: 'vehicle sustainment' },
  ],
  eligibility: { state: 'eligible', reason: 'Open competition.' },
  clientId: 'client-1',
  ...overrides,
});

const props = (row: FundingOpportunityResultRow) => ({
  row,
  clientName: 'Overland AI',
  matched: true,
  onOpenDetail: vi.fn(),
  onQuick: vi.fn(),
  onExternal: vi.fn(),
  onAction: vi.fn(),
});

afterEach(() => cleanup());

describe('FundingOpportunityV2ResultCard evidence and source facts', () => {
  test('keeps collapsed evidence concise and reveals the full persisted evidence on demand', () => {
    render(<FundingOpportunityV2ResultCard {...props(baseRow())} />);

    expect(document.querySelector('.fo-v2-result-evidence > strong')?.textContent).toContain(
      'support this match.',
    );
    expect(document.querySelector('.fo-v2-result-evidence > code')?.textContent).toContain(
      '541715',
    );
    expect(screen.queryByText('vehicle sustainment')).toBeNull();
    expect(screen.getByRole('button', { name: /Evidence \(3\) · relevance 78/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Evidence \(3\) · relevance 78/ }));

    expect(screen.getByText('Capability keywords')).toBeTruthy();
    for (const signal of baseRow().matchedSignals) {
      expect(screen.getByText(signal.matchedOn)).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Hide evidence' })).toBeTruthy();
  });

  test('preserves a scalar date-only source fact as the normalized deadline date', () => {
    const row = baseRow({
      deadline: '2026-09-24',
      sourceFacts: {
        provenance: 'source',
        responseDeadLine: '2026-09-24',
        solicitation: 'W911QY-26-R-0148',
      },
    });
    render(<FundingOpportunityV2ResultCard {...props(row)} />);
    expect(screen.getByText('Sep 24')).toBeTruthy();
    expect(document.querySelector('.fo-v2-result-when small')?.textContent).toContain('2026');
    expect(document.querySelector('.fo-v2-result-when small')?.textContent).not.toContain(
      '2026-09-24',
    );
  });

  test.each([
    ['2026-09-25T03:00:00Z', '2026-09-24T23:00:00-04:00'],
    ['2026-09-25T01:00:00Z', 'Sep 24, 2026 21:00 EDT'],
  ])('uses the provider cutoff zone across UTC midnight (%s / %s)', (normalized, raw) => {
    vi.useFakeTimers({ now: new Date('2026-09-16T12:00:00.000Z') });
    try {
      const row = baseRow({
        deadline: normalized,
        sourceFacts: {
          provenance: 'source',
          responseDeadline: normalized,
          responseDeadLine: raw,
          solicitation: 'W911QY-26-R-0148',
        },
      });
      render(<FundingOpportunityV2ResultCard {...props(row)} />);
      expect(screen.getByText('Sep 24')).toBeTruthy();
      expect(screen.getByText('8d')).toBeTruthy();
      expect(document.querySelector('.fo-v2-result-when small')?.textContent).toContain('2026');
    } finally {
      vi.useRealTimers();
    }
  });

  test('renders source-backed facts without fixture-only reference or invented generic rows', () => {
    render(<FundingOpportunityV2ResultCard {...props(baseRow())} />);

    expect(document.querySelector('.fo-v2-result-meta > span')?.textContent).toContain(
      'W911QY-26-R-0148',
    );
    expect(screen.getByText('Ceiling')).toBeTruthy();
    expect(screen.getByText('$48,000,000')).toBeTruthy();
    expect(screen.queryByText('Archive date')).toBeNull();
    expect(screen.queryByText('Applicant eligibility')).toBeNull();
    expect(screen.queryByText('Source record id')).toBeNull();
    expect(screen.getByText('RESPONSE DEADLINE')).toBeTruthy();
    expect(screen.getByText('Sep 24')).toBeTruthy();
    expect(document.querySelector('.fo-v2-result-when small')?.textContent).toContain('2026');
    expect(document.querySelector('.fo-v2-result-when small')?.textContent).toContain('17:00 ET');
  });

  test('keeps the source pill palette separate from the semantic card rule', () => {
    const row = baseRow({
      source: 'sam_gov',
      matchedSignals: [{ signal: 'naicsExact', strength: 'strong', matchedOn: '541715' }],
    });
    const { unmount } = render(<FundingOpportunityV2ResultCard {...props(row)} />);
    expect(document.querySelector('.fo-v2-pill--cyan')).toBeTruthy();
    expect(document.querySelector('.fo-v2-result-rule--plain')).toBeTruthy();
    unmount();

    render(
      <FundingOpportunityV2ResultCard
        {...props(baseRow({
          matchedSignals: [{ signal: 'agencyHistory', strength: 'strong', matchedOn: 'ACC-DTA' }],
        }))}
      />,
    );
    expect(document.querySelector('.fo-v2-result-rule--brand')).toBeTruthy();
  });

  test('maps the supported agency-history display label to the semantic card rule', () => {
    render(
      <FundingOpportunityV2ResultCard
        {...props(baseRow({
          matchedSignals: [{ signal: 'Agency history', strength: 'strong', matchedOn: 'ACC-DTA' }],
        }))}
      />,
    );

    expect(document.querySelector('.fo-v2-result-rule--brand')).toBeTruthy();
  });

  test('all mode preserves actions but suppresses ranked evidence and recommendation tags', () => {
    const row = baseRow({ clientId: null, matchedSignals: [], relevanceScore: null });
    render(<FundingOpportunityV2ResultCard {...props(row)} matched={false} />);

    expect(screen.getByText('Relevance is not calculated in all-opportunities mode.')).toBeTruthy();
    expect(screen.queryByText('MATCH EVIDENCE')).toBeNull();
    expect(screen.queryByText(/Evidence \(/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Save opportunity' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Quick details' })).toBeTruthy();
  });
});
