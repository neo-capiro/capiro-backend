/**
 * Business Development Phase 5 — focused watch & alerts contract tests.
 *
 * Same API-mock pattern as business-development.test.tsx. Covers:
 * - flag-off keeps the honest Phase 1 copy and never calls watch/alert APIs
 * - quiet-baseline copy renders with the real watch controls
 * - activate / pause / mute / resume POST+PATCH the frozen contracts
 * - source failure wording distinguishes error/stale/paused/pending
 * - alert rows render dates, materiality text, safe source link attributes,
 *   read + dismiss, and no duplicate actions while one is pending
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import {
  BusinessDevelopmentPage,
  BIZDEV_QUIET_BASELINE_COPY,
} from './BusinessDevelopmentPage.js';
import type { BizDevProspect, BizDevProspectAlert, BizDevProspectWatch } from './bizdev-api.js';

// ── fixtures ───────────────────────────────────────────────────────────

const PROSPECT_UUID = '55555555-5555-4555-8555-555555555555';
const ALERT_UUID = '66666666-6666-4666-8666-666666666666';

function prospect(): BizDevProspect {
  return {
    id: PROSPECT_UUID,
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
    nextActionDueAt: null,
    linkedClientId: null,
    convertedAt: null,
    watchRequested: false,
    createdByUserId: 'u-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    canonicalEntity: null,
    linkedClient: null,
  };
}

const MEMBERS = [{ id: 'u-1', firstName: 'Sarah', lastName: 'Martinez', email: 'sarah@test.com' }];

function alertFixture(overrides: Partial<BizDevProspectAlert> = {}): BizDevProspectAlert {
  return {
    id: ALERT_UUID,
    prospectId: PROSPECT_UUID,
    title: 'New federal contract award',
    summary: 'A new federal contract award appeared for this company.',
    materiality: 'High — directly relevant to your service hypothesis',
    materialityLevel: 'high',
    company: 'Overland AI',
    sourceFamily: 'usaspending_contract',
    category: 'contracts',
    eventAt: '2026-09-18T00:00:00.000Z',
    effectiveAt: null,
    publishedAt: '2026-09-19T00:00:00.000Z',
    firstObservedAt: '2026-09-20T00:00:00.000Z',
    sourceLocator: 'https://example.test/record/1',
    implication: 'May indicate growing federal demand.',
    readAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

function watchFixture(
  overrides: Partial<NonNullable<BizDevProspectWatch['watch']>> = {},
): BizDevProspectWatch {
  return {
    watch: {
      status: 'active',
      categories: ['contracts', 'lobbying'],
      ownerUserId: 'u-1',
      mutedUntil: null,
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
      ...overrides,
    },
    sources: [
      { source: 'USAspending', health: 'healthy', lastCheckedAt: '2026-09-20T00:00:00.000Z', detail: null },
      { source: 'LDA', health: 'error', lastCheckedAt: '2026-09-19T00:00:00.000Z', detail: 'Provider returned an error' },
      { source: 'SAM', health: 'stale', lastCheckedAt: null, detail: null },
      { source: 'News', health: 'paused', lastCheckedAt: null, detail: null },
      { source: 'Crunchbase', health: 'pending', lastCheckedAt: null, detail: null },
    ],
    lastCompletedCheckAt: '2026-09-20T00:00:00.000Z',
  };
}

// ── mock API ───────────────────────────────────────────────────────────

interface MockConfig {
  meFeatures?: Record<string, boolean | undefined>;
  hasWatch?: boolean;
  alerts?: BizDevProspectAlert[];
  watchPatchFails?: boolean;
  alertActionFails?: boolean;
}

const apiCalls: { method: string; path: string; body?: unknown }[] = [];

function makeApi(cfg: MockConfig): AxiosInstance {
  const record = (method: string, path: string, body?: unknown) =>
    apiCalls.push({ method, path, body });
  const api = {
    get: vi.fn(async (path: string) => {
      record('GET', path);
      if (path === '/api/business-development/prospects')
        return {
          data: {
            prospects: [prospect()],
            counts: { visible: 1, total: 1, active: 1, dismissed: 0, byStage: { researching: 1 } },
          },
        };
      if (path === `/api/business-development/prospects/${PROSPECT_UUID}`)
        return { data: prospect() };
      if (path === `/api/business-development/prospects/${PROSPECT_UUID}/history`)
        return { data: [] };
      if (path === `/api/business-development/prospects/${PROSPECT_UUID}/duplicate-hints`)
        return { data: { hints: [] } };
      if (path === `/api/business-development/prospects/${PROSPECT_UUID}/watch`)
        return { data: cfg.hasWatch === false ? { watch: null, sources: [], lastCompletedCheckAt: null } : watchFixture() };
      if (path === `/api/business-development/prospects/${PROSPECT_UUID}/alerts`)
        return { data: { items: cfg.alerts ?? [alertFixture()], nextCursor: null } };
      if (path === '/api/business-development/member-options') return { data: { members: MEMBERS } };
      if (path === '/api/business-development/preferences') return { data: null };
      if (path === '/api/business-development/search/canonical-organizations')
        return { data: { results: [] } };
      if (path === '/api/business-development/search/clients') return { data: { results: [] } };
      throw new Error(`unmocked GET ${path}`);
    }),
    post: vi.fn(async (path: string, body?: unknown) => {
      record('POST', path, body);
      if (path === `/api/business-development/prospects/${PROSPECT_UUID}/watch`)
        return { data: watchFixture() };
      if (path === `/api/business-development/prospects/${PROSPECT_UUID}/alerts/${ALERT_UUID}/read`) {
        if (cfg.alertActionFails) throw new Error('read failed');
        return { data: { ok: true } };
      }
      if (path === `/api/business-development/prospects/${PROSPECT_UUID}/alerts/${ALERT_UUID}/dismiss`) {
        if (cfg.alertActionFails) throw new Error('dismiss failed');
        return { data: { ok: true } };
      }
      if (path === `/api/business-development/prospects`) return { data: prospect() };
      throw new Error(`unmocked POST ${path}`);
    }),
    patch: vi.fn(async (path: string, body?: unknown) => {
      record('PATCH', path, body);
      if (path === `/api/business-development/prospects/${PROSPECT_UUID}/watch`) {
        if (cfg.watchPatchFails) throw new Error('watch update failed');
        const base = watchFixture();
        return {
          data: {
            ...base,
            watch: base.watch
              ? {
                  ...base.watch,
                  ...(typeof body === 'object' && body ? (body as Record<string, unknown>) : {}),
                }
              : null,
          },
        };
      }
      return { data: prospect() };
    }),
    put: vi.fn(async (path: string) => {
      record('PUT', path);
      return { data: prospect() };
    }),
  } as unknown as AxiosInstance;
  return api;
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
      role: 'user_admin',
      billingAdmin: false,
      features: { meetingsV2: false, meriDockUndockUi: false, ...(meConfig.meFeatures ?? {}) },
    },
    isLoading: false,
  }),
}));

function renderAt(search: string, cfg: MockConfig = {}) {
  meConfig = cfg;
  apiCalls.length = 0;
  apiMock = makeApi(cfg);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/clients${search}`]}>
        <Routes>
          <Route path="/clients" element={<BusinessDevelopmentPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const WATCH_ON = { businessDevelopment: true, businessDevelopmentWatch: true } as const;

async function openDrawer() {
  return await screen.findByRole('dialog', { name: /Prospect — Overland AI/ });
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── 1. flag gating ──────────────────────────────────────────────────────

describe('Phase 5 flag gating', () => {
  it('flag off keeps the honest Phase 1 copy and never calls watch/alert endpoints', async () => {
    renderAt('?view=business-development&bdProspect=' + PROSPECT_UUID, {
      meFeatures: { businessDevelopment: true },
    });
    const drawer = await openDrawer();
    expect(within(drawer).getByText(/Notifications are not active yet/)).toBeInTheDocument();
    expect(within(drawer).queryByText(BIZDEV_QUIET_BASELINE_COPY)).not.toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Watch this prospect' })).toBeInTheDocument();
    // No Phase 5 endpoint was touched at all.
    expect(apiCalls.map((c) => c.path).join(' ')).not.toMatch(/\/watch|\/alerts/);
  });

  it('flag on replaces the false copy with real watch controls and the quiet-baseline explanation', async () => {
    renderAt('?view=business-development&bdProspect=' + PROSPECT_UUID, {
      meFeatures: { ...WATCH_ON },
    });
    const drawer = await openDrawer();
    await waitFor(() =>
      expect(within(drawer).getByText(/Status:/)).toBeInTheDocument(),
    );
    expect(within(drawer).queryByText(/Notifications are not active yet/)).not.toBeInTheDocument();
    // Quiet-baseline copy appears and explains no historical alerts.
    expect(within(drawer).getAllByText(BIZDEV_QUIET_BASELINE_COPY).length).toBeGreaterThan(0);
    expect(BIZDEV_QUIET_BASELINE_COPY).toMatch(/does not send an alert/i);
    expect(BIZDEV_QUIET_BASELINE_COPY).toMatch(/baseline/i);
  });
});

// ── 2. activate / pause / mute ───────────────────────────────────────────

describe('watch lifecycle actions', () => {
  it('POSTs the frozen activate contract when no watch exists yet', async () => {
    renderAt('?view=business-development&bdProspect=' + PROSPECT_UUID, {
      meFeatures: { ...WATCH_ON },
      hasWatch: false,
    });
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Watch this prospect' }));
    await waitFor(() =>
      expect(apiCalls).toContainEqual({
        method: 'POST',
        path: `/api/business-development/prospects/${PROSPECT_UUID}/watch`,
        body: {},
      }),
    );
  });

  it('PATCHes pause and mute with the frozen contracts', async () => {
    renderAt('?view=business-development&bdProspect=' + PROSPECT_UUID, {
      meFeatures: { ...WATCH_ON },
    });
    const drawer = await openDrawer();
    await waitFor(() => within(drawer).getByRole('button', { name: 'Pause watch' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Pause watch' }));
    await waitFor(() =>
      expect(apiCalls).toContainEqual({
        method: 'PATCH',
        path: `/api/business-development/prospects/${PROSPECT_UUID}/watch`,
        body: { status: 'paused' },
      }),
    );
    fireEvent.click(within(drawer).getByRole('button', { name: 'Mute for 7 days' }));
    await waitFor(() =>
      expect(apiCalls).toContainEqual({
        method: 'PATCH',
        path: `/api/business-development/prospects/${PROSPECT_UUID}/watch`,
        body: expect.objectContaining({ mutedUntil: expect.any(String) }),
      }),
    );
  });
});

// ── 3. source health wording ────────────────────────────────────────────

describe('source health', () => {
  it('distinguishes healthy/error/stale/paused/pending — a failure is never absence', async () => {
    renderAt('?view=business-development&bdProspect=' + PROSPECT_UUID, {
      meFeatures: { ...WATCH_ON },
    });
    const drawer = await openDrawer();
    await waitFor(() => expect(within(drawer).getByText('Source health')).toBeInTheDocument());
    expect(within(drawer).getByText(/Checked and healthy/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Error — the last check failed/)).toBeInTheDocument();
    expect(
      within(drawer).getByText(/Unavailable — this source is deferred or needs review/),
    ).toBeInTheDocument();
    expect(within(drawer).getByText(/Paused — checks are not running/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Waiting for its first check/)).toBeInTheDocument();
    // Last completed check is shown explicitly.
    expect(within(drawer).getByText(/Last completed check:/)).toBeInTheDocument();
  });
});

// ── 4. alert rendering + actions ────────────────────────────────────────

describe('Prospect Alerts panel', () => {
  it('renders title, summary, materiality text, dates, inference and a safe source link', async () => {
    renderAt('?view=business-development&bdProspect=' + PROSPECT_UUID, {
      meFeatures: { ...WATCH_ON },
    });
    const drawer = await openDrawer();
    await waitFor(() =>
      expect(within(drawer).getByText('New federal contract award')).toBeInTheDocument(),
    );
    expect(within(drawer).getByText(/A new federal contract award appeared/)).toBeInTheDocument();
    // Materiality is text, not color alone.
    expect(within(drawer).getByText(/Materiality: High — directly relevant/)).toBeInTheDocument();
    // Event vs publication/first-observed dates are labeled separately.
    expect(within(drawer).getByText(/Event:/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Published:/)).toBeInTheDocument();
    // Inference is explicitly labeled.
    expect(within(drawer).getByText(/Inference: May indicate growing federal demand/)).toBeInTheDocument();
    // Source deep link opens safely.
    const link = within(drawer).getByRole('link', { name: /View source record/ });
    expect(link).toHaveAttribute('href', 'https://example.test/record/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('read and dismiss call the exact prospect-scoped endpoints', async () => {
    renderAt('?view=business-development&bdProspect=' + PROSPECT_UUID, {
      meFeatures: { ...WATCH_ON },
    });
    const drawer = await openDrawer();
    await waitFor(() =>
      expect(within(drawer).getByRole('button', { name: 'Mark as read' })).toBeInTheDocument(),
    );
    fireEvent.click(within(drawer).getByRole('button', { name: 'Mark as read' }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        `/api/business-development/prospects/${PROSPECT_UUID}/alerts/${ALERT_UUID}/read`,
      ),
    );
    fireEvent.click(within(drawer).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        `/api/business-development/prospects/${PROSPECT_UUID}/alerts/${ALERT_UUID}/dismiss`,
      ),
    );
    // Every alert endpoint call stayed inside this exact prospect.
    for (const call of apiCalls) {
      if (call.path.includes('/alerts')) {
        expect(call.path).toContain(`/prospects/${PROSPECT_UUID}/`);
      }
    }
  });

  it('never issues a duplicate read while one read is pending', async () => {
    apiCalls.length = 0;
    let resolveRead: (v: unknown) => void = () => {};
    const base = makeApi({ meFeatures: { ...WATCH_ON } });
    meConfig = { meFeatures: { ...WATCH_ON } };
    apiMock = {
      ...base,
      post: vi.fn(async (path: string, body?: unknown) => {
        if (path.endsWith(`/alerts/${ALERT_UUID}/read`)) {
          apiCalls.push({ method: 'POST', path, body });
          await new Promise((r) => {
            resolveRead = r as (v: unknown) => void;
          });
          return { data: { ok: true } };
        }
        return (base.post as (p: string, b?: unknown) => Promise<unknown>)(path, body);
      }),
    } as unknown as AxiosInstance;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/clients?view=business-development&bdProspect=${PROSPECT_UUID}`]}>
          <Routes>
            <Route path="/clients" element={<BusinessDevelopmentPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const drawer = await openDrawer();
    const readButton = await within(drawer).findByRole('button', { name: 'Mark as read' });
    fireEvent.click(readButton);
    await waitFor(() => expect(readButton).toBeDisabled());
    // A second click while disabled/pending must not fire another POST.
    fireEvent.click(readButton);
    await waitFor(() =>
      expect(
        apiCalls.filter(
          (c) => c.method === 'POST' && c.path.endsWith(`/alerts/${ALERT_UUID}/read`),
        ).length,
      ).toBe(1),
    );
    resolveRead({});
    await waitFor(() =>
      expect(
        apiCalls.filter(
          (c) => c.method === 'POST' && c.path.endsWith(`/alerts/${ALERT_UUID}/read`),
        ).length,
      ).toBe(1),
    );
  });
});

// ── 5. no provider ingestion / outreach ─────────────────────────────────

describe('no external activity from the UI', () => {
  it('the watch surface never calls provider, outreach or external endpoints', async () => {
    renderAt('?view=business-development&bdProspect=' + PROSPECT_UUID, {
      meFeatures: { ...WATCH_ON },
    });
    const drawer = await openDrawer();
    await waitFor(() => expect(within(drawer).getByText('Source health')).toBeInTheDocument());
    const paths = apiCalls.map((c) => `${c.method} ${c.path}`).join('\n');
    expect(paths).not.toMatch(/outreach|\/send|usaspending\.gov|lda|sam\.gov|crunchbase|news\./i);
    // Only Business Development API paths were called.
    for (const call of apiCalls) {
      expect(call.path).toMatch(/^\/api\/business-development\//);
    }
    // No outreach action exists in the alerts panel.
    expect(within(drawer).queryByRole('button', { name: /outreach|send/i })).not.toBeInTheDocument();
  });
});
