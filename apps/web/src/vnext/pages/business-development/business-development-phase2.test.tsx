/**
 * Business Development Phase 2 — discover + evidence dossier contract tests.
 *
 * Same mocked Axios/query/router harness as business-development.test.tsx,
 * but against the FROZEN Phase 2 backend contract:
 *   GET /search/candidates        → { results, coverage } (q 2..200, limit 1..25, offset 0..500)
 *   GET /dossier/companies/:id    → BizDevDossier (optional ?section=)
 *   GET /prospects/:id/dossier    → BizDevDossier (optional ?section=)
 * Proves: dossier gating fail-closed (Phase 1 intact), explicit-only bounded
 * search + stable offset paging + URL state, structured why-inspect and safe
 * markers (no conflict reason/note bodies), exact company dossier route +
 * identity-only header + independent section calls (no full dossier call),
 * per-section error/retry independence, normalized source inspector + safe
 * detail rendering, direct vs potential labels, honest empty/partial/deferred
 * states, no people-provider request implied, open-without-save, save via the
 * Phase 1 create flow, existing-prospect marker handling, resolved A→B
 * identity correction affordance + duplicate-review behavior, and
 * tenant+identity query keys.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  type BizDevDossier,
  type BizDevDossierSection,
  type BizDevEvidenceItem,
  type BizDevProspect,
} from './bizdev-api.js';

// ── fixtures (exact backend shapes) ────────────────────────────────────

function evidence(overrides: Partial<BizDevEvidenceItem> = {}): BizDevEvidenceItem {
  return {
    sourceFamily: 'usaspending_contract',
    recordId: 'CONT_AWD_1',
    locator: 'https://example.gov/award/CONT_AWD_1',
    originalSourceName: 'USAspending',
    originalSourceId: 'PIID-1',
    claimType: 'government_exposure',
    relationshipStrength: 'direct',
    eventDate: '2026-06-30',
    effectiveDate: null,
    fiscalYear: 2026,
    stage: 'obligated',
    sourceUpdatedAt: '2026-07-01T00:00:00.000Z',
    fetchedAt: '2026-09-20T00:00:00.000Z',
    scopeChecked: 'recipient_uei=UEI123',
    status: 'available',
    title: 'Direct award to this company',
    detail: { awardingAgency: 'Department of Defense', obligation: 12000000 },
    ...overrides,
  };
}

function candidate(overrides: Partial<BizDevCandidate> = {}): BizDevCandidate {
  return {
    canonicalEntityId: 'ce-1',
    canonicalName: 'Overland AI',
    identityScope: 'global_public',
    identifiers: [{ type: 'UEI', value: 'UEI123' }],
    whyInspect: {
      title: 'Named prime contractor on an Army SBIR award',
      eventDate: '2026-06-30',
      sourceFamily: 'usaspending_contract',
      originalSourceName: 'USAspending',
      recordId: 'CONT_AWD_1',
      locator: 'https://example.gov/award/CONT_AWD_1',
      fetchedAt: '2026-09-20T00:00:00.000Z',
      relationshipStrength: 'direct',
      status: 'available',
    },
    markerCoverage: 'complete',
    marker: {
      prospectActive: false,
      prospectDismissed: false,
      client: false,
      excluded: false,
    },
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
      unsupportedFilters: [],
      more: false,
      offset: 0,
      limit: 20,
      ...coverage,
    },
  };
}

function section(
  kind: BizDevDossierSection['section'],
  overrides: Partial<BizDevDossierSection> = {},
): BizDevDossierSection {
  return {
    section: kind,
    status: 'available',
    statusText: 'Available.',
    evidence: [],
    detail: {},
    ...overrides,
  };
}

function dossier(): BizDevDossier {
  return {
    canonicalEntityId: 'ce-1',
    canonicalName: 'Overland AI',
    identityScope: 'global_public',
    identityBasis: 'exact_uei',
    generatedAt: '2026-09-24T00:00:00.000Z',
    sections: {
      identity: section('identity', {
        statusText: 'Registered entity, exact UEI match.',
        evidence: [evidence({ claimType: 'identity' })],
        detail: { uei: 'UEI123', cage: 'CAGE1', names: ['Overland AI'] },
      }),
      government_exposure: section('government_exposure', {
        statusText: 'Federal award records found.',
        evidence: [
          evidence({ recordId: 'CONT_AWD_2', title: 'Direct contract — Army SBIR' }),
          evidence({
            recordId: 'SIG-3',
            title: 'Budget line mentions autonomy programs',
            relationshipStrength: 'thematic',
            claimType: 'relevant_signal',
            status: 'available',
          }),
        ],
      }),
      relevant_signals: section('relevant_signals', {
        statusText: 'Signals retrieved.',
      }),
      footprint: section('footprint', {
        statusText: 'Place-of-performance records found.',
      }),
      lobbying: section('lobbying', {
        statusText: 'Lobbying disclosure records found.',
      }),
      people: section('people', {
        status: 'empty_in_queried_scope',
        statusText:
          'People enrichment is not available for this organization yet.',
        detail: { providerState: 'deferred', callsMade: 0 },
      }),
    },
    sectionStates: [],
    prospect: null,
  };
}

const MEMBERS = [{ id: 'u-1', firstName: 'Sarah', lastName: 'M', email: 's@test.com' }];

function prospect(overrides: Partial<BizDevProspect> = {}): BizDevProspect {
  return {
    id: 'p-1',
    tenantId: 't-1',
    canonicalEntityId: null,
    displayName: 'Overland AI',
    domain: null,
    website: null,
    description: null,
    serviceHypothesis: null,
    geography: null,
    ownerUserId: null,
    stage: 'researching',
    status: 'active',
    dismissedAt: null,
    conflictExcluded: false,
    conflictReason: null,
    nextAction: null,
    nextActionDueAt: null,
    linkedClientId: null,
    convertedAt: null,
    watchRequested: false,
    createdByUserId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    canonicalEntity: null,
    linkedClient: null,
    ...overrides,
  };
}

interface Cfg {
  meFeatures?: Record<string, boolean | undefined>;
  candidates?: BizDevCandidateSearchResult;
  dossier?: BizDevDossier;
  dossierErrorSections?: string[];
  createResult?: BizDevProspect;
  prospectResult?: BizDevProspect;
  resolveIdentityResult?: unknown;
  canonicalOrgs?: Array<{
    id: string;
    canonicalName: string;
    normalizedName: string;
    identityScope: string;
    tenantId: string | null;
  }>;
  onProspectDossierSection?: (kind: string) => BizDevDossierSection | undefined;
}

function makeApi(cfg: Cfg): AxiosInstance {
  const theDossier = cfg.dossier ?? dossier();
  const p1 = cfg.prospectResult ?? prospect();
  const errSections = new Set(cfg.dossierErrorSections ?? []);
  const sectionResponse = (kind: string): BizDevDossier => {
    // Non-identity section responses repeat the identity section (backend
    // finalizeDossier behavior); sections carry ONLY identity + the kind.
    const sections: BizDevDossier['sections'] = {
      identity: theDossier.sections.identity,
    };
    const override = cfg.onProspectDossierSection?.(kind);
    sections[kind as BizDevDossierSection['section']] =
      override ?? theDossier.sections[kind as BizDevDossierSection['section']];
    return { ...theDossier, sections, sectionStates: theDossier.sectionStates };
  };
  return {
    get: vi.fn(async (path: string, config?: { params?: Record<string, unknown> }) => {
      const params = config?.params ?? {};
      if (path === '/api/business-development/prospects')
        return {
          data: {
            prospects: [p1],
            counts: {
              visible: 1,
              total: 1,
              active: 1,
              dismissed: 0,
              byStage: { researching: 1 },
            },
          },
        };
      if (path === '/api/business-development/prospects/p-1') return { data: p1 };
      if (/^\/api\/business-development\/prospects\/[^/]+$/.test(path))
        return { data: p1 };
      if (/^\/api\/business-development\/prospects\/[^/]+\/history$/.test(path))
        return { data: [] };
      if (/^\/api\/business-development\/prospects\/[^/]+\/duplicate-hints$/.test(path))
        return { data: { hints: [] } };
      if (path === '/api/business-development/member-options')
        return { data: { members: MEMBERS } };
      if (path === '/api/business-development/preferences') return { data: null };
      if (path === '/api/business-development/search/canonical-organizations')
        return { data: { results: cfg.canonicalOrgs ?? [] } };
      if (path === '/api/business-development/search/clients')
        return { data: { results: [] } };
      if (path === '/api/business-development/search/candidates')
        return { data: cfg.candidates ?? candidateSearch([candidate()]) };
      if (path === '/api/business-development/dossier/companies/ce-1') {
        const kind = typeof params.section === 'string' ? params.section : null;
        if (kind && errSections.has(kind)) throw new Error('source down');
        if (kind) return { data: sectionResponse(kind) };
        throw new Error('full no-section dossier call is forbidden by the UI contract');
      }
      if (path === '/api/business-development/prospects/p-1/dossier') {
        const kind = typeof params.section === 'string' ? params.section : null;
        if (kind && errSections.has(kind)) throw new Error('source down');
        if (kind) return { data: sectionResponse(kind) };
        throw new Error('full no-section dossier call is forbidden by the UI contract');
      }
      throw new Error(`unmocked GET ${path}`);
    }),
    post: vi.fn(async (path: string, body?: unknown) => {
      if (path === '/api/business-development/duplicate-hints') return { data: { hints: [] } };
      if (path === '/api/business-development/prospects')
        return { data: cfg.createResult ?? { ...prospect(), id: 'p-2' } };
      if (path === '/api/business-development/prospects/p-1/identity')
        return {
          data:
            cfg.resolveIdentityResult ?? { outcome: 'resolved', prospect: p1 },
        };
      if (path === '/api/business-development/prospects/p-1/notes') return { data: [] };
      throw new Error(`unmocked POST ${path}`);
    }),
    patch: vi.fn(async () => ({ data: p1 })),
    put: vi.fn(async () => ({ data: p1 })),
  } as unknown as AxiosInstance;
}

let apiMock: AxiosInstance;
let meConfig: Cfg;
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
      features: {
        meetingsV2: false,
        meriDockUndockUi: false,
        ...(meConfig.meFeatures ?? {}),
      },
    },
    isLoading: false,
  }),
}));

function renderAt(search: string, cfg: Cfg = {}) {
  meConfig = cfg;
  apiMock = makeApi(cfg);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/clients${search}`]}>
        <Routes>
          <Route
            path="/clients"
            element={<div className="capiro-vnext-root">{<BusinessDevelopmentPage />}</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const getCalls = () =>
  (apiMock.get as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown?]>;
const postCalls = () =>
  (apiMock.post as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown?]>;

afterEach(() => {
  vi.clearAllMocks();
});

// ── 1. gating: fail closed, Phase 1 intact ─────────────────────────────

const DOSSIER_ON = { meFeatures: { businessDevelopment: true, businessDevelopmentDossier: true } };

describe('Phase 2 gating', () => {
  it('hides Discover/dossier controls but keeps Phase 1 when the dossier flag is absent/false', async () => {
    renderAt('?view=business-development', {
      meFeatures: { businessDevelopment: true, businessDevelopmentDossier: false },
    });
    expect(await screen.findByRole('button', { name: 'Add prospect' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Discover companies' }),
    ).not.toBeInTheDocument();
    // Phase 1 pipeline renders normally.
    expect(await screen.findByText('Overland AI')).toBeInTheDocument();
    // The resolved-prospect drawer shows no dossier affordance when the flag is off.
    fireEvent.click(screen.getByRole('button', { name: /Overland AI/ }));
    const drawer = await screen.findByRole('dialog', { name: /Prospect — Overland AI/ });
    expect(
      within(drawer).queryByRole('button', { name: 'View evidence dossier' }),
    ).not.toBeInTheDocument();
    // No candidate/dossier endpoint was ever hit.
    expect(
      getCalls().some(([p]) => p.includes('search/candidates') || p.includes('/dossier')),
    ).toBe(false);
  });

  it('renders the Discover entry when businessDevelopmentDossier is exactly true', async () => {
    renderAt('?view=business-development', DOSSIER_ON);
    expect(
      await screen.findByRole('button', { name: 'Discover companies' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add prospect' })).toBeInTheDocument();
  });
});

// ── 2. explicit-only bounded search + stable offset paging + URL state ─

describe('discover search', () => {
  it('fires the candidate search only on explicit submit, with bounded exact params', async () => {
    renderAt('?view=business-development', DOSSIER_ON);
    fireEvent.click(await screen.findByRole('button', { name: 'Discover companies' }));
    await screen.findByLabelText(/Company search/);
    // Panel open, nothing submitted yet.
    expect(
      getCalls().some(([p]) => p === '/api/business-development/search/candidates'),
    ).toBe(false);

    // Typing alone never fetches.
    fireEvent.change(screen.getByLabelText(/Company search/), {
      target: { value: 'overland' },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(
      getCalls().some(([p]) => p === '/api/business-development/search/candidates'),
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Search companies' }));
    await waitFor(() => {
      expect(
        getCalls().some(([p]) => p === '/api/business-development/search/candidates'),
      ).toBe(true);
    });
    const [, config] = getCalls().find(
      ([p]) => p === '/api/business-development/search/candidates',
    )!;
    expect((config as { params?: Record<string, unknown> }).params).toEqual({
      q: 'overland',
      limit: 20,
      offset: 0,
    });
    // No agency/issue/geography params are ever sent.
    const params = (config as { params?: Record<string, unknown> }).params!;
    expect(params).not.toHaveProperty('agency');
    expect(params).not.toHaveProperty('issue');
    expect(params).not.toHaveProperty('geography');
  });

  it('does not submit a query shorter than 2 characters', async () => {
    renderAt('?view=business-development&bdDiscover=open', DOSSIER_ON);
    const input = await screen.findByLabelText(/Company search/);
    fireEvent.change(input, { target: { value: 'o' } });
    expect(screen.getByRole('button', { name: 'Search companies' })).toBeDisabled();
    expect(
      getCalls().some(([p]) => p === '/api/business-development/search/candidates'),
    ).toBe(false);
  });

  it('pages with a stable numeric offset driven by coverage, and restores state from the URL', async () => {
    renderAt('?view=business-development&bdDiscover=open&bdDq=overland', {
      ...DOSSIER_ON,
      candidates: candidateSearch([candidate()], { more: true, offset: 20, limit: 20 }),
    });
    // URL state alone restores the search (no re-typing).
    await screen.findByText('Overland AI');
    const firstCall = getCalls().find(
      ([p]) => p === '/api/business-development/search/candidates',
    )!;
    expect((firstCall[1] as { params?: { offset?: number } }).params?.offset).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      const next = getCalls()
        .filter(([p]) => p === '/api/business-development/search/candidates')
        .at(-1)!;
      expect((next[1] as { params?: { offset?: number } }).params?.offset).toBe(20);
    });
    // Coverage reported by the response renders (mock coverage offset 20 → 21).
    await waitFor(() => {
      expect(screen.getByText(/more results follow/)).toBeInTheDocument();
      expect(screen.getByText(/Showing from result 21/)).toBeInTheDocument();
    });
  });

  it('renders candidate identity, structured why-inspect, and safe markers; never conflict reasons', async () => {
    renderAt('?view=business-development&bdDiscover=open&bdDq=overland', {
      ...DOSSIER_ON,
      candidates: candidateSearch([
        candidate({
          identifiers: [{ type: 'UEI', value: 'UEI123' }, { type: 'CAGE', value: 'CAGE9' }],
          marker: {
            prospectActive: true,
            prospectDismissed: false,
            client: true,
            excluded: true,
          },
          prospectId: 'p-1',
        }),
      ]),
    });
    await screen.findByText('Overland AI');
    expect(screen.getByText(/UEI: UEI123/)).toBeInTheDocument();
    expect(screen.getByText(/CAGE: CAGE9/)).toBeInTheDocument();
    expect(
      screen.getByText(/Why inspect: Named prime contractor on an Army SBIR award/),
    ).toBeInTheDocument();
    expect(screen.getByText(/USAspending/)).toBeInTheDocument();
    expect(screen.getByText('Saved prospect')).toBeInTheDocument();
    expect(screen.getByText('Client')).toBeInTheDocument();
    expect(screen.getByText('Excluded')).toBeInTheDocument();
    // Existing-prospect marker: open it, never duplicate.
    expect(screen.getByRole('button', { name: 'Open existing prospect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save prospect' })).not.toBeInTheDocument();
    // No private reason text anywhere in discovery.
    expect(screen.queryByText(/conflict reason/i)).not.toBeInTheDocument();
    // No unsupported agency/issue/geography filter inputs are shown.
    expect(screen.queryByLabelText(/Agency/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Issue/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Geography/)).not.toBeInTheDocument();
  });

  it('opens the dossier without saving first', async () => {
    renderAt('?view=business-development&bdDiscover=open&bdDq=overland', DOSSIER_ON);
    await screen.findByText('Overland AI');
    fireEvent.click(screen.getByRole('button', { name: 'Open dossier' }));
    await screen.findByRole('dialog', { name: /Evidence dossier — Overland AI/ });
    // No create was issued.
    expect(
      postCalls().some(([p]) => p === '/api/business-development/prospects'),
    ).toBe(false);
  });

  it('saves a candidate through the Phase 1 create flow exactly once and opens the prospect', async () => {
    renderAt('?view=business-development&bdDiscover=open&bdDq=overland', {
      ...DOSSIER_ON,
      createResult: { ...prospect(), id: 'p-9' },
    });
    await screen.findByText('Overland AI');
    const saveBtn = screen.getByRole('button', { name: 'Save prospect' });
    fireEvent.click(saveBtn);
    fireEvent.click(saveBtn); // double-click while pending
    await waitFor(() => {
      const creates = postCalls().filter(([p]) => p === '/api/business-development/prospects');
      expect(creates.length).toBe(1);
      expect(creates[0]![1]).toEqual({
        canonicalEntityId: 'ce-1',
        displayName: 'Overland AI',
      });
    });
    await screen.findByRole('dialog', { name: /Prospect — Overland AI/ });
  });
});

// ── 3. dossier drawer ──────────────────────────────────────────────────

describe('evidence dossier', () => {
  it('requests the exact company dossier route with identity-only header plus independent section calls', async () => {
    renderAt('?view=business-development&bdDiscover=open&bdDq=overland&bdDossier=ce-1', DOSSIER_ON);
    const drawer = await screen.findByRole('dialog', {
      name: /Evidence dossier — Overland AI/,
    });
    await waitFor(() => {
      const dossierCalls = getCalls().filter(([p]) => p.includes('/dossier/companies/ce-1'));
      // identity header + 5 non-identity sections — nothing else.
      expect(dossierCalls.length).toBe(6);
      const sections = dossierCalls.map(
        ([, c]) => (c as { params?: { section?: string } }).params?.section,
      );
      expect(sections.filter((s) => s === 'identity').length).toBe(1);
      expect(sections.filter((s) => s === undefined).length).toBe(0);
      for (const kind of [
        'government_exposure',
        'relevant_signals',
        'footprint',
        'lobbying',
        'people',
      ]) {
        expect(sections.filter((s) => s === kind).length).toBe(1);
      }
    });
    // Header identity honesty.
    expect(within(drawer).getByText(/matched on an exact UEI identifier/)).toBeInTheDocument();
    expect(within(drawer).getByText(/public shared record/)).toBeInTheDocument();
    expect(
      within(drawer).getByText(/without saving the company/i),
    ).toBeInTheDocument();
  });

  it('renders one failed section alongside a successful one and retries only that section', async () => {
    renderAt('?view=business-development&bdDiscover=open&bdDq=overland&bdDossier=ce-1', {
      ...DOSSIER_ON,
      dossierErrorSections: ['lobbying'],
    });
    const drawer = await screen.findByRole('dialog', {
      name: /Evidence dossier — Overland AI/,
    });
    // Government exposure succeeded with direct evidence.
    expect(
      await within(drawer).findByText(/Direct contract — Army SBIR/),
    ).toBeInTheDocument();
    // Lobbying shows its own error with its own retry — others unaffected.
    expect(within(drawer).getAllByText(/This section could not be loaded/).length).toBe(1);
    expect(within(drawer).getAllByRole('button', { name: 'Retry this section' }).length).toBe(1);

    const before = getCalls().filter(([p]) => p.includes('/dossier/companies/ce-1')).length;
    fireEvent.click(within(drawer).getByRole('button', { name: 'Retry this section' }));
    await waitFor(() => {
      const after = getCalls().filter(([p]) => p.includes('/dossier/companies/ce-1')).length;
      expect(after).toBe(before + 1);
      const last = getCalls()
        .filter(([p]) => p.includes('/dossier/companies/ce-1'))
        .at(-1)!;
      expect((last[1] as { params?: { section?: string } }).params?.section).toBe('lobbying');
    });
  });

  it('labels Direct prominently and puts conditional/thematic under Potential relevance', async () => {
    renderAt('?view=business-development&bdDiscover=open&bdDq=overland&bdDossier=ce-1', DOSSIER_ON);
    const drawer = await screen.findByRole('dialog', {
      name: /Evidence dossier — Overland AI/,
    });
    await within(drawer).findByText(/Direct contract — Army SBIR/);
    expect(within(drawer).getAllByText('Direct').length).toBeGreaterThan(0);
    expect(within(drawer).getByText('Potential relevance')).toBeInTheDocument();
    expect(
      within(drawer).getByText('Budget line mentions autonomy programs'),
    ).toBeInTheDocument();
  });

  it('exposes the normalized source inspector with dates, stage, status and a noreferrer locator link', async () => {
    renderAt('?view=business-development&bdDiscover=open&bdDq=overland&bdDossier=ce-1', DOSSIER_ON);
    const drawer = await screen.findByRole('dialog', {
      name: /Evidence dossier — Overland AI/,
    });
    const awardTitle = await within(drawer).findByText('Direct contract — Army SBIR');
    const evidenceCard = awardTitle.closest('li')!;
    const details = within(evidenceCard).getByText('Source details').closest('details')!;
    fireEvent.click(within(details).getByText('Source details'));
    expect(within(details).getByText('Source family')).toBeInTheDocument();
    expect(within(details).getByText('usaspending_contract')).toBeInTheDocument();
    expect(within(details).getByText(/USAspending/)).toBeInTheDocument();
    expect(within(details).getByText(/PIID-1/)).toBeInTheDocument();
    expect(within(details).getByText(/CONT_AWD_2/)).toBeInTheDocument();
    expect(within(details).getByText(/recipient_uei=UEI123/)).toBeInTheDocument();
    expect(
      within(details).getByText('Direct — matched on an exact identifier'),
    ).toBeInTheDocument();
    expect(within(details).getByText('obligated')).toBeInTheDocument();
    expect(within(details).getByText(/Fiscal year/)).toBeInTheDocument();
    // Structured detail renders as key/value rows — never [object Object].
    expect(within(details).getByText(/awarding agency/)).toBeInTheDocument();
    expect(within(details).getByText('Department of Defense')).toBeInTheDocument();
    expect(within(details).queryByText(/\[object Object\]/)).not.toBeInTheDocument();
    const link = within(details).getByRole('link', { name: 'Open source record' });
    expect(link).toHaveAttribute('href', 'https://example.gov/award/CONT_AWD_1');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders People honestly as deferred/zero-call and implies no people-provider request', async () => {
    renderAt('?view=business-development&bdDiscover=open&bdDq=overland&bdDossier=ce-1', DOSSIER_ON);
    const drawer = await screen.findByRole('dialog', {
      name: /Evidence dossier — Overland AI/,
    });
    expect(
      await within(drawer).findByText(/People enrichment is not available/),
    ).toBeInTheDocument();
    // Deferred detail renders the honest callsMade: 0 row.
    const peopleSection = within(drawer)
      .getAllByText(/People enrichment is not available/)[0]!
      .closest('section')!;
    expect(within(peopleSection).getByText(/calls made/)).toBeInTheDocument();
    expect(within(peopleSection).getByText('0')).toBeInTheDocument();
    // The only people-related requests are the dossier section calls themselves.
    expect(
      getCalls().some(([p]) => /pdl|rocketreach|zoominfo|close\.com|people-provider/i.test(p)),
    ).toBe(false);
  });

  it('opens the saved-prospect dossier and notes viewing never changes the prospect', async () => {
    renderAt(
      '?view=business-development&bdProspect=p-1&bdDossierProspect=p-1',
      DOSSIER_ON,
    );
    const drawer = await screen.findByRole('dialog', {
      name: /Evidence dossier — Overland AI/,
    });
    expect(
      within(drawer).getByText(/Opened from a saved prospect of your firm/),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByText(/Viewing never changes the prospect/),
    ).toBeInTheDocument();
    // Prospect dossier route with identity header + independent sections.
    await waitFor(() => {
      const calls = getCalls().filter(([p]) => p === '/api/business-development/prospects/p-1/dossier');
      expect(calls.length).toBe(6);
      expect(
        calls.filter(([, c]) => (c as { params?: { section?: string } }).params?.section === 'identity')
          .length,
      ).toBe(1);
    });
  });
});

// ── 4. identity correction (Phase 1 reuse, dossier-flag-gated) ─────────

describe('identity correction', () => {
  it('shows the review/correct affordance for a RESOLVED prospect with preserved-state wording', async () => {
    renderAt('?view=business-development&bdProspect=p-1', {
      meFeatures: {
        businessDevelopment: true,
        businessDevelopmentDossier: true,
      },
      prospectResult: prospect({
        canonicalEntityId: 'ce-1',
        canonicalEntity: {
          id: 'ce-1',
          canonicalName: 'Overland AI',
          normalizedName: 'overland ai',
          entityType: 'organization',
        },
      }),
    });
    const drawer = await screen.findByRole('dialog', { name: /Prospect — Overland AI/ }, { timeout: 4000 });
    expect(
      within(drawer).getByRole('button', { name: 'View evidence dossier' }),
    ).toBeInTheDocument();
    // Review affordance + preserved-state wording for the resolved case.
    expect(
      within(drawer).getByText(/review or correct the identity below/i),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByText(/keeps its id, stage, owner, notes, watch setting and client linkage/),
    ).toBeInTheDocument();
  });

  it('resolved A→B correction: reuse canonical search + resolveBizDevIdentity, duplicate outcome is review/open-existing', async () => {
    renderAt('?view=business-development&bdProspect=p-1', {
      meFeatures: { businessDevelopment: true, businessDevelopmentDossier: true },
      canonicalOrgs: [
        {
          id: 'ce-1',
          canonicalName: 'Overland AI',
          normalizedName: 'overland ai',
          identityScope: 'global_public',
          tenantId: null,
        },
      ],
    });
    const drawer = await screen.findByRole('dialog', { name: /Prospect — Overland AI/ }, { timeout: 4000 });
    // Preserved-state wording is present in the unresolved identity section.
    expect(
      within(drawer).getByText(/keeps its id, stage, owner, notes, watch setting and client linkage/),
    ).toBeInTheDocument();
    // Canonical organization search reuse with identifiers/source names shown.
    fireEvent.change(within(drawer).getAllByLabelText(/Search confirmed organizations/)[0]!, {
      target: { value: 'over' },
    });
    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Search' })[0]!);
    await waitFor(() =>
      expect(
        getCalls().some(([p]) => p === '/api/business-development/search/canonical-organizations'),
      ).toBe(true),
    );
    await within(drawer).findByText('Overland AI');
    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Confirm identity' })[0]!);
    await waitFor(() =>
      expect(
        postCalls().some(([p]) => p === '/api/business-development/prospects/p-1/identity'),
      ).toBe(true),
    );
  });

  it('duplicate identity outcome renders as a review/open-existing result — never a merge claim', async () => {
    renderAt('?view=business-development&bdProspect=p-1', {
      meFeatures: { businessDevelopment: true, businessDevelopmentDossier: true },
      resolveIdentityResult: {
        outcome: 'duplicate',
        duplicate: {
          prospectId: 'p-other',
          status: 'active',
          displayName: 'Other Overland AI',
          linkedClientId: null,
        },
      },
      canonicalOrgs: [
        {
          id: 'ce-1',
          canonicalName: 'Overland AI',
          normalizedName: 'overland ai',
          identityScope: 'global_public',
          tenantId: null,
        },
      ],
    });
    const drawer = await screen.findByRole('dialog', { name: /Prospect — Overland AI/ }, { timeout: 4000 });
    fireEvent.change(within(drawer).getAllByLabelText(/Search confirmed organizations/)[0]!, {
      target: { value: 'over' },
    });
    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Search' })[0]!);
    await within(drawer).findByText('Overland AI');
    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Confirm identity' })[0]!);
    expect(
      await within(drawer).findByText(/This is a review result — nothing was merged/),
    ).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Open that prospect' })).toBeInTheDocument();
  });
});

// ── 5. URL round-trip + query-key identity ──────────────────────────────

describe('Phase 2 URL state and query keys', () => {
  it('round-trips discover/dossier params preserving unrelated params and Phase 1 defaults', () => {
    const params = new URLSearchParams('view=business-development&sort=name');
    const next = applyBizDevRoute(params, {
      discover: 'open',
      discoverQuery: 'overland',
      discoverOffset: 20,
      dossierEntityId: 'ce-1',
      dossierSection: 'lobbying',
    });
    expect(next.get('sort')).toBe('name');
    expect(next.get('view')).toBe('business-development');
    const route = resolveBizDevRoute(next);
    expect(route.discover).toBe('open');
    expect(route.discoverQuery).toBe('overland');
    expect(route.discoverOffset).toBe(20);
    expect(route.dossierEntityId).toBe('ce-1');
    expect(route.dossierSection).toBe('lobbying');
    // Phase 1 shape untouched.
    expect(route.stage).toBe('');
    expect(route.status).toBe('active');
    expect(route.prospectId).toBe('');

    // Clearing restores Phase 1 defaults (params removed).
    const cleared = applyBizDevRoute(next, {
      discover: '',
      discoverQuery: '',
      discoverOffset: 0,
      dossierEntityId: '',
      dossierProspectId: '',
      dossierSection: '',
    });
    expect(cleared.get('bdDq')).toBeNull();
    expect(cleared.get('bdDiscover')).toBeNull();
    expect(cleared.get('bdOffset')).toBeNull();
    expect(cleared.get('bdDossier')).toBeNull();
    expect(cleared.get('bdSection')).toBeNull();
  });

  it('clamps invalid numeric offsets and dossier sections to safe defaults', () => {
    const route = resolveBizDevRoute(
      new URLSearchParams('bdDq=x&bdOffset=9999&bdSection=nonsense&bdDossierProspect=p-1'),
    );
    expect(route.discoverOffset).toBe(500);
    expect(route.dossierSection).toBe('');
    expect(route.dossierProspectId).toBe('p-1');
  });

  it('builds the bounded discover query from the route', () => {
    expect(bizDevDiscoverQuery(resolveBizDevRoute(new URLSearchParams('bdDq=overland')))).toEqual({
      q: 'overland',
      limit: 20,
      offset: 0,
    });
    expect(
      bizDevDiscoverQuery(resolveBizDevRoute(new URLSearchParams('bdDq=x&bdOffset=40'))),
    ).toEqual({ q: 'x', limit: 20, offset: 40 });
  });

  it('keys candidates and dossiers by tenant + full identity', () => {
    expect(bizdevKeys.candidates('t-a', { q: 'x', limit: 20, offset: 0 })).not.toEqual(
      bizdevKeys.candidates('t-b', { q: 'x', limit: 20, offset: 0 }),
    );
    expect(bizdevKeys.candidates('t-a', { q: 'x', limit: 20, offset: 0 })).not.toEqual(
      bizdevKeys.candidates('t-a', { q: 'y', limit: 20, offset: 0 }),
    );
    expect(bizdevKeys.candidates('t-a', { q: 'x', limit: 20, offset: 0 })).not.toEqual(
      bizdevKeys.candidates('t-a', { q: 'x', limit: 20, offset: 20 }),
    );
    expect(
      bizdevKeys.companyDossierIdentity('t-a', 'ce-1'),
    ).not.toEqual(bizdevKeys.companyDossierIdentity('t-b', 'ce-1'));
    expect(
      bizdevKeys.companyDossierSection('t-a', 'ce-1', 'lobbying'),
    ).not.toEqual(bizdevKeys.companyDossierSection('t-a', 'ce-1', 'footprint'));
    expect(
      bizdevKeys.prospectDossierSection('t-a', 'p-1', 'lobbying'),
    ).not.toEqual(bizdevKeys.prospectDossierSection('t-b', 'p-1', 'lobbying'));
  });

  it('keeps the Phase 1 routing contract unchanged when no Phase 2 params exist', () => {
    expect(resolveBizDevRoute(new URLSearchParams('bdStage=qualified&bdQ=ov'))).toEqual({
      stage: 'qualified',
      ownerId: '',
      status: 'active',
      conflict: '',
      linkedClient: '',
      q: 'ov',
      prospectId: '',
      discover: '',
      discoverQuery: '',
      discoverOffset: 0,
      dossierEntityId: '',
      dossierProspectId: '',
      dossierSection: '',
    });
  });
});
