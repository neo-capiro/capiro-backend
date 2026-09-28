import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PeCompareView } from './PeCompareView.js';
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const identity = vi.hoisted(() => ({
  userId: 'actor-1',
  orgId: 'org-1',
  actAsTenantSlug: null as string | null,
}));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => identity }));
vi.mock('../../../state/impersonation.js', () => ({ useImpersonation: () => identity }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  localStorage.clear();
  identity.userId = 'actor-1';
  identity.orgId = 'org-1';
  identity.actAsTenantSlug = null;
});
describe('saved Defense Compare reopening', () => {
  it('shows immutable captured zero and subjects instead of fetching current live comparison', async () => {
    const subjects = [
      { type: 'program_element', id: '0600000A' },
      { type: 'program_element', id: '0600001A' },
    ];
    const basis = {
      requestEdition: null,
      fundingFiscalYear: null,
      stage: null,
      metric: null,
      unit: null,
      currency: null,
      priceBasis: null,
      asOfDate: null,
      periodStart: null,
      periodEnd: null,
    };
    const saved = {
      id: 'saved-1',
      name: 'Captured comparison',
      revision: 1,
      portfolioId: null,
      currentVersion: {
        version: 1,
        capturedAt: '2026-09-28T00:00:00Z',
        captureKnownAt: '2026-09-28T00:00:00Z',
        knownAtSupport: 'capture_only',
        subjects,
        selection: {
          mode: 'explicit',
          subjectKeys: subjects.map((s) => s.type + ':' + s.id),
          passageIds: [],
        },
        basisPair: { left: basis, right: basis },
        capturedProjection: {
          projectionVersion: 'defense-comparison-v1',
          subjects: subjects.map((s) => ({
            ...s,
            key: s.type + ':' + s.id,
            label: s.id,
            availability: 'available',
          })),
          metrics: [
            {
              key: 'captured',
              label: 'Captured request',
              period: 'FY2026',
              metric: 'funding',
              unit: 'usd_millions',
              cells: subjects.map((s) => ({
                subjectKey: s.type + ':' + s.id,
                value: '0',
                disposition: 'observed',
                reason: null,
                evidence: [],
              })),
            },
          ],
          alignments: [],
          limitations: [],
        },
      },
    };
    api.get.mockImplementation(async (url: string) => ({
      data:
        url === '/api/research-portfolios'
          ? { items: [], nextCursor: null }
          : url === '/api/defense-budget/saved-comparisons'
            ? [saved]
            : saved,
    }));
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter
          initialEntries={[
            '/program-elements/compare?subjects=program:stale-a,program:stale-b&saved=saved-1',
          ]}
        >
          <PeCompareView />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Captured request')).toBeTruthy());
    expect(screen.getAllByText('0')).toHaveLength(2);
    expect(screen.queryByText('program:stale-a')).toBeNull();
    expect(screen.getByText('program_element:0600000A')).toBeTruthy();
    expect(api.get.mock.calls.map((call) => call[0])).not.toContain('/api/defense-budget/compare');
  });
  it('scopes saved query/cache and editable draft to actor, organization and impersonation authority', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(
      ['defense-saved-comparisons', 'actor-1', 'org-1', null, false],
      [{ id: 'private-saved', name: 'Actor one private saved name' }],
    );
    api.get.mockImplementation(async () => ({ data: [] }));
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PeCompareView />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const page = render(tree());
    expect(screen.getByRole('option', { name: 'Actor one private saved name' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Comparison name'), {
      target: { value: 'Actor one unsent draft' },
    });
    identity.userId = 'actor-2';
    page.rerender(tree());
    expect(screen.queryByRole('option', { name: 'Actor one private saved name' })).toBeNull();
    expect((screen.getByLabelText('Comparison name') as HTMLInputElement).value).toBe('');
    identity.orgId = 'org-2';
    identity.actAsTenantSlug = 'sandbox-tenant';
    page.rerender(tree());
    await waitFor(() =>
      expect(
        queryClient.getQueryCache().find({
          queryKey: ['defense-saved-comparisons', 'actor-2', 'org-2', 'sandbox-tenant', false],
          exact: true,
        }),
      ).toBeTruthy(),
    );
    expect(api.post).not.toHaveBeenCalled();
  });
});
