import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VNextOutreachTemplates } from './VNextOutreachTemplates.js';
import {
  blankOutreachTemplateSpec,
  type OutreachTemplateSummary,
} from './outreach-v3-template-api.js';

type ListParams = {
  clientId?: string;
  includeArchived?: boolean;
  search?: string;
  mineOnly?: boolean;
  sort?: string;
};

const { getCalls, postCalls, listResponse, detailResponse, useResponse, api } = vi.hoisted(() => {
  const getCalls: Array<{ url: string; params: Record<string, unknown> }> = [];
  const postCalls: Array<{ url: string; body?: unknown }> = [];
  // `forParams` lets a test answer differently depending on what the component
  // actually asked the server for — the only way to prove a category is a real
  // server read rather than the prototype's fall-through.
  const listResponse: {
    rows: unknown[];
    forParams?: (params: Record<string, unknown>) => unknown[] | undefined;
  } = { rows: [] };
  const detailResponse: { value: unknown } = { value: null };
  const useResponse: { value: unknown } = { value: null };
  const api = {
    get: vi.fn(async (url: string, config?: { params?: Record<string, unknown> }) => {
      const params = config?.params ?? {};
      getCalls.push({ url, params });
      if (/\/templates\/[^/]+$/.test(url) && !url.includes('provenance')) {
        return { data: detailResponse.value };
      }
      return { data: listResponse.forParams?.(params) ?? listResponse.rows };
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
    publishedVersionNumber: 3,
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
    lastUsedAt: '2026-08-20T12:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    archivedAt: null,
    ...over,
  };
}

function renderLibrary(selectedClientId: string | null = null, onOpenCampaign = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <VNextOutreachTemplates selectedClientId={selectedClientId} onOpenCampaign={onOpenCampaign} />
    </QueryClientProvider>,
  );
  return { ...result, onOpenCampaign };
}

function lastListParams(): ListParams {
  const listCalls = getCalls.filter((call) => call.url.endsWith('/templates'));
  return (listCalls.at(-1)?.params ?? {}) as ListParams;
}

describe('VNextOutreachTemplates', () => {
  beforeEach(() => {
    getCalls.length = 0;
    postCalls.length = 0;
    listResponse.rows = [];
    listResponse.forParams = undefined;
    detailResponse.value = null;
    useResponse.value = null;
    api.get.mockClear();
    api.post.mockClear();
  });

  it('renders the prototype header, the six category chips and the search field verbatim', async () => {
    renderLibrary();
    expect(screen.getByText('Templates')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Start from an approved way of working' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Templates carry reusable strategy, questions, and guardrails. Recipients, evidence, context, approvals, and sending are refreshed in the new campaign.',
      ),
    ).toBeInTheDocument();
    for (const label of ['All', 'Capiro', 'Firm', 'Client', 'My templates', 'Archived']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    // U+2026, not three dots.
    expect(screen.getByPlaceholderText('Search templates…')).toBeInTheDocument();
    await waitFor(() => expect(getCalls.length).toBeGreaterThan(0));
  });

  it('renders a card with the prototype scope, version, type and usage lines', async () => {
    listResponse.rows = [template()];
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());
    const card = screen.getByRole('article');
    // Scoped to the card: "Firm" is also a category chip.
    expect(within(card).getByText('Firm')).toBeInTheDocument();
    expect(screen.getByText('Published v3')).toBeInTheDocument();
    expect(screen.getByText('A reusable firm playbook')).toBeInTheDocument();
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Funding ask')).toBeInTheDocument();
    expect(screen.getByText('Used')).toBeInTheDocument();
    // `3× · last Aug 20` — U+00D7 then U+00B7, per the prototype's formula.
    expect(screen.getByText(/^3× · last /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use template' })).toBeEnabled();
  });

  it('shows "Not set" rather than an invented campaign type when the row has none', async () => {
    listResponse.rows = [template({ campaignType: null, usageCount: 0, lastUsedAt: null })];
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());
    expect(screen.getByText('Not set')).toBeInTheDocument();
    expect(screen.getByText('0× · last never')).toBeInTheDocument();
  });

  it('the Capiro category always shows its own truthful empty state, never a fabricated row', async () => {
    listResponse.rows = [template()];
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Capiro' }));
    await waitFor(() =>
      expect(
        screen.getByText("Capiro-curated templates aren't available in this release yet."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('Firm playbook')).not.toBeInTheDocument();
    expect(
      screen.queryByText('No templates match this view. Try a different category or search.'),
    ).not.toBeInTheDocument();
  });

  it('shows the no-match empty state for a category that filtered everything out', async () => {
    listResponse.rows = [template()];
    renderLibrary('client-9');
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Client' }));
    await waitFor(() =>
      expect(
        screen.getByText('No templates match this view. Try a different category or search.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('Firm playbook')).not.toBeInTheDocument();
  });

  it('"My templates" is a real owner-scoped read, not the prototype fall-through that shows everything', async () => {
    const mine = template({ id: 'mine-1', name: 'My own playbook' });
    listResponse.rows = [template(), template({ id: 'template-2', name: 'Someone elses playbook' })];
    listResponse.forParams = (params) => (params.mineOnly ? [mine] : undefined);
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'My templates' }));
    await waitFor(() => expect(screen.getByText('My own playbook')).toBeInTheDocument());
    expect(lastListParams().mineOnly).toBe(true);
    expect(screen.queryByText('Someone elses playbook')).not.toBeInTheDocument();
  });

  it('"Archived" is a real archived read, not the prototype hardcoded empty', async () => {
    const archived = template({ id: 'arch-1', name: 'Retired playbook', status: 'archived', archivedAt: '2026-08-10T00:00:00.000Z' });
    listResponse.rows = [template()];
    listResponse.forParams = (params) => (params.includeArchived ? [template(), archived] : undefined);
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    await waitFor(() => expect(screen.getByText('Retired playbook')).toBeInTheDocument());
    expect(lastListParams().includeArchived).toBe(true);
    // Only the archived rows — an active row in the same response must not leak.
    expect(screen.queryByText('Firm playbook')).not.toBeInTheDocument();
  });

  it('the "Firm" category filters the shared read client-side without a new request', async () => {
    listResponse.rows = [template(), template({ id: 'template-3', name: 'Client playbook', scope: 'client' })];
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Client playbook')).toBeInTheDocument());
    const before = getCalls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Firm' }));
    await waitFor(() => expect(screen.queryByText('Client playbook')).not.toBeInTheDocument());
    expect(screen.getByText('Firm playbook')).toBeInTheDocument();
    expect(getCalls.length).toBe(before);
  });

  it('disables the Client chip when no client is selected, because that read can only be empty', async () => {
    listResponse.rows = [template()];
    renderLibrary(null);
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Client' })).toBeDisabled();
    renderLibrary('client-9');
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Client' }).at(-1)).toBeEnabled(),
    );
  });

  it('sends the typed query to the server search parameter', async () => {
    listResponse.rows = [template()];
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('Search templates…'), { target: { value: 'markup' } });
    await waitFor(() => expect(lastListParams().search).toBe('markup'));
  });

  it('an unpublished template offers a genuinely inert "Publish before use" button', async () => {
    listResponse.rows = [template({
      name: 'Post-hearing thank-you',
      publishedVersionId: null,
      publishedVersionNumber: null,
      currentDraftVersionId: 'version-draft',
      draftVersionNumber: 1,
    })];
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Post-hearing thank-you')).toBeInTheDocument());
    expect(screen.getByText('Draft v1')).toBeInTheDocument();

    const button = screen.getByRole('button', { name: 'Publish before use' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(postCalls).toEqual([]);
    expect(getCalls.every((call) => call.url.endsWith('/templates'))).toBe(true);
  });

  it('keeps the management actions behind the card overflow menu', async () => {
    listResponse.rows = [template()];
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());
    // At rest the card reads like the prototype's: one action.
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Duplicate' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Manage Firm playbook' }));
    const menu = screen.getByRole('menu');
    for (const label of ['Duplicate', 'Edit content', 'Settings', 'History', 'Archive']) {
      expect(within(menu).getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
    // No published draft on this row, so nothing to publish.
    expect(within(menu).queryByRole('menuitem', { name: 'Publish draft' })).not.toBeInTheDocument();

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() =>
      expect(postCalls).toEqual([
        { url: '/api/engagement/outreach-v3/templates/template-1/duplicate', body: { clientId: null } },
      ]),
    );
  });

  it('never shows an owner-only management control to a non-manager', async () => {
    listResponse.rows = [template({
      capabilities: {
        canUse: true, canDuplicate: false, canInspect: false, canEdit: false,
        canCreateVersion: false, canPublish: false, canArchive: false, canRestore: false,
      },
    })];
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Firm playbook')).toBeInTheDocument());
    // With no capability at all the overflow trigger is not rendered either.
    expect(screen.queryByRole('button', { name: 'Manage Firm playbook' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use template' })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: 'Use template' }));
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

    fireEvent.click(screen.getByRole('button', { name: 'Use template' }));
    await waitFor(() => expect(screen.getByText(/Answer a few questions/)).toBeInTheDocument());
    expect(screen.getByText('Which program?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start campaign/i })).toBeDisabled();
    expect(postCalls.some((call) => call.url.endsWith('/use'))).toBe(false);
  });
});
