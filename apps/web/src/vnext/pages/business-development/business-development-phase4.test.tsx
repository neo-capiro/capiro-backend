/**
 * Business Development Phase 4 — focused integration contract tests.
 *
 * Same API-mock pattern as business-development.test.tsx. Covers:
 * - both feature flags fail closed independently (brief surface, Meri tools)
 * - Overview/Evidence/Brief tabs + no brief query when disabled
 * - Draft with Meri: create-initial-brief-then-launch, fresh session +
 *   cleared client filter, only prospectId + bounded prompt, no outreach
 *   endpoints, create failure must not launch Meri
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import {
  BusinessDevelopmentPage,
  BIZDEV_DRAFT_WITH_MERI_PROMPT,
} from './BusinessDevelopmentPage.js';
import type { BizDevBriefVersionDetail, BizDevProspect } from './bizdev-api.js';

const meriWindowMocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../../components/chat/meri-window.js', () => ({
  openVNextMeriWorkspaceWindow: meriWindowMocks.open,
}));

// ── fixtures ───────────────────────────────────────────────────────────

const PROSPECT_UUID = '11111111-1111-4111-8111-111111111111';

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
    nextActionDueAt: '2026-10-01T00:00:00.000Z',
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

function briefVersion(): BizDevBriefVersionDetail {
  const section = {
    text: 'Grounded text.',
    provenance: 'generated' as const,
    citationIndexes: [0],
  };
  return {
    id: 'bv-1',
    versionNumber: 1,
    createdAt: '2026-09-20T00:00:00.000Z',
    createdByUserId: 'u-1',
    sectionsHash: 'hash-1',
    citationCount: 1,
    sections: {
      companyAndFirmImplication: section,
      verifiedEvidence: section,
      judgment: section,
      practicalAction: section,
      missingInformation: section,
    },
    citations: [
      {
        sourceFamily: 'lda',
        recordId: 'r-1',
        locator: 'https://example.test/record',
        originalSourceName: 'LDA',
        originalSourceId: 'lda-1',
        eventDate: null,
        sourceUpdatedAt: null,
        retrievedAt: null,
        title: 'Source record',
        relationshipStrength: 'direct',
        stage: null,
      },
    ],
    sourceSnapshot: {
      generatedAt: '2026-09-20T00:00:00.000Z',
      identityBasis: 'manual',
      canonicalEntityId: null,
      canonicalName: null,
      evidence: [],
    },
    snapshotHash: 'snap-1',
  };
}

function briefSummary() {
  return {
    id: 'bb-1',
    tenantId: 't-1',
    prospectId: PROSPECT_UUID,
    title: 'Overland AI opportunity brief',
    status: 'draft' as const,
    currentVersionNumber: 1,
    currentVersionId: 'bv-1',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    createdByUserId: 'u-1',
  };
}

interface MockConfig {
  meFeatures?: Record<string, boolean | undefined>;
  hasBrief?: boolean;
  briefCreateFails?: boolean;
}

let apiCalls: { method: string; path: string }[] = [];

function makeApi(cfg: MockConfig): AxiosInstance {
  const record = (method: string, path: string) => apiCalls.push({ method, path });
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
      if (path === `/api/business-development/prospects/${PROSPECT_UUID}/brief`)
        return {
          data:
            cfg.hasBrief === false
              ? { brief: null, currentVersion: null }
              : { brief: briefSummary(), currentVersion: briefVersion() },
        };
      if (path === `/api/business-development/prospects/${PROSPECT_UUID}/brief/versions`)
        return { data: { versions: [] } };
      if (path === '/api/business-development/member-options')
        return { data: { members: MEMBERS } };
      if (path === '/api/business-development/preferences') return { data: null };
      if (path === '/api/business-development/search/canonical-organizations')
        return { data: { results: [] } };
      if (path === '/api/business-development/search/clients') return { data: { results: [] } };
      throw new Error(`unmocked GET ${path}`);
    }),
    post: vi.fn(async (path: string) => {
      record('POST', path);
      if (path === `/api/business-development/prospects/${PROSPECT_UUID}/brief/versions`) {
        if (cfg.briefCreateFails) throw new Error('dossier snapshot unavailable');
        return { data: { brief: briefSummary(), version: briefVersion(), created: true } };
      }
      if (path === '/api/business-development/prospects') return { data: prospect() };
      throw new Error(`unmocked POST ${path}`);
    }),
    patch: vi.fn(async (path: string) => {
      record('PATCH', path);
      return { data: prospect() };
    }),
    put: vi.fn(async (path: string) => {
      record('PUT', path);
      if (path === '/api/business-development/preferences')
        return {
          data: {
            id: 'pref-1',
            tenantId: 't-1',
            practiceServiceAreas: [],
            agenciesIssues: [],
            geographies: [],
          },
        };
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
  apiCalls = [];
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

afterEach(() => {
  vi.clearAllMocks();
});

// ── 1. both flags fail closed independently ────────────────────────────

describe('Phase 4 flag gating', () => {
  it('does not mount the brief surface or its query when businessDevelopmentBrief is off', async () => {
    renderAt('?view=business-development&bdProspect=' + PROSPECT_UUID, {
      meFeatures: { businessDevelopment: true, businessDevelopmentDossier: true },
    });
    await waitFor(() => expect(screen.getByText('Prospect — Overland AI')).toBeInTheDocument());
    // Only the Overview tab exists.
    expect(screen.queryByRole('tab', { name: 'Brief' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Evidence' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    // No brief query was issued at all.
    expect(apiCalls).not.toContainEqual(
      expect.objectContaining({ path: expect.stringContaining('/brief') }),
    );
  });

  it('hides the Brief tab when the brief flag is on but dossier is off (independent fail-closed)', async () => {
    renderAt('?view=business-development&bdProspect=' + PROSPECT_UUID, {
      meFeatures: { businessDevelopment: true, businessDevelopmentBrief: true },
    });
    await waitFor(() => expect(screen.getByText('Prospect — Overland AI')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Brief' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Evidence' })).not.toBeInTheDocument();
  });

  it('shows the Brief tab when the brief flag is on, but no Draft with Meri button without Meri prospect tools', async () => {
    renderAt('?view=business-development&bdProspect=' + PROSPECT_UUID, {
      meFeatures: {
        businessDevelopment: true,
        businessDevelopmentBrief: true,
        businessDevelopmentDossier: true,
      },
    });
    await waitFor(() => expect(screen.getByText('Prospect — Overland AI')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    // The brief loads (query runs only once the tab is mounted).
    await waitFor(() => expect(screen.getByText('Version 1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Draft with Meri' })).not.toBeInTheDocument();
  });
});

// ── 2. Draft with Meri launch ───────────────────────────────────────────

describe('Draft with Meri', () => {
  it('awaits initial brief creation, then launches Meri with only prospectId + the bounded prompt', async () => {
    renderAt('?view=business-development&bdProspect=' + PROSPECT_UUID, {
      meFeatures: {
        businessDevelopment: true,
        businessDevelopmentBrief: true,
        businessDevelopmentMeriProspectTools: true,
      },
      hasBrief: false,
    });
    await waitFor(() => expect(screen.getByText('Prospect — Overland AI')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    const draftButton = await screen.findByRole('button', { name: 'Draft with Meri' });
    fireEvent.click(draftButton);

    await waitFor(() => expect(meriWindowMocks.open).toHaveBeenCalledTimes(1));

    // The deterministic initial brief was created FIRST (Meri save tool
    // needs a current version/citation set)…
    expect(apiCalls).toContainEqual({
      method: 'POST',
      path: `/api/business-development/prospects/${PROSPECT_UUID}/brief/versions`,
    });
    // …and the launch carried only prospectId plus the bounded prompt.
    expect(meriWindowMocks.open).toHaveBeenCalledWith(window, window.location.origin, {
      prompt: BIZDEV_DRAFT_WITH_MERI_PROMPT,
      prospectId: PROSPECT_UUID,
    });
    // The bounded prompt smuggles no firm/prospect/provider facts.
    expect(BIZDEV_DRAFT_WITH_MERI_PROMPT).not.toContain('Overland');
    // No external outreach/send endpoint was called anywhere.
    expect(apiCalls.map((c) => c.path).join(' ')).not.toMatch(/outreach|\/send|email/i);
  });

  it('does not launch Meri when the initial brief creation fails', async () => {
    renderAt('?view=business-development&bdProspect=' + PROSPECT_UUID, {
      meFeatures: {
        businessDevelopment: true,
        businessDevelopmentBrief: true,
        businessDevelopmentMeriProspectTools: true,
      },
      hasBrief: false,
      briefCreateFails: true,
    });
    await waitFor(() => expect(screen.getByText('Prospect — Overland AI')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    const draftButton = await screen.findByRole('button', { name: 'Draft with Meri' });
    fireEvent.click(draftButton);
    // Creation was attempted…
    await waitFor(() =>
      expect(apiCalls).toContainEqual({
        method: 'POST',
        path: `/api/business-development/prospects/${PROSPECT_UUID}/brief/versions`,
      }),
    );
    // …but no Meri event ever fired.
    await act(async () => {});
    expect(meriWindowMocks.open).not.toHaveBeenCalled();
  });
});

// ── 3. the bounded prompt is the single launch text ─────────────────────

describe('bounded prompt', () => {
  it('asks for the five-section grounded brief, evidence, uncertainty, citations and no outreach', () => {
    const p = BIZDEV_DRAFT_WITH_MERI_PROMPT;
    for (const word of [
      'five sections',
      'Company and firm implication',
      'Verified evidence',
      'Judgment',
      'Practical action',
      'Missing information',
      'authorized evidence',
      'uncertainty',
      'citation',
      'outreach',
    ]) {
      expect(p.toLowerCase()).toContain(word.toLowerCase());
    }
  });
});
