import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PeResearchView } from './PeResearchView.js';
const get = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get }) }));
const detail = {
  identityKey: 'fpds:award/123',
  title: 'Owned acquisition',
  sourceRecordId: '123',
  recordKind: 'award',
  sourceSystem: 'fpds',
  status: 'active',
  responseDeadline: null,
  parentIdentityKey: null,
  sourceVersion: 'r2',
  contentHash: 'abc',
  sourceObservedAt: '2026-09-01',
  recordedAt: '2026-09-01',
  sourceUrl: null,
  extractedFields: {},
  associations: [],
};
const action = {
  transactionIdentityKey: 'actual-action',
  modificationNumber: 'M7',
  sourceTransactionId: 'T7',
  actionDate: '2026-09-01',
  signedObligationDelta: '0',
  correctsIdentityKey: null,
  sourceUrl: null,
};
const gap = {
  id: 'actual-gap',
  reason: 'Exact document unavailable',
  coverageState: 'partial',
  detail: 'Retained source gap',
};
function Nav() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate('?view=relationships&relationshipStatus=historical')}>
      Historical relationships
    </button>
  );
}
function mount(url = '/program-elements/research?view=acquisition&record=fpds%3Aaward%2F123') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <PeResearchView />
        <Nav />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
function routes(actions: () => Promise<unknown>, coverage: () => Promise<unknown>) {
  get.mockImplementation(async (url: string) => {
    if (url.endsWith('/actions')) return { data: await actions() };
    if (url === '/api/defense-budget/acquisition-coverage') return { data: await coverage() };
    if (url.includes('/acquisition-records/')) return { data: detail };
    return { data: { items: [], total: 0, page: 1, limit: 100 } };
  });
}
describe('Native acquisition truth and URL-filter identity', () => {
  beforeEach(() => {
    get.mockReset();
  });
  it('does not assert empty actions or no gaps while requests are pending, then permits successful empty responses', async () => {
    let resolveActions!: (value: unknown) => void, resolveCoverage!: (value: unknown) => void;
    routes(
      () =>
        new Promise((resolve) => {
          resolveActions = resolve;
        }),
      () =>
        new Promise((resolve) => {
          resolveCoverage = resolve;
        }),
    );
    mount();
    await screen.findByText('Owned acquisition');
    expect(screen.queryByText('No source actions are available.')).not.toBeInTheDocument();
    expect(screen.queryByText(/No open coverage gaps recorded/)).not.toBeInTheDocument();
    expect(screen.getByText('Loading actions…')).toBeInTheDocument();
    expect(screen.getByText('Loading acquisition coverage…')).toBeInTheDocument();
    await act(async () => {
      resolveActions([]);
      resolveCoverage({ items: [] });
    });
    expect(await screen.findByText('No source actions are available.')).toBeInTheDocument();
    expect(screen.getByText(/No open coverage gaps recorded/)).toBeInTheDocument();
  });
  it('reports initial acquisition lookup failures as unknown rather than empty', async () => {
    routes(
      async () => {
        throw Error('action down');
      },
      async () => {
        throw Error('coverage down');
      },
    );
    mount();
    await screen.findByText('Owned acquisition');
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    expect(screen.queryByText('No source actions are available.')).not.toBeInTheDocument();
    expect(screen.queryByText(/No open coverage gaps recorded/)).not.toBeInTheDocument();
  });
  it('retains successful action and gap rows after failed refresh and labels freshness unknown', async () => {
    let fail = false;
    routes(
      async () => {
        if (fail) throw Error('action down');
        return [action];
      },
      async () => {
        if (fail) throw Error('coverage down');
        return { items: [gap] };
      },
    );
    const client = mount();
    await screen.findByText('M7');
    await screen.findByText('Exact document unavailable');
    fail = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['defense-research'] });
    });
    expect(await screen.findByText(/Current availability is unknown/)).toBeInTheDocument();
    expect(screen.getByText(/Current open gaps are unknown/)).toBeInTheDocument();
    expect(screen.getByText('M7')).toBeInTheDocument();
    expect(screen.getByText('Exact document unavailable')).toBeInTheDocument();
  });
  it('keys the relationship projection by URL status and fetches the newly requested status', async () => {
    get.mockImplementation(async (_url: string, options: { params: { status: string } }) => ({
      data: {
        items: [
          {
            id: options.params.status,
            from: { label: options.params.status + ' office' },
            to: { label: 'Program' },
            relation: 'manages',
            validity: 'current',
            observationRevision: null,
            sourceStated: true,
            derived: false,
            evidence: [],
          },
        ],
        total: 1,
        page: 1,
        limit: 200,
      },
    }));
    mount('/program-elements/research?view=relationships&relationshipStatus=active');
    await screen.findByText('active office');
    fireEvent.click(screen.getByRole('button', { name: 'Historical relationships' }));
    expect(await screen.findByText('historical office')).toBeInTheDocument();
    expect(get).toHaveBeenLastCalledWith('/api/defense-budget/relationships', {
      params: { status: 'historical', includeSpeculative: false, limit: 200 },
    });
  });
});
