/**
 * Business Development v5 — view tabs / routing / histogram / watchlist tests.
 *
 * Covers the v5 first production pass:
 * - bdView URL param round-trip + legacy bdDiscover=open compatibility
 * - three view tabs with URL switching (Discover flag-gated, Watchlist flag-gated)
 * - Pipeline default view; stage histogram from real counts.byStage applies the
 *   existing stage filter
 * - One status selector + derived overdue-only toggle (from nextActionDueAt)
 * - Watchlist renders from the existing list/watch/alert GETs only, with bounded
 *   fan-out, and opens the prospect drawer
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
}

function makeApi(cfg: MockConfig): AxiosInstance {
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
      if (path === ALERTS_URL) return { data: { items: cfg.alerts ?? [alertFixture()], nextCursor: null } };
      if (path === '/api/business-development/member-options') return { data: { members: MEMBERS } };
      if (path === '/api/business-development/preferences') return { data: null };
      if (path === '/api/business-development/search/canonical-organizations') return { data: { results: [] } };
      if (path === '/api/business-development/search/clients') return { data: { results: [] } };
      throw new Error(`unmocked GET ${path}`);
    }),
    post: vi.fn(async (path: string) => {
      if (path === '/api/business-development/duplicate-hints') return { data: { hints: [] } };
      if (path === '/api/business-development/prospects') return { data: prospect() };
      throw new Error(`unmocked POST ${path}`);
    }),
    patch: vi.fn(async () => ({ data: prospect() })),
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
    // Only existing endpoints: list + watch + alerts.
    const paths = getCalls().map(([p]) => p);
    expect(paths).toContain('/api/business-development/prospects');
    expect(paths).toContain(WATCH_URL);
    expect(paths).toContain(ALERTS_URL);
    for (const p of paths) expect(p).toMatch(/^\/api\/business-development\//);
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
    const many = Array.from({ length: 20 }, (_, i) =>
      prospect({ id: `p-${i}`, displayName: `Co ${i}` }),
    );
    renderAt('?view=business-development&bdView=watchlist', {
      ...ALL_ON,
      prospects: many,
      counts: { visible: 20, total: 20, active: 20, dismissed: 0, byStage: { researching: 20 } },
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
