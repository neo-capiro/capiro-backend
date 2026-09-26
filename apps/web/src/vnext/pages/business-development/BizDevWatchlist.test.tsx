import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { BizDevWatchlist, BIZDEV_WATCH_MERI_PROMPT } from './BizDevWatchlist.js';
import type { BizDevProspect, BizDevProspectAlert, BizDevProspectWatch } from './bizdev-api.js';

const { launchMeri } = vi.hoisted(() => ({ launchMeri: vi.fn() }));
vi.mock('../../../components/chat/meri-window.js', () => ({ openVNextMeriWorkspaceWindow: launchMeri }));
let api: AxiosInstance;
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));

function prospect(index: number): BizDevProspect {
  return {
    id: `p-${index}`, tenantId: 't-1', canonicalEntityId: null, displayName: `Company ${index}`,
    domain: null, website: null, description: null, serviceHypothesis: null, geography: null,
    ownerUserId: 'u-1', stage: 'researching', status: 'active', dismissedAt: null,
    conflictExcluded: false, conflictReason: null, nextAction: null, nextActionDueAt: null,
    linkedClientId: null, convertedAt: null, watchRequested: true, createdByUserId: 'u-1',
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
    canonicalEntity: null, linkedClient: null,
  };
}

function watch(): BizDevProspectWatch {
  return {
    watch: { status: 'active', categories: [], ownerUserId: 'u-1', mutedUntil: null,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' },
    sources: [{ source: 'FEDERAL_AWARD', health: 'healthy', lastCheckedAt: '2026-09-20T12:30:00Z', detail: null }],
    lastCompletedCheckAt: '2026-09-20T12:30:00Z',
  };
}

const alert: BizDevProspectAlert = {
  id: 'a-1', prospectId: 'p-1', title: 'Award changed', summary: null, materiality: null,
  materialityLevel: null, company: 'Company 1', sourceFamily: 'federal_award',
  category: 'contract_award', eventAt: '2026-09-18T12:00:00Z', effectiveAt: null,
  publishedAt: '2026-09-19T12:00:00Z', firstObservedAt: '2026-09-20T12:00:00Z',
  sourceLocator: null, implication: null, readAt: null, dismissedAt: null,
};

function setup({ count = 1, meri = false, alerts = [] as BizDevProspectAlert[] } = {}) {
  launchMeri.mockClear();
  const prospects = Array.from({ length: count }, (_, i) => prospect(i + 1));
  const watches = new Map(prospects.map((p) => [p.id, watch()]));
  const get = vi.fn(async (path: string) => {
    if (path === '/api/business-development/prospects') return { data: { prospects } };
    const id = path.split('/')[4]!;
    if (path.endsWith('/watch')) return { data: watches.get(id) };
    if (path.endsWith('/alerts')) return { data: { items: alerts } };
    throw new Error(`Unexpected GET ${path}`);
  });
  const patch = vi.fn(async (path: string, input: object): Promise<{ data: BizDevProspectWatch }> => {
    const id = path.split('/')[4]!;
    const current = watches.get(id)!;
    const next = { ...current, watch: { ...current.watch!, ...input } };
    watches.set(id, next);
    return { data: next };
  });
  api = { get, patch } as unknown as AxiosInstance;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BizDevWatchlist tenantId="t-1" members={[]} watchAlertsEnabled meriProspectToolsEnabled={meri} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { get, patch, watches, queryClient };
}

describe('Watchlist direct controls', () => {
  it('pauses, resumes, mutes and unmutes through the existing prospect watch endpoint', async () => {
    const { patch, queryClient } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mute for 7 days' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unmute' }));
    await screen.findByRole('button', { name: 'Mute for 7 days' });
    expect(patch.mock.calls).toEqual([
      ['/api/business-development/prospects/p-1/watch', { status: 'paused' }],
      ['/api/business-development/prospects/p-1/watch', { status: 'active' }],
      ['/api/business-development/prospects/p-1/watch', { mutedUntil: expect.any(String) }],
      ['/api/business-development/prospects/p-1/watch', { mutedUntil: null }],
    ]);
    expect(queryClient.getQueryData(['business-development', 't-1', 'prospect', 'p-1', 'watch']))
      .toMatchObject({ watch: { status: 'active', mutedUntil: null } });
  });

  it('preserves the confirmed watch state after failure and allows retry', async () => {
    const { patch } = setup();
    patch.mockRejectedValueOnce(new Error('Watch service unavailable'));
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Watch service unavailable');
    const pause = screen.getByRole('button', { name: 'Pause' });
    expect(pause).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    fireEvent.click(pause);
    await screen.findByRole('button', { name: 'Resume' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it('sends only one mutation while a watch update is pending', async () => {
    const { patch } = setup();
    let finish!: (value: { data: BizDevProspectWatch }) => void;
    patch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pause = await screen.findByRole('button', { name: 'Pause' });
    fireEvent.click(pause);
    fireEvent.click(pause);
    fireEvent.click(screen.getByRole('button', { name: 'Mute for 7 days' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(pause).toBeDisabled();
    finish({ data: watch() });
    await waitFor(() => expect(pause).toBeEnabled());
  });

  it('keeps later watches reachable while bounding each page to twelve prospect reads', async () => {
    const { get } = setup({ count: 13 });
    await screen.findByRole('button', { name: 'Company 12' });
    expect(screen.queryByRole('button', { name: 'Company 13' })).not.toBeInTheDocument();
    expect(get.mock.calls.filter(([path]) => path.endsWith('/watch'))).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: 'Next watches' }));
    await screen.findByRole('button', { name: 'Company 13' });
    expect(screen.queryByRole('button', { name: 'Company 1' })).not.toBeInTheDocument();
    expect(get.mock.calls.filter(([path]) => path.endsWith('/watch'))).toHaveLength(13);
    expect(screen.getByRole('button', { name: 'Next watches' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous watches' })).toBeEnabled();
  });

  it('shows distinct source dates and opens Meri with the authorized prospect identifier', async () => {
    setup({ meri: true, alerts: [alert] });
    const feed = await screen.findByRole('list', { name: 'Recent watch alerts' });
    expect(within(feed).getByText(/^Event:/)).toHaveTextContent(new Date(alert.eventAt!).toLocaleString());
    expect(within(feed).getByText(/^Published:/)).toHaveTextContent(new Date(alert.publishedAt!).toLocaleString());
    expect(within(feed).getByText(/^First observed:/)).toHaveTextContent(new Date(alert.firstObservedAt!).toLocaleString());
    fireEvent.click(within(feed).getByRole('button', { name: 'Ask Meri what changed' }));
    expect(launchMeri).toHaveBeenCalledWith(window, window.location.origin, {
      prospectId: 'p-1', prompt: BIZDEV_WATCH_MERI_PROMPT,
    });
  });

  it('does not offer Meri when prospect tools are disabled', async () => {
    setup({ alerts: [alert] });
    await screen.findByRole('list', { name: 'Recent watch alerts' });
    expect(screen.queryByRole('button', { name: 'Ask Meri what changed' })).not.toBeInTheDocument();
  });
});
