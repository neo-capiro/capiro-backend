import { ResearchImportsPanel } from './ResearchPortfolioOperationsPanel.js';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const authority = vi.hoisted(() => ({ userId: 'actor-a', orgId: 'tenant-a' }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => authority }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('../../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: null }),
}));
const portfolio: any = {
  id: 'portfolio-a',
  revision: 4,
  myRole: 'owner',
  lifecycle: 'active',
  name: 'Owned',
};
const operationId = '11111111-1111-4111-8111-111111111111';
const operation: any = {
  id: operationId,
  portfolioId: portfolio.id,
  kind: 'output',
  status: 'outcome_unknown',
  domainStatus: 'checkpoint_not_observed',
  limitations: ['No committed checkpoint was observed'],
  actorUserId: null,
  label: 'Original operation',
  startedAt: null,
  completedAt: null,
  lastErrorCode: null,
  lastError: null,
  retryCount: 0,
  createdAt: '2026-09-28T00:00:00Z',
  updatedAt: '2026-09-28T00:00:00Z',
};
let client: QueryClient;
function tree(canEdit = true) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ResearchImportsPanel portfolio={portfolio} canEdit={canEdit} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
async function load() {
  fireEvent.change(screen.getByLabelText('Operation ID'), { target: { value: operationId } });
  fireEvent.click(screen.getByRole('button', { name: 'Load operation' }));
  await screen.findByText(/Domain state:/);
}
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  authority.userId = 'actor-a';
  authority.orgId = 'tenant-a';
  localStorage.clear();
  sessionStorage.clear();
  api.get.mockReset().mockResolvedValue({ data: operation });
  api.post.mockReset().mockResolvedValue({ data: operation });
});
afterEach(() => {
  cleanup();
  client.clear();
});
describe('Exact-domain operation recovery', () => {
  it('does no automatic requests; reads only a valid explicit ID and displays unknown actor/time honestly', async () => {
    render(tree());
    expect(api.get).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Operation ID'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load operation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter an exact operation UUID');
    expect(api.get).not.toHaveBeenCalled();
    await load();
    expect(api.get).toHaveBeenCalledWith(
      `/api/research-portfolios/${portfolio.id}/operations/${operationId}`,
    );
    expect(screen.getByText('Actor: not recorded')).toBeInTheDocument();
    expect(screen.getByText(/Started: not recorded/)).toBeInTheDocument();
    expect(screen.getByText(operation.limitations[0])).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
  it.each(['import', 'recompute', 'snapshot'])(
    'shows %s limitations and never offers unsupported generic reconciliation',
    async (kind) => {
      api.get.mockResolvedValue({
        data: {
          ...operation,
          kind,
          domainStatus: kind === 'import' ? 'paused' : 'legacy_state',
          status: kind === 'import' ? 'paused' : 'outcome_unknown',
        },
      });
      render(tree());
      await load();
      expect(screen.getByText(new RegExp(`Use the original ${kind} action`))).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Reconcile existing checkpoint' }),
      ).not.toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalled();
    },
  );
  it('reconciles an output checkpoint and preserves an actual unknown result without claiming completion', async () => {
    render(tree());
    await load();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile existing checkpoint' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/api/research-portfolios/${portfolio.id}/operations/${operationId}/reconcile`,
        {},
      ),
    );
    expect(screen.getByText(/output — outcome_unknown/)).toBeInTheDocument();
    expect(screen.getByText(operation.limitations[0])).toBeInTheDocument();
  });
  it('requires exact original filing key, passes it unchanged, and clears private handle/key/data on actor switch', async () => {
    api.get.mockResolvedValue({
      data: { ...operation, kind: 'client_filing', label: 'Private filing' },
    });
    const view = render(tree());
    await load();
    const button = screen.getByRole('button', { name: 'Reconcile existing checkpoint' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Original filing operation key'), {
      target: { value: 'original:key:with-identity' },
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/api/research-portfolios/${portfolio.id}/operations/${operationId}/reconcile`,
        { operationKey: 'original:key:with-identity' },
      ),
    );
    authority.userId = 'actor-b';
    view.rerender(tree());
    expect(screen.queryByText(/Private filing/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Original filing operation key')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Operation ID')).toHaveValue('');
    expect(api.post).toHaveBeenCalledTimes(1);
  });
  it('holds the original operation during a deferred reconciliation and never files its result under a newly typed ID', async () => {
    let complete: (value: unknown) => void = () => {};
    api.post.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    render(tree());
    await load();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile existing checkpoint' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const secondId = '22222222-2222-4222-8222-222222222222';
    fireEvent.change(screen.getByLabelText('Operation ID'), { target: { value: secondId } });
    expect(screen.getByRole('button', { name: 'Load operation' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Load operation' }));
    expect(api.get).toHaveBeenCalledTimes(1);
    complete({
      data: {
        ...operation,
        label: 'Original completed checkpoint',
        status: 'completed',
        domainStatus: 'completed',
      },
    });
    await screen.findByText(/Original completed checkpoint/);
    api.get.mockResolvedValue({
      data: {
        ...operation,
        id: secondId,
        label: 'Second owned operation',
        domainStatus: 'second_unknown',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load operation' }));
    await screen.findByText(/Second owned operation/);
    expect(screen.queryByText(/Original completed checkpoint/)).not.toBeInTheDocument();
    expect(api.get).toHaveBeenLastCalledWith(
      `/api/research-portfolios/${portfolio.id}/operations/${secondId}`,
    );
  });
  it('viewer reads status but has no mutation affordance', async () => {
    render(tree(false));
    await load();
    expect(
      screen.queryByRole('button', { name: 'Reconcile existing checkpoint' }),
    ).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
