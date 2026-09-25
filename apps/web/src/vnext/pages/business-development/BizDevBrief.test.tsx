import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { BizDevBrief } from './BizDevBrief.js';
import type {
  BizDevBriefSections,
  BizDevBriefVersionDetail,
  BizDevCurrentBriefResult,
  BizDevProspect,
} from './bizdev-api.js';

const sections: BizDevBriefSections = {
  companyAndFirmImplication: {
    text: 'Overland AI is the confirmed company. Strategic fit is an inference.',
    provenance: 'generated',
    citationIndexes: [0],
  },
  verifiedEvidence: {
    text: 'USAspending records a $12 million obligated award on June 30, 2026.',
    provenance: 'generated',
    citationIndexes: [0],
  },
  judgment: {
    text: 'The evidence supports a bounded opportunity hypothesis, not purchase intent.',
    provenance: 'generated',
    citationIndexes: [0],
  },
  practicalAction: {
    text: 'The owner should inspect the award and choose a next research step.',
    provenance: 'generated',
    citationIndexes: [0],
  },
  missingInformation: {
    text: 'Buyer intent and an authorized relationship path are not supplied.',
    provenance: 'generated',
    citationIndexes: [],
  },
};

const version: BizDevBriefVersionDetail = {
  id: 'v-1',
  versionNumber: 1,
  createdAt: '2026-09-25T12:00:00.000Z',
  createdByUserId: 'user-1',
  sectionsHash: 'hash',
  citationCount: 1,
  sections,
  citations: [
    {
      sourceFamily: 'usaspending_contract',
      recordId: 'award-1',
      locator: 'https://example.gov/award-1',
      originalSourceName: 'USAspending',
      originalSourceId: 'PIID-1',
      eventDate: '2026-06-30',
      sourceUpdatedAt: null,
      retrievedAt: '2026-09-24T15:00:00.000Z',
      title: 'Direct obligated award',
      relationshipStrength: 'direct',
      stage: 'obligated',
    },
  ],
  sourceSnapshot: {
    generatedAt: '2026-09-25T11:58:00.000Z',
    identityBasis: 'exact_uei',
    canonicalEntityId: '33333333-3333-4333-8333-333333333333',
    canonicalName: 'Overland AI',
    evidence: [
      {
        sourceFamily: 'usaspending_contract',
        recordId: 'award-1',
        locator: 'https://example.gov/award-1',
        originalSourceName: 'USAspending',
        originalSourceId: 'PIID-1',
        claimType: 'government_exposure',
        relationshipStrength: 'direct',
        eventDate: '2026-06-30',
        effectiveDate: null,
        fiscalYear: 2026,
        stage: 'obligated',
        sourceUpdatedAt: null,
        fetchedAt: '2026-09-24T15:00:00.000Z',
        scopeChecked: 'recipient_uei=UEI123',
        status: 'available',
        title: 'Direct obligated award',
        detail: { amount: 12_000_000 },
      },
    ],
  },
  snapshotHash: 'snapshot',
};

const current: BizDevCurrentBriefResult = {
  brief: {
    id: 'brief-1',
    tenantId: 'tenant-1',
    prospectId: '11111111-1111-4111-8111-111111111111',
    title: 'Prospect brief — Overland AI',
    status: 'draft',
    currentVersionNumber: 1,
    currentVersionId: 'v-1',
    createdAt: '2026-09-25T12:00:00.000Z',
    updatedAt: '2026-09-25T12:00:00.000Z',
    createdByUserId: 'user-1',
  },
  currentVersion: version,
};

const prospect: BizDevProspect = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-1',
  canonicalEntityId: '33333333-3333-4333-8333-333333333333',
  displayName: 'Overland AI',
  domain: 'overland.ai',
  website: 'https://overland.ai',
  description: null,
  serviceHypothesis: null,
  geography: null,
  ownerUserId: 'user-1',
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
  createdByUserId: 'user-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-25T00:00:00.000Z',
  canonicalEntity: {
    id: '33333333-3333-4333-8333-333333333333',
    canonicalName: 'Overland AI',
    normalizedName: 'overland ai',
    entityType: 'company',
  },
  linkedClient: null,
};

function apiHarness() {
  const get = vi.fn(async (path: string) => {
    if (path.endsWith('/brief')) return { data: current };
    if (path.endsWith('/brief/versions')) {
      return { data: { brief: current.brief, versions: [version] } };
    }
    if (path.endsWith('/brief/citations')) {
      return {
        data: {
          resolvable: true,
          citation: version.citations[0],
          sourceSnapshotEvidence: version.sourceSnapshot.evidence[0],
          currentDossierEvidence: version.sourceSnapshot.evidence[0],
        },
      };
    }
    if (path.endsWith('/brief/refresh-proposal')) {
      return {
        data: {
          baseVersionNumber: 1,
          proposed: sections,
          diff: [
            {
              section: 'judgment',
              changed: true,
              baseText: sections.judgment.text,
              proposedText: 'Fresh evidence supports a narrower hypothesis.',
            },
          ],
          sourceSnapshot: version.sourceSnapshot,
          snapshotHash: 'fresh',
        },
      };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  const put = vi.fn(async () => ({
    data: {
      brief: { ...current.brief, currentVersionNumber: 2, currentVersionId: 'v-2' },
      version: { ...version, id: 'v-2', versionNumber: 2 },
      created: true,
    },
  }));
  return { api: { get, put, post: vi.fn() } as unknown as AxiosInstance, get, put };
}

function renderBrief(api: AxiosInstance, onDraftWithMeri = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BizDevBrief
        api={api}
        tenantId="tenant-1"
        prospect={prospect}
        meriEnabled
        onDraftWithMeri={onDraftWithMeri}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('BizDevBrief', () => {
  it('renders exactly the five editable sections and a request-only Meri action', async () => {
    const h = apiHarness();
    const onDraftWithMeri = vi.fn();
    renderBrief(h.api, onDraftWithMeri);

    for (const label of [
      'Company and firm implication',
      'Verified evidence',
      'Judgment',
      'Practical action',
      'Missing information',
    ]) {
      expect(await screen.findByRole('textbox', { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Draft with Meri' }));
    expect(onDraftWithMeri).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/never sends outreach/i)).toBeTruthy();
  });

  it('opens an inspectable citation with separated dates and honest missing data', async () => {
    const h = apiHarness();
    renderBrief(h.api);
    const sourceButtons = await screen.findAllByRole('button', { name: /Direct obligated award/ });
    fireEvent.click(sourceButtons[0]!);
    expect(await screen.findByRole('complementary', { name: /Source: Direct obligated award/ })).toBeTruthy();
    expect(screen.getByText('Publication / source update')).toBeTruthy();
    expect(screen.getAllByText('Not supplied').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Open precise source record' })).toHaveAttribute(
      'href',
      'https://example.gov/award-1',
    );
  });

  it('saves a changed section as an edited, version-checked idempotent write', async () => {
    const h = apiHarness();
    renderBrief(h.api);
    const judgment = await screen.findByRole('textbox', { name: 'Judgment' });
    fireEvent.change(judgment, { target: { value: 'User-authored judgment with a qualification.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));

    await waitFor(() => expect(h.put).toHaveBeenCalledTimes(1));
    const [, body] = h.put.mock.calls[0]! as unknown as [
      string,
      {
        expectedVersionNumber: number;
        idempotencyKey: string;
        sections: Record<string, { text: string; provenance: string; citationIndexes: number[] }>;
      },
    ];
    expect(body.expectedVersionNumber).toBe(1);
    expect(body.idempotencyKey).toMatch(/^bizdev-brief:edit:/);
    expect(body.sections.judgment).toMatchObject({
      text: 'User-authored judgment with a qualification.',
      provenance: 'edited',
      citationIndexes: [0],
    });
    expect(body.sections.verifiedEvidence!.provenance).toBe('generated');
  });

  it('previews refresh differences without writing or replacing edits', async () => {
    const h = apiHarness();
    renderBrief(h.api);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview refresh' }));
    expect(await screen.findByRole('dialog', { name: 'Review refreshed evidence proposal' })).toBeTruthy();
    expect(screen.getByText('Fresh evidence supports a narrower hypothesis.')).toBeTruthy();
    expect(h.put).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Keep my edits and refresh the rest' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace with fresh proposal' })).toBeTruthy();
  });
});
