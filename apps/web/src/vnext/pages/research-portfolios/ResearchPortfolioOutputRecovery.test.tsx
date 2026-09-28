import { DurableOutputs } from './ResearchPortfolioAnalyticsPanel.js';
import { ResearchPortfolioDetailPage } from './ResearchPortfolioDetailPage.js';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
const authority = vi.hoisted(() => ({
  userId: 'actor-a',
  orgId: 'tenant-a',
  actAsTenantSlug: null as string | null,
}));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => authority }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('../../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: authority.actAsTenantSlug }),
}));
const portfolio: any = {
  id: 'portfolio-a',
  name: 'Owned scope',
  revision: 3,
  mode: 'manual',
  lifecycle: 'active',
  myRole: 'owner',
  memberCount: 0,
  members: [],
  grants: [],
  recentEvents: [],
  clientLinks: [{ id: 'link-a', clientId: 'client-a', clientName: 'Private destination A' }],
};
const job: any = {
  id: 'job-a',
  status: 'completed',
  attemptCount: 1,
  updatedAt: '2026-09-28T00:00:00Z',
  artifact: { id: 'artifact-a', fileName: 'owned.csv', contentHash: 'a'.repeat(64), byteSize: 5 },
};
const receipt = {
  id: 'receipt-a',
  attachmentId: 'attachment-a',
  attachmentName: 'Private attachment A',
  scanStatus: 'clean',
  openPath: '/clients?clientId=client-a',
};
function calls(kind: 'create' | 'filing') {
  return api.post.mock.calls.filter((call) =>
    String(call[0]).endsWith(kind === 'create' ? '/outputs' : '/client-files'),
  );
}
function payload(kind: 'create' | 'filing', index: number) {
  const call = calls(kind)[index];
  if (!call) throw Error('Missing captured POST');
  return call[1];
}
let browserQueryClient: QueryClient;
function tree(element: any = <DurableOutputs portfolio={portfolio} />) {
  return (
    <QueryClientProvider client={browserQueryClient}>
      <MemoryRouter initialEntries={['/research-portfolios/portfolio-a?tab=settings']}>
        <Routes>
          <Route path="/research-portfolios/:id" element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
async function build() {
  fireEvent.click(screen.getByRole('button', { name: 'Build CSV' }));
  await screen.findByText('Job job-a');
}
const fileButton = () =>
  screen.getByRole('button', { name: /Save exact file|Reconcile exact client filing/ });
beforeEach(() => {
  browserQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  authority.userId = 'actor-a';
  authority.orgId = 'tenant-a';
  authority.actAsTenantSlug = null;
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(async (url: string) => {
    if (url.includes('/output-jobs/')) return { data: job };
    if (url.endsWith('/fit'))
      return {
        data: {
          portfolioId: portfolio.id,
          clientFits: [
            {
              clientId: 'client-a',
              clientName: 'Private fit A',
              fitScore: 50,
              ruleMatches: [],
              reasons: [],
              sourceDocumentIds: [],
              refreshedAt: null,
            },
          ],
        },
      };
    if (url.endsWith('/changes')) return { data: { items: [], nextCursor: null } };
    if (url.endsWith('/analytics'))
      return {
        data: {
          portfolioId: portfolio.id,
          portfolioRevision: 3,
          calculationVersion: 'v2',
          availability: 'unavailable',
          totals: [],
          contributions: [],
          coverage: {},
          limitations: [],
        },
      };
    if (url.endsWith('/annual-review')) return { data: { items: [], counts: {} } };
    if (url.includes('/tour-state/'))
      return { data: { tourVersion: 'research-portfolios-v1', status: 'completed' } };
    if (url === '/api/research-portfolios/portfolio-a') return { data: portfolio };
    return { data: [] };
  });
  api.post.mockImplementation(async (url: string) => ({
    data: url.endsWith('/client-files') ? receipt : job,
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe('retained output and filing identities within current authority', () => {
  it('persists output before POST, remounts without autosend and retries the original key and payload', async () => {
    api.post.mockRejectedValueOnce({ response: { status: 503 } });
    const first = render(tree());
    fireEvent.click(screen.getByRole('button', { name: 'Build CSV' }));
    await waitFor(() => expect(calls('create')).toHaveLength(1));
    const original = payload('create', 0);
    first.unmount();
    render(tree());
    await screen.findByRole('button', { name: 'Retry exact CSV request' });
    expect(calls('create')).toHaveLength(1);
    expect(screen.getByLabelText('Projection')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact CSV request' }));
    await screen.findByText('Job job-a');
    expect(payload('create', 1)).toEqual(original);
  });
  it('retains exact filing identity through 5xx, retry and remount; completion does not lose its key', async () => {
    const first = render(tree());
    await build();
    api.post.mockRejectedValueOnce({ response: { status: 503 } });
    fireEvent.click(fileButton());
    await waitFor(() => expect(calls('filing')).toHaveLength(1));
    const original = payload('filing', 0);
    first.unmount();
    render(tree());
    await screen.findByText('Job job-a');
    expect(calls('filing')).toHaveLength(1);
    expect(screen.getByLabelText('Authorized destination')).toBeDisabled();
    fireEvent.click(fileButton());
    await screen.findByText(/Saved as Private attachment A/);
    expect(payload('filing', 1)).toEqual(original);
    cleanup();
    render(tree());
    await screen.findByText('Job job-a');
    expect(calls('filing')).toHaveLength(2);
    fireEvent.click(fileButton());
    await screen.findByText(/Saved as Private attachment A/);
    expect(payload('filing', 2)).toEqual(original);
  });
  it('fails before output POST when browser storage cannot retain its key', async () => {
    render(tree());
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw Error('quota');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Build CSV' }));
    await screen.findByText(/No request was sent/);
    expect(api.post).not.toHaveBeenCalled();
  });
  it('fails before filing POST when browser storage cannot retain its key', async () => {
    render(tree());
    await build();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw Error('quota');
    });
    fireEvent.click(fileButton());
    await screen.findByText(/No filing was sent/);
    expect(calls('filing')).toHaveLength(0);
  });
  it.each(['actor', 'org', 'actas'])(
    'does not show prior receipts, output handles or cached snapshot names after scope switch: %s',
    async (changed) => {
      api.get.mockImplementation(async (url: string) => ({
        data: url.endsWith('/snapshots')
          ? [{ id: 'snapshot-a', name: 'Private snapshot A', portfolioRevision: 3 }]
          : job,
      }));
      const view = render(tree());
      await build();
      fireEvent.click(fileButton());
      await screen.findByText(/Saved as Private attachment A/);
      if (changed === 'actor') authority.userId = 'actor-b';
      if (changed === 'org') authority.orgId = 'tenant-b';
      if (changed === 'actas') authority.actAsTenantSlug = 'owned-other-tenant';
      api.get.mockImplementation(() => new Promise(() => undefined));
      view.rerender(tree());
      expect(
        screen.queryByText(/Private attachment A|Private snapshot A|Private destination A/),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('Job job-a')).not.toBeInTheDocument();
      expect(calls('filing')).toHaveLength(1);
    },
  );
  it('a delayed old-scope filing success cannot populate the new scope', async () => {
    let release!: (value: any) => void;
    const pending = new Promise((resolve) => (release = resolve));
    const view = render(tree());
    await build();
    api.post.mockReturnValueOnce(pending);
    fireEvent.click(fileButton());
    await waitFor(() => expect(calls('filing')).toHaveLength(1));
    authority.userId = 'actor-b';
    view.rerender(tree());
    await act(async () => {
      release({ data: receipt });
      await pending;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(screen.queryByText(/Private attachment A/)).not.toBeInTheDocument());
    expect(screen.queryByText('Job job-a')).not.toBeInTheDocument();
  });
  it('a mounted Detail scope change hides cached fit/client names until the new authority response', async () => {
    const view = render(tree(<ResearchPortfolioDetailPage />));
    await screen.findByText('Private fit A');
    authority.userId = 'actor-b';
    api.get.mockImplementation(() => new Promise(() => undefined));
    view.rerender(tree(<ResearchPortfolioDetailPage />));
    expect(screen.queryByText('Private fit A')).not.toBeInTheDocument();
    expect(screen.queryByText('Private destination A')).not.toBeInTheDocument();
  });
});
