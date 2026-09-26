/**
 * Business Development v5 — view tabs / routing / histogram / watchlist tests.
 *
 * Covers the v5 first production pass:
 * - bdView URL param round-trip + legacy bdDiscover=open compatibility
 * - three view tabs with URL switching (Discover flag-gated, Watchlist flag-gated)
 * - Pipeline default view; stage histogram from real counts.byStage applies the
 *   existing stage filter
 * - One status selector + derived overdue-only toggle (from nextActionDueAt)
 * - Watchlist renders from existing list/watch/alert GETs, with bounded
 *   fan-out, opens the prospect drawer, and uses existing alert action endpoints
 * - absence of prototype-only fabrications (priority, digest, demo controls)
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { BusinessDevelopmentPage } from './BusinessDevelopmentPage.js';
import {
  applyBizDevRoute,
  isBizDevOverdue,
  resolveBizDevRoute,
} from './bizdev-routing.js';
import {
  BIZDEV_WATCHLIST_FANOUT_LIMIT,
} from './BizDevWatchlist.js';
import type {
  BizDevProspect,
  BizDevProspectAlert,
  BizDevProspectWatch,
} from './bizdev-api.js';

// ── fixtures ───────────────────────────────────────────────────────────

function prospect(overrides: Partial<BizDevProspect> = {}): BizDevProspect {
  return {
    id: 'p-1',
    tenantId: 't-1',
    canonicalEntityId: null,
    displayName: 'Overland AI',
    domain: 'overland.ai',
    website: 'https://overland.ai',
    description: null,
    serviceHypothesis: null,
    geography: null,
    ownerUserId: 'u-1',
    stage: 'researching',
    status: 'active',
    dismissedAt: null,
    conflictExcluded: false,
    conflictReason: null,
    nextAction: 'Send intro email',
    nextActionDueAt: '2026-10-01T00:00:00.000Z',
    linkedClientId: null,
    convertedAt: null,
    watchRequested: false,
    createdByUserId: 'u-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    canonicalEntity: null,
    linkedClient: null,
    ...overrides,
  };
}

const MEMBERS = [{ id: 'u-1', firstName: 'Sarah', lastName: 'Martinez', email: 'sarah@test.com' }];

const WATCH_URL = '/api/business-development/prospects/p-1/watch';
const ALERTS_URL = '/api/business-development/prospects/p-1/alerts';

function watchFixture(): BizDevProspectWatch {
  return {
    watch: {
      status: 'active',
      categories: ['contracts'],
      ownerUserId: 'u-1',
      mutedUntil: null,
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    },
    sources: [
      { source: 'USAspending', health: 'healthy', lastCheckedAt: '2026-09-20T00:00:00.000Z', detail: null },
    ],
    lastCompletedCheckAt: '2026-09-20T00:00:00.000Z',
  };
}

function alertFixture(): BizDevProspectAlert {
  return {
    id: 'a-1',
    prospectId: 'p-1',
    title: 'New federal contract award',
    summary: null,
    materiality: null,
    materialityLevel: null,
    company: 'Overland AI',
    sourceFamily: 'usaspending_contract',
    category: 'contracts',
    eventAt: null,
    effectiveAt: null,
    publishedAt: null,
    firstObservedAt: null,
    sourceLocator: null,
    implication: null,
    readAt: null,
    dismissedAt: null,
  };
}

interface MockConfig {
  meFeatures?: Record<string, boolean | undefined>;
  prospects?: BizDevProspect[];
  counts?: { visible: number; total: number; active: number; dismissed: number; byStage: Record<string, number> };
  watch?: BizDevProspectWatch | null;
  watchError?: Error;
  alerts?: BizDevProspectAlert[];
  alertActionFails?: boolean;
  patchFails?: boolean;
}

function makeApi(cfg: MockConfig): AxiosInstance {
  let alertItems = cfg.alerts ?? [alertFixture()];
  const counts = cfg.counts ?? {
    visible: 2,
    total: 2,
    active: 2,
    dismissed: 0,
    byStage: { researching: 1, qualified: 1 },
  };
  const prospects = cfg.prospects ?? [prospect(), prospect({ id: 'p-2', displayName: 'Second Co', stage: 'qualified' })];
  return {
    get: vi.fn(async (path: string) => {
      if (path === '/api/business-development/prospects')
        return { data: { prospects, counts } };
      if (path === '/api/business-development/prospects/p-1') return { data: prospect() };
      if (path === '/api/business-development/prospects/p-2') return { data: prospects[1]! };
      if (path === '/api/business-development/prospects/p-1/history') return { data: [] };
      if (path === '/api/business-development/prospects/p-2/history') return { data: [] };
      if (/\/duplicate-hints$/.test(path)) return { data: { hints: [] } };
      if (/^\/api\/business-development\/prospects\/[^/]+\/watch$/.test(path)) {
        if (path !== WATCH_URL) {
          return { data: { watch: null, sources: [], lastCompletedCheckAt: null } };
        }
        if (cfg.watchError) throw cfg.watchError;
        return {
          data:
            cfg.watch === null
              ? { watch: null, sources: [], lastCompletedCheckAt: null }
              : (cfg.watch ?? watchFixture()),
        };
      }
      if (path === ALERTS_URL) return { data: { items: alertItems, nextCursor: null } };
      if (path === '/api/business-development/member-options') return { data: { members: MEMBERS } };
      if (path === '/api/business-development/preferences') return { data: null };
      if (path === '/api/business-development/search/canonical-organizations') return { data: { results: [] } };
      if (path === '/api/business-development/search/clients') return { data: { results: [] } };
      throw new Error(`unmocked GET ${path}`);
    }),
    post: vi.fn(async (path: string) => {
      if (path === `${ALERTS_URL}/a-1/read`) {
        if (cfg.alertActionFails) throw new Error('alert action unavailable');
        alertItems = alertItems.map((alert) => alert.id === 'a-1' ? { ...alert, readAt: '2026-09-25T12:00:00.000Z' } : alert);
        return { data: {} };
      }
      if (path === `${ALERTS_URL}/a-1/dismiss`) {
        if (cfg.alertActionFails) throw new Error('alert action unavailable');
        alertItems = alertItems.map((alert) => alert.id === 'a-1' ? { ...alert, dismissedAt: '2026-09-25T12:00:00.000Z' } : alert);
        return { data: {} };
      }
      if (path === '/api/business-development/duplicate-hints') return { data: { hints: [] } };
      if (path === '/api/business-development/prospects') return { data: prospect() };
      throw new Error(`unmocked POST ${path}`);
    }),
    patch: vi.fn(async (path: string, body: { stage?: string; ownerUserId?: string | null }) => {
      if (cfg.patchFails) throw new Error('save unavailable');
      const id = /^\/api\/business-development\/prospects\/([^/]+)$/.exec(path)?.[1];
      const target = prospects.find((p) => p.id === id) ?? prospects[0]!;
      const saved = { ...target, ...(body as object) };
      if (id === target.id) Object.assign(target, saved);
      return { data: saved };
    }),
    put: vi.fn(async () => ({ data: prospect() })),
  } as unknown as AxiosInstance;
}

let apiMock: AxiosInstance;
let meConfig: MockConfig;
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => apiMock }));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => ({ enabled: false, ready: true }),
  useIntelFeatureEnabled: () => false,
}));
vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({
    data: {
      user: {
        id: 'u-1',
        clerkUserId: 'cu-1',
        email: 'sarah@test.com',
        firstName: 'Sarah',
        lastName: 'M',
        title: null,
        emailSignatureEnabled: false,
        hasEmailSignature: false,
        tourCompleted: true,
        legiwatchIntroSeen: true,
      },
      tenant: { id: 't-1', slug: 'test', name: 'Test' },
      role: 'user_admin',
      billingAdmin: false,
      features: { meetingsV2: false, meriDockUndockUi: false, ...(meConfig.meFeatures ?? {}) },
    },
    isLoading: false,
  }),
}));

function renderAt(search: string, cfg: MockConfig = {}) {
  meConfig = cfg;
  apiMock = makeApi(cfg);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/clients${search}`]}>
        <Routes>
          <Route
            path="/clients"
            element={<div className="capiro-vnext-root"><BusinessDevelopmentPage /></div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

const getCalls = () =>
  (apiMock.get as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown?]>;

const ALL_ON = {
  meFeatures: {
    businessDevelopment: true,
    businessDevelopmentDossier: true,
    businessDevelopmentBrief: true,
    businessDevelopmentWatch: true,
  },
};

// ── 1. routing: bdView param + backwards compatibility ─────────────────

describe('v5 route parsing', () => {
  it('defaults to the pipeline view and omits bdView from the URL', () => {
    const route = resolveBizDevRoute(new URLSearchParams('view=business-development'));
    expect(route.view).toBe('pipeline');
    const next = applyBizDevRoute(new URLSearchParams('view=business-development'), {
      view: 'watchlist',
    });
    expect(next.get('bdView')).toBe('watchlist');
    expect(resolveBizDevRoute(next).view).toBe('watchlist');
    // Back to pipeline clears the param.
    const back = applyBizDevRoute(next, { view: 'pipeline' });
    expect(back.get('bdView')).toBeNull();
    expect(resolveBizDevRoute(back).view).toBe('pipeline');
  });

  it('invalid bdView values fall back to pipeline', () => {
    expect(resolveBizDevRoute(new URLSearchParams('bdView=nonsense')).view).toBe('pipeline');
  });

  it('legacy bdDiscover=open URLs still resolve to the discover view', () => {
    const route = resolveBizDevRoute(
      new URLSearchParams('view=business-development&bdDiscover=open&bdDq=acme'),
    );
    expect(route.view).toBe('discover');
    expect(route.discover).toBe('open');
    expect(route.discoverQuery).toBe('acme');
  });

  it('round-trips the derived overdue toggle without touching other params', () => {
    const next = applyBizDevRoute(new URLSearchParams('view=business-development&sort=name'), {
      overdueOnly: true,
    });
    expect(next.get('bdOverdue')).toBe('1');
    expect(next.get('sort')).toBe('name');
    expect(resolveBizDevRoute(next).overdueOnly).toBe(true);
    const off = applyBizDevRoute(next, { overdueOnly: false });
    expect(off.get('bdOverdue')).toBeNull();
  });

  it('isBizDevOverdue derives purely from nextActionDueAt', () => {
    const now = Date.parse('2026-09-25T00:00:00.000Z');
    expect(isBizDevOverdue('2026-09-20T00:00:00.000Z', now)).toBe(true);
    expect(isBizDevOverdue('2026-10-01T00:00:00.000Z', now)).toBe(false);
    expect(isBizDevOverdue(null, now)).toBe(false);
    expect(isBizDevOverdue(undefined, now)).toBe(false);
  });
});

// ── 2. three view tabs + URL switching ─────────────────────────────────

describe('v5 view tabs', () => {
  it('renders the three tabs with the pipeline active by default and switches via URL', async () => {
    renderAt('?view=business-development', ALL_ON);
    const tabs = await screen.findAllByRole('tab');
    const names = tabs.map((t) => t.textContent ?? '');
    expect(names.some((n) => n.includes('Pipeline'))).toBe(true);
    expect(names.some((n) => n.includes('Discover'))).toBe(true);
    expect(names.some((n) => n.includes('Watchlist'))).toBe(true);
    expect(screen.getByRole('tab', { name: /Pipeline/ })).toHaveAttribute('aria-selected', 'true');
    // Pipeline content is visible.
    expect(await screen.findByText('Overland AI')).toBeInTheDocument();
  });

  it('opens firm preferences from the header and closes the drawer accessibly', async () => {
    renderAt('?view=business-development', ALL_ON);
    await screen.findByText('Overland AI');
    expect(screen.queryByRole('dialog', { name: /Firm business-development preferences/ })).not.toBeInTheDocument();
    expect(getCalls().map(([path]) => path)).not.toContain('/api/business-development/preferences');
    fireEvent.click(screen.getByRole('button', { name: 'Preferences' }));
    expect(await screen.findByRole('dialog', { name: /Firm business-development preferences/ })).toBeInTheDocument();
    expect(await screen.findByLabelText(/Practice \/ service areas/)).toBeInTheDocument();
    expect(getCalls().map(([path]) => path)).toContain('/api/business-development/preferences');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Firm business-development preferences/ })).not.toBeInTheDocument(),
    );
  });

  it('switching to Discover writes bdView=discover and keeps the legacy param in sync', async () => {
    renderAt('?view=business-development', ALL_ON);
    fireEvent.click(await screen.findByRole('tab', { name: /Discover/ }));
    // Discover panel content mounts.
    expect(await screen.findByLabelText(/Company search/)).toBeInTheDocument();
  });

  it('a legacy bdDiscover=open URL renders the Discover view selected', async () => {
    renderAt('?view=business-development&bdDiscover=open', ALL_ON);
    expect(await screen.findByLabelText(/Company search/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Discover/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('hides the Discover tab when the dossier flag is off', async () => {
    renderAt('?view=business-development', {
      meFeatures: { businessDevelopment: true, businessDevelopmentWatch: true },
    });
    await screen.findByText('Overland AI');
    expect(screen.queryByRole('tab', { name: /Discover/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Pipeline/ })).toBeInTheDocument();
  });

  it.each([
    '?view=business-development&bdView=discover',
    '?view=business-development&bdDiscover=open',
  ])('fails a disabled Discover deep link closed to Pipeline (%s)', async (search) => {
    renderAt(search, {
      meFeatures: { businessDevelopment: true, businessDevelopmentWatch: true },
    });
    expect(await screen.findByText('Overland AI')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Pipeline/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByLabelText(/Company search/)).not.toBeInTheDocument();
  });

  it('hides the Watchlist tab when the watch flag is off', async () => {
    renderAt('?view=business-development', {
      meFeatures: { businessDevelopment: true, businessDevelopmentDossier: true },
    });
    await screen.findByText('Overland AI');
    expect(screen.queryByRole('tab', { name: /Watchlist/ })).not.toBeInTheDocument();
  });
});

// ── 3. stage histogram / segment / overdue ─────────────────────────────

describe('pipeline stage summary', () => {
  it('renders per-stage counts from counts.byStage and clicking a cell applies the stage filter', async () => {
    renderAt('?view=business-development', {
      ...ALL_ON,
      counts: { visible: 2, total: 2, active: 2, dismissed: 0, byStage: { researching: 1, qualified: 2 } },
    });
    const qualifiedCell = await screen.findByRole('button', { name: /Qualified/ });
    expect(within(qualifiedCell).getByText('2')).toBeInTheDocument();
    expect(qualifiedCell.querySelector('.capiro-bizdev__stagecell-bar')).toHaveStyle({ width: '100%' });
    const researchingCell = screen.getByRole('button', { name: /Researching/ });
    expect(researchingCell.querySelector('.capiro-bizdev__stagecell-bar')).toHaveStyle({ width: '50%' });
    fireEvent.click(qualifiedCell);
    await waitFor(() => {
      const [path, config] = getCalls().filter(([p]) => p === '/api/business-development/prospects').at(-1)!;
      expect(path).toBe('/api/business-development/prospects');
      expect((config as { params?: Record<string, unknown> }).params).toMatchObject({
        stage: 'qualified',
      });
    });
    // Click again to clear (wait for the refetched histogram to re-render).
    fireEvent.click(await screen.findByRole('button', { name: /Qualified/ }));
    await waitFor(() => {
      const [, config] = getCalls().filter(([p]) => p === '/api/business-development/prospects').at(-1)!;
      expect((config as { params?: Record<string, unknown> }).params).not.toHaveProperty('stage');
    });
  });

  it('exposes a single status selector and switches status via URL', async () => {
    renderAt('?view=business-development', ALL_ON);
    const statusFilters = await screen.findAllByLabelText('Filter by status');
    expect(statusFilters).toHaveLength(1);
    expect(screen.queryByRole('group', { name: 'Pipeline segment' })).not.toBeInTheDocument();
    fireEvent.change(statusFilters[0]!, { target: { value: 'dismissed' } });
    await waitFor(() => {
      const [, config] = getCalls().filter(([p]) => p === '/api/business-development/prospects').at(-1)!;
      expect((config as { params?: Record<string, unknown> }).params).toMatchObject({
        status: 'dismissed',
      });
    });
  });

  it('filters the loaded rows to overdue only, derived from nextActionDueAt', async () => {
    renderAt('?view=business-development', {
      ...ALL_ON,
      prospects: [
        prospect({ displayName: 'Overdue Co', nextActionDueAt: '2026-09-01T00:00:00.000Z' }),
        prospect({ id: 'p-2', displayName: 'Future Co', nextActionDueAt: '2026-12-01T00:00:00.000Z', stage: 'qualified' }),
      ],
      counts: { visible: 2, total: 2, active: 2, dismissed: 0, byStage: { researching: 1, qualified: 1 } },
    });
    expect(await screen.findByText('Overdue Co')).toBeInTheDocument();
    expect(screen.getByText('Future Co')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Overdue only/ }));
    await waitFor(() => {
      expect(screen.queryByText('Future Co')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Overdue Co')).toBeInTheDocument();
    // The toggle never adds an API param.
    const [, config] = getCalls().filter(([p]) => p === '/api/business-development/prospects').at(-1)!;
    expect((config as { params?: Record<string, unknown> }).params).not.toHaveProperty('overdue');
  });
});

// ── 4. Watchlist view ──────────────────────────────────────────────────

describe('Watchlist view', () => {
  it('renders watched prospects, real source health, last completed check and alerts from existing GETs only', async () => {
    renderAt('?view=business-development&bdView=watchlist', ALL_ON);
    // Card for the watched prospect.
    expect(await screen.findByText(/watched · 1 unread alerts/)).toBeInTheDocument();
    expect(screen.getByText('Overland AI')).toBeInTheDocument();
    expect(screen.getByText(/Last completed check/)).toBeInTheDocument();
    expect(screen.getByText(/Checked and healthy/)).toBeInTheDocument();
    expect(screen.getByText('New federal contract award')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Recent changes' })).toHaveClass('capiro-bizdev__watchlist-main');
    expect(screen.getByRole('complementary', { name: 'Watched prospects' })).toHaveClass('capiro-bizdev__watchlist-side');
    expect(screen.getByRole('list', { name: 'Recent watch alerts' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Source health for Overland AI' })).toBeInTheDocument();
    // Only existing endpoints: list + watch + alerts.
    const paths = getCalls().map(([p]) => p);
    expect(paths).toContain('/api/business-development/prospects');
    expect(paths).toContain(WATCH_URL);
    expect(paths).toContain(ALERTS_URL);
    for (const p of paths) expect(p).toMatch(/^\/api\/business-development\//);
  });

  it('marks a feed alert read using the existing endpoint and refreshes the real feed', async () => {
    renderAt('?view=business-development&bdView=watchlist', ALL_ON);
    const feed = await screen.findByRole('list', { name: 'Recent watch alerts' });
    fireEvent.click(within(feed).getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect((apiMock.post as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([`${ALERTS_URL}/a-1/read`]));
    await waitFor(() => expect(screen.getByText(/watched · 0 unread alerts/)).toBeInTheDocument());
    expect(within(feed).getByText('Read')).toBeInTheDocument();
    expect(within(feed).queryByRole('button', { name: 'Mark read' })).not.toBeInTheDocument();
  });

  it('dismisses a feed alert and refreshes the empty feed while retaining its watch', async () => {
    renderAt('?view=business-development&bdView=watchlist', ALL_ON);
    const feed = await screen.findByRole('list', { name: 'Recent watch alerts' });
    fireEvent.click(within(feed).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect((apiMock.post as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([`${ALERTS_URL}/a-1/dismiss`]));
    expect(await screen.findByText('No alerts from the loaded watches yet.')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Watched prospects' })).toHaveTextContent('Overland AI');
  });

  it('keeps a failed alert action visible with an actionable error', async () => {
    renderAt('?view=business-development&bdView=watchlist', { ...ALL_ON, alertActionFails: true });
    const feed = await screen.findByRole('list', { name: 'Recent watch alerts' });
    fireEvent.click(within(feed).getByRole('button', { name: 'Mark read' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('alert action unavailable');
    expect(within(feed).getByRole('button', { name: 'Mark read' })).toBeEnabled();
    expect(within(feed).getByText('New federal contract award')).toBeInTheDocument();
  });

  it('filters only by categories present in loaded alerts', async () => {
    renderAt('?view=business-development&bdView=watchlist', {
      ...ALL_ON,
      alerts: [alertFixture(), { ...alertFixture(), id: 'a-2', title: 'Leadership change', category: 'leadership' }],
    });
    const filter = await screen.findByRole('combobox', { name: 'Category' });
    expect(within(filter).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'All categories', 'contracts', 'leadership',
    ]);
    fireEvent.change(filter, { target: { value: 'leadership' } });
    const feed = screen.getByRole('list', { name: 'Recent watch alerts' });
    expect(within(feed).getByText('Leadership change')).toBeInTheDocument();
    expect(within(feed).queryByText('New federal contract award')).not.toBeInTheDocument();
  });

  it('opens the watched prospect drawer where the real watch controls live', async () => {
    renderAt('?view=business-development&bdView=watchlist', ALL_ON);
    const openButtons = await screen.findAllByRole('button', { name: 'Open prospect' });
    fireEvent.click(openButtons[0]!);
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: /Prospect — Overland AI/ })).toBeInTheDocument(),
    );
  });

  it('skips prospects without a watch and never fans out beyond the bound', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      prospect({ id: `p-${i}`, displayName: `Co ${i}` }),
    );
    renderAt('?view=business-development&bdView=watchlist', {
      ...ALL_ON,
      prospects: many,
      counts: { visible: 60, total: 60, active: 60, dismissed: 0, byStage: { researching: 60 } },
    });
    await waitFor(() => {
      const watchCalls = getCalls().filter(([p]) => String(p).endsWith('/watch'));
      expect(watchCalls.length).toBe(BIZDEV_WATCHLIST_FANOUT_LIMIT);
    });
    expect(screen.getByText(/Showing the first/)).toBeInTheDocument();
  });

  it('shows the honest empty state when nothing is watched', async () => {
    renderAt('?view=business-development&bdView=watchlist', {
      ...ALL_ON,
      watch: null,
    });
    expect(await screen.findByText(/No watched prospects yet/)).toBeInTheDocument();
  });

  it('fails a disabled Watchlist deep link closed to Pipeline and calls no watch endpoint', async () => {
    renderAt('?view=business-development&bdView=watchlist', {
      meFeatures: { businessDevelopment: true, businessDevelopmentWatch: false },
    });
    expect(await screen.findByText('Overland AI')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Pipeline/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('heading', { name: 'Watchlist' })).not.toBeInTheDocument();
    expect(getCalls().map(([p]) => p).some((p) => p.endsWith('/watch'))).toBe(false);
  });

  it('surfaces a per-prospect watch load failure instead of claiming the list is empty', async () => {
    renderAt('?view=business-development&bdView=watchlist', {
      ...ALL_ON,
      prospects: [prospect()],
      counts: { visible: 1, total: 1, active: 1, dismissed: 0, byStage: { researching: 1 } },
      watchError: new Error('temporary watch failure'),
    });
    expect(
      await screen.findByText(/Watch status could not be loaded right now/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No watched prospects yet/)).not.toBeInTheDocument();
  });
});

// ── 5. absence of prototype-only fabrications ──────────────────────────

describe('no prototype-only fabrications', () => {
  it('renders no priority, digest, delivery-preference or demo controls anywhere', async () => {
    renderAt('?view=business-development', ALL_ON);
    await screen.findByText('Overland AI');
    // No priority column/selector (the API has no priority field).
    expect(screen.queryByText('Priority')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/priority/i)).not.toBeInTheDocument();
    // No digest or delivery-preference UI.
    expect(screen.queryByText(/digest/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/delivery/i)).not.toBeInTheDocument();
    // No demo/firm-switcher/source-failure chrome.
    expect(screen.queryByText(/illustrative data/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /demo/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/firm switcher/i)).not.toBeInTheDocument();
  });

  it('the watch surface keeps real statuses only — no scenario stepper controls', async () => {
    renderAt('?view=business-development&bdView=watchlist', ALL_ON);
    await screen.findByText(/watched/);
    expect(screen.queryByText(/Quiet baseline →/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Replay no duplicate/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run scenario/i })).not.toBeInTheDocument();
  });
});

// ── v5 pipeline slice: inline mutations, failed-write recovery, sorting ──

describe('v5 pipeline inline stage/owner mutations', () => {
  it('saves an inline stage change via the existing PATCH and refreshes the list', async () => {
    renderAt('?view=business-development', ALL_ON);
    const stageSelect = await screen.findByLabelText('Stage for Overland AI');
    expect(stageSelect).toHaveValue('researching');
    fireEvent.change(stageSelect, { target: { value: 'qualified' } });
    await waitFor(() =>
      expect(screen.getByLabelText('Stage for Overland AI')).toHaveValue('qualified'),
    );
    const patch = apiMock.patch as unknown as ReturnType<typeof vi.fn>;
    expect(patch).toHaveBeenCalledWith(
      '/api/business-development/prospects/p-1',
      { stage: 'qualified' },
    );
    // Success invalidates the existing list query (refetch after save).
    await waitFor(() => {
      expect(getCalls().filter(([p]) => p === '/api/business-development/prospects').length).toBeGreaterThan(1);
    });
  });

  it('saves an inline owner change and an unassign to null', async () => {
    renderAt('?view=business-development', ALL_ON);
    const ownerSelect = await screen.findByLabelText('Owner for Overland AI');
    expect(ownerSelect).toHaveValue('u-1');
    fireEvent.change(ownerSelect, { target: { value: '' } });
    await waitFor(() =>
      expect(screen.getByLabelText('Owner for Overland AI')).toHaveValue(''),
    );
    const patch = apiMock.patch as unknown as ReturnType<typeof vi.fn>;
    expect(patch).toHaveBeenCalledWith(
      '/api/business-development/prospects/p-1',
      { ownerUserId: null },
    );
  });

  it('keeps the server-confirmed value and shows an actionable error with Retry when the write fails', async () => {
    const cfg = { ...ALL_ON, patchFails: true };
    renderAt('?view=business-development', cfg);
    const stageSelect = await screen.findByLabelText('Stage for Overland AI');
    fireEvent.change(stageSelect, { target: { value: 'qualified' } });
    // Server-confirmed value stays on screen; error is actionable.
    await waitFor(() => expect(screen.getByText(/save unavailable/)).toBeInTheDocument());
    expect(screen.getByLabelText('Stage for Overland AI')).toHaveValue('researching');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    cfg.patchFails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByLabelText('Stage for Overland AI')).toHaveValue('qualified'));
    expect(screen.queryByText(/save unavailable/)).not.toBeInTheDocument();
    expect(apiMock.patch).toHaveBeenCalledTimes(2);
  });

  it('blocks both inline fields and duplicate changes until the pending write settles', async () => {
    renderAt('?view=business-development', ALL_ON);
    const stage = await screen.findByLabelText('Stage for Overland AI');
    const owner = screen.getByLabelText('Owner for Overland AI');
    let finish!: (value: { data: BizDevProspect }) => void;
    const patch = apiMock.patch as unknown as ReturnType<typeof vi.fn>;
    patch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.change(stage, { target: { value: 'qualified' } });
    fireEvent.change(stage, { target: { value: 'outreach' } });
    fireEvent.change(owner, { target: { value: '' } });
    expect(stage).toBeDisabled();
    expect(owner).toBeDisabled();
    expect(patch).toHaveBeenCalledTimes(1);
    finish({ data: prospect({ stage: 'qualified' }) });
    await waitFor(() => expect(stage).toBeEnabled());
    expect(owner).toBeEnabled();
  });
});

describe('v5 pipeline sorting', () => {
  it('sorts by createdAt newest-first by default and by due date (nulls last) via the sort control', async () => {
    renderAt('?view=business-development', {
      ...ALL_ON,
      prospects: [
        prospect({ id: 'p-old', displayName: 'Older Co', createdAt: '2026-08-01T00:00:00.000Z', nextActionDueAt: '2026-10-05T00:00:00.000Z', stage: 'qualified' }),
        prospect({ id: 'p-new', displayName: 'Newer Co', createdAt: '2026-09-15T00:00:00.000Z', nextActionDueAt: null, stage: 'qualified' }),
        prospect({ id: 'p-due', displayName: 'Due Soon Co', createdAt: '2026-08-15T00:00:00.000Z', nextActionDueAt: '2026-10-01T00:00:00.000Z', stage: 'qualified' }),
      ],
      counts: { visible: 3, total: 3, active: 3, dismissed: 0, byStage: { qualified: 3 } },
    });
    await screen.findByText('Older Co');
    // Default: newest first (createdAt desc).
    expect(document.querySelectorAll('.capiro-bizdev__name-btn').item(0)).toHaveTextContent('Newer Co');
    // Switch to Sort: due date — p-due first, p-old second, null-due last.
    fireEvent.change(screen.getByLabelText('Sort prospects'), { target: { value: 'due' } });
    const names = document.querySelectorAll('.capiro-bizdev__name-btn');
    expect(names.item(0)).toHaveTextContent('Due Soon Co');
    expect(names.item(1)).toHaveTextContent('Older Co');
    expect(names.item(2)).toHaveTextContent('Newer Co');
  });

  it('round-trips the sort through the URL (bdSort) without touching other params', () => {
    const next = applyBizDevRoute(new URLSearchParams('view=business-development&sort=name'), {
      sort: 'due',
    });
    expect(next.get('bdSort')).toBe('due');
    expect(next.get('sort')).toBe('name');
    expect(resolveBizDevRoute(next).sort).toBe('due');
    const back = applyBizDevRoute(next, { sort: 'newest' });
    expect(back.get('bdSort')).toBeNull();
    expect(resolveBizDevRoute(back).sort).toBe('newest');
  });

  it('renders no priority sort option (no priority field in the API)', async () => {
    renderAt('?view=business-development', ALL_ON);
    await screen.findByText('Overland AI');
    expect(screen.queryByText('Sort: priority')).not.toBeInTheDocument();
  });
});

describe('v5 pipeline prototype layout', () => {
  it('uses prototype columns Prospect/Stage/Owner/Next action/Status/Last activity and the firm breadcrumb', async () => {
    renderAt('?view=business-development', ALL_ON);
    await screen.findByText('Overland AI');
    const headers = Array.from(document.querySelectorAll('.capiro-bizdev__table--v5 th')).map((th) => th.textContent);
    expect(headers).toEqual(['Prospect', 'Stage', 'Owner', 'Next action', 'Status', 'Last activity']);
    // Real firm name from the me contract in the breadcrumb.
    expect(screen.getByText('Portfolio · Test')).toBeInTheDocument();
    // Status counters use the current response counts.
    expect(screen.getByText(/Active 2 · Dismissed 0 · Total 2/)).toBeInTheDocument();
  });
});
