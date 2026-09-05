import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DistrictPriorityIntelligencePanelVNext } from './DistrictPriorityIntelligencePanelVNext.js';
import {
  DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE,
  type ClientPriorityIntelligenceResponse,
} from '../../../pages/intelligence/district-nexus/priority-intelligence-api.js';
import type { ReactNode } from 'react';

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock }),
}));

// The panel is a pure data-rendering rail; keep the DOM shallow.
vi.mock('../../components/feedback/index.js', () => ({
  CapiroSkeleton: ({ height }: { height: number; width?: string }): ReactNode => (
    <div data-testid="skeleton" style={{ height }} />
  ),
}));

function renderPanel(clientId: string | null = 'client-1', districtKey: string | null = 'VA-10') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <DistrictPriorityIntelligencePanelVNext clientId={clientId} districtKey={districtKey} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function baseResponse(
  overrides: Partial<ClientPriorityIntelligenceResponse> = {},
): ClientPriorityIntelligenceResponse {
  return {
    clientId: 'client-1',
    clientName: 'Acme Defense',
    districtKey: 'VA-10',
    state: 'VA',
    district: '10',
    member: {
      houseMemberBioguideIds: ['B001'],
      senatorBioguideIds: ['S001', 'S002'],
      representation: 'VA-10 · 2 senator(s)',
    },
    nexusStrength: { score: 42, coveragePercent: 60, scoreVersion: 'district-nexus-v2' },
    strategicRelevance: null,
    dataCoverage: null,
    priorityIntelligence: {
      cpfCds: {
        availability: {
          status: 'loaded',
          reason: null,
          lastIngestRunAt: '2026-08-31T00:00:00.000Z',
          loadedFiscalYears: [2026],
        },
        districtRequests: [],
        clientRequests: [],
        memberHistoricalPriorities: [],
        warnings: [],
      },
      federalProperty: {
        availability: {
          status: 'not_loaded',
          reason: 'No GSA FRPP source run has ever been executed in this environment',
          lastSuccessAt: null,
          lastFailureAt: null,
          lastError: null,
        },
        detailedAssetCount: null,
        detailedSquareFeetTotal: null,
        summarizedInstallationCount: 0,
        ownedCount: null,
        leasedCount: null,
        agenciesByAssetCount: [],
        topAssets: [],
        fiscalYears: [],
        warnings: [],
      },
      sectorSignals: {
        availability: {
          status: 'not_loaded',
          sources: [
            {
              source: 'acs',
              dataset: 'acs',
              sourceYear: null,
              lastSyncedAt: null,
              lastRunStatus: 'no_run',
            },
            {
              source: 'cbp',
              dataset: 'cbp',
              sourceYear: null,
              lastSyncedAt: null,
              lastRunStatus: 'no_run',
            },
            {
              source: 'lodes',
              dataset: 'lodes',
              sourceYear: null,
              lastSyncedAt: null,
              lastRunStatus: 'no_run',
            },
          ],
        },
        metrics: [],
        warnings: [],
      },
      recentChanges: [],
    },
    strongestPrioritySignals: [],
    missingPrioritySources: [],
    freshness: [],
    geographyVintage: { boundaryCongress: null, conflict: false, detail: null },
    warnings: [],
    computedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('DistrictPriorityIntelligencePanelVNext', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
  });

  test('fetches the R4 endpoint for the client + district', async () => {
    apiGetMock.mockResolvedValue({ data: baseResponse() });
    renderPanel();
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith(
        `/api/intelligence/clients/client-1/district-nexus-v2/priority-intelligence?state=VA&district=10`,
      );
    });
  });

  test('shows a hint (not data) when no client or district is selected', () => {
    renderPanel(null, 'VA-10');
    expect(screen.getByText(/Select a client/i)).toBeTruthy();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('flag-off / not-enabled 404 renders as not enabled — never as empty data', async () => {
    apiGetMock.mockRejectedValue({ response: { status: 404 } });
    renderPanel();
    await waitFor(() => {
      expect(
        screen.getByText(new RegExp(`${DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE}`)),
      ).toBeTruthy();
    });
    expect(screen.getByText(/not enabled for this tenant/i)).toBeTruthy();
  });

  test('a non-404 failure renders as an error — other rails are unaffected', async () => {
    apiGetMock.mockRejectedValue({ response: { status: 500 } });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/could not load/i)).toBeTruthy();
    });
    expect(screen.getByText(/error, not empty data/i)).toBeTruthy();
  });

  test('loading renders skeletons, never fixture rows', () => {
    apiGetMock.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
    expect(screen.queryByText(/House CPF/i)).toBeNull();
    expect(screen.queryByText(/Senate CDS/i)).toBeNull();
  });

  test('unavailable CPF/CDS corpus differs from a real empty result', async () => {
    apiGetMock.mockResolvedValue({
      data: baseResponse({
        priorityIntelligence: {
          ...baseResponse().priorityIntelligence,
          cpfCds: {
            ...baseResponse().priorityIntelligence.cpfCds,
            availability: {
              status: 'unavailable',
              reason: 'corpus_not_loaded',
              lastIngestRunAt: null,
              loadedFiscalYears: [],
            },
          },
        },
      }),
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getAllByText(/CPF\/CDS corpus not ingested/i).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/No member request history attributable/i)).toBeNull();
  });

  test('loaded corpus with zero attributable requests reads as a real empty result', async () => {
    apiGetMock.mockResolvedValue({ data: baseResponse() });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/No member request history attributable/i)).toBeTruthy();
    });
    expect(screen.queryByText(/corpus not ingested/i)).toBeNull();
  });

  test('requested and final amounts are separately labeled; absent final is not $0', async () => {
    const d = baseResponse();
    d.priorityIntelligence.cpfCds.districtRequests = [
      {
        requestId: 'req-1',
        chamber: 'house',
        requestType: 'cpf',
        fiscalYear: 2026,
        requesterName: 'Rep. Smith',
        recipientName: 'Smithville Water Authority',
        projectTitle: 'Water treatment upgrades',
        districtKey: 'VA-10',
        geography: { basis: 'house_district', state: 'VA', district: '10' },
        requestedAmountUsd: 500000,
        finalAmountUsd: null,
        amountStageRaw: 'house_requested',
        appropriationsAccountRaw: null,
        sourceOccurrenceCount: 1,
        occurrences: [],
        clientAttribution: null,
      },
    ];
    apiGetMock.mockResolvedValue({ data: d });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Requested:/i)).toBeTruthy();
    });
    expect(screen.getByText(/\$500,000/)).toBeTruthy();
    expect(screen.getByText(/no final\/enacted amount recorded/i)).toBeTruthy();
    // Final label must not appear without a final amount.
    expect(screen.queryByText(/Final\/enacted:/i)).toBeNull();
  });

  test('senate statewide requests are labeled statewide, house requests are not', async () => {
    const d = baseResponse();
    d.priorityIntelligence.cpfCds.districtRequests = [
      {
        requestId: 'req-h',
        chamber: 'house',
        requestType: 'cpf',
        fiscalYear: 2026,
        requesterName: 'Rep. Smith',
        recipientName: 'Local Plant',
        projectTitle: 'Equipment',
        districtKey: 'VA-10',
        geography: { basis: 'house_district', state: 'VA', district: '10' },
        requestedAmountUsd: 100000,
        finalAmountUsd: null,
        amountStageRaw: 'house_requested',
        appropriationsAccountRaw: null,
        sourceOccurrenceCount: 1,
        occurrences: [],
        clientAttribution: null,
      },
      {
        requestId: 'req-s',
        chamber: 'senate',
        requestType: 'cds',
        fiscalYear: 2026,
        requesterName: 'Sen. Jones',
        recipientName: 'Statewide Grid',
        projectTitle: 'Grid resilience',
        districtKey: null,
        geography: { basis: 'senate_statewide', state: 'VA' },
        requestedAmountUsd: 2000000,
        finalAmountUsd: null,
        amountStageRaw: 'senate_requested',
        appropriationsAccountRaw: null,
        sourceOccurrenceCount: 1,
        occurrences: [],
        clientAttribution: null,
      },
    ];
    apiGetMock.mockResolvedValue({ data: d });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Senate CDS \(statewide\)/i)).toBeTruthy();
    });
    expect(screen.getByText(/House CPF/i)).toBeTruthy();
  });

  test('client-linked requests are visually distinct from public context', async () => {
    const d = baseResponse();
    d.priorityIntelligence.cpfCds.districtRequests = [
      {
        requestId: 'req-1',
        chamber: 'house',
        requestType: 'cpf',
        fiscalYear: 2026,
        requesterName: 'Rep. Smith',
        recipientName: 'Smithville Water Authority',
        projectTitle: 'Water treatment upgrades',
        districtKey: 'VA-10',
        geography: { basis: 'house_district', state: 'VA', district: '10' },
        requestedAmountUsd: 500000,
        finalAmountUsd: null,
        amountStageRaw: 'house_requested',
        appropriationsAccountRaw: null,
        sourceOccurrenceCount: 1,
        occurrences: [],
        clientAttribution: { method: 'confirmed_client_intel_mapping', evidenceId: 'm-1' },
      },
    ];
    d.priorityIntelligence.cpfCds.clientRequests = d.priorityIntelligence.cpfCds.districtRequests;
    apiGetMock.mockResolvedValue({ data: d });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Linked to this client/i)).toBeTruthy();
    });
    // The same request renders in the public district list AND the linked list.
    expect(screen.getAllByText(/linked to client/i).length).toBe(2);
  });

  test('GSA unavailable (no run) differs from GSA empty (source loaded, no rows here)', async () => {
    apiGetMock.mockResolvedValue({ data: baseResponse() });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/GSA FRPP data not ingested/i)).toBeTruthy();
    });

    const d = baseResponse();
    d.priorityIntelligence.federalProperty = {
      ...d.priorityIntelligence.federalProperty,
      availability: {
        status: 'loaded',
        reason: null,
        lastSuccessAt: '2026-09-01T00:00:00.000Z',
        lastFailureAt: null,
        lastError: null,
      },
      detailedAssetCount: 0,
      fiscalYears: [2024],
    };
    apiGetMock.mockResolvedValue({ data: d });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/No FRPP assets recorded for this district/i)).toBeTruthy();
    });
    expect(screen.getByText(/Real empty, not missing data/i)).toBeTruthy();
  });

  test('a failed GSA source run renders as unavailable, not empty', async () => {
    const d = baseResponse();
    d.priorityIntelligence.federalProperty = {
      ...d.priorityIntelligence.federalProperty,
      availability: {
        status: 'error',
        reason: 'Latest GSA FRPP source run failed',
        lastSuccessAt: null,
        lastFailureAt: '2026-09-01T00:00:00.000Z',
        lastError: 'download failed',
      },
    };
    apiGetMock.mockResolvedValue({ data: d });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/GSA FRPP last source run failed/i)).toBeTruthy();
    });
  });

  test('GSA rows with no boundary congress carry the source-unknown warning', async () => {
    const d = baseResponse();
    d.priorityIntelligence.federalProperty = {
      ...d.priorityIntelligence.federalProperty,
      availability: {
        status: 'loaded',
        reason: null,
        lastSuccessAt: '2026-09-01T00:00:00.000Z',
        lastFailureAt: null,
        lastError: null,
      },
      detailedAssetCount: 3,
      detailedSquareFeetTotal: 120000,
      ownedCount: 2,
      leasedCount: 1,
      fiscalYears: [2024],
      warnings: [
        'FRPP rows carry no boundary Congress for their district column — district vintage is source-unknown (not inferred).',
      ],
    };
    apiGetMock.mockResolvedValue({ data: d });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/district vintage is source-unknown/i)).toBeTruthy();
    });
    // Source year + provenance is visible with the numbers.
    expect(screen.getByText(/GSA FRPP FY2024 public dataset/i)).toBeTruthy();
  });

  test('sector metrics always carry the public-context disclaimer (never client figures)', async () => {
    const d = baseResponse();
    d.priorityIntelligence.sectorSignals = {
      availability: {
        status: 'loaded',
        sources: [
          {
            source: 'cbp',
            dataset: 'cbp',
            sourceYear: 2023,
            lastSyncedAt: '2026-08-22T00:00:00.000Z',
            lastRunStatus: 'success',
          },
        ],
      },
      metrics: [
        {
          family: 'manufacturing_industry',
          label: 'Manufacturing (NAICS 31–33)',
          source: 'cbp',
          dataset: 'cbp',
          sourceYear: 2023,
          boundaryCongress: 119,
          naicsCode: '336413',
          metricKey: 'employment',
          metricValue: 14280,
          unit: 'employees',
          sourceRecordId: 'row-1',
          sourceUrl: null,
          observedAt: null,
          lastSyncedAt: '2026-08-22T00:00:00.000Z',
        },
      ],
      warnings: [],
    };
    apiGetMock.mockResolvedValue({ data: d });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Manufacturing \(NAICS 31–33\)/i)).toBeTruthy();
    });
    expect(screen.getByText(/public district context, not client figures/i)).toBeTruthy();
    expect(screen.getByText(/CBP \(2023\)/)).toBeTruthy();
  });

  test('stale sector sources render a visible stale warning', async () => {
    const d = baseResponse();
    d.priorityIntelligence.sectorSignals = {
      availability: {
        status: 'stale',
        sources: [
          {
            source: 'cbp',
            dataset: 'cbp',
            sourceYear: 2018,
            lastSyncedAt: '2026-08-22T00:00:00.000Z',
            lastRunStatus: 'success',
          },
        ],
      },
      metrics: [],
      warnings: ['Some public economic sources are stale — see freshness.'],
    };
    apiGetMock.mockResolvedValue({ data: d });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Some economic sources are stale/i)).toBeTruthy();
    });
  });

  test('a partial rail failure keeps successful groups visible (missing-sources hint, not blank)', async () => {
    const d = baseResponse();
    d.missingPrioritySources = ['GSA FRPP federal property data not ingested'];
    apiGetMock.mockResolvedValue({ data: d });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Missing sources:/i)).toBeTruthy();
    });
    // Other rails still render their own honest states.
    expect(screen.getByText(/GSA FRPP data not ingested/i)).toBeTruthy();
    expect(screen.getByText(/Public economic metrics not ingested/i)).toBeTruthy();
  });
});
