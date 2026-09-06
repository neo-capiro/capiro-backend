import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DigestContent } from '../lib/wave3-api.js';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => api }));

import { DigestTab } from './DigestTab.js';

function brief(id: string, headline: string): DigestContent {
  return {
    id, headline, generatedAt: '2026-09-06T11:00:00Z', scopeLabel: headline,
    clientsInScope: 1, whatChanged: [], decisionsRequired: [], upcomingHearings: [],
    billMovement: [], clientImplications: [], recommendedActions: [],
    provenance: { sourceFamilies: [], officialRecordCount: 0, captureCount: 0 },
  };
}

const runs = {
  older: brief('older', 'Earlier Alpha briefing'),
  generated: brief('generated', 'New Alpha briefing'),
  beta: brief('beta', 'Beta briefing'),
};
const historyRow = (id: string) => ({ id, generatedAt: runs[id as keyof typeof runs].generatedAt, itemCount: 0, decisionCount: 0, sourceFamilies: [] });

beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockImplementation(async (url: string) => {
    if (url.includes('/history')) return { data: { rows: [historyRow(url.includes('clientId=beta') ? 'beta' : 'older')] } };
    if (url.includes('/schedule/config')) return { data: { cadence: 'off', hourUtc: 11, emailEnabled: false } };
    const id = url.split('/').pop() as keyof typeof runs;
    if (runs[id]) return { data: runs[id] };
    throw new Error(`Unexpected read: ${url}`);
  });
  api.post.mockResolvedValue({ data: runs.generated });
});
afterEach(cleanup);

function mount(scope = 'alpha') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const ui = (client: string) => <QueryClientProvider client={qc}><DigestTab scope={client} /></QueryClientProvider>;
  const view = render(ui(scope));
  return { ...view, switchScope: (client: string) => view.rerender(ui(client)) };
}

describe('Digest selection and client scope', () => {
  it('opens a historical run after generating a new brief', async () => {
    mount();
    await screen.findByText('Earlier Alpha briefing');
    fireEvent.click(screen.getByRole('button', { name: 'Generate now' }));
    await screen.findByText('New Alpha briefing');
    fireEvent.click(screen.getByRole('button', { name: /0 items · 0 decisions/ }));
    await screen.findByText('Earlier Alpha briefing');
    expect(screen.queryByText('New Alpha briefing')).toBeNull();
  });

  it('never displays the generated brief from the previous client after a scope change', async () => {
    const view = mount();
    await screen.findByText('Earlier Alpha briefing');
    fireEvent.click(screen.getByRole('button', { name: 'Generate now' }));
    await screen.findByText('New Alpha briefing');
    view.switchScope('beta');
    expect(screen.queryByText('New Alpha briefing')).toBeNull();
    await screen.findByText('Beta briefing');
  });

  it('does not let a late generation replace the newly selected client scope', async () => {
    let finish!: (value: { data: DigestContent }) => void;
    api.post.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = mount();
    await screen.findByText('Earlier Alpha briefing');
    fireEvent.click(screen.getByRole('button', { name: 'Generate now' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    view.switchScope('beta');
    await screen.findByText('Beta briefing');
    finish({ data: runs.generated });
    await waitFor(() => expect(screen.queryByText('New Alpha briefing')).toBeNull());
    expect(screen.getByText('Beta briefing')).toBeTruthy();
  });

  it('reports a history read failure instead of claiming no digest exists', async () => {
    api.get.mockRejectedValue(new Error('unavailable'));
    mount();
    await screen.findByText('Saved briefs could not be loaded.');
    expect(screen.queryByText('No digest has been generated yet for this scope.')).toBeNull();
  });
});
