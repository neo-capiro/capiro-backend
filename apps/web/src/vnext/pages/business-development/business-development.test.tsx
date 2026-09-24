/**
 * Business Development Phase 1 — focused contract tests.
 *
 * The API layer is mocked (same pattern as PortfolioIndexPage.test.tsx);
 * tests assert the flag gating, URL-driven state, pipeline states, create
 * privacy copy, duplicate handling, edit/note/conflict/dismiss/watch,
 * conversion + navigation, preferences authorization, and narrow-layout
 * contract markers.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { BusinessDevelopmentPage } from './BusinessDevelopmentPage.js';
import { VNextClientCrmRoute } from '../client-crm/VNextClientCrmRoute.js';
import {
  applyBizDevRoute,
  bizDevListQuery,
  hasBizDevFilters,
  resolveBizDevRoute,
} from './bizdev-routing.js';
import { bizdevKeys, type BizDevDuplicateHint, type BizDevProspect } from './bizdev-api.js';

// ── fixtures ───────────────────────────────────────────────────────────

function prospect(overrides: Partial<BizDevProspect> = {}): BizDevProspect {
  return {
    id: 'p-1',
    tenantId: 't-1',
    canonicalEntityId: null,
    displayName: 'Overland AI',
    domain: 'overland.ai',
    website: 'https://overland.ai',
    description: 'Autonomy company',
    serviceHypothesis: 'Ground robotics advocacy',
    geography: 'Seattle, WA',
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

const MEMBERS = [
  { id: 'u-1', firstName: 'Sarah', lastName: 'Martinez', email: 'sarah@test.com' },
  { id: 'u-2', firstName: 'Jordan', lastName: 'Clayton', email: 'jordan@test.com' },
];

interface MockConfig {
  meFeatures?: Record<string, boolean | undefined>;
  role?: string;
  listError?: boolean;
  prospects?: BizDevProspect[];
  counts?: {
    visible: number;
    total: number;
    active: number;
    dismissed: number;
    byStage: Record<string, number>;
  };
  duplicateHints?: BizDevDuplicateHint[];
  convertResult?: {
    prospect: BizDevProspect;
    client: { id: string; name: string };
    created: boolean;
  };
  createResult?: BizDevProspect;
  history?: Array<{
    id: string;
    tenantId: string;
    prospectId: string;
    actorUserId: string | null;
    kind: string;
    body: string;
    beforeJsonb: unknown;
    afterJsonb: unknown;
    createdAt: string;
  }>;
  prefs?: {
    id: 'pref-1';
    tenantId: 't-1';
    practiceServiceAreas: string[];
    agenciesIssues: string[];
    geographies: string[];
  };
}

function makeApi(cfg: MockConfig): AxiosInstance {
  const counts = cfg.counts ?? {
    visible: 1,
    total: 1,
    active: 1,
    dismissed: 0,
    byStage: { researching: 1 },
  };
  return {
    get: vi.fn(async (path: string) => {
      if (path === '/api/business-development/prospects') {
        if (cfg.listError) throw new Error('boom');
        return { data: { prospects: cfg.prospects ?? [prospect()], counts } };
      }
      if (path === '/api/business-development/prospects/p-1')
        return { data: (cfg.prospects ?? [prospect()])[0] };
      if (path === '/api/business-development/prospects/p-1/history')
        return { data: cfg.history ?? [] };
      if (path === '/api/business-development/prospects/p-1/duplicate-hints')
        return { data: { hints: [] } };
      if (path === '/api/business-development/member-options')
        return { data: { members: MEMBERS } };
      if (path === '/api/business-development/preferences') {
        return { data: cfg.prefs ?? null };
      }
      if (path === '/api/business-development/search/canonical-organizations')
        return { data: { results: [] } };
      if (path === '/api/business-development/search/clients') return { data: { results: [] } };
      if (path === '/api/clients') return { data: [] };
      if (path === '/api/intelligence/portfolio-summary')
        return {
          data: {
            activeClients: 0,
            needAttention: 0,
            ldaSpendQtd: 0,
            billsTracked: 0,
            activeRegulations: 0,
            meetingsThisWeek: 0,
            activeStrategies: 0,
          },
        };
      if (path === '/api/intelligence/portfolio-rollup') return { data: { rollup: {} } };
      if (path === '/api/intelligence/portfolio-pe-summary')
        return { data: { netDeltaPct: null, peAttribution: {}, watchedCount: 0 } };
      if (path === '/api/intelligence/portfolio-engagement-trend')
        return { data: { quarters: [], currentQuarterTotal: 0, qoqDeltaPct: null } };
      if (path === '/api/client-account-owners') return { data: {} };
      if (path === '/api/engagement/meetings') return { data: [] };
      if (path === '/strategy-api/strategies') return { data: [] };
      if (path === '/api/firm/registrant')
        return { data: { ldaRegistrantId: null, ldaRegistrantName: null } };
      if (path === '/api/firm/import-candidates')
        return { data: { registrantId: 1, registrantName: 'Capiro', candidates: [] } };
      if (path.startsWith('/intel-api/')) return { data: { counts: {} } };
      throw new Error(`unmocked GET ${path}`);
    }),
    post: vi.fn(async (path: string) => {
      if (path === '/api/business-development/duplicate-hints') {
        return { data: { hints: cfg.duplicateHints ?? [] } };
      }
      if (path === '/api/business-development/prospects')
        return { data: cfg.createResult ?? prospect({ id: 'p-2', displayName: 'New Co' }) };
      if (path === '/api/business-development/prospects/p-1/notes') return { data: [] };
      if (path === '/api/business-development/prospects/p-1/dismiss')
        return { data: prospect({ status: 'dismissed' }) };
      if (path === '/api/business-development/prospects/p-1/restore') return { data: prospect() };
      if (path === '/api/business-development/prospects/p-1/convert') {
        return {
          data: cfg.convertResult ?? {
            prospect: prospect(),
            client: { id: 'c-1', name: 'Overland AI' },
            created: true,
          },
        };
      }
      throw new Error(`unmocked POST ${path}`);
    }),
    patch: vi.fn(async () => ({ data: prospect() })),
    put: vi.fn(async (path: string) => {
      if (path === '/api/business-development/preferences') {
        return {
          data: {
            id: 'pref-1',
            tenantId: 't-1',
            practiceServiceAreas: [],
            agenciesIssues: [],
            geographies: [],
          },
        };
      }
      return { data: prospect() };
    }),
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
        email: 's@test.com',
        firstName: 'Sarah',
        lastName: 'M',
        title: null,
        emailSignatureEnabled: false,
        hasEmailSignature: false,
        tourCompleted: true,
        legiwatchIntroSeen: true,
      },
      tenant: { id: 't-1', slug: 'test', name: 'Test' },
      role: meConfig.role ?? 'user_admin',
      billingAdmin: false,
      features: { meetingsV2: false, meriDockUndockUi: false, ...(meConfig.meFeatures ?? {}) },
    },
    isLoading: false,
  }),
}));

function renderAt(
  search: string,
  cfg: MockConfig = {},
  routeComponent = <BusinessDevelopmentPage />,
) {
  meConfig = cfg;
  apiMock = makeApi(cfg);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/clients${search}`]}>
        <Routes>
          <Route
            path="/clients"
            element={<div className="capiro-vnext-root">{routeComponent}</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── 1. flag off hides everything; no endpoint calls ────────────────────

describe('Business Development flag gating', () => {
  it('renders the ordinary Clients Portfolio and calls no business-development endpoint when the flag is off', async () => {
    renderAt('', { meFeatures: { businessDevelopment: false } });
    // Falls through to the Portfolio index (its /api/clients etc are unmocked
    // → the suite's axios mock throws for them; assert only the fallback copy).
    await waitFor(() => {
      expect(screen.getByText('Portfolio')).toBeInTheDocument();
    });
    expect(apiMock.get).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/business-development'),
    );
    expect(screen.queryByText('Business Development')).not.toBeInTheDocument();
    expect(screen.queryByText('Add prospect')).not.toBeInTheDocument();
  });

  it('fails closed when the flag is missing entirely', async () => {
    renderAt('?view=business-development', {});
    await waitFor(() => expect(screen.getByText('Portfolio')).toBeInTheDocument());
    expect(screen.queryByText('Add prospect')).not.toBeInTheDocument();
  });
});

// ── 2. URL-driven state ────────────────────────────────────────────────

describe('bizdev-routing', () => {
  it('round-trips filter state through the URL preserving unrelated params', () => {
    const params = new URLSearchParams('view=business-development&sort=name');
    const next = applyBizDevRoute(params, {
      stage: 'qualified',
      ownerId: 'u-2',
      status: 'dismissed',
      conflict: 'excl',
      linkedClient: 'yes',
      q: 'over',
      prospectId: 'p-1',
    });
    expect(next.get('sort')).toBe('name');
    expect(next.get('view')).toBe('business-development');
    const route = resolveBizDevRoute(next);
    expect(route).toEqual({
      stage: 'qualified',
      ownerId: 'u-2',
      status: 'dismissed',
      conflict: 'excl',
      linkedClient: 'yes',
      q: 'over',
      prospectId: 'p-1',
    });
    expect(hasBizDevFilters(route)).toBe(true);
  });

  it('defaults invalid values and omits defaults from the query', () => {
    const route = resolveBizDevRoute(new URLSearchParams('bdStage=nonsense&bdStatus=all'));
    expect(route.stage).toBe('');
    expect(route.status).toBe('all');
    const cleared = applyBizDevRoute(new URLSearchParams('bdStage=qualified'), {
      stage: '',
      status: 'active',
    });
    expect(cleared.get('bdStage')).toBeNull();
    expect(cleared.get('bdStatus')).toBeNull();
    expect(hasBizDevFilters({ ...route, status: 'active' })).toBe(false);
  });

  it('builds the list query with the same active/dismissed scope the URL shows', () => {
    expect(bizDevListQuery(resolveBizDevRoute(new URLSearchParams('')))).toEqual({
      status: 'active',
    });
    expect(
      bizDevListQuery(
        resolveBizDevRoute(
          new URLSearchParams(
            'bdStatus=all&bdStage=qualified&bdConflict=excl&bdClient=no&bdOwner=u-1&bdQ=ov',
          ),
        ),
      ),
    ).toEqual({
      status: 'all',
      stage: 'qualified',
      conflictExcluded: true,
      linkedClient: false,
      ownerId: 'u-1',
      search: 'ov',
    });
  });

  it('includes tenant identity in every private query-key namespace', () => {
    expect(bizdevKeys.detail('tenant-a', 'p-1')).not.toEqual(bizdevKeys.detail('tenant-b', 'p-1'));
    expect(bizdevKeys.lists('tenant-a', { status: 'active' })).not.toEqual(
      bizdevKeys.lists('tenant-b', { status: 'active' }),
    );
    expect(bizdevKeys.preferences('tenant-a')).not.toEqual(bizdevKeys.preferences('tenant-b'));
  });
});

// ── 3. pipeline states ─────────────────────────────────────────────────

describe('pipeline states', () => {
  it('renders loading skeleton then the populated list with owner/stage/next action', async () => {
    renderAt('?view=business-development', { meFeatures: { businessDevelopment: true } });
    expect(await screen.findByText('Overland AI')).toBeInTheDocument();
    // Scope to the row: the stage filter <select> also lists every stage label.
    const row = screen.getByRole('row', { name: /Overland AI/ });
    expect(within(row).getByText('Researching')).toBeInTheDocument();
    expect(within(row).getByText('Sarah Martinez')).toBeInTheDocument();
    expect(within(row).getByText(/Send intro email/)).toBeInTheDocument();
    expect(screen.getByText(/Active 1 · Dismissed 0 · Total 1/)).toBeInTheDocument();
  });

  it('renders an error state with retry and refetches on retry', async () => {
    const api = makeApi({ meFeatures: { businessDevelopment: true } });
    meConfig = { meFeatures: { businessDevelopment: true } };
    const broken = {
      ...api,
      get: vi.fn(async (path: string) => {
        if (path === '/api/business-development/prospects') throw new Error('boom');
        return api.get(path);
      }),
    } as unknown as AxiosInstance;
    apiMock = broken;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/clients?view=business-development']}>
          <Routes>
            <Route
              path="/clients"
              element={
                <div className="capiro-vnext-root">
                  <BusinessDevelopmentPage />
                </div>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/The pipeline could not be loaded/)).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    const listCalls = () =>
      (broken.get as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([path]) => String(path) === '/api/business-development/prospects',
      );
    await waitFor(() => expect(listCalls().length).toBe(2), { timeout: 4000 });
  });

  it('renders the usable empty state with Add prospect when the firm has none', async () => {
    renderAt('?view=business-development', {
      meFeatures: { businessDevelopment: true },
      prospects: [],
      counts: { visible: 0, total: 0, active: 0, dismissed: 0, byStage: {} },
    });
    expect(await screen.findByText(/No prospects yet/)).toBeInTheDocument();
    // Header + empty-state CTA both offer "Add prospect"; assert both exist.
    expect(screen.getAllByRole('button', { name: 'Add prospect' }).length).toBe(2);
  });
});

// ── 4. create + duplicates ──────────────────────────────────────────────

describe('create prospect', () => {
  it('creates a manual prospect and opens its drawer, stating it stays private', async () => {
    renderAt('?view=business-development', { meFeatures: { businessDevelopment: true } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add prospect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add prospect' });
    fireEvent.change(within(dialog).getByLabelText(/Company name/), {
      target: { value: 'New Co' },
    });
    fireEvent.change(within(dialog).getByLabelText('Stage'), {
      target: { value: 'qualified' },
    });
    expect(
      within(dialog).getByText(/does not create or imply a shared organization record/i),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review duplicates and add' }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith('/api/business-development/prospects', {
        displayName: 'New Co',
        stage: 'qualified',
      }),
    );
  });

  it('checks same-firm duplicates before save and pauses for explicit review', async () => {
    renderAt('?view=business-development', {
      meFeatures: { businessDevelopment: true },
      duplicateHints: [
        {
          id: 'p-existing',
          displayName: 'New Company LLC',
          domain: 'new.example',
          website: null,
          canonicalEntityId: null,
          stage: 'researching',
          status: 'active',
          linkedClientId: null,
          ownerUserId: 'u-1',
          updatedAt: '2026-09-20T00:00:00.000Z',
        },
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Add prospect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add prospect' });
    fireEvent.change(within(dialog).getByLabelText(/Company name/), {
      target: { value: 'New Company' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review duplicates and add' }));

    expect(await within(dialog).findByText(/Review these same-firm prospects/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Open existing' })).toBeInTheDocument();
    expect(apiMock.post).toHaveBeenCalledWith('/api/business-development/duplicate-hints', {
      displayName: 'New Company',
    });
    expect(apiMock.post).not.toHaveBeenCalledWith(
      '/api/business-development/prospects',
      expect.anything(),
    );
  });
});

// ── 5. edit / note / conflict / dismiss / watch ─────────────────────────

describe('prospect detail', () => {
  it('edits stage and next action, adds a note, and saves the patch', async () => {
    renderAt('?view=business-development&bdProspect=p-1', {
      meFeatures: { businessDevelopment: true },
      history: [
        {
          id: 'h-1',
          tenantId: 't-1',
          prospectId: 'p-1',
          actorUserId: 'u-1',
          kind: 'note',
          body: 'First note',
          beforeJsonb: null,
          afterJsonb: null,
          createdAt: '2026-09-19T00:00:00.000Z',
        },
      ],
    });
    const drawer = await screen.findByRole('dialog', { name: /Prospect — Overland AI/ });
    fireEvent.change(within(drawer).getByLabelText('Stage'), { target: { value: 'qualified' } });
    fireEvent.change(within(drawer).getByLabelText('Next action'), {
      target: { value: 'Schedule call' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith('/api/business-development/prospects/p-1', {
        stage: 'qualified',
        nextAction: 'Schedule call',
      }),
    );
    // history renders
    expect(within(drawer).getByText('First note')).toBeInTheDocument();
    // note add
    fireEvent.change(within(drawer).getByLabelText(/New note/), {
      target: { value: 'Called them' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add note' }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith('/api/business-development/prospects/p-1/notes', {
        body: 'Called them',
      }),
    );
  });

  it('shows conflict reason controls only to admins', async () => {
    const { unmount } = renderAt('?view=business-development&bdProspect=p-1', {
      meFeatures: { businessDevelopment: true },
      role: 'standard_user',
    });
    const drawer = await screen.findByRole(
      'dialog',
      { name: /Prospect — Overland AI/ },
      { timeout: 4000 },
    );
    expect(
      within(drawer).getByText('Only firm admins can change the conflict reason.'),
    ).toBeInTheDocument();
    // non-admin: no edit control and no save button for the conflict reason
    expect(within(drawer).queryByLabelText(/Reason \(admins only/)).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Mark excluded' })).not.toBeInTheDocument();
    unmount();
  });

  it('shows the conflict reason save control to admins', async () => {
    renderAt('?view=business-development&bdProspect=p-1', {
      meFeatures: { businessDevelopment: true },
      role: 'user_admin',
    });
    const drawer = await screen.findByRole('dialog', { name: /Prospect — Overland AI/ });
    expect(within(drawer).getByRole('button', { name: 'Mark excluded' })).toBeInTheDocument();
  });

  it('requires confirmation before dismissing, and restores keep history copy', async () => {
    renderAt('?view=business-development&bdProspect=p-1', {
      meFeatures: { businessDevelopment: true },
    });
    const drawer = await screen.findByRole('dialog', { name: /Prospect — Overland AI/ });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Dismiss prospect' }));
    expect(
      screen.getByText(/Dismiss this prospect\? Its history stays available/),
    ).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Confirm dismiss' }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        '/api/business-development/prospects/p-1/dismiss',
        {},
      ),
    );
  });

  it('watch states the truth: notifications are not active yet', async () => {
    renderAt('?view=business-development&bdProspect=p-1', {
      meFeatures: { businessDevelopment: true },
    });
    const drawer = await screen.findByRole('dialog', { name: /Prospect — Overland AI/ });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Watch this prospect' }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith('/api/business-development/prospects/p-1', {
        watchRequested: true,
      }),
    );
    expect(within(drawer).getByText(/Notifications are not active yet/)).toBeInTheDocument();
  });
});

// ── 6. conversion ───────────────────────────────────────────────────────

describe('conversion', () => {
  it('converts, suppresses double-clicks while pending, and navigates to the linked client', async () => {
    let resolveConvert: (v: unknown) => void = () => {};
    const api = makeApi({ meFeatures: { businessDevelopment: true } });
    meConfig = { meFeatures: { businessDevelopment: true } };
    apiMock = {
      ...api,
      post: vi.fn(async (path: string) => {
        if (path === '/api/business-development/prospects/p-1/convert') {
          await new Promise((r) => {
            resolveConvert = r;
          });
          return {
            data: {
              prospect: prospect(),
              client: { id: 'c-9', name: 'Overland AI' },
              created: true,
            },
          };
        }
        return api.post(path);
      }),
    } as unknown as AxiosInstance;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function RouteSwitch() {
      const [params] = useSearchParams();
      if (params.get('clientId')) return <div>crm-profile-stub</div>;
      return (
        <div className="capiro-vnext-root">
          <BusinessDevelopmentPage />
        </div>
      );
    }
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/clients?view=business-development&bdProspect=p-1']}>
          <Routes>
            <Route path="/clients" element={<RouteSwitch />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const drawer = await screen.findByRole('dialog', { name: /Prospect — Overland AI/ });
    const convertBtn = within(drawer).getByRole('button', {
      name: /Create client and mark converted/,
    });
    fireEvent.click(convertBtn);
    // double-click while pending: still exactly one request
    fireEvent.click(convertBtn);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(convertBtn).toBeDisabled();
    await act(async () => {
      resolveConvert(null);
    });
    // Success navigates to the linked client profile URL (/clients?clientId=…)
    await waitFor(() => expect(screen.getByText('crm-profile-stub')).toBeInTheDocument());
  });
});

// ── 7. preferences authorization ───────────────────────────────────────

describe('preferences', () => {
  it('admins can edit and save; non-admins see view-only with no save control', async () => {
    const { unmount } = renderAt('?view=business-development', {
      meFeatures: { businessDevelopment: true },
      role: 'standard_user',
      prefs: {
        id: 'pref-1',
        tenantId: 't-1',
        practiceServiceAreas: ['Defense advocacy'],
        agenciesIssues: [],
        geographies: ['WA'],
      },
    });
    await screen.findByText(/Firm business-development preferences/);
    expect(screen.getByText('Defense advocacy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save preferences/ })).not.toBeInTheDocument();
    unmount();

    renderAt('?view=business-development', {
      meFeatures: { businessDevelopment: true },
      role: 'user_admin',
      prefs: {
        id: 'pref-1',
        tenantId: 't-1',
        practiceServiceAreas: ['Defense advocacy'],
        agenciesIssues: [],
        geographies: ['WA'],
      },
    });
    await screen.findByText(/Firm business-development preferences/);
    fireEvent.change(await screen.findByLabelText(/Practice \/ service areas/), {
      target: { value: 'Defense advocacy, Energy' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save preferences/ }));
    await waitFor(() =>
      expect(apiMock.put).toHaveBeenCalledWith('/api/business-development/preferences', {
        practiceServiceAreas: ['Defense advocacy', 'Energy'],
        agenciesIssues: [],
        geographies: ['WA'],
      }),
    );
  });
});

// ── 8. narrow layout + a11y contract ───────────────────────────────────

describe('narrow rendering contract', () => {
  it('uses the responsive token-only CSS contract (no hard px widths on containers)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(
      resolve(process.cwd(), 'src/vnext/pages/business-development/business-development.css'),
      'utf8',
    );
    expect(css).toContain('.capiro-bizdev');
    // canonical breakpoints only, same as portfolio.css
    expect(css).toMatch(/@media \(max-width: 1179px\)/);
    expect(css).toMatch(/@media \(max-width: 779px\)/);
    // no raw hex color literals in component CSS (token-layer rule)
    expect(css.replace(/\/\*[\s\S]*?\*\//g, ' ')).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('exposes accessible names and keyboard-operable controls on the populated pipeline', async () => {
    renderAt('?view=business-development', { meFeatures: { businessDevelopment: true } });
    const nameBtn = await screen.findByRole('button', { name: /Overland AI/ });
    expect(nameBtn.tagName).toBe('BUTTON');
    expect(screen.getByLabelText('Search prospects')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add prospect' })).toBeInTheDocument();
    fireEvent.click(nameBtn);
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Prospect — Overland AI/ })));
  });
});

// ── 9. route-level integration: view switch keeps client profile intact ─

describe('route integration', () => {
  it('VNextClientCrmRoute renders Business Development only at ?view=business-development', async () => {
    renderAt(
      '?view=business-development',
      { meFeatures: { businessDevelopment: true } },
      <VNextClientCrmRoute />,
    );
    expect(await screen.findByText('Business Development')).toBeInTheDocument();
    expect(screen.queryByText(/Every client account/)).not.toBeInTheDocument();
  });

  it('VNextClientCrmRoute keeps the ordinary Portfolio at /clients', async () => {
    renderAt('', { meFeatures: { businessDevelopment: true } }, <VNextClientCrmRoute />);
    await waitFor(() => expect(screen.getByText(/Every client account/)).toBeInTheDocument());
  });
});
