import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefenseSavedComparisonActions } from './DefenseSavedComparisonActions.js';
import {
  addSavedDefenseComparisonSelection,
  changeSavedDefenseComparisonLifecycle,
} from './defense-research-api.js';
import {
  getResearchPortfolio,
  listResearchPortfolios,
} from '../research-portfolios/research-portfolios-api.js';
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({}) }));
vi.mock('./defense-research-api.js', () => ({
  addSavedDefenseComparisonSelection: vi.fn(),
  changeSavedDefenseComparisonLifecycle: vi.fn(),
}));
vi.mock('../research-portfolios/research-portfolios-api.js', () => ({
  getResearchPortfolio: vi.fn(),
  listResearchPortfolios: vi.fn(),
}));
const authority = ['user-a', 'org-a', null] as const;
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
const saved: any = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Exact capture',
  ownerUserId: 'user-a',
  portfolioId: null,
  revision: 3,
  archivedAt: null,
  currentVersion: {
    id: '22222222-2222-4222-8222-222222222222',
    version: 2,
    schemaVersion: 'defense_saved_comparison_v1',
    displayVersion: 'defense-compare-display-v1',
    projectionVersion: 'defense-comparison-v1',
    subjects: [
      { type: 'program_element', id: '0600000A' },
      { type: 'program_element', id: '0600001A' },
    ],
    selection: { mode: 'explicit', subjectKeys: ['program_element:0600000A'], passageIds: [] },
    basisPair: { left: basis, right: basis },
    passageMode: 'none',
    sourcePins: { evidence: [] },
    capturedProjection: {
      projectionVersion: 'defense-comparison-v1',
      subjects: [
        {
          key: 'program_element:0600000A',
          type: 'program_element',
          id: '0600000A',
          label: 'Retained public PE',
          availability: 'available',
        },
      ],
      metrics: [],
      alignments: [],
      limitations: [],
    },
    contentHash: 'a'.repeat(64),
    capturedAt: '2026-09-28T00:00:00.000Z',
    captureKnownAt: '2026-09-28T00:00:00.000Z',
    knownAtSupport: 'capture_only',
    limitations: [],
  },
};
const portfolio: any = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Owned portfolio',
  lifecycle: 'active',
  revision: 7,
  myRole: 'owner',
};
const key = (value: readonly unknown[]) =>
  'capiro:defense-compare-action-pending:v1:' + JSON.stringify(value);
function mount(props: any = {}) {
  const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    }),
    onLoad = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <DefenseSavedComparisonActions
        authority={authority}
        saved={saved}
        onLoad={onLoad}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...view, client, onLoad };
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(listResearchPortfolios).mockResolvedValue({
    items: [portfolio],
    nextCursor: null,
  } as any);
  vi.mocked(getResearchPortfolio).mockResolvedValue(portfolio);
});
afterEach(() => cleanup());
describe('saved capture action authority and durable recovery', () => {
  it('stores exact explicit selection/version/revisions before POST, and uses no unselected subjects', async () => {
    let stored: any;
    vi.mocked(addSavedDefenseComparisonSelection).mockImplementation(
      async (_api, id, versionId, input) => {
        stored = JSON.parse(localStorage.getItem(key(authority))!);
        expect(stored.action).toEqual({ kind: 'selection', id, versionId, input });
        return {
          comparison: saved,
          eventId: 'actual-receipt',
          resultingRevision: 4,
          replayed: false,
          portfolioId: portfolio.id,
          portfolioRevision: 8,
          outcomes: [],
        } as any;
      },
    );
    mount();
    await screen.findByRole('option', { name: 'Owned portfolio' });
    fireEvent.change(screen.getByLabelText('Target portfolio'), {
      target: { value: portfolio.id },
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Add selected saved items' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(screen.getByLabelText('Retained public PE'));
    fireEvent.click(screen.getByRole('button', { name: 'Add selected saved items' }));
    await waitFor(() => expect(addSavedDefenseComparisonSelection).toHaveBeenCalledTimes(1));
    expect(stored.action.versionId).toBe(saved.currentVersion.id);
    expect(stored.action.input.expectedRevision).toBe(3);
    expect(stored.action.input.expectedPortfolioRevision).toBe(7);
    expect(stored.action.input.selection).toEqual({
      mode: 'explicit',
      subjectKeys: ['program_element:0600000A'],
      passageIds: [],
    });
  });
  it('unknown archive survives remount and retries original request only after explicit click', async () => {
    vi.mocked(changeSavedDefenseComparisonLifecycle)
      .mockRejectedValueOnce(Error('network lost'))
      .mockResolvedValueOnce({
        comparison: { ...saved, revision: 4, archivedAt: '2026-09-28T01:00:00.000Z' },
        eventId: 'receipt',
        resultingRevision: 4,
        replayed: true,
      } as any);
    const first = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Archive saved comparison' }));
    await screen.findByRole('button', { name: 'Retry original saved action' });
    const original = JSON.parse(localStorage.getItem(key(authority))!).action;
    first.unmount();
    mount();
    expect(changeSavedDefenseComparisonLifecycle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry original saved action' }));
    await waitFor(() => expect(changeSavedDefenseComparisonLifecycle).toHaveBeenCalledTimes(2));
    expect(vi.mocked(changeSavedDefenseComparisonLifecycle).mock.calls[1]!.slice(1)).toEqual([
      original.id,
      original.input,
      true,
    ]);
  });
  it('fresh definitive409 unlocks while unknown followed by409 retains original lock', async () => {
    const conflict = { response: { status: 409 } };
    vi.mocked(changeSavedDefenseComparisonLifecycle).mockRejectedValueOnce(conflict);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Archive saved comparison' }));
    await screen.findByText(/action was rejected/i);
    expect(
      screen.getByRole('button', { name: 'Archive saved comparison' }).hasAttribute('disabled'),
    ).toBe(false);
    expect(screen.queryByRole('button', { name: 'Retry original saved action' })).toBeNull();
    cleanup();
    localStorage.clear();
    vi.mocked(changeSavedDefenseComparisonLifecycle)
      .mockRejectedValueOnce(Error('network'))
      .mockRejectedValueOnce(conflict);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Archive saved comparison' }));
    await screen.findByRole('button', { name: 'Retry original saved action' });
    const original = localStorage.getItem(key(authority));
    fireEvent.click(screen.getByRole('button', { name: 'Retry original saved action' }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(key(authority))!).inFlight).toBe(false),
    );
    expect(
      screen.getByRole('button', { name: 'Archive saved comparison' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(JSON.parse(localStorage.getItem(key(authority))!).action).toEqual(
      JSON.parse(original!).action,
    );
  });
  it('different user/org/impersonation authority never reuses pending action or query cache', async () => {
    vi.mocked(changeSavedDefenseComparisonLifecycle).mockRejectedValueOnce(Error('unknown'));
    const a = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Archive saved comparison' }));
    await screen.findByRole('button', { name: 'Retry original saved action' });
    a.unmount();
    const next = ['user-b', 'org-b', 'tenant-b'] as const,
      b = mount({ authority: next });
    expect(screen.queryByRole('button', { name: 'Retry original saved action' })).toBeNull();
    expect(changeSavedDefenseComparisonLifecycle).toHaveBeenCalledTimes(1);
    expect(
      b.client
        .getQueryCache()
        .getAll()
        .every(
          (query) =>
            query.queryKey.includes('user-b') &&
            query.queryKey.includes('org-b') &&
            query.queryKey.includes('tenant-b'),
        ),
    ).toBe(true);
    expect(localStorage.getItem(key(authority))).not.toBeNull();
    expect(localStorage.getItem(key(next))).toBeNull();
  });
  it('confirmed success remains known when durable cleanup throws', async () => {
    vi.mocked(changeSavedDefenseComparisonLifecycle).mockResolvedValueOnce({
      comparison: { ...saved, revision: 4, archivedAt: '2026-09-28T01:00:00.000Z' },
      eventId: 'receipt',
      resultingRevision: 4,
      replayed: false,
    } as any);
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw Error('storage unavailable');
    });
    const view = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Archive saved comparison' }));
    await waitFor(() => expect(view.onLoad).toHaveBeenCalledWith(saved.id));
    expect(screen.queryByRole('button', { name: 'Retry original saved action' })).toBeNull();
    expect(JSON.parse(localStorage.getItem(key(authority))!).resolved).toBe(true);
    remove.mockRestore();
  });
});
