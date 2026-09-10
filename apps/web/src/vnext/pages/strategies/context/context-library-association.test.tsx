/**
 * F06 (2026-09-10 remediation plan §4, implementation item 6) — Context
 * library card association labels.
 *
 * A strategy-scoped document's card used to say just "This strategy" without
 * identifying WHICH strategy — and never distinguished an archived
 * association. The card must now name the actual strategy (batched, not one
 * request per card) and distinguish:
 *   - active association  → "Strategy: <title>"
 *   - archived association → "<title> · Archived"
 *   - missing/mismatched  → "Association unavailable" (never "deleted")
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextLibraryVNext } from './ContextLibraryVNext.js';
import type { ContextDocumentListItem } from '../../../../pages/strategy/types.js';

const state = vi.hoisted(() => ({
  documents: [] as ContextDocumentListItem[],
  strategies: [
    { id: 'strategy-active', title: 'Active strategy', clientId: 'client-a' },
    { id: 'strategy-archived', title: 'Archived strategy', clientId: 'client-a' },
  ],
  associations: {} as Record<string, { state: string; strategy: { id: string; title: string } | null }>,
}));

vi.mock('../../../adapters/legacy/useShellClientContext.js', () => ({
  useShellClientContext: () => ({ selectedClientId: null }),
}));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ data: { role: 'user', features: { agenticMeri: true, contextSteward: true } } }) }));

vi.mock('../strategies-api.js', async () => {
  const actual = await vi.importActual<typeof import('../strategies-api.js')>('../strategies-api.js');
  return {
    ...actual,
    useClientsLite: () => ({ data: [{ id: 'client-a', name: 'Client A' }], isLoading: false }),
    useContextDocuments: () => ({ data: state.documents, isLoading: false, isError: false }),
    useContextFacts: () => ({ data: [], isLoading: false, isError: false }),
    useContextConflicts: () => ({ data: [], isLoading: false, isError: false }),
    useContextHealth: () => ({ data: undefined, isLoading: false, isError: false }),
    useStrategies: () => ({ data: state.strategies, isLoading: false, isError: false }),
    useContextAssociations: () => ({
      data: state.associations,
      isLoading: false,
      isError: false,
    }),
  };
});

function doc(over: Partial<ContextDocumentListItem> & { id: string; scope: string; scopeRef: string | null }): ContextDocumentListItem {
  return {
    clientId: 'client-a',
    templateKey: '01_strategy_brief',
    title: 'Doc',
    state: 'active',
    frontmatter: { authority: 'client_approved', as_of: '2026-07-01' },
    checksum: 'x',
    supersedesId: null,
    validUntil: null,
    createdByUserId: 'u',
    updatedByUserId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  } as ContextDocumentListItem;
}

function renderLibrary() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/strategies/context?clientId=client-a']}>
        <Routes>
          <Route path="/strategies/context" element={<ContextLibraryVNext />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.documents = [];
  state.associations = {};
});

describe('Context library — association labels (F06)', () => {
  it('names the actual strategy on a strategy-scoped card instead of "This strategy"', async () => {
    state.documents = [
      doc({ id: 'd-1', scope: 'strategy', scopeRef: 'strategy-active', title: 'Active strategy brief' }),
    ];
    state.associations = {
      'd-1': { state: 'active', strategy: { id: 'strategy-active', title: 'Active strategy' } },
    };
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Active strategy brief')).toBeTruthy());
    // The meta line carries the strategy's actual title, not a relative label.
    expect(screen.getAllByText((_, el) => (el?.textContent ?? '').includes('Strategy: Active strategy')).length).toBeGreaterThan(0);
    expect(screen.queryByText('This strategy')).toBeNull();
  });

  it('marks an archived association distinctly', async () => {
    state.documents = [
      doc({ id: 'd-2', scope: 'strategy', scopeRef: 'strategy-archived', title: 'Archived strategy brief' }),
    ];
    state.associations = {
      'd-2': { state: 'archived', strategy: { id: 'strategy-archived', title: 'Archived strategy' } },
    };
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Archived strategy brief')).toBeTruthy());
    expect(screen.getAllByText((_, el) => (el?.textContent ?? '').includes('Archived strategy · Archived')).length).toBeGreaterThan(0);
  });

  it('falls back to "Association unavailable" when the strategy cannot be resolved', async () => {
    state.documents = [
      doc({ id: 'd-3', scope: 'strategy', scopeRef: 'gone-strategy', title: 'Mystery brief' }),
    ];
    state.associations = {
      'd-3': { state: 'missing', strategy: null },
    };
    renderLibrary();
    await waitFor(() => expect(screen.getByText('Mystery brief')).toBeTruthy());
    expect(screen.getAllByText((_, el) => (el?.textContent ?? '').includes('Association unavailable')).length).toBeGreaterThan(0);
    // Never infer "deleted" from a missing list row.
    expect(screen.queryByText(/deleted/i)).toBeNull();
  });
});
