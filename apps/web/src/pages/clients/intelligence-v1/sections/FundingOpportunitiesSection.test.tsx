import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { FundingOpportunitiesSection } from './FundingOpportunitiesSection.js';
import type { ClientFundingOpportunitySummary } from '../../../intelligence/opportunities/funding-opportunities-api.js';
import { SECTION_ORDER } from '../mappers.js';

let flag = { enabled: true, ready: true };
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => flag,
  useIntelFeatureEnabled: () => flag.enabled,
}));

const apiGetMock = vi.fn();
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGetMock }) }));

const CLIENT = 'client-1';

function summary(
  partial: Partial<ClientFundingOpportunitySummary> = {},
): ClientFundingOpportunitySummary {
  return {
    clientId: CLIENT,
    counts: {
      activeGrants: 0,
      activeContracts: 0,
      saved: 0,
      pursuing: 0,
      dismissed: 0,
      deadlinesIn30Days: 0,
    },
    nextDeadline: null,
    topGrants: [],
    topContracts: [],
    missingProfileFields: [],
    freshness: [
      {
        source: 'grants_gov',
        verb: 'sync-grants',
        label: 'Grants.gov opportunities',
        lastSyncedAt: '2026-07-28T00:00:00.000Z',
        neverSynced: false,
        lastRunDegraded: false,
        recordCount: 800,
        activeRecordCount: 120,
      },
    ],
    emptyReason: 'no_match_above_threshold',
    emptyExplanation: 'Opportunities were evaluated and none cleared the relevance floor.',
    generatedAt: '2026-07-28T12:00:00.000Z',
    ...partial,
  };
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>
        <FundingOpportunitiesSection clientId={CLIENT} />
      </AntApp>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  apiGetMock.mockReset();
  flag = { enabled: true, ready: true };
});

describe('the card ALWAYS renders when the feature is available', () => {
  test('it renders at ZERO matches, with an explanation', async () => {
    // A card that disappears is indistinguishable from a feature the workspace
    // does not have, and it gives the user nothing to act on.
    apiGetMock.mockResolvedValue({ data: summary() });
    renderSection();
    expect(await screen.findByTestId('funding-opportunities-section')).toBeInTheDocument();
    const empty = await screen.findByTestId('fo-client-empty');
    expect(empty.textContent).toMatch(/none cleared the relevance floor/i);
  });

  test('it lists the profile gaps that would fix an empty state', async () => {
    apiGetMock.mockResolvedValue({
      data: summary({
        emptyReason: 'client_profile_too_thin',
        emptyExplanation: 'Nothing any matching signal reads.',
        missingProfileFields: [
          {
            field: 'naicsCodes',
            label: 'NAICS codes',
            impact: 'NAICS is the strongest contract-matching signal.',
            href: '/clients?client=client-1',
          },
          {
            field: 'contractorIdentity',
            label: 'Confirmed federal contractor identity',
            impact: 'Without one, this client has no award history.',
            href: '/settings/intelligence-mappings?source=contracting&clientId=client-1',
          },
        ],
      }),
    });
    renderSection();
    const empty = await screen.findByTestId('fo-client-empty');
    expect(empty.textContent).toMatch(/NAICS codes/);
    expect(empty.textContent).toMatch(/no award history/);
  });

  test('the contractor-identity gap deep-links to the CLIENT-SCOPED mapping flow', async () => {
    apiGetMock.mockResolvedValue({
      data: summary({
        missingProfileFields: [
          {
            field: 'contractorIdentity',
            label: 'Confirmed federal contractor identity',
            impact: 'Without one, this client has no award history.',
            href: '/settings/intelligence-mappings?source=contracting&clientId=client-1',
          },
        ],
      }),
    });
    renderSection();
    const link = await screen.findByRole('link', { name: /Confirmed federal contractor identity/i });
    // Both params matter: the source preselects the picker, the clientId is what
    // stops the reviewer having to search for the client again.
    expect(link).toHaveAttribute(
      'href',
      '/settings/intelligence-mappings?source=contracting&clientId=client-1',
    );
  });

  test('a request failure renders an error, never an empty card', async () => {
    apiGetMock.mockRejectedValue(new Error('boom'));
    renderSection();
    const err = await screen.findByTestId('fo-client-error', {}, { timeout: 8000 });
    expect(err.textContent).toMatch(/request failure, not an empty result/i);
    expect(screen.queryByTestId('fo-client-empty')).not.toBeInTheDocument();
  });

  test('an un-flagged tenant gets nothing rather than an unactionable explanation', async () => {
    flag = { enabled: false, ready: true };
    apiGetMock.mockResolvedValue({ data: summary() });
    renderSection();
    await waitFor(() =>
      expect(screen.queryByTestId('funding-opportunities-section')).not.toBeInTheDocument(),
    );
    expect(apiGetMock).not.toHaveBeenCalled();
  });
});

describe('counts and links', () => {
  test('grants and contracts are counted separately, with no blended total', async () => {
    apiGetMock.mockResolvedValue({
      data: summary({
        counts: {
          activeGrants: 3,
          activeContracts: 7,
          saved: 2,
          pursuing: 1,
          dismissed: 0,
          deadlinesIn30Days: 4,
        },
      }),
    });
    renderSection();
    // The section SHELL renders before the query resolves (that is the point of
    // the always-render card), so await a data-dependent node rather than the
    // shell, or the assertions run against the skeleton.
    await screen.findByText('Active grants');
    const section = screen.getByTestId('funding-opportunities-section');
    expect(section).toHaveTextContent('Active contracts');
    expect(section).toHaveTextContent('Saved');
    expect(section).toHaveTextContent('Pursuing');
    // No money at all on this card.
    expect(section.textContent ?? '').not.toContain('$');
  });

  test('it links to the full surface, scoped to this client', async () => {
    apiGetMock.mockResolvedValue({ data: summary() });
    renderSection();
    const link = await screen.findByRole('link', { name: /Open Funding Opportunities/i });
    expect(link).toHaveAttribute('href', '/intelligence/opportunities?clientId=client-1');
  });

  test('the card says these are future pursuits, not awarded funding', async () => {
    apiGetMock.mockResolvedValue({ data: summary() });
    renderSection();
    const section = await screen.findByTestId('funding-opportunities-section');
    expect(section).toHaveTextContent(/Future\s+competitions, not awarded funding/i);
  });

  test('source freshness is shown on the card too', async () => {
    apiGetMock.mockResolvedValue({ data: summary() });
    renderSection();
    expect(await screen.findByText(/Grants\.gov opportunities: current to/i)).toBeInTheDocument();
  });
});

describe('section registration', () => {
  test('Funding Opportunities is its own section, placed before District Nexus', () => {
    // Ordering carries the distinction: this section is future pursuits, the next
    // one is money already awarded into a district. It is not a District Nexus
    // sub-panel.
    const ids = SECTION_ORDER.map((s) => s.id);
    expect(ids).toContain('funding-opportunities');
    expect(ids.indexOf('funding-opportunities')).toBeLessThan(ids.indexOf('district-nexus'));
  });

  test('section numbers stay contiguous after the insertion', () => {
    expect(SECTION_ORDER.map((s) => s.num)).toEqual([1, 2, 3, 4, 5]);
  });
});
