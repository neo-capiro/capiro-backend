import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ClientCrmWorkProto } from './WorkTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import type { StrategyDetail, StrategyListItem } from '../../../../pages/strategy/types.js';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock }),
}));
vi.mock('../../../../pages/strategy/members.js', () => ({
  useTenantMembers: () => ({ data: [] }),
  initialsOf: (name: string) => name.slice(0, 2).toUpperCase(),
  memberName: () => 'Team member',
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

const STRATEGY_ID = '11111111-1111-4111-8111-111111111111';

// Deliberately distinct from FEATURED_FIXTURE's title — the test asserts on
// this text specifically so it can only pass once the REAL detail query
// (not the design fixture, which happens to reuse that fixture's name) has
// actually resolved.
const REAL_TITLE = 'Army Robotics Procurement Push';

const listItem: StrategyListItem = {
  id: STRATEGY_ID,
  clientId: client.id,
  title: REAL_TITLE,
  type: 'appropriations',
  ownerUserId: 'user-1',
  createdByUserId: 'user-1',
  lastEditedByUserId: null,
  lastEditedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  nodeCount: 0,
};

const detail: StrategyDetail = {
  id: STRATEGY_ID,
  clientId: client.id,
  title: REAL_TITLE,
  type: 'appropriations',
  goal: 'Protect funding',
  meriContext: null,
  meriSummary: null,
  draftedByMeri: false,
  targetDate: '2026-09-30T00:00:00.000Z',
  ownerUserId: 'user-1',
  createdByUserId: 'user-1',
  lastEditedByUserId: null,
  lastEditedAt: null,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  nodes: [],
  artifacts: [],
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderWork() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/clients']}>
        <Routes>
          <Route
            path="/clients"
            element={
              <>
                <ClientCrmWorkProto client={client} />
                <LocationProbe />
              </>
            }
          />
          <Route path="/strategies/:id" element={<LocationProbe />} />
          <Route path="/strategies" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
});

describe('ClientCrmWorkProto', () => {
  it('shows a real empty CTA instead of the fixture strategy when the client has none', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/strategy-api/strategies') return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`unexpected get ${url}`));
    });
    renderWork();

    await waitFor(() => expect(screen.getByText('No strategies yet for this client')).toBeInTheDocument());
    expect(screen.queryByText('FY27 Ground Robotics Funding')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing scheduled in the next year.')).toBeInTheDocument();
  });

  it('opens the featured strategy\'s real page when "View timeline" is clicked', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/strategy-api/strategies') return Promise.resolve({ data: [listItem] });
      if (url === `/strategy-api/strategies/${STRATEGY_ID}`) return Promise.resolve({ data: detail });
      return Promise.reject(new Error(`unexpected get ${url}`));
    });
    renderWork();

    await screen.findByText(REAL_TITLE);
    fireEvent.click(screen.getByRole('button', { name: 'View timeline' }));

    expect(screen.getByTestId('location')).toHaveTextContent(`/strategies/${STRATEGY_ID}`);
  });
});

/* ── stat band (item 13, wire-audit "3 Compose extend") ───────────────────── */

const SECOND_ID = '22222222-2222-4222-8222-222222222222';

describe('ClientCrmWorkProto — stat band', () => {
  it('says the details failed — with a Retry — instead of showing fixture figures', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/strategy-api/strategies') return Promise.resolve({ data: [listItem] });
      // The client demonstrably HAS a strategy; only its detail fails.
      return Promise.reject(new Error('detail unavailable'));
    });
    renderWork();

    await waitFor(() =>
      expect(screen.getByText('Some strategy details failed to load')).toBeInTheDocument(),
    );
    // The strategy count is still known from the list itself.
    expect(screen.getByText('1')).toBeInTheDocument();
    // BAND_FIXTURE's figures must not stand in for this client's real numbers.
    expect(screen.queryByText('12')).not.toBeInTheDocument();
    expect(screen.queryByText('9')).not.toBeInTheDocument();
    // The failure state offers a way out, not a dash farm.
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Strategy details could not be read')).toBeInTheDocument();
  });

  it('states how many strategies were left out when only some details fail', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/strategy-api/strategies')
        return Promise.resolve({ data: [listItem, { ...listItem, id: SECOND_ID }] });
      if (url === `/strategy-api/strategies/${STRATEGY_ID}`) return Promise.resolve({ data: detail });
      return Promise.reject(new Error('detail unavailable'));
    });
    renderWork();

    // The figures below are real but SHORT — a low number that is silently
    // wrong is worse than one that says what it is missing.
    await waitFor(() =>
      expect(
        screen.getByText('1 of 2 strategies could not be read — figures below exclude them.'),
      ).toBeInTheDocument(),
    );
  });

  it('keeps the design band while the details are still loading', () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/strategy-api/strategies') return Promise.resolve({ data: [listItem] });
      return new Promise(() => {}); // detail never resolves
    });
    renderWork();

    expect(screen.queryByText('1 strategy could not be read.')).not.toBeInTheDocument();
  });
});

/* ── "4 New capability" rows 8-9 ──────────────────────────────────────────── */

describe('ClientCrmWorkProto — unbacked status signals', () => {
  it('renders no "On track" pill or readiness meter over real strategies', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/strategy-api/strategies') return Promise.resolve({ data: [listItem] });
      if (url === `/strategy-api/strategies/${STRATEGY_ID}`) return Promise.resolve({ data: detail });
      return Promise.reject(new Error(`unexpected get ${url}`));
    });
    renderWork();

    await screen.findByText(REAL_TITLE);
    // The Strategy API carries no completion or readiness state, so neither
    // may appear beside a real strategy name.
    expect(screen.queryByText('On track')).not.toBeInTheDocument();
    expect(screen.queryByText('54% ready')).not.toBeInTheDocument();
    expect(screen.queryByText('38% ready')).not.toBeInTheDocument();
  });

  it('renders skeletons while loading — never the design fixture or its "On track" pill', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/strategy-api/strategies') return new Promise(() => {}); // never resolves
      return new Promise(() => {});
    });
    renderWork();

    // The fixture strategy must not masquerade as this client's data while
    // the list is still in flight — and "On track" is an assertion nothing
    // in the Strategy API can back.
    expect(screen.queryByText('FY27 Ground Robotics Funding')).not.toBeInTheDocument();
    expect(screen.queryByText('On track')).not.toBeInTheDocument();
  });
});
