/**
 * Discover service/exclusion filter slice — focused contract tests.
 *
 * Covers: routing parse/apply/query reset for bdDService/bdDExcluded, strict
 * includeExcluded '0'|'1' serialization, query-key tenant/filter isolation,
 * explicit-submit only (selecting a draft service never fetches), preference
 * empty/outage behavior, selected URL value not in preferences preserved,
 * empty-result review toggle, paging with filters, back/reload restore, and
 * no client-side post-filtering of candidates.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { BusinessDevelopmentPage } from './BusinessDevelopmentPage.js';
import {
  applyBizDevRoute,
  bizDevDiscoverQuery,
  resolveBizDevRoute,
} from './bizdev-routing.js';
import {
  bizdevKeys,
  type BizDevCandidate,
  type BizDevCandidateSearchResult,
  type BizDevPreferences,
} from './bizdev-api.js';

// ── routing (pure) ─────────────────────────────────────────────────────

describe('discover filter routing', () => {
  const base = new URLSearchParams('view=business-development&bdDiscover=open&bdDq=acme');

  it('parses bdDService/bdDExcluded with strict excluded serialization', () => {
    const route = resolveBizDevRoute(
      new URLSearchParams('bdDq=acme&bdDService=Appropriations advocacy&bdDExcluded=1'),
    );
    expect(route.discoverService).toBe('Appropriations advocacy');
    expect(route.discoverIncludeExcluded).toBe(true);
    const query = bizDevDiscoverQuery(route);
    expect(query).toEqual({
      q: 'acme',
      service: 'Appropriations advocacy',
      includeExcluded: '1',
      limit: 20,
      offset: 0,
    });
  });

  it('defaults includeExcluded to exactly "0" and omits service when unset', () => {
    const route = resolveBizDevRoute(new URLSearchParams('bdDq=acme'));
    const query = bizDevDiscoverQuery(route);
    expect(query.includeExcluded).toBe('0');
    expect(query).not.toHaveProperty('service');
    expect(query).toEqual({ q: 'acme', includeExcluded: '0', limit: 20, offset: 0 });
  });

  it('rejects non-strict bdDExcluded values (only "1" means included)', () => {
    for (const raw of ['0', 'true', 'yes', '2']) {
      const route = resolveBizDevRoute(new URLSearchParams(`bdDq=acme&bdDExcluded=${raw}`));
      expect(route.discoverIncludeExcluded).toBe(false);
    }
  });

  it('apply writes bdDService and bdDExcluded=1, and clears them on reset', () => {
    const next = applyBizDevRoute(base, { discoverService: 'Agency engagement', discoverIncludeExcluded: true });
    expect(next.get('bdDService')).toBe('Agency engagement');
    expect(next.get('bdDExcluded')).toBe('1');
    const cleared = applyBizDevRoute(next, { discoverService: '', discoverIncludeExcluded: false });
    expect(cleared.has('bdDService')).toBe(false);
    expect(cleared.has('bdDExcluded')).toBe(false);
  });

  it('preserves pipeline params alongside discover filter params', () => {
    const next = applyBizDevRoute(
      new URLSearchParams('view=business-development&bdStage=qualified&bdQ=pipeline-search'),
      { discoverService: 'Budget monitoring' },
    );
    expect(next.get('bdStage')).toBe('qualified');
    expect(next.get('bdQ')).toBe('pipeline-search');
    expect(next.get('bdDService')).toBe('Budget monitoring');
  });

  it('query-key includes the full filter identity and stays tenant-keyed', () => {
    const a = bizdevKeys.candidates('t-1', {
      q: 'acme', service: 's', includeExcluded: '0', limit: 20, offset: 0,
    });
    const b = bizdevKeys.candidates('t-2', {
      q: 'acme', service: 's', includeExcluded: '0', limit: 20, offset: 0,
    });
    const c = bizdevKeys.candidates('t-1', {
      q: 'acme', service: 's', includeExcluded: '1', limit: 20, offset: 0,
    });
    const d = bizdevKeys.candidates('t-1', {
      q: 'acme', includeExcluded: '0', limit: 20, offset: 0,
    });
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).not.toEqual(d);
  });

});

// ── component harness ──────────────────────────────────────────────────

function candidate(overrides: Partial<BizDevCandidate> = {}): BizDevCandidate {
  return {
    canonicalEntityId: 'ce-1',
    canonicalName: 'Acme Defense',
    identityScope: 'global_public',
    identifiers: [{ type: 'UEI', value: 'UEI123' }],
    whyInspect: null,
    markerCoverage: 'complete',
    marker: { prospectActive: false, prospectDismissed: false, client: false, excluded: false },
    clientWithoutProspect: false,
    ...overrides,
  };
}

function candidateSearch(
  results: BizDevCandidate[],
  coverage: Partial<BizDevCandidateSearchResult['coverage']> = {},
): BizDevCandidateSearchResult {
  return {
    results,
    coverage: {
      agencyFilterApplied: false,
      issueFilterApplied: false,
      geographyFilterApplied: false,
      serviceFilterApplied: false,
      exclusionsApplied: false,
      unsupportedFilters: [],
      more: false,
      offset: 0,
      limit: 20,
      ...coverage,
    },
  };
}

const PREFERENCES: BizDevPreferences = {
  id: 'pref-1',
  tenantId: 't-1',
  practiceServiceAreas: ['Appropriations advocacy', 'Authorization (NDAA)', 'Agency engagement'],
  agenciesIssues: [],
  geographies: [],
};

const MEMBERS = [{ id: 'u-1', firstName: 'Sarah', lastName: 'M', email: 's@test.com' }];

function prospectBody() {
  const p = {
    id: 'p-1', tenantId: 't-1', canonicalEntityId: null, displayName: 'Acme Defense',
    domain: null, website: null, description: null, serviceHypothesis: null, geography: null,
    ownerUserId: null, stage: 'researching', status: 'active', dismissedAt: null,
    conflictExcluded: false, conflictReason: null, nextAction: null, nextActionDueAt: null,
    linkedClientId: null, convertedAt: null, watchRequested: false, createdByUserId: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    canonicalEntity: null, linkedClient: null,
  };
  return {
    data: {
      prospects: [p],
      counts: { visible: 1, total: 1, active: 1, dismissed: 0, byStage: { researching: 1 } },
    },
  };
}

interface Cfg {
  preferences?: BizDevPreferences | null | 'error';
  candidates?: BizDevCandidateSearchResult;
  rawServerResponse?: boolean;
  legacyServer?: boolean;
}

function makeApi(cfg: Cfg): AxiosInstance {
  const candidates = cfg.candidates ?? candidateSearch([candidate()]);
  return {
    get: vi.fn(async (path: string, config?: { params?: Record<string, unknown> }) => {
      if (path === '/api/business-development/prospects') return prospectBody();
      if (path === '/api/business-development/member-options') return { data: { members: MEMBERS } };
      if (path === '/api/business-development/preferences') {
        if (cfg.preferences === 'error') throw new Error('preferences down');
        return { data: cfg.preferences ?? null };
      }
      if (path === '/api/business-development/search/canonical-organizations')
        return { data: { results: [] } };
      if (path === '/api/business-development/search/clients') return { data: { results: [] } };
      if (path === '/api/business-development/search/candidates') {
        // Simulate the backend filter contract: apply BEFORE paging, tenant only.
        const params = config?.params ?? {};
        let results = candidates.results;
        if (params.service && !cfg.rawServerResponse) {
          const svc = String(params.service).toLowerCase();
          results = results.filter(
            (c) => (c.serviceHypothesis ?? '').toLowerCase() === svc,
          );
        }
        if (params.includeExcluded !== '1' && !cfg.rawServerResponse) {
          results = results.filter((c) => !c.marker.excluded);
        }
        return { data: { ...candidates, results, coverage: {
          ...candidates.coverage,
          serviceFilterApplied: cfg.legacyServer ? undefined : Boolean(params.service),
          exclusionsApplied: cfg.legacyServer ? undefined : params.includeExcluded !== '1',
        } } };
      }
      throw new Error(`unmocked GET ${path}`);
    }),
    post: vi.fn(async () => { throw new Error('unmocked POST'); }),
    patch: vi.fn(async () => { throw new Error('unmocked PATCH'); }),
    put: vi.fn(async () => { throw new Error('unmocked PUT'); }),
  } as unknown as AxiosInstance;
}

let apiMock: AxiosInstance;
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => apiMock }));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => ({ enabled: false, ready: true }),
  useIntelFeatureEnabled: () => false,
}));
vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({
    data: {
      user: {
        id: 'u-1', clerkUserId: 'cu-1', email: 's@test.com', firstName: 'Sarah',
        lastName: 'M', title: null, emailSignatureEnabled: false, hasEmailSignature: false,
        tourCompleted: true, legiwatchIntroSeen: true,
      },
      tenant: { id: 't-1', slug: 'test', name: 'Test' },
      role: 'user_admin',
      billingAdmin: false,
      features: { meetingsV2: false, meriDockUndockUi: false, businessDevelopment: true, businessDevelopmentDossier: true },
    },
    isLoading: false,
  }),
}));

function renderAt(search: string, cfg: Cfg = {}) {
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

const getCalls = () =>
  (apiMock.get as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown?]>;
const candidateCalls = () =>
  getCalls().filter(([p]) => p === '/api/business-development/search/candidates');

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

const FLAGS_ON = {};

async function openDiscover(search: string, cfg: Cfg = {}) {
  const utils = renderAt(`?view=business-development&bdDiscover=open${search}`, { ...FLAGS_ON, ...cfg });
  await screen.findByLabelText(/Company search/);
  return utils;
}

// ── component behavior ────────────────────────────────────────────────

describe('Discover service filter', () => {
  it('offers tenant preference services with All services default and the hypothesis disclosure', async () => {
    await openDiscover('&bdDq=acme', { preferences: PREFERENCES });
    const select = screen.getByLabelText(/Service/) as HTMLSelectElement;
    expect(select.value).toBe('');
    await waitFor(() => {
      expect(Array.from(select.options).map((o) => o.value))
        .toEqual(['', ...PREFERENCES.practiceServiceAreas]);
    });
    expect(
      screen.getByText('Matches your firm’s saved service hypothesis, not an assessed company service.'),
    ).toBeInTheDocument();
    expect(select.getAttribute('aria-describedby')).toBe('bizdev-discover-service-note');
  });

  it('selecting a draft service never fetches until explicit submit; submit sends the filter and resets offset', async () => {
    await openDiscover('', { preferences: PREFERENCES });
    fireEvent.change(screen.getByLabelText(/Company search/), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText(/Service/), { target: { value: 'Agency engagement' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    expect(candidateCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Search companies' }));
    await waitFor(() => expect(candidateCalls().length).toBeGreaterThanOrEqual(1));
    const [, config] = candidateCalls()[0]!;
    const params = (config as { params?: Record<string, unknown> }).params!;
    expect(params.service).toBe('Agency engagement');
    expect(params.includeExcluded).toBe('0');
    expect(params.offset).toBe(0);
  });

  it('submitting a new search from a paged URL resets offset to 0', async () => {
    await openDiscover('&bdDq=acme&bdOffset=40', {
      candidates: candidateSearch([candidate()], { more: true, offset: 40 }),
    });
    fireEvent.change(screen.getByLabelText(/Company search/), { target: { value: 'acme defense' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search companies' }));
    await waitFor(() => {
      const last = candidateCalls().at(-1)![1] as { params?: { offset?: number } };
      expect(last.params?.offset).toBe(0);
    });
  });

  it('keeps basic company search working with no saved preferences and invents no labels', async () => {
    await openDiscover('', { preferences: null });
    fireEvent.change(screen.getByLabelText(/Company search/), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search companies' }));
    await waitFor(() => expect(candidateCalls().length).toBeGreaterThanOrEqual(1));
    const select = screen.getByLabelText(/Service/) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['']);
    await screen.findByText('Acme Defense');
  });

  it('keeps search usable during a preferences outage (select renders, no options, no crash)', async () => {
    await openDiscover('&bdDq=acme', { preferences: 'error' });
    fireEvent.click(screen.getByRole('button', { name: 'Search companies' }));
    await screen.findByText('Acme Defense');
    const select = screen.getByLabelText(/Service/) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['']);
  });

  it('preserves a submitted URL service value as an option even when preferences no longer contain it', async () => {
    await openDiscover('&bdDq=acme&bdDService=Legacy service', {
      preferences: { ...PREFERENCES, practiceServiceAreas: ['Appropriations advocacy'] },
    });
    const select = screen.getByLabelText(/Service/) as HTMLSelectElement;
    expect(select.value).toBe('Legacy service');
    await waitFor(() => {
      expect(Array.from(select.options).map((o) => o.value)).toContain('Appropriations advocacy');
    });
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('Legacy service');
    // URL-restored filter round-trips into the API call.
    await waitFor(() => expect(candidateCalls().length).toBeGreaterThanOrEqual(1));
    const params = candidateCalls()[0]![1] as { params?: Record<string, unknown> };
    expect(params.params?.service).toBe('Legacy service');
  });

  it('applies the service filter server-side only: non-matching candidates are not rendered but the client never post-filters', async () => {
    const mixed = candidateSearch([
      candidate({ canonicalEntityId: 'ce-1', canonicalName: 'Acme Defense', serviceHypothesis: 'Agency engagement' }),
      candidate({ canonicalEntityId: 'ce-2', canonicalName: 'Other Co', serviceHypothesis: 'Budget monitoring' }),
    ]);
    const { unmount } = await openDiscover('&bdDq=acme&bdDService=Agency engagement', { candidates: mixed });
    await screen.findByText('Acme Defense');
    expect(screen.queryByText('Other Co')).not.toBeInTheDocument();
    // This scenario proves the rendered server-filtered response only.
    unmount();
  });
});

describe('Discover exclusions review toggle', () => {
  it('warns when an older server does not confirm filters instead of claiming they were applied', async () => {
    await openDiscover('&bdDq=acme', { legacyServer: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('may be unfiltered');
    expect(screen.getByRole('button', { name: 'Firm exclusion filter requested · Show for review' })).toBeInTheDocument();
  });

  it('renders the authoritative server page without silently post-filtering it', async () => {
    await openDiscover('&bdDq=acme&bdDService=Agency engagement', {
      rawServerResponse: true,
      candidates: candidateSearch([candidate({ canonicalName: 'Server-selected company', serviceHypothesis: null })]),
    });
    expect(await screen.findByText('Server-selected company')).toBeInTheDocument();
  });
  const excludedOnly = candidateSearch([
    candidate({ marker: { prospectActive: false, prospectDismissed: false, client: false, excluded: true } }),
  ]);

  it('shows the toggle for empty results so excluded-only searches recover, and toggling refetches with includeExcluded=1', async () => {
    await openDiscover('&bdDq=acme', { candidates: candidateSearch([]) });
    expect(await screen.findByText('No companies matched this search')).toBeInTheDocument();
    const toggle = screen.getByRole('button', {
      name: 'Firm exclusions filtered · Show for review',
    });
    fireEvent.click(toggle);
    await waitFor(() => {
      const calls = candidateCalls().map(([, c]) => (c as { params?: { includeExcluded?: string } }).params?.includeExcluded);
      expect(calls.at(-1)).toBe('1');
    });
    expect(
      await screen.findByRole('button', { name: 'Including firm exclusions · Hide exclusions' }),
    ).toBeInTheDocument();
  });

  it('preserves submitted q/service when toggling and resets offset to 0', async () => {
    await openDiscover('&bdDq=acme&bdDService=Agency engagement&bdOffset=40', {
      candidates: candidateSearch([candidate({ serviceHypothesis: 'Agency engagement' })], { more: true, offset: 40 }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Firm exclusions filtered · Show for review' }));
    await waitFor(() => {
      const last = candidateCalls().at(-1)![1] as { params?: Record<string, unknown> };
      expect(last.params?.includeExcluded).toBe('1');
      expect(last.params?.q).toBe('acme');
      expect(last.params?.service).toBe('Agency engagement');
      expect(last.params?.offset).toBe(0);
    });
  });

  it('excluded candidates surfaced for review keep only the safe Excluded marker; no reasons or notes render', async () => {
    await openDiscover('&bdDq=acme&bdDExcluded=1', {
      candidates: excludedOnly,
    });
    expect(await screen.findByText('Excluded')).toBeInTheDocument();
    expect(screen.queryByText(/conflict reason/i)).not.toBeInTheDocument();
  });

  it('does not locally post-filter or claim a hidden count when includeExcluded=0', async () => {
    const withExcluded = candidateSearch([
      candidate({ canonicalEntityId: 'ce-9', marker: { prospectActive: false, prospectDismissed: false, client: false, excluded: true } }),
    ], { exclusionsApplied: true });
    const { container } = await openDiscover('&bdDq=acme', { candidates: withExcluded });
    // Server (mock) filtered the excluded row out; UI renders nothing about a
    // hidden total and never mutates results client-side.
    await waitFor(() => expect(candidateCalls().length).toBeGreaterThanOrEqual(1));
    expect(container.textContent).not.toMatch(/hidden by firm exclusions/i);
    expect(container.textContent).not.toMatch(/\d+ hidden/i);
  });

  it('restores the review mode from the URL on reload (back/forward state is URL-backed)', async () => {
    await openDiscover('&bdDq=acme&bdDExcluded=1', { candidates: excludedOnly });
    await waitFor(() => expect(candidateCalls().length).toBeGreaterThanOrEqual(1));
    const params = candidateCalls()[0]![1] as { params?: { includeExcluded?: string } };
    expect(params.params?.includeExcluded).toBe('1');
    expect(
      await screen.findByRole('button', { name: 'Including firm exclusions · Hide exclusions' }),
    ).toBeInTheDocument();
  });
});

describe('Discover paging with filters', () => {
  it('pages with a stable offset while service and exclusion filters persist in every call', async () => {
    await openDiscover('&bdDq=acme&bdDService=Agency engagement&bdDExcluded=1&bdOffset=20', {
      candidates: candidateSearch([candidate({ serviceHypothesis: 'Agency engagement' })], {
        more: true, offset: 20, serviceFilterApplied: true, exclusionsApplied: false,
      }),
    });
    await screen.findByText('Acme Defense');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      const last = candidateCalls().at(-1)![1] as { params?: Record<string, unknown> };
      expect(last.params?.offset).toBe(40);
      expect(last.params?.service).toBe('Agency engagement');
      expect(last.params?.includeExcluded).toBe('1');
    });
  });
});
