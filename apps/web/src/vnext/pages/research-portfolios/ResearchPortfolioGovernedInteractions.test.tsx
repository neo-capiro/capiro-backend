import { ResearchPortfolioOperationsPanel } from './ResearchPortfolioOperationsPanel.js';
import { ResearchPortfolioDetailPage } from './ResearchPortfolioDetailPage.js';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
const authority = vi.hoisted(() => ({ userId: 'user-1', orgId: 'tenant-1' }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => authority }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('../../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: null }),
}));
let portfolio: any, fit: any, savedTour: any;
const job = {
  id: 'job-1',
  fileName: 'owned.csv',
  status: 'mapped',
  rowCount: 1,
  appliedCount: 0,
  originalHash: 'a'.repeat(64),
  compensationReceipts: [],
  rows: [],
};
function capturedPayload(index: number): any {
  const call = api.post.mock.calls[index];
  if (!call) throw Error(`Missing POST ${index}`);
  return call[1];
}
function mount(element: any, tab = 'overview') {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <MemoryRouter initialEntries={[`/research-portfolios/portfolio-1?tab=${tab}`]}>
        <Routes>
          <Route path="/research-portfolios/:id" element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
function file(text = 'Type,Code,Name\nprogram_element,0604115A,Owned') {
  const bytes = new TextEncoder().encode(text);
  return Object.assign(new File([bytes], 'owned.csv', { type: 'text/csv' }), {
    arrayBuffer: async () => bytes.buffer,
  });
}
async function chooseAndMap() {
  fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [file()] } });
  await screen.findByText(/Retained original: owned.csv/);
  fireEvent.change(screen.getByLabelText('Map target_kind (required)'), {
    target: { value: 'Type' },
  });
  fireEvent.change(screen.getByLabelText('Map target_id (required)'), {
    target: { value: 'Code' },
  });
  fireEvent.change(screen.getByLabelText('Map label'), { target: { value: 'Name' } });
}
beforeEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  authority.userId = 'user-1';
  authority.orgId = 'tenant-1';
  portfolio = {
    id: 'portfolio-1',
    revision: 5,
    name: 'Owned portfolio',
    purpose: 'Research',
    mode: 'manual',
    lifecycle: 'active',
    myRole: 'owner',
    memberCount: 0,
    clientLinkCount: 0,
    members: [],
    grants: [],
    clientLinks: [],
    recentEvents: [],
  };
  fit = { portfolioId: portfolio.id, calculatedAt: '2026-09-28T00:00:00Z', clientFits: [] };
  savedTour = { tourVersion: 'research-portfolios-v1', status: 'active', completedAt: null };
  vi.stubGlobal('crypto', {
    subtle: { digest: async () => Uint8Array.from({ length: 32 }, () => 170).buffer },
  });
  api.get.mockReset().mockImplementation(async (url: string) => ({
    data: url.includes('/tour-state/')
      ? savedTour
      : url === '/api/research-portfolios/portfolio-1'
        ? portfolio
        : url.endsWith('/fit')
          ? fit
          : url.includes('/imports/')
            ? job
            : url.endsWith('/annual-review')
              ? { items: [], counts: {} }
              : url.endsWith('/reviews')
                ? [
                    {
                      id: 'review-1',
                      status: 'open',
                      revision: 2,
                      targetKind: 'program_element',
                      targetId: '0604115A',
                      trigger: 'annual_rollover',
                      reason: 'Review record',
                      evidenceFor: [],
                      evidenceAgainst: [],
                      assigneeUserId: null,
                    },
                  ]
                : url.endsWith('/tenant-members')
                  ? [{ id: 'member-user-1', name: 'Authorized analyst' }]
                  : url.endsWith('/changes')
                    ? { items: [], nextCursor: null }
                    : url.endsWith('/analytics')
                      ? {
                          portfolioId: portfolio.id,
                          portfolioRevision: 5,
                          calculationVersion: 'v2',
                          availability: 'unavailable',
                          totals: [],
                          contributions: [],
                          coverage: {},
                          limitations: [],
                          observedAt: '2026-09-28T00:00:00Z',
                          readAt: '2026-09-28T00:00:00Z',
                        }
                      : [],
  }));
  api.post.mockReset().mockImplementation(async (url: string, input: any) => ({
    data: url.endsWith('/imports')
      ? job
      : url.includes('/tour-state/')
        ? { ...savedTour, status: input.status }
        : url.endsWith('/members/decisions')
          ? {
              portfolioId: portfolio.id,
              outcomes: input.decisions.map((decision: any) => ({
                id: decision.memberId,
                targetId: decision.memberId,
                status: 'updated',
                message: decision.disposition,
              })),
            }
          : { portfolioId: portfolio.id, outcomes: [] },
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('Research Portfolio retained imports and governed interactions', () => {
  it('retains original import bytes/hash/metadata/mapping and request key across unknown response and remount without autosending', async () => {
    api.post
      .mockRejectedValueOnce(Error('response lost after commit'))
      .mockResolvedValueOnce({ data: job });
    const first = mount(<ResearchPortfolioOperationsPanel portfolio={portfolio} canEdit={true} />);
    await chooseAndMap();
    fireEvent.click(screen.getByRole('button', { name: 'Create import job' }));
    await screen.findByRole('button', { name: 'Retry original import request' });
    const original = capturedPayload(0);
    expect(original.contentBase64).toBe(btoa('Type,Code,Name\nprogram_element,0604115A,Owned'));
    expect(original.mapping).toEqual({ target_kind: 'Type', target_id: 'Code', label: 'Name' });
    first.unmount();
    mount(<ResearchPortfolioOperationsPanel portfolio={portfolio} canEdit={true} />);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Worksheet')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry original import request' }));
    await screen.findByText('Job ID job-1');
    expect(capturedPayload(1)).toEqual(original);
    expect(api.get).toHaveBeenCalledWith('/api/research-portfolios/portfolio-1/imports/job-1');
  });
  it('storage failure and server-size bound prevent submission honestly', async () => {
    mount(<ResearchPortfolioOperationsPanel portfolio={portfolio} canEdit={true} />);
    const tooLarge = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'oversize.csv', {
      type: 'text/csv',
    });
    fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [tooLarge] } });
    await screen.findByText(/exceeds the server’s 5 MiB limit/);
    expect(api.post).not.toHaveBeenCalled();
    const failStorage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw Error('quota exceeded');
    });
    fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [file()] } });
    await screen.findByText(/No request was sent/);
    expect(screen.getByRole('button', { name: 'Create import job' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
    failStorage.mockRestore();
  });
  it('confirms tour state on the server before hiding and retries failures; replay does not claim a saved restart', async () => {
    api.post
      .mockRejectedValueOnce(Error('failed save'))
      .mockResolvedValueOnce({ data: { ...savedTour, status: 'completed' } });
    mount(<ResearchPortfolioDetailPage />);
    const tour = await screen.findByRole('region', { name: 'Research Portfolio product tour' });
    fireEvent.click(within(tour).getByRole('button', { name: 'Mark tour complete' }));
    await screen.findByText('Tour state was not saved. The tour remains open.');
    expect(tour).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving tour state' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Research Portfolio product tour' })).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Product tour' }));
    expect(screen.getByText(/Replaying this version locally/)).toBeVisible();
    expect(api.post).toHaveBeenCalledTimes(2);
  });
  it('uses structured source location fields and authorized assignee choices', async () => {
    mount(<ResearchPortfolioOperationsPanel portfolio={portfolio} canEdit={true} />);
    await screen.findByText('Review record');
    await screen.findByRole('option', { name: 'Authorized analyst' });
    fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: 'member-user-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(capturedPayload(0).assigneeUserId).toBe('member-user-1');
    fireEvent.change(screen.getByLabelText('Evidence revision ID'), {
      target: { value: 'source-1' },
    });
    fireEvent.change(screen.getByLabelText('Evidence page'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Evidence row'), { target: { value: '0604115A' } });
    fireEvent.click(screen.getByRole('button', { name: 'include' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(capturedPayload(1).evidenceFor[0].locator).toEqual({ page: 2, row: '0604115A' });
  });
  it('sends typed unresolved resolution and reasoned bulk decisions with actual per-member receipts', async () => {
    portfolio.members = [
      {
        id: 'unresolved-1',
        targetKind: 'program_element',
        targetId: 'legacy-input',
        label: 'Unresolved subject',
        disposition: 'unresolved',
      },
      {
        id: 'member-1',
        targetKind: 'program_element',
        targetId: '0604115A',
        label: 'Included PE',
        disposition: 'included',
      },
      {
        id: 'member-2',
        targetKind: 'award',
        targetId: 'award-2',
        label: 'Excluded award',
        disposition: 'excluded',
      },
    ];
    mount(<ResearchPortfolioDetailPage />, 'members');
    await screen.findByText('Unresolved subject');
    fireEvent.change(screen.getByLabelText('Resolve type'), { target: { value: 'project' } });
    fireEvent.change(screen.getByLabelText('Resolve Unresolved subject'), {
      target: { value: 'project-owned' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(capturedPayload(0).targetKind).toBe('project');
    expect(capturedPayload(0).targetId).toBe('project-owned');
    fireEvent.click(screen.getByLabelText('Select member Included PE'));
    fireEvent.click(screen.getByLabelText('Select member Excluded award'));
    fireEvent.change(screen.getByLabelText('Bulk decision reason'), {
      target: { value: 'Outside owned research scope' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Exclude selected members' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(capturedPayload(1).decisions).toHaveLength(2);
    expect(
      capturedPayload(1).decisions.every(
        (decision: any) =>
          decision.reason === 'Outside owned research scope' && decision.disposition === 'excluded',
      ),
    ).toBe(true);
    await screen.findByRole('region', { name: 'Bulk member outcomes' });
  });
  it('labels optional fit as supported qualified share with immutable version/basis and legacy scores as unqualified', async () => {
    fit.clientFits = [
      {
        portfolioId: portfolio.id,
        clientId: 'client-1',
        clientName: 'Authorized client',
        fitScore: 50,
        ruleMatches: [],
        refreshedAt: null,
        versionId: 'fit-version-1',
        availability: 'partial',
        basis: {
          calculationVersion: 'fit-v2',
          scoreBasis: 'direct_qualified_pe_association_share',
          portfolioRevision: 5,
          ruleVersionIds: ['rule-1'],
          capabilityFingerprint: 'cap-hash',
          sourceBasisFingerprint: 'source-hash',
          basisFingerprint: 'basis-hash',
          totalIncludedMemberCount: 4,
          supportedMemberCount: 2,
          matchedMemberCount: 1,
          limitations: ['Two unsupported members'],
        },
        memberMatches: [
          {
            memberId: 'member-3',
            targetKind: 'award',
            targetId: 'award-1',
            matched: null,
            reasons: ['No qualified PE basis'],
            capabilityIds: [],
            sourceDocumentIds: [],
          },
        ],
      },
    ];
    const first = mount(<ResearchPortfolioDetailPage />);
    await screen.findByText(/Direct qualified PE association share: 50% of 2 supported members/);
    expect(screen.getByText(/Stored version fit-version-1/)).toBeVisible();
    expect(screen.getByText(/This basis covers 2 of 4 included members/)).toBeVisible();
    first.unmount();
    delete fit.clientFits[0].basis;
    mount(<ResearchPortfolioDetailPage />);
    await screen.findByText(/No qualified score basis\/version was returned/);
    expect(screen.queryByText(/Direct qualified PE association share/)).toBeNull();
  });
});
