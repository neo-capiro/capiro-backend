import '@testing-library/jest-dom/vitest';
import { ResearchPortfolioOperationsPanel } from './ResearchPortfolioOperationsPanel.js';
import { ResearchPortfolioDetailPage } from './ResearchPortfolioDetailPage.js';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
const authority = vi.hoisted(() => ({ userId: 'user-1', orgId: 'tenant-1' }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => authority }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('../../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: null }),
}));
const portfolio: any = {
  id: 'portfolio-1',
  revision: 5,
  name: 'Owned portfolio',
  purpose: 'Research purpose',
  mode: 'hybrid',
  lifecycle: 'active',
  myRole: 'owner',
  members: [],
  grants: [],
  clientLinks: [],
  recentEvents: [],
  memberCount: 0,
  clientLinkCount: 0,
};
let reviewStatus = 'open';
function review() {
  return {
    id: 'review-1',
    revision: 2,
    status: reviewStatus,
    targetKind: 'program_element',
    targetId: '0604115A',
    trigger: 'annual_rollover',
    evidenceFor: [],
    evidenceAgainst: [],
    reason: 'Review record',
    assigneeUserId: null,
  };
}
let job: any;
function RouterProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Current route">{location.pathname + location.search}</output>
      <button onClick={() => navigate(-1)}>Browser back</button>
      <button onClick={() => navigate(1)}>Browser forward</button>
    </>
  );
}
function mount(element: any, path = '/research-portfolios/portfolio-1') {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/research-portfolios/:id" element={element} />
        </Routes>
        <RouterProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  authority.userId = 'user-1';
  authority.orgId = 'tenant-1';
  reviewStatus = 'open';
  job = {
    id: 'job-1',
    fileName: 'owned.csv',
    status: 'previewed',
    rowCount: 2,
    appliedCount: 0,
    originalHash: 'owned-hash',
    compensationReceipts: [],
    rows: [
      {
        id: 'row-1',
        rowNumber: 1,
        selected: true,
        repairs: {},
        previewClassification: 'invalid',
        finalOutcome: null,
      },
      {
        id: 'row-2',
        rowNumber: 2,
        selected: true,
        repairs: {},
        previewClassification: 'resolved',
        finalOutcome: null,
      },
    ],
  };
  api.get.mockReset().mockImplementation(async (url: string) => ({
    data: url.includes('/tour-state/')
      ? { status: 'active' }
      : url === '/api/research-portfolios/portfolio-1'
        ? portfolio
        : url.includes('/imports/')
          ? job
          : url.endsWith('/annual-review')
            ? { items: [], counts: {} }
            : url.endsWith('/reviews')
              ? [review()]
              : url.endsWith('/analytics')
                ? {
                    portfolioId: portfolio.id,
                    portfolioRevision: 5,
                    calculationVersion: 'v2',
                    availability: 'unavailable',
                    totals: [],
                    contributions: [],
                    coverage: {
                      eligibleMembers: 0,
                      supportedMembers: 0,
                      includedContributions: 0,
                      excludedContributions: 0,
                      overlapContributions: 0,
                      unavailableMembers: 0,
                    },
                    limitations: [],
                    observedAt: '2026-09-28T00:00:00Z',
                    readAt: '2026-09-28T00:00:00Z',
                  }
                : url.endsWith('/changes')
                  ? { items: [], nextCursor: null }
                  : [],
  }));
  api.post.mockReset().mockImplementation(async (url: string, input: any) => {
    if (url.endsWith('/imports')) return { data: { id: 'job-1' } };
    if (url.endsWith('/preview') && url.includes('/imports/')) {
      job = {
        ...job,
        rows: job.rows.map((row: any) => ({
          ...row,
          selected: input.selectedRowIds.includes(row.id),
          repairs: input.repairs[row.id],
        })),
      };
      return { data: job };
    }
    return { data: url.includes('/imports/') ? job : {} };
  });
});
describe('Research Portfolio sections, review decisions, and import recovery', () => {
  it('normalizes review alias to reviews, preserves unrelated query, and supports keyboard Back/Forward', async () => {
    mount(
      <ResearchPortfolioDetailPage />,
      '/research-portfolios/portfolio-1?tab=review&retained=1',
    );
    const tabs = await screen.findByRole('tablist', { name: 'Research Portfolio sections' });
    await waitFor(() =>
      expect(screen.getByLabelText('Current route')).toHaveTextContent('tab=reviews&retained=1'),
    );
    expect(within(tabs).getAllByRole('tab')).toHaveLength(6);
    const reviews = within(tabs).getByRole('tab', { name: 'Reviews' });
    reviews.focus();
    fireEvent.keyDown(reviews, { key: 'Home' });
    expect(within(tabs).getByRole('tab', { name: 'Overview' })).toHaveFocus();
    expect(screen.getByLabelText('Current route')).toHaveTextContent('?retained=1');
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
    await waitFor(() => expect(reviews).toHaveAttribute('aria-selected', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'Browser forward' }));
    await waitFor(() =>
      expect(within(tabs).getByRole('tab', { name: 'Overview' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
  });
  it('normalizes invalid tabs, preserves draft fields across tabs, and tour Show me focuses the actual task', async () => {
    mount(
      <ResearchPortfolioDetailPage />,
      '/research-portfolios/portfolio-1?tab=unknown&keep=value',
    );
    const tabs = await screen.findByRole('tablist', { name: 'Research Portfolio sections' });
    await waitFor(() =>
      expect(screen.getByLabelText('Current route')).toHaveTextContent('?keep=value'),
    );
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Settings' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unsent settings edit' } });
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Members' }));
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Settings' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Unsent settings edit');
    const tour = screen.getByRole('region', { name: 'Research Portfolio product tour' });
    fireEvent.click(within(tour).getAllByRole('button', { name: 'Show me' })[2]!);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Changes and watches' })).toHaveFocus(),
    );
    expect(within(tabs).getByRole('tab', { name: 'Changes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
  it('resolved reviews allow only reopen while cancelled reviews are read-only', async () => {
    reviewStatus = 'resolved';
    const first = mount(<ResearchPortfolioOperationsPanel portfolio={portfolio} canEdit={true} />);
    await screen.findByText('Review record');
    expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'defer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'include' })).toBeNull();
    expect(screen.getByRole('button', { name: 'reopen' })).toBeEnabled();
    first.unmount();
    reviewStatus = 'cancelled';
    mount(<ResearchPortfolioOperationsPanel portfolio={portfolio} canEdit={true} />);
    await screen.findByText('Review record');
    expect(screen.queryByRole('button', { name: 'reopen' })).toBeNull();
    expect(screen.queryByLabelText('Evidence revision ID')).toBeNull();
  });
  it('review requires exact locator and sends it on the correct conflicting-evidence side', async () => {
    mount(<ResearchPortfolioOperationsPanel portfolio={portfolio} canEdit={true} />);
    await screen.findByText('Review record');
    fireEvent.change(screen.getByLabelText('Evidence revision ID'), {
      target: { value: 'source-revision-1' },
    });
    expect(screen.getByRole('button', { name: 'dispute' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Evidence locator JSON'), {
      target: { value: '{"page":2,"table":"Funding","row":"0604115A","cell":"FY27"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'dispute' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0]![1].evidenceAgainst[0].locator).toEqual({
      page: 2,
      table: 'Funding',
      row: '0604115A',
      cell: 'FY27',
    });
    expect(api.post.mock.calls[0]![1].evidenceFor).toEqual([]);
  });
  it('loads a persisted import after remount, supports scoped recovery, selection, repairs, and re-preview before apply', async () => {
    const first = mount(<ResearchPortfolioOperationsPanel portfolio={portfolio} canEdit={true} />);
    fireEvent.change(screen.getByLabelText('Import job ID'), { target: { value: 'job-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load import' }));
    await screen.findByText('owned.csv');
    fireEvent.click(screen.getByLabelText('Select import row 2'));
    fireEvent.change(screen.getByLabelText('Repair import row 1 JSON'), {
      target: { value: '{"target_id":"0604115A"}' },
    });
    expect(screen.getByRole('button', { name: 'Apply selected rows' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview selected rows' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0]![1].selectedRowIds).toEqual(['row-1']);
    expect(api.post.mock.calls[0]![1].repairs['row-1']).toEqual({ target_id: '0604115A' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Apply selected rows' })).toBeEnabled(),
    );
    expect(screen.getByRole('button', { name: 'Export all-row receipt' })).toBeEnabled();
    first.unmount();
    const second = mount(<ResearchPortfolioOperationsPanel portfolio={portfolio} canEdit={true} />);
    await screen.findByText('owned.csv');
    second.unmount();
    authority.orgId = 'tenant-2';
    mount(<ResearchPortfolioOperationsPanel portfolio={portfolio} canEdit={true} />);
    expect(screen.queryByText('owned.csv')).toBeNull();
  });
  it('exports bytes containing every authorized row, including unselected outcomes', async () => {
    mount(<ResearchPortfolioOperationsPanel portfolio={portfolio} canEdit={false} />);
    fireEvent.change(screen.getByLabelText('Import job ID'), { target: { value: 'job-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load import' }));
    await screen.findByText('owned.csv');
    expect(screen.getByLabelText('Select import row 1')).toBeDisabled();
    job.rows[1] = { ...job.rows[1], selected: false, finalOutcome: 'skipped' };
    let receipt!: Blob;
    const createURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      receipt = blob as Blob;
      return 'blob:owned-receipt';
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Export all-row receipt' }));
    const bytes = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(receipt);
    });
    const parsed = JSON.parse(bytes);
    expect(parsed.id).toBe('job-1');
    expect(parsed.originalHash).toBe('owned-hash');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[1].selected).toBe(false);
    expect(parsed.rows[1].finalOutcome).toBe('skipped');
    createURL.mockRestore();
    anchorClick.mockRestore();
  });
});
