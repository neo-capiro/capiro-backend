/**
 * F06 (2026-09-10 remediation plan §4) — the New-strategy overlay's context
 * availability data source.
 *
 * The overlay used to derive "available context" by filtering the broad
 * 200-capped inventory list client-side — admitting strategy-scoped documents
 * of OTHER strategies and presenting a capped read as an authoritative
 * total. The hook under test consumes the server-backed availability
 * projection instead (GET /strategy-api/context/availability?clientId=…).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStrategyContextAvailability } from './strategies-api.js';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

const PROJECTION = {
  clientId: 'client-1',
  eligibleDocumentIds: ['d-1', 'd-2'],
  eligibleFactCount: 7,
  excluded: { strategyScoped: 1, nodeScoped: 0, stale: 2, retired: 1 },
  truncated: false,
};

beforeEach(() => {
  api.get.mockReset();
});

describe('useStrategyContextAvailability (F06)', () => {
  it('is disabled until a client is selected, then fetches the projection once', async () => {
    api.get.mockResolvedValue({ data: PROJECTION });
    const { wrapper } = harness();
    const hook = renderHook(() => useStrategyContextAvailability(null), { wrapper });
    expect(api.get).not.toHaveBeenCalled();

    hook.rerender();
    const hook2 = renderHook(() => useStrategyContextAvailability('client-1'), { wrapper });
    await waitFor(() => expect(hook2.result.current.data).toEqual(PROJECTION));
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/strategy-api/context/availability?clientId=client-1');
  });

  it('keys per client so switching clients cannot show the prior client\'s projection', async () => {
    api.get.mockImplementation(async (url: string) => ({
      data: {
        ...PROJECTION,
        clientId: url.includes('client-a') ? 'client-a' : 'client-b',
        eligibleDocumentIds: url.includes('client-a') ? ['a-doc'] : ['b-doc'],
      },
    }));
    const { wrapper } = harness();
    const a = renderHook(() => useStrategyContextAvailability('client-a'), { wrapper });
    await waitFor(() => expect(a.result.current.data?.eligibleDocumentIds).toEqual(['a-doc']));

    const b = renderHook(() => useStrategyContextAvailability('client-b'), { wrapper });
    await waitFor(() => expect(b.result.current.data?.eligibleDocumentIds).toEqual(['b-doc']));
    // The first client's cached entry is untouched — its own key still holds
    // its own projection (no cross-client bleed through a shared key).
    expect(a.result.current.data?.eligibleDocumentIds).toEqual(['a-doc']);
  });

  it('keeps loading, error and zero states distinct (never renders a fabricated 0)', async () => {
    const { wrapper } = harness();
    const idle = renderHook(() => useStrategyContextAvailability(null), { wrapper });
    expect(idle.result.current.data).toBeUndefined();
    expect(idle.result.current.isLoading).toBe(false);

    api.get.mockRejectedValue(new Error('boom'));
    const failed = renderHook(() => useStrategyContextAvailability('client-1'), { wrapper });
    await waitFor(() => expect(failed.result.current.isError).toBe(true));
    expect(failed.result.current.data).toBeUndefined();

    api.get.mockReset();
    api.get.mockResolvedValue({ data: { ...PROJECTION, eligibleDocumentIds: [], eligibleFactCount: 0 } });
    const empty = renderHook(() => useStrategyContextAvailability('client-1'), { wrapper });
    await waitFor(() => expect(empty.result.current.data?.eligibleDocumentIds).toEqual([]));
    expect(empty.result.current.isError).toBe(false);
    expect(empty.result.current.isLoading).toBe(false);
  });
});
