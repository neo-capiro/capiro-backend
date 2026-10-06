import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDrafts } from './api.js';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => ({ get }) }));

function PriorDocuments() {
  const { data: drafts, isPending } = useDrafts({ sector: 'Defense', scope: 'mine' });
  if (isPending) return <p>Loading documents</p>;
  // Same client/completion constraints as the context builder, after the async response.
  return <ul>{(drafts ?? []).filter((draft) => draft.client === 'Acme' && draft.status === 'complete')
    .map((draft) => <li key={draft.id}>{draft.docTitle}</li>)}</ul>;
}

function renderDocuments(children: ReactNode = <PriorDocuments />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

const drafts = [
  { id: 'complete', client: 'Acme', status: 'complete', docTitle: 'Completed hearing debrief' },
  { id: 'draft', client: 'Acme', status: 'draft', docTitle: 'Unfinished debrief' },
  { id: 'other-client', client: 'Other', status: 'complete', docTitle: 'Other client document' },
];

describe('Workspace draft list response', () => {
  beforeEach(() => get.mockReset());

  it.each([
    ['engine envelope', { drafts }],
    ['legacy array', drafts],
  ])('supports %s without breaking context filters', async (_label, response) => {
    let resolve!: (value: { data: unknown }) => void;
    get.mockReturnValue(new Promise((done) => { resolve = done; }));
    renderDocuments();
    expect(screen.getByText('Loading documents')).toBeInTheDocument();
    resolve({ data: response });
    expect(await screen.findByText('Completed hearing debrief')).toBeInTheDocument();
    expect(screen.queryByText('Unfinished debrief')).not.toBeInTheDocument();
    expect(screen.queryByText('Other client document')).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/workspace-api/drafts?sector=Defense&scope=mine');
  });

  it.each([null, {}, { drafts: null }, { drafts: {} }])('keeps absent or malformed lists iterable: %j', async (response) => {
    get.mockResolvedValue({ data: response });
    renderDocuments();
    await waitFor(() => expect(screen.queryByText('Loading documents')).not.toBeInTheDocument());
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});
