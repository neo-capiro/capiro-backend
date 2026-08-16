import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmIntelligenceProto } from './IntelligenceTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock }),
}));

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

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

describe('ClientCrmIntelligenceProto — legislative panel', () => {
  it('navigates to LegiWatch when "Open full board" is clicked', () => {
    render(
      <MemoryRouter initialEntries={['/clients']}>
        <Routes>
          <Route
            path="/clients"
            element={
              <>
                <ClientCrmIntelligenceProto client={client} view="legislative" />
                <LocationProbe />
              </>
            }
          />
          <Route path="/legiwatch" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Open full board →'));

    expect(screen.getByTestId('location')).toHaveTextContent('/legiwatch');
  });
});

function renderDistrict() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ClientCrmIntelligenceProto client={client} view="district" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const FACILITY = {
  id: 'fac-1',
  clientId: 'client-1',
  name: 'Seattle HQ',
  addressLine: null,
  city: 'Seattle',
  state: 'WA',
  zip: null,
  congressionalDistrict: '07',
  districtSource: 'geocoder',
  employeeCount: 248,
  notes: null,
  latitude: 47.61,
  longitude: -122.33,
  stateHouseDistrict: null,
  stateSenateDistrict: null,
  geocodedAt: '2026-01-01T00:00:00.000Z',
  geocodeStatus: 'matched',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const NEXUS_LINKED = {
  linked: true,
  contractorNames: ['Overland AI Inc'],
  totalAwards: 3,
  totalAmount: 12_000_000,
  districtCount: 1,
  unmappedAmount: 0,
  districts: [
    {
      district: 'WA-07',
      state: 'WA',
      districtNumber: '07',
      awardCount: 3,
      totalAmount: 12_000_000,
      demographics: null,
      representatives: { house: null, senate: [] },
    },
  ],
  disclaimer: 'Figures reflect confirmed contractor mappings only.',
};

const REPRESENTATION = [
  {
    facility: { id: 'fac-1', name: 'Seattle HQ', city: 'Seattle', state: 'WA' },
    representation: {
      unresolved: false,
      federal: {
        house: { bioguideId: 'X000000', fullName: 'Rep. Jamie Rivera', party: 'D', state: 'WA', district: 7, chamber: 'House' },
        senate: [],
      },
      state: { lower: null, upper: null },
    },
  },
];

function mockDistrictApis(overrides: { facilities?: unknown; nexus?: unknown; representation?: unknown } = {}) {
  const facilities = overrides.facilities ?? [FACILITY];
  const nexus = overrides.nexus ?? NEXUS_LINKED;
  const representation = overrides.representation ?? REPRESENTATION;
  getMock.mockImplementation((url: string) => {
    if (url === '/api/clients/client-1/facilities') return Promise.resolve({ data: facilities });
    if (url === '/api/intelligence/clients/client-1/district-nexus-spend') return Promise.resolve({ data: nexus });
    if (url === '/api/clients/client-1/representation') return Promise.resolve({ data: representation });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe('ClientCrmIntelligenceProto — district panel (items 1-2, wire-audit)', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('binds the map, rail, and selected-district panel to real facilities/district-nexus/representation data', async () => {
    mockDistrictApis();
    renderDistrict();

    await waitFor(() => expect(screen.getByText('Rep. Jamie Rivera (D) · House')).toBeInTheDocument());
    expect(screen.getByText('$12,000,000')).toBeInTheDocument();
    expect(screen.getAllByText('WA-07').length).toBeGreaterThan(0);

    // The design fixture's own facility/rep must not leak through as if real.
    expect(screen.queryByText('Seattle headquarters')).not.toBeInTheDocument();
    expect(screen.queryByText('Rep. Jane Doe · House · HASC')).not.toBeInTheDocument();
    expect(screen.queryByText('8 districts · 92% coverage')).not.toBeInTheDocument();
  });

  it('wires the facilities & representation table per-facility', async () => {
    mockDistrictApis();
    renderDistrict();

    await waitFor(() => expect(screen.getByText('Confirmed')).toBeInTheDocument());
    expect(screen.getAllByText('Seattle HQ').length).toBeGreaterThan(0);
  });

  it('shows an honest empty state instead of the fixture when the client has no facilities', async () => {
    mockDistrictApis({ facilities: [] });
    renderDistrict();

    await waitFor(() =>
      expect(screen.getByText('No facilities recorded for this client')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Seattle headquarters')).not.toBeInTheDocument();
  });

  it('keeps the design fixture on screen while the facilities query is still loading', () => {
    getMock.mockImplementation(() => new Promise(() => {})); // never resolves
    renderDistrict();

    expect(screen.getByText('8 districts · 92% coverage')).toBeInTheDocument();
    expect(screen.getByText('Seattle headquarters')).toBeInTheDocument();
  });
});
