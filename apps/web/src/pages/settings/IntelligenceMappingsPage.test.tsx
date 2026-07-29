import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { IntelligenceMappingsPage } from './IntelligenceMappingsPage.js';

let search = '';
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(search), vi.fn()],
}));

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPatchMock = vi.fn();
vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock, patch: apiPatchMock }),
}));

const CLIENT = '00000000-0000-0000-0000-000000000010';
const CONTRACTOR = '11111111-1111-1111-1111-111111111111';

const MAPPINGS = [
  {
    id: 'm-1',
    clientId: CLIENT,
    clientName: 'Acme Defense',
    source: 'contracting',
    externalId: CONTRACTOR,
    externalName: 'ACME DEFENSE LLC',
    confidence: 0.98,
    confirmed: true,
    matchBasis: 'exact_uei',
    matchTier: 1,
    relationshipType: 'self',
    rollUpAwards: true,
    reviewStatus: 'confirmed',
    rejectionReason: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  },
  {
    id: 'm-2',
    clientId: CLIENT,
    clientName: 'Acme Defense',
    source: 'contracting',
    externalId: '22222222-2222-2222-2222-222222222222',
    externalName: 'ACME HOLDINGS',
    confidence: 0.62,
    confirmed: false,
    // A row written before the basis column existed.
    matchBasis: null,
    matchTier: null,
    relationshipType: null,
    rollUpAwards: null,
    reviewStatus: 'candidate',
    rejectionReason: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  },
  {
    id: 'm-3',
    clientId: 'other-client',
    clientName: 'Other Client',
    source: 'lda',
    externalId: '4321',
    externalName: 'SOMEBODY ELSE',
    confidence: 0.9,
    confirmed: false,
    matchBasis: 'fuzzy_name',
    matchTier: 4,
    relationshipType: null,
    rollUpAwards: null,
    reviewStatus: 'candidate',
    rejectionReason: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  },
];

const CANDIDATES = {
  client: { id: CLIENT, name: 'Acme Defense', uei: 'ABC123456789', cageCode: null },
  candidates: [
    {
      contractorId: CONTRACTOR,
      contractorName: 'ACME DEFENSE LLC',
      confidence: 0.98,
      autoConfirmEligible: true,
      matchBasis: 'exact_uei',
      matchTier: 1,
      explanation: {
        basis: 'exact_uei',
        tier: 1,
        exactIdentifiers: { uei: 'ABC123456789' },
        normalizedClientName: 'acme defense',
        normalizedCandidateName: 'acme defense',
        corroborators: ['uei'],
        conflicts: [],
        awardCount: null,
        totalObligated: 4_200_000,
        latestAwardDate: null,
        sourceSyncedAt: '2026-07-20T00:00:00.000Z',
      },
      mapping: null,
    },
    {
      contractorId: '33333333-3333-3333-3333-333333333333',
      contractorName: 'ACME AEROSPACE GROUP',
      confidence: 0.55,
      autoConfirmEligible: false,
      matchBasis: 'fuzzy_name',
      matchTier: 4,
      explanation: {
        basis: 'fuzzy_name',
        tier: 4,
        exactIdentifiers: {},
        normalizedClientName: 'acme defense',
        normalizedCandidateName: 'acme aerospace',
        corroborators: [],
        conflicts: ['This contractor record carries no UEI, so the client’s UEI cannot confirm it.'],
        awardCount: null,
        totalObligated: null,
        latestAwardDate: null,
        sourceSyncedAt: null,
      },
      mapping: null,
    },
  ],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>
        <IntelligenceMappingsPage />
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
  apiPostMock.mockReset();
  apiPatchMock.mockReset();
  apiPostMock.mockResolvedValue({ data: {} });
  apiPatchMock.mockResolvedValue({ data: {} });
  search = '';
  apiGetMock.mockImplementation(async (url: string) => {
    if (url === '/api/intelligence/mappings') return { data: MAPPINGS };
    if (url === '/api/clients') {
      return {
        data: [
          { id: CLIENT, name: 'Acme Defense' },
          { id: 'other-client', name: 'Other Client' },
        ],
      };
    }
    if (url.includes('contractor-candidates')) return { data: CANDIDATES };
    return { data: [] };
  });
});

describe('client-scoped entry from a profile CTA', () => {
  test('?clientId= preselects the client and filters to its rows immediately', async () => {
    search = `?source=contracting&clientId=${CLIENT}`;
    renderPage();
    // Another client's mapping must not be in the list — the reviewer arrived
    // scoped to one client and should not have to search again.
    await waitFor(() => expect(screen.queryByText('SOMEBODY ELSE')).not.toBeInTheDocument());
    expect(await screen.findByText('ACME DEFENSE LLC')).toBeInTheDocument();
  });

  test('?clientId= opens the contractor candidate panel for that client', async () => {
    search = `?clientId=${CLIENT}`;
    renderPage();
    expect(await screen.findByTestId('contractor-candidate-panel')).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith(
      `/api/intelligence/mappings/${CLIENT}/contractor-candidates`,
    );
  });

  test('with no ?clientId the candidate panel is not shown', async () => {
    renderPage();
    await screen.findByText('ACME DEFENSE LLC');
    expect(screen.queryByTestId('contractor-candidate-panel')).not.toBeInTheDocument();
  });
});

describe('the match explanation replaces a bare confidence percentage', () => {
  test('the mapping table shows a basis, not just a number', async () => {
    renderPage();
    expect(await screen.findByText('Exact UEI')).toBeInTheDocument();
  });

  test('a row written before the basis column existed says so honestly', async () => {
    // Back-filling 'exact_uei' or 'self' across the table would invent a reviewed
    // assertion nobody made.
    renderPage();
    expect(await screen.findByText('Basis not recorded')).toBeInTheDocument();
  });

  test('the candidate panel shows identifiers, normalized names and CONFLICTS', async () => {
    search = `?clientId=${CLIENT}`;
    renderPage();
    // The panel SHELL renders before its query resolves, so await a
    // data-dependent node or the assertions run against the skeleton.
    await screen.findByText('ACME AEROSPACE GROUP');
    const panel = screen.getByTestId('contractor-candidate-panel');
    expect(panel).toHaveTextContent('uei: ABC123456789');
    expect(panel).toHaveTextContent('normalized: acme defense');
    expect(panel).toHaveTextContent('normalized: acme aerospace');
    // The part a percentage can never convey.
    expect(panel).toHaveTextContent(/carries no UEI/i);
  });

  test('an unheld award count reads "not held", never 0', async () => {
    search = `?clientId=${CLIENT}`;
    renderPage();
    await screen.findByText('ACME AEROSPACE GROUP');
    const panel = screen.getByTestId('contractor-candidate-panel');
    expect(panel).toHaveTextContent('Awards: not held');
  });

  test('a client with no UEI on file is told that blocks automatic confirmation', async () => {
    search = `?clientId=${CLIENT}`;
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/intelligence/mappings') return { data: MAPPINGS };
      if (url === '/api/clients') return { data: [{ id: CLIENT, name: 'Acme Defense' }] };
      if (url.includes('contractor-candidates')) {
        return { data: { ...CANDIDATES, client: { ...CANDIDATES.client, uei: null } } };
      }
      return { data: [] };
    });
    renderPage();
    expect(await screen.findByText('No UEI on file')).toBeInTheDocument();
  });
});

describe('the exact-identifier action', () => {
  test('it posts to the identifier-matching route, not resolve-all', async () => {
    apiPostMock.mockResolvedValue({
      data: { totalClients: 2, mappingsCreated: 3, autoConfirmed: 1, needsReview: 2 },
    });
    renderPage();
    const button = await screen.findByRole('button', { name: /Find exact identifier matches/i });
    button.click();
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/intelligence/mappings/match-contractor-identifiers',
      ),
    );
    expect(apiPostMock).not.toHaveBeenCalledWith('/api/intelligence/resolve-all');
  });

  test('Resolve All Clients still exists alongside it', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: /Resolve All Clients/i })).toBeInTheDocument();
  });

  test('bulk confirmation is disabled for a contracting-only review queue', async () => {
    search = '?source=contracting';
    renderPage();
    await screen.findByText('ACME DEFENSE LLC');
    expect(screen.getByRole('button', { name: /Confirm All/i })).toBeDisabled();
  });

  test('confirming a candidate pins it with an explicit relationship type', async () => {
    search = `?clientId=${CLIENT}`;
    apiPostMock.mockResolvedValue({ data: {} });
    renderPage();
    await screen.findByText('ACME AEROSPACE GROUP');
    const confirm = screen.getAllByRole('button', { name: /Confirm as this client/i })[0]!;
    confirm.click();
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        `/api/intelligence/mappings/${CLIENT}/manual`,
        expect.objectContaining({
          source: 'contracting',
          externalId: CONTRACTOR,
          relationshipType: 'self',
          rollUpAwards: true,
        }),
      ),
    );
  });

  test('a reviewer can confirm a subsidiary and explicitly roll its awards up', async () => {
    search = `?clientId=${CLIENT}`;
    renderPage();
    await screen.findByText('ACME AEROSPACE GROUP');
    const other = screen.getAllByRole('button', { name: 'Other…' })[0]!;
    fireEvent.click(other);
    const item = await screen.findByText(/Confirm as subsidiary · roll awards up/i);
    fireEvent.click(item);
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        `/api/intelligence/mappings/${CLIENT}/manual`,
        expect.objectContaining({
          source: 'contracting',
          relationshipType: 'subsidiary',
          rollUpAwards: true,
        }),
      ),
    );
  });

  test('rejecting a contractor candidate writes a durable rejection', async () => {
    search = `?clientId=${CLIENT}`;
    renderPage();
    await screen.findByText('ACME AEROSPACE GROUP');
    const reject = screen.getAllByRole('button', { name: 'Reject' })[0]!;
    fireEvent.click(reject);
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        `/api/intelligence/mappings/${CLIENT}/reject-candidate`,
        expect.objectContaining({
          source: 'contracting',
          externalId: CONTRACTOR,
        }),
      ),
    );
  });
});

describe('honest failure', () => {
  test('a candidate-panel load failure renders an error, not an empty panel', async () => {
    search = `?clientId=${CLIENT}`;
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/intelligence/mappings') return { data: MAPPINGS };
      if (url === '/api/clients') return { data: [{ id: CLIENT, name: 'Acme Defense' }] };
      if (url.includes('contractor-candidates')) throw new Error('boom');
      return { data: [] };
    });
    renderPage();
    const err = await screen.findByTestId('contractor-candidates-error', {}, { timeout: 8000 });
    expect(err.textContent).toMatch(/request failure, not an empty result/i);
  });
});
