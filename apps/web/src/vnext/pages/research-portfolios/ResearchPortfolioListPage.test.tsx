import type { AxiosInstance } from 'axios';
import { ResearchPortfolioListPage } from './ResearchPortfolioListPage.js';
import { createResearchPortfolio } from './research-portfolios-api.js';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
const authority = vi.hoisted(() => ({ userId: 'user-1', orgId: 'tenant-1' }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const axiosMethods: Pick<AxiosInstance, 'get' | 'post'> = api;
// Only these two Axios methods are invoked by the contract under test.
const axiosApi = axiosMethods as AxiosInstance;
function capturedPayload(index: number): Record<string, unknown> {
  const call = api.post.mock.calls[index];
  if (!call) throw new Error(`Expected recorded POST call ${index}`);
  const payload: unknown = call[1];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('Expected an object POST payload');
  return payload as Record<string, unknown>;
}
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => authority }));
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => api,
}));
vi.mock('../../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: null }),
}));
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <MemoryRouter>
        <ResearchPortfolioListPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}</output>;
}
function item(id: string) {
  return {
    id,
    name: id,
    lifecycle: 'active',
    mode: 'manual',
    memberCount: 0,
    clientLinkCount: 0,
    myRole: 'owner',
  };
}
async function preview(name = 'Retained purpose') {
  fireEvent.click(screen.getByRole('button', { name: 'New portfolio' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(screen.getByLabelText('Collection mode'), {
    target: { value: 'hybrid' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}
beforeEach(() => {
  cleanup();
  sessionStorage.clear();
  authority.userId = 'user-1';
  authority.orgId = 'tenant-1';
  api.get.mockReset().mockResolvedValue({ data: { items: [], nextCursor: null } });
  api.post.mockReset();
});
describe('Research Portfolio list and retained create intent', () => {
  it('loads a second cursor page while keeping the first page visible', async () => {
    api.get.mockImplementation(async (_url, options) => ({
      data: options?.params?.cursor
        ? { items: [item('Second')], nextCursor: null }
        : { items: [item('First')], nextCursor: 'First' },
    }));
    mount();
    await screen.findByText('First');
    fireEvent.click(screen.getByRole('button', { name: 'Load more portfolios' }));
    await screen.findByText('Second');
    expect(screen.getByText('First')).toBeVisible();
    expect(api.get).toHaveBeenLastCalledWith('/api/research-portfolios', {
      params: { cursor: 'First', limit: 50 },
    });
  });
  it('preserves the first page when a later page fails and retries that cursor', async () => {
    let fail = true;
    api.get.mockImplementation(async (_url, options) => {
      if (options?.params?.cursor && fail) throw Error('later page unavailable');
      return {
        data: options?.params?.cursor
          ? { items: [item('Second')], nextCursor: null }
          : { items: [item('First')], nextCursor: 'First' },
      };
    });
    mount();
    await screen.findByText('First');
    fireEvent.click(screen.getByRole('button', { name: 'Load more portfolios' }));
    await screen.findByRole('button', { name: 'Retry loading portfolios' });
    expect(screen.getByText('First')).toBeVisible();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading portfolios' }));
    await screen.findByText('Second');
  });
  it('retains the preview across remount and isolates another actor', async () => {
    const first = mount();
    await preview();
    expect(api.post).not.toHaveBeenCalled();
    first.unmount();
    const second = mount();
    expect(screen.getByRole('region', { name: 'Portfolio preview' })).toBeVisible();
    expect(screen.getByText('Retained purpose')).toBeVisible();
    second.unmount();
    authority.userId = 'user-2';
    mount();
    expect(screen.queryByText('Retained purpose')).toBeNull();
  });
  it('replays the same payload and key after unknown commit and remount; blocks edits meanwhile', async () => {
    api.post.mockRejectedValueOnce(Error('response lost after commit')).mockResolvedValueOnce({
      data: { portfolioId: 'p-recovered', replayed: true },
    });
    const first = mount();
    await preview();
    fireEvent.click(screen.getByRole('button', { name: 'Create portfolio' }));
    await screen.findByRole('button', { name: 'Retry create request' });
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    first.unmount();
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Retry create request' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(capturedPayload(0)).toEqual(capturedPayload(1));
    await waitFor(() =>
      expect(screen.getByLabelText('Current route')).toHaveTextContent(
        '/research-portfolios/p-recovered',
      ),
    );
    expect(
      Array.from({ length: sessionStorage.length }, (_, index) =>
        JSON.parse(sessionStorage.getItem(sessionStorage.key(index)!)!),
      ).every((value) => !value.attempt && !value.name),
    ).toBe(true);
  });
  it('accepts an explicit caller key while keeping omitted-key callers compatible', async () => {
    api.post.mockResolvedValue({ data: { portfolioId: 'p1' } });
    await createResearchPortfolio(
      axiosApi,
      { name: 'Same intent', mode: 'manual' },
      'retained-key',
    );
    expect(capturedPayload(0).idempotencyKey).toBe('retained-key');
    await createResearchPortfolio(axiosApi, {
      name: 'Other intent',
      mode: 'manual',
    });
    expect(capturedPayload(1).idempotencyKey).toMatch(/^research-portfolios:create:/);
  });
  it('allows edits after authoritative rejection and binds a fresh key to the new payload', async () => {
    api.post
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockResolvedValueOnce({ data: { portfolioId: 'p2' } });
    mount();
    await preview();
    fireEvent.click(screen.getByRole('button', { name: 'Create portfolio' }));
    await screen.findByText('The request was rejected. Review the draft and try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Edited intent' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create portfolio' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(capturedPayload(1).name).toBe('Edited intent');
    expect(capturedPayload(1).idempotencyKey).not.toEqual(capturedPayload(0).idempotencyKey);
  });
  it('does not let a delayed success navigate or erase a new authority scope draft', async () => {
    let resolveWrite!: (value: unknown) => void;
    api.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const first = mount();
    await preview('Old scope intent');
    fireEvent.click(screen.getByRole('button', { name: 'Create portfolio' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    first.unmount();
    authority.orgId = 'tenant-2';
    mount();
    await preview('New scope intent');
    resolveWrite({ data: { portfolioId: 'old-scope-success' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create portfolio' })).toBeEnabled(),
    );
    expect(screen.getByLabelText('Current route')).toHaveTextContent('/');
    expect(screen.getByText('New scope intent')).toBeVisible();
    expect(
      Array.from({ length: sessionStorage.length }, (_, index) =>
        sessionStorage.getItem(sessionStorage.key(index)!),
      ).some((value) => value?.includes('New scope intent')),
    ).toBe(true);
  });
});
