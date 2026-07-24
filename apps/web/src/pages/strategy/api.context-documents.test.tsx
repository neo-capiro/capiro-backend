import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ContextDocumentListItem } from './types.js';

const apiGetMock = vi.fn();

// useApi -> api-client.ts -> env.ts throws at module-load time without the
// Clerk env; mock it out (same pattern as ActionBoardPage.test.tsx) — the
// mock also lets us assert the exact URL the hook requests.
vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: vi.fn() }),
}));

const { useContextDocuments } = await import('./api.js');
const { isContextDocStale } = await import('./context/context-utils.js');

function doc(overrides: Partial<ContextDocumentListItem> = {}): ContextDocumentListItem {
  return {
    id: 'doc-1',
    clientId: null,
    scope: 'firm',
    scopeRef: null,
    templateKey: '05_environment_and_context',
    title: 'Environment and context',
    state: 'active',
    frontmatter: null,
    checksum: 'abc123',
    supersedesId: null,
    validUntil: null,
    createdByUserId: 'user_1',
    updatedByUserId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderContextDocuments() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useContextDocuments(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
}

describe('useContextDocuments — the library list must include stale rows', () => {
  test('requests /context/documents WITH includeStale=true and keeps stale rows in the data', async () => {
    // A doc whose staleness horizon has passed (upload accepts any real past
    // date) plus retained superseded history — both have validUntil < today.
    const staleActive = doc({ id: 'doc-stale', validUntil: '2026-07-01' });
    const supersededHistory = doc({
      id: 'doc-superseded',
      state: 'superseded',
      validUntil: '2026-01-01',
    });
    const fresh = doc({ id: 'doc-fresh', validUntil: '2099-01-01' });
    apiGetMock.mockResolvedValue({ data: [staleActive, supersededHistory, fresh] });

    const { result } = renderContextDocuments();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // REGRESSION ANCHOR: without ?includeStale=true the server default drops
    // every row with validUntil < today regardless of state — a just-uploaded
    // past-dated doc silently vanishes from the library (no toggle to reveal
    // it, no path to its view/archive page), and an active doc disappears
    // overnight instead of showing the amber Stale chip. The management
    // surface must always request the full library.
    expect(apiGetMock).toHaveBeenCalledWith('/strategy-api/context/documents?includeStale=true');

    const ids = (result.current.data ?? []).map((d) => d.id);
    expect(ids).toEqual(['doc-stale', 'doc-superseded', 'doc-fresh']);
  });

  test('the amber Stale chip is reachable for a column-backed stale ACTIVE doc (and only that one)', async () => {
    const staleActive = doc({ id: 'doc-stale', validUntil: '2026-07-01' });
    const supersededHistory = doc({
      id: 'doc-superseded',
      state: 'superseded',
      validUntil: '2026-01-01',
    });
    apiGetMock.mockResolvedValue({ data: [staleActive, supersededHistory] });

    const { result } = renderContextDocuments();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const rows = result.current.data ?? [];
    // ContextLibrary renders the chip via isContextDocStale(doc) — with the
    // stale rows now present, the past-dated ACTIVE doc gets the chip while
    // superseded history (out of rotation) stays chip-free.
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(isContextDocStale(byId.get('doc-stale')!, '2026-07-24')).toBe(true);
    expect(isContextDocStale(byId.get('doc-superseded')!, '2026-07-24')).toBe(false);
  });
});
