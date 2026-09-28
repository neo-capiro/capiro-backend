import { ResearchPortfolioListPage } from './ResearchPortfolioListPage.js';
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
describe('Recovered attempts conservatively retain unknown outcomes', () => {
  it('keeps import bytes/mapping/key locked after remount-before-response then definitive rejection', async () => {
    const text = 'Type,Code,Name\nprogram_element,0604115A,Owned',
      contentBase64 = btoa(text),
      mapping = { target_kind: 'Type', target_id: 'Code', label: 'Name' };
    const key =
      'capiro:research-portfolio-import-draft:v1:' +
      JSON.stringify(['user-1', 'tenant-1', null, 'portfolio-1']);
    const payload = {
      expectedRevision: 5,
      worksheetKind: 'membership',
      fileName: 'owned.csv',
      mediaType: 'text/csv',
      contentBase64,
      schemaVersion: 'membership-v1',
      mapping,
    };
    sessionStorage.setItem(
      key,
      JSON.stringify({
        original: {
          name: 'owned.csv',
          mediaType: 'text/csv',
          contentBase64,
          size: new TextEncoder().encode(text).length,
          sha256: 'aa'.repeat(32),
          headers: ['Type', 'Code', 'Name'],
        },
        kind: 'membership',
        mapping,
        attempt: { operationKey: 'retained-original-key', payload, uncertain: false },
      }),
    );
    api.post.mockRejectedValue({ response: { status: 400 } });
    mount(<ResearchPortfolioOperationsPanel portfolio={portfolio} canEdit={true} />);
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry original import request' }));
    await screen.findByText(/The import could not be admitted/);
    expect(screen.getByLabelText('CSV file')).toBeDisabled();
    expect(JSON.parse(sessionStorage.getItem(key)!).attempt).toEqual({
      operationKey: 'retained-original-key',
      payload,
      uncertain: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry original import request' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(capturedPayload(1)).toEqual(capturedPayload(0));
  });
  it('keeps portfolio create identity after remount-before-response then definitive rejection', async () => {
    const key =
      'capiro:research-portfolio-create:v1:' + JSON.stringify(['user-1', 'tenant-1', null]);
    const payload = { name: 'Retained original', purpose: 'Owned', mode: 'manual' };
    sessionStorage.setItem(
      key,
      JSON.stringify({
        name: payload.name,
        purpose: payload.purpose,
        mode: payload.mode,
        step: 3,
        attempt: { key: 'retained-create-key', payload },
      }),
    );
    api.get.mockResolvedValue({ data: { items: [], nextCursor: null } });
    api.post.mockRejectedValue({ response: { status: 422 } });
    mount(<ResearchPortfolioListPage />);
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry create request' }));
    await screen.findByText(/The response was not confirmed|The request was rejected/);
    expect(JSON.parse(sessionStorage.getItem(key)!).attempt).toEqual({
      key: 'retained-create-key',
      payload,
      uncertain: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry create request' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(capturedPayload(1)).toEqual(capturedPayload(0));
  });
});
