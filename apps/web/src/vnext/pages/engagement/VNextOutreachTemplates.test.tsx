import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VNextOutreachTemplates } from './VNextOutreachTemplates.js';
import {
  blankOutreachTemplateSpec,
  type OutreachTemplateSummary,
} from './outreach-v3-template-api.js';

const { getCalls, postCalls, listResponse, detailResponse, useResponse, api } = vi.hoisted(() => {
  const getCalls: Array<{ url: string; params?: unknown }> = [];
  const postCalls: Array<{ url: string; body?: unknown }> = [];
  const listResponse: { rows: unknown[] } = { rows: [] };
  const detailResponse: { value: unknown } = { value: null };
  const useResponse: { value: unknown } = { value: null };
  const api = {
    get: vi.fn(async (url: string, config?: { params?: unknown }) => {
      getCalls.push({ url, params: config?.params });
      if (/\/templates\/[^/]+$/.test(url) && !url.includes('provenance')) {
        return { data: detailResponse.value };
      }
      return { data: listResponse.rows };
    }),
    post: vi.fn(async (url: string, body?: unknown) => {
      postCalls.push({ url, body });
      if (url.endsWith('/use')) return { data: useResponse.value };
      if (url.endsWith('/duplicate')) return { data: { template: template({ id: 'dup-1', name: 'Firm playbook (copy)' }), version: {}, published: false } };
      return { data: {} };
    }),
    patch: vi.fn(async () => ({ data: {} })),
  };
  return { getCalls, postCalls, listResponse, detailResponse, useResponse, api };
});

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));

function template(over: Partial<OutreachTemplateSummary> = {}): OutreachTemplateSummary {
  return {
    id: 'template-1',
    ownerUserId: 'user-1',
    clientId: null,
    scope: 'firm',
    name: 'Firm playbook',
    description: 'A reusable firm playbook',
    campaignType: 'Funding ask',
    status: 'active',
    currentDraftVersionId: null,
    publishedVersionId: 'version-1',
    duplicatedFromTemplateId: null,
    duplicatedFromVersionId: null,
    draftVersionNumber: null,
    publishedVersionNumber: 1,
    previewSummary: {
      topic: 'Autonomy',
      sponsorKind: 'firm',
      deliveryPattern: 'personalized_separate',
      personalization: 'high',
      tone: 'Direct',
      length: 'short',
      hasExplicitAsk: true,
      styleSampleCount: 0,
      variableCount: 0,
      requiredVariableCount: 0,
    },
    capabilities: {
      canUse: true,
      canDuplicate: true,
      canInspect: true,
      canEdit: true,
      canCreateVersion: true,
      canPublish: true,
      canArchive: true,
      canRestore: false,
    },
    usageCount: 3,
    lastUsedAt: '2026-08-20T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    archivedAt: null,
    ...over,
  };
}

function renderLibrary(onOpenCampaign = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <VNextOutreachTemplates selectedClientId={null} onOpenCampaign={onOpenCampaign} />
    </QueryClientProvider>,
  );
  return { ...result, onOpenCampaign };
}

describe('VNextOutreachTemplates', () => {
  beforeEach(() => {
    getCalls.length = 0;
    postCalls.length = 0;
    listResponse.rows = [];
    detailResponse.value = null;
    useResponse.value = null;
    api.get.mockClear();
    api.post.mockClear();
  });

  it('lists templates from the real endpoint and shows usage metadata', async () => {
    listResponse.rows = [template()];
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());
    expect(screen.getByText(/3× · last/)).toBeInTheDocument();
    // "Funding ask" legitimately appears twice: once on the card, once as a
    // derived option in the campaign-type filter dropdown.
    expect(screen.getAllByText('Funding ask').length).toBeGreaterThanOrEqual(1);
  });

  it('the Capiro category always shows a truthful empty state, never a fabricated row', async () => {
    listResponse.rows = [template()];
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Capiro' }));
    await waitFor(() =>
      expect(screen.getByText(/Capiro-curated templates aren't available in this release yet/)).toBeInTheDocument(),
    );
    expect(screen.queryByText('Firm playbook')).not.toBeInTheDocument();
  });

  it('uses a published template with no variables and shows the application receipt before opening the campaign', async () => {
    const t = template();
    listResponse.rows = [t];
    detailResponse.value = {
      template: t,
      versions: [{ id: 'version-1', templateId: t.id, versionNumber: 1, lifecycle: 'published', contentHash: 'a'.repeat(64), sourceSessionId: null, sourceStateVersion: null, createdByUserId: 'user-1', createdAt: '2026-08-01T00:00:00.000Z', publishedAt: '2026-08-01T00:00:00.000Z', spec: blankOutreachTemplateSpec() }],
      capabilities: t.capabilities,
    };
    useResponse.value = {
      sessionId: 'new-session-1',
      stateVersion: 1,
      templateId: t.id,
      templateVersionId: 'version-1',
      applicationId: 'app-1',
      replayed: false,
      receipt: {
        templateId: t.id,
        templateName: t.name,
        templateVersionId: 'version-1',
        templateVersionNumber: 1,
        templateContentHash: 'a'.repeat(64),
        inherited: [{ field: 'tone', label: 'Tone', detail: 'Direct' }],
        refreshed: [{ field: 'targets', label: 'Recipients', detail: 'Resolved fresh.' }],
        unresolved: [],
        unavailable: [],
        nextRequiredStep: 'targets',
        requiresLiveTargets: true,
        requiresLiveContext: true,
      },
    };
    const { onOpenCampaign } = renderLibrary();
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Use template/i }));
    await waitFor(() => expect(screen.getByText(/Firm playbook · v1/)).toBeInTheDocument());
    expect(screen.getByText('Tone')).toBeInTheDocument();
    expect(screen.getByText('Recipients')).toBeInTheDocument();
    expect(onOpenCampaign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Continue to campaign/i }));
    expect(onOpenCampaign).toHaveBeenCalledWith('new-session-1');
  });

  it('prompts for required variables before using a template that declares them', async () => {
    const t = template({ id: 'template-var', name: 'Variable playbook' });
    listResponse.rows = [t];
    detailResponse.value = {
      template: t,
      versions: [{
        id: 'version-1', templateId: t.id, versionNumber: 1, lifecycle: 'published', contentHash: 'a'.repeat(64),
        sourceSessionId: null, sourceStateVersion: null, createdByUserId: 'user-1',
        createdAt: '2026-08-01T00:00:00.000Z', publishedAt: '2026-08-01T00:00:00.000Z',
        spec: {
          ...blankOutreachTemplateSpec(),
          variables: [{
            key: 'program', label: 'Program', question: 'Which program?', type: 'text', choices: null,
            required: true, defaultValue: null, resolutionPolicy: 'user_must_confirm', scope: 'public', appliesTo: ['goal'],
          }],
        },
      }],
      capabilities: t.capabilities,
    };
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Variable playbook')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Use template/i }));
    await waitFor(() => expect(screen.getByText(/Answer a few questions/)).toBeInTheDocument());
    expect(screen.getByText('Which program?')).toBeInTheDocument();
    // Cannot start until the required field is filled.
    expect(screen.getByRole('button', { name: /Start campaign/i })).toBeDisabled();
    expect(postCalls.some((call) => call.url.endsWith('/use'))).toBe(false);
  });

  it('duplicates a template through the real endpoint', async () => {
    const t = template();
    listResponse.rows = [t];
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Duplicate/i }));
    await waitFor(() =>
      expect(postCalls).toEqual([{ url: `/api/engagement/outreach-v3/templates/${t.id}/duplicate`, body: { clientId: null } }]),
    );
  });

  it('never shows an owner-only draft management control to a non-manager', async () => {
    listResponse.rows = [template({
      capabilities: {
        canUse: true, canDuplicate: true, canInspect: false, canEdit: false,
        canCreateVersion: false, canPublish: false, canArchive: false, canRestore: false,
      },
    })];
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Edit content/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Settings$/i })).not.toBeInTheDocument();
    // Exact match: the "Archived" category tab also renders and legitimately
    // matches a loose /Archive/i, but the card's own archive ACTION button
    // (exact text "Archive") must be absent for a non-manager.
    expect(screen.queryByRole('button', { name: /^Archive$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Duplicate/i })).toBeInTheDocument();
  });
});
