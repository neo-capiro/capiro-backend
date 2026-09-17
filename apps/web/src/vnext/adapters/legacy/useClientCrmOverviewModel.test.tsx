import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useClientCrmOverviewModel } from './useClientCrmOverviewModel.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Items 9-10 (wire-audit "2 Wire existing APIs"): the Overview tab's Intel
 * pulse / Work pulse composition. These three behaviors were bugs in an
 * already-real pipeline (facility rows miscounted as districts, a hardcoded
 * `lastRefresh: null`, and a "Next 30 days" label with no upper bound) —
 * not new wiring — so these tests exercise the hook's derivation directly
 * rather than a rendered card.
 */

const getMock = vi.hoisted(() => vi.fn());
let fundingEnabled = true;
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock }),
}));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => ({ enabled: feature === 'funding_opportunities' ? fundingEnabled : feature !== 'funding_opportunities_pipeline', ready: true }),
}));

let opportunityResponse: Record<string, unknown> = { total: 0, counts: { grants: 0, contracts: 0, active: 0, closed: 0 }, opportunities: [], freshness: [], provenance: [], profileGaps: null };

const client: Client = {
  id: 'client-1',
  name: 'Overland AI',
  website: 'overland.ai',
  description: null,
  productDescription: null,
  primaryContactName: null,
  primaryContactEmail: null,
  primaryContactPhone: null,
  logoS3Key: null,
  logoContentType: null,
  logoUploadedAt: null,
  intakeData: null,
  status: 'active',
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
};

function Harness({ clientOverride = client }: { clientOverride?: Client } = {}) {
  const model = useClientCrmOverviewModel(clientOverride);
  return (
    <div>
      <div data-testid="funding-total">{model.intelligence.opportunities.kind === 'value' ? model.intelligence.opportunities.value : 'unavailable'}</div>
      <div data-testid="districts">
        {model.intelligence.districts.kind === 'value' ? model.intelligence.districts.value : 'unavailable'}
      </div>
      <div data-testid="last-refresh">{model.intelligence.lastRefresh ?? 'null'}</div>
      {/* Settle signal: real once the strategies list + its node detail have
          loaded, so a milestones assertion of "0" can't pass vacuously on the
          transient pre-fetch state (also 0, since strategyDetails starts empty). */}
      <div data-testid="current-strategies">
        {model.work.currentStrategies.kind === 'value' ? model.work.currentStrategies.value : 'unavailable'}
      </div>
      <div data-testid="milestones">
        {model.work.upcomingMilestones.kind === 'value' ? model.work.upcomingMilestones.value : 'unavailable'}
      </div>
      <div data-testid="federal-awards">
        {model.federalFootprint.federalAwards.kind === 'value'
          ? `${model.federalFootprint.federalAwards.format ?? 'none'}:${model.federalFootprint.federalAwards.value}`
          : 'unavailable'}
      </div>
    </div>
  );
}

function renderModel(clientOverride = client) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Harness clientOverride={clientOverride} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
    queryClient,
  };
}

const NOW = Date.now();
const isoInDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

function strategyNode(overrides: Record<string, unknown>) {
  return {
    id: 'node-1',
    strategyId: 'strat-1',
    kind: 'milestone',
    subject: 'client',
    title: 'A milestone',
    note: null,
    ownerUserId: null,
    status: 'active',
    startsOn: isoInDays(-5),
    endsOn: null,
    openEnded: false,
    dependsOnIds: [],
    provenance: null,
    targetRef: null,
    meriAuthored: false,
    ...overrides,
  };
}

function mockEndpoints(overrides: {
  facilities?: unknown[];
  strategies?: unknown[];
  strategyDetails?: Record<string, unknown>;
  clientProfile?: unknown;
} = {}) {
  const facilities = overrides.facilities ?? [];
  const strategies = overrides.strategies ?? [];
  const strategyDetails = overrides.strategyDetails ?? {};
  const clientProfile = overrides.clientProfile ?? {};

  getMock.mockImplementation((url: string) => {
    if (url === '/api/intelligence/actions') return Promise.resolve({ data: { data: [], total: 0 } });
    if (url === '/api/engagement/meetings') return Promise.resolve({ data: [] });
    if (url === '/intel-api/feature-flags') return Promise.resolve({ data: {} });
    if (url === '/strategy-api/strategies') return Promise.resolve({ data: strategies });
    if (url.startsWith('/strategy-api/strategies/')) {
      const id = url.split('/').pop()!;
      return Promise.resolve({ data: strategyDetails[id] ?? null });
    }
    if (url === '/api/intelligence/clients/client-1/tracker/summary') {
      return Promise.resolve({ data: { boardCount: 0, unread: 0 } });
    }
    if (url.startsWith('/api/intelligence/opportunities/v2/search?')) {
      return Promise.resolve({ data: opportunityResponse });
    }
    if (url === '/api/intelligence/clients/client-1/pipeline') {
      return Promise.resolve({ data: { clientId: 'client-1', counts: { stages: [] }, cards: [], cardsTruncated: false } });
    }
    if (url === '/api/clients/client-1/facilities') return Promise.resolve({ data: facilities });
    if (url === '/api/intelligence/comment-alerts') return Promise.resolve({ data: { alerts: [] } });
    if (url === '/api/intelligence/client-profile/client-1') return Promise.resolve({ data: clientProfile });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

beforeEach(() => {
  getMock.mockReset();
  fundingEnabled = true;
  opportunityResponse = { total: 0, counts: { grants: 0, contracts: 0, active: 0, closed: 0 }, opportunities: [], freshness: [], provenance: [], profileGaps: null };
});

describe('useClientCrmOverviewModel — Intel pulse districts (item 9)', () => {
  it('counts DISTINCT congressional districts, not facility rows', async () => {
    mockEndpoints({
      facilities: [
        { id: 'f1', clientId: 'client-1', name: 'HQ', state: 'WA', congressionalDistrict: '07', latitude: 47.6, longitude: -122.3, employeeCount: 200 },
        { id: 'f2', clientId: 'client-1', name: 'Annex', state: 'WA', congressionalDistrict: '07', latitude: 47.61, longitude: -122.31, employeeCount: 20 },
        { id: 'f3', clientId: 'client-1', name: 'Austin site', state: 'TX', congressionalDistrict: '31', latitude: 30.5, longitude: -97.7, employeeCount: 40 },
      ],
    });
    renderModel();

    // 3 facilities, but only 2 distinct districts (WA-07 shared by two facilities).
    await waitFor(() => expect(screen.getByTestId('districts')).toHaveTextContent('2'));
  });
});

describe('useClientCrmOverviewModel — canonical funding aggregate', () => {
  it('shows canonical zero after the V2 search resolves, not a transient unavailable state', async () => {
    opportunityResponse = { total: 0, counts: { grants: 0, contracts: 0, active: 0, closed: 0 }, opportunities: [], freshness: [], provenance: [], profileGaps: null };
    mockEndpoints();
    renderModel();
    await waitFor(() => expect(screen.getByTestId('funding-total')).toHaveTextContent('0'));
  });
  it('shows an unknown aggregate as unavailable after the V2 search resolves', async () => {
    opportunityResponse = { total: null, counts: { grants: null, contracts: null, active: null, closed: null }, opportunities: [], freshness: [], provenance: [], profileGaps: null };
    mockEndpoints();
    renderModel();
    await waitFor(() => expect(getMock.mock.calls.some(([url]) => String(url).startsWith('/api/intelligence/opportunities/v2/search?'))).toBe(true));
    await waitFor(() => expect(screen.getByTestId('funding-total')).toHaveTextContent('unavailable'));
  });
  it('does not expose a cached total after the master funding flag turns off', async () => {
    opportunityResponse = { total: 13, counts: { grants: 8, contracts: 5, active: 13, closed: 0 }, opportunities: [{}], freshness: [], provenance: [], profileGaps: null };
    mockEndpoints();
    const rendered = renderModel();
    await waitFor(() => expect(screen.getByTestId('funding-total')).toHaveTextContent('13'));
    fundingEnabled = false;
    rendered.rerender(<QueryClientProvider client={rendered.queryClient}><MemoryRouter><Harness /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByTestId('funding-total')).toHaveTextContent('unavailable');
  });
});

describe('useClientCrmOverviewModel — Intel pulse lastRefresh (item 9)', () => {
  it('computes a real lastRefresh from actual query fetch times instead of a hardcoded null', async () => {
    mockEndpoints();
    renderModel();

    await waitFor(() => expect(screen.getByTestId('last-refresh')).not.toHaveTextContent('null'));
  });
});

describe('useClientCrmOverviewModel — Work pulse upcoming milestones (item 10)', () => {
  it('counts a milestone due within 30 days', async () => {
    mockEndpoints({
      strategies: [{ id: 'strat-1', clientId: 'client-1', title: 'FY27 push', type: 'appropriations', ownerUserId: 'u1', createdByUserId: 'u1', lastEditedByUserId: null, lastEditedAt: null, createdAt: '2026-01-01T00:00:00.000Z', nodeCount: 1 }],
      strategyDetails: {
        'strat-1': {
          id: 'strat-1', clientId: 'client-1', title: 'FY27 push', type: 'appropriations', goal: null,
          meriContext: null, meriSummary: null, draftedByMeri: false, targetDate: null, ownerUserId: 'u1',
          createdByUserId: 'u1', lastEditedByUserId: null, lastEditedAt: null, archivedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', artifacts: [],
          nodes: [strategyNode({ id: 'near', endsOn: isoInDays(10) })],
        },
      },
    });
    renderModel();

    await waitFor(() => expect(screen.getByTestId('milestones')).toHaveTextContent('1'));
  });

  it('does NOT count a milestone due in 60 days, despite the "Next 30 days" label previously having no upper bound', async () => {
    mockEndpoints({
      strategies: [{ id: 'strat-1', clientId: 'client-1', title: 'FY27 push', type: 'appropriations', ownerUserId: 'u1', createdByUserId: 'u1', lastEditedByUserId: null, lastEditedAt: null, createdAt: '2026-01-01T00:00:00.000Z', nodeCount: 1 }],
      strategyDetails: {
        'strat-1': {
          id: 'strat-1', clientId: 'client-1', title: 'FY27 push', type: 'appropriations', goal: null,
          meriContext: null, meriSummary: null, draftedByMeri: false, targetDate: null, ownerUserId: 'u1',
          createdByUserId: 'u1', lastEditedByUserId: null, lastEditedAt: null, archivedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', artifacts: [],
          nodes: [strategyNode({ id: 'far', endsOn: isoInDays(60) })],
        },
      },
    });
    renderModel();

    // Wait for the strategy detail to have actually loaded before trusting
    // "0" — that value is also the transient pre-fetch state.
    await waitFor(() => expect(screen.getByTestId('current-strategies')).toHaveTextContent('1'));
    expect(screen.getByTestId('milestones')).toHaveTextContent('0');
  });

  it('does NOT count an open-ended milestone with no end date (no bounded date to verify "next 30 days" against)', async () => {
    mockEndpoints({
      strategies: [{ id: 'strat-1', clientId: 'client-1', title: 'FY27 push', type: 'appropriations', ownerUserId: 'u1', createdByUserId: 'u1', lastEditedByUserId: null, lastEditedAt: null, createdAt: '2026-01-01T00:00:00.000Z', nodeCount: 1 }],
      strategyDetails: {
        'strat-1': {
          id: 'strat-1', clientId: 'client-1', title: 'FY27 push', type: 'appropriations', goal: null,
          meriContext: null, meriSummary: null, draftedByMeri: false, targetDate: null, ownerUserId: 'u1',
          createdByUserId: 'u1', lastEditedByUserId: null, lastEditedAt: null, archivedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', artifacts: [],
          nodes: [strategyNode({ id: 'open-ended', endsOn: null, openEnded: true })],
        },
      },
    });
    renderModel();

    await waitFor(() => expect(screen.getByTestId('current-strategies')).toHaveTextContent('1'));
    expect(screen.getByTestId('milestones')).toHaveTextContent('0');
  });
});

describe('useClientCrmOverviewModel — federal awards is money, not a count', () => {
  /**
   * Regression: RTX's Overview printed `68973208559.3` under "FEDERAL AWARDS".
   *
   * `federal_contractor.total_contracts` is Decimal(18,2) DOLLARS of obligations,
   * but this slot was built as a `'count'`. Two things then compounded: the count
   * branch is the wrong unit, and because Prisma serializes Decimal as a STRING,
   * `formatNumber`'s `toLocaleString` was a no-op on it — so the cell showed the
   * raw digits with not even a thousands separator.
   */
  it('reports a decimal-string total as currency (the real API wire shape)', async () => {
    mockEndpoints({
      clientProfile: {
        // A STRING, exactly as Prisma Decimal arrives over JSON.
        contracting: { matched: true, totalContracts: '68973208559.30' },
      },
    });
    renderModel();

    await waitFor(() =>
      expect(screen.getByTestId('federal-awards')).toHaveTextContent('currency:68973208559.3'),
    );
  });

  it('reports a numeric total as currency too', async () => {
    mockEndpoints({
      clientProfile: { contracting: { matched: true, totalContracts: 84_200_000 } },
    });
    renderModel();

    await waitFor(() =>
      expect(screen.getByTestId('federal-awards')).toHaveTextContent('currency:84200000'),
    );
  });

  it('stays unavailable — never $0 — when the contractor record is unmatched', async () => {
    mockEndpoints({ clientProfile: { contracting: { matched: false, totalContracts: null } } });
    renderModel();

    await waitFor(() =>
      expect(screen.getByTestId('federal-awards')).toHaveTextContent('unavailable'),
    );
  });

  it('stays unavailable when a matched record carries an unparseable total', async () => {
    mockEndpoints({
      clientProfile: { contracting: { matched: true, totalContracts: 'not-a-number' } },
    });
    renderModel();

    await waitFor(() =>
      expect(screen.getByTestId('federal-awards')).toHaveTextContent('unavailable'),
    );
  });
});
