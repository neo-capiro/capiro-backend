import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmGovernmentProto } from './RelationshipsGovTab.js';
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
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

const TARGET = {
  id: 'ct-1',
  clientId: 'client-1',
  memberId: 'M000123',
  memberName: 'Rep. Dana Whitfield',
  sourceDirectory: 'congress',
  party: 'D',
  state: 'WA',
  chamber: 'House',
  committee: 'Armed Services',
  tier: 1,
  source: 'manual',
  addedByUserId: 'user-1',
  addedAt: '2026-05-04T00:00:00.000Z',
  representedFacilities: [{ id: 'fac-1', name: 'Seattle HQ' }],
};

function mockTargets(targets: unknown[] = [TARGET]) {
  getMock.mockImplementation((url: string) => {
    if (url === '/api/clients/client-1/targets') return Promise.resolve({ data: targets });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderGov() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/clients']}>
        <Routes>
          <Route
            path="/clients"
            element={
              <>
                <ClientCrmGovernmentProto client={client} />
                <LocationProbe />
              </>
            }
          />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
});

describe('ClientCrmGovernmentProto', () => {
  it('navigates to the Directory vNext congressional staff page when "View directory" is clicked', async () => {
    mockTargets();
    renderGov();

    await waitFor(() => expect(screen.getAllByText('Rep. Dana Whitfield').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'View directory' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/directory/congressional-staff');
  });
});

describe('ClientCrmGovernmentProto — real targets (items 11-14, wire-audit)', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('renders real targets in the cards and table instead of the TARGETS/GOV_ROWS fixtures (items 12/14)', async () => {
    mockTargets();
    renderGov();

    await waitFor(() => expect(screen.getAllByText('Rep. Dana Whitfield').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Tier 1').length).toBeGreaterThan(0);
    expect(screen.getByText('Seattle HQ')).toBeInTheDocument();

    // The TARGETS fixture's own cards must not leak through as if real.
    // ("Rep. Jane Doe" also appears in the deliberately-fixture network card,
    // so assert on strings unique to the targets fixture instead.)
    expect(screen.queryByText('Schedule member meeting before HASC markup')).not.toBeInTheDocument();
    expect(screen.queryByText('FY27 Ground Robotics Funding')).not.toBeInTheDocument();
    expect(screen.queryByText('3 active · from Strategies')).not.toBeInTheDocument();
  });

  it('opens the real target drawer with real record fields and no invented narrative (item 13)', async () => {
    mockTargets();
    renderGov();

    await waitFor(() => expect(screen.getAllByText('Rep. Dana Whitfield').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('Open target →')[0]!);

    // Real fields render...
    await waitFor(() => expect(screen.getByText('Target record')).toBeInTheDocument());
    // Also a card field label, hence getAllByText.
    expect(screen.getAllByText('Represents').length).toBeGreaterThan(0);
    // ...and the unbacked context is stated as absent rather than fabricated.
    expect(
      screen.getByText(/No linked strategy, ask or next action is recorded/),
    ).toBeInTheDocument();
  });

  it('wires "Add relationship" to the real canonical Targets tab (item 11)', async () => {
    mockTargets();
    renderGov();

    await waitFor(() => expect(screen.getAllByText('Rep. Dana Whitfield').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Add relationship' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/clients?clientId=client-1&tab=targets');
  });

  it('shows an honest empty state instead of the fixture when the client has no targets', async () => {
    mockTargets([]);
    renderGov();

    await waitFor(() =>
      expect(
        screen.getAllByText('No government targets have been added for this client yet.').length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryByText('FY27 Ground Robotics Funding')).not.toBeInTheDocument();
  });

  it('keeps the design fixture on screen while the targets query is loading', () => {
    getMock.mockImplementation(() => new Promise(() => {})); // never resolves
    renderGov();

    expect(screen.getByText('3 active · from Strategies')).toBeInTheDocument();
  });
});
