/**
 * Knowledge Graph vNext — behavioral coverage for the ported chrome. The
 * canonical panel had no test file; these pin the data-plane contract the
 * port preserves (endpoints, query keys, populate confirm + backfill call)
 * and the named empty/guard states. The Cytoscape scene itself is not
 * rendered here — jsdom has no canvas; these tests exercise the states that
 * render BEFORE the graph mounts.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { KnowledgeGraphPageVNext } from './KnowledgeGraphPageVNext.js';

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock }),
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/intelligence/graph']}>
      <QueryClientProvider client={queryClient}>
        <KnowledgeGraphPageVNext />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const emptyGraph = { nodes: [], edges: [] };

describe('KnowledgeGraphPageVNext', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/memory/graph') return { data: emptyGraph };
      if (url === '/api/clients') return { data: [{ id: 'client-1', name: 'Overland AI' }] };
      return { data: emptyGraph };
    });
  });

  test('loads the full-firm graph endpoint and names the empty state', async () => {
    renderPage();

    expect(
      await screen.findByText('No connections yet.'),
    ).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith('/api/memory/graph');
    expect(
      screen.getByText(/Populate the graph from your clients, memories, and meetings/i),
    ).toBeInTheDocument();
  });

  test('populate asks for confirmation, then POSTs the idempotent backfill', async () => {
    apiPostMock.mockResolvedValue({
      data: { counts: { clients: 12, clioMemories: 340, meetings: 57 } },
    });
    renderPage();

    await screen.findByText('No connections yet.');
    // Two entry points (controls row + empty state) — both open the confirm.
    fireEvent.click(screen.getAllByRole('button', { name: /Populate graph/i })[0]!);
    expect(
      await screen.findByText(/Builds graph nodes\/links from your clients, memories, and meetings/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Populate' }));
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/api/memory/backfill', {}, { timeout: 600_000 }),
    );
  });

  test('the client view guards until a client is chosen, then fetches the client subgraph', async () => {
    renderPage();
    await screen.findByText('No connections yet.');

    fireEvent.click(screen.getByRole('tab', { name: 'By client' }));
    expect(await screen.findByText('Select a client to see their subgraph.')).toBeInTheDocument();

    const select = await screen.findByLabelText('Select client');
    fireEvent.change(select, { target: { value: 'client-1' } });
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith('/api/memory/graph/client/client-1'),
    );
  });

  test('the path view guards until a target is chosen', async () => {
    renderPage();
    await screen.findByText('No connections yet.');

    fireEvent.click(screen.getByRole('tab', { name: 'Path to…' }));
    expect(
      await screen.findByText('Pick a target office or person to find routes from your clients.'),
    ).toBeInTheDocument();
  });

  test('a failed graph fetch is named as a failure', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/clients') return { data: [] };
      throw new Error('graph down');
    });
    renderPage();

    // The graph query retries once (retry: 1, canonical behavior) before
    // surfacing the error, so allow the retry round-trip to settle.
    expect(
      await screen.findByText('Could not load the knowledge graph.', undefined, { timeout: 8000 }),
    ).toBeInTheDocument();
  });
});
