import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OutreachTemplateWizard } from './OutreachTemplateWizard.js';
import { blankOutreachTemplateSpec } from './outreach-v3-template-api.js';

const { postCalls, patchCalls, api } = vi.hoisted(() => {
  const postCalls: Array<{ url: string; body?: unknown }> = [];
  const patchCalls: Array<{ url: string; body?: unknown }> = [];
  const api = {
    post: vi.fn(async (url: string, body?: unknown) => {
      postCalls.push({ url, body });
      if (url.endsWith('/from-scratch')) {
        return { data: { template: { id: 'new-template-1' }, version: { versionNumber: 1 }, published: false } };
      }
      if (url.endsWith('/publish')) return { data: { published: true } };
      return { data: {} };
    }),
    patch: vi.fn(async (url: string, body?: unknown) => {
      patchCalls.push({ url, body });
      return { data: {} };
    }),
  };
  return { postCalls, patchCalls, api };
});

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));

function renderWizard(onSaved = vi.fn(), onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <OutreachTemplateWizard mode="create" onClose={onClose} onSaved={onSaved} />
    </QueryClientProvider>,
  );
  return { onSaved, onClose };
}

function renderEditWizard(existingScope: 'private' | 'firm' | 'client' = 'firm') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSaved = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <OutreachTemplateWizard
        mode="edit"
        existing={{
          templateId: 'template-existing',
          name: 'Original name',
          description: 'Original description',
          campaignType: 'Funding ask',
          scope: existingScope,
          clientId: existingScope === 'client' ? 'client-9' : null,
          spec: blankOutreachTemplateSpec(),
        }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    </QueryClientProvider>,
  );
  return { onSaved };
}

describe('OutreachTemplateWizard', () => {
  beforeEach(() => {
    postCalls.length = 0;
    patchCalls.length = 0;
    api.post.mockClear();
    api.patch.mockClear();
  });

  it('editing an existing FIRM template resends its own current scope/client, never downgrading it to private', async () => {
    const { onSaved } = renderEditWizard('firm');
    fireEvent.change(screen.getByDisplayValue('Original name'), { target: { value: 'Renamed' } });
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: /Save draft/i }));

    // Content (draft spec) and metadata (name/scope/client) go through two
    // separate PATCH calls — find the metadata one specifically by its URL
    // (no `/draft` suffix).
    await waitFor(() =>
      expect(patchCalls.some((call) => call.url === '/api/engagement/outreach-v3/templates/template-existing')).toBe(true),
    );
    const metadataCall = patchCalls.find((call) => call.url === '/api/engagement/outreach-v3/templates/template-existing')!;
    expect(metadataCall.body).toMatchObject({ name: 'Renamed', scope: 'firm', clientId: null });
    await waitFor(() => expect(onSaved).not.toHaveBeenCalled()); // draft only, not yet published
  });

  it('editing an existing CLIENT template preserves its clientId too', async () => {
    renderEditWizard('client');
    fireEvent.change(screen.getByDisplayValue('Original name'), { target: { value: 'Renamed client template' } });
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: /Save draft/i }));

    await waitFor(() =>
      expect(patchCalls.some((call) => call.url === '/api/engagement/outreach-v3/templates/template-existing')).toBe(true),
    );
    const metadataCall = patchCalls.find((call) => call.url === '/api/engagement/outreach-v3/templates/template-existing')!;
    expect(metadataCall.body).toMatchObject({ scope: 'client', clientId: 'client-9' });
  });

  it('cannot advance past Basics without a name', () => {
    renderWizard();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/HAC-D Program Support/), { target: { value: 'My template' } });
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();
  });

  it('walks all five steps and saves a draft with the entered name/campaign type', async () => {
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText(/HAC-D Program Support/), { target: { value: 'Readiness Ask' } });
    fireEvent.change(screen.getByPlaceholderText(/Funding ask/), { target: { value: 'Readiness' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // -> Defaults
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // -> Questions & Variables
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // -> Guardrails
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // -> Review & Publish
    expect(screen.getByText('Readiness Ask')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Save draft/i }));
    await waitFor(() => expect(postCalls).toHaveLength(1));
    expect(postCalls[0]!.url).toMatch(/\/from-scratch$/);
    expect(postCalls[0]!.body).toMatchObject({ name: 'Readiness Ask', campaignType: 'Readiness' });
    await waitFor(() => expect(screen.getByText('Draft saved.')).toBeInTheDocument());
  });

  it('adding a variable requires a valid lowercase key before Questions & Variables can be left', () => {
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText(/HAC-D Program Support/), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // Defaults
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); // Questions & Variables
    fireEvent.click(screen.getByRole('button', { name: /Add variable/i }));
    // An empty key is invalid, so Next stays disabled on this step.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('key (e.g. client)'), { target: { value: 'client' } });
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();
  });

  it('publishes the saved draft on request', async () => {
    renderWizard();
    fireEvent.change(screen.getByPlaceholderText(/HAC-D Program Support/), { target: { value: 'Readiness Ask' } });
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: /Save draft/i }));
    await waitFor(() => expect(screen.getByText('Draft saved.')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Publish v1/i }));
    await waitFor(() => expect(postCalls.some((call) => call.url.endsWith('/publish'))).toBe(true));
  });
});
