/**
 * F08 — delete-mutation cache invalidation for archived strategies.
 *
 * The 410 archive response is only useful if it actually fires after a
 * library delete: the delete mutation must drop the detail cache entry AND
 * refresh the list, so a stale editor tab/back-navigation cannot flash the
 * removed strategy's editable content before the 410 arrives.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDeleteStrategy } from './strategies-api.js';

const api = vi.hoisted(() => ({ delete: vi.fn() }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));

function harness() {
  const client = new QueryClient();
  // Seed both caches with a stale successful payload — the situation after a
  // user viewed the strategy in the editor and the library.
  client.setQueryData(['strategy', 'strategy', 'strategy-1'], {
    id: 'strategy-1',
    title: 'Deleted strategy',
    nodes: [],
  });
  client.setQueryData(
    ['strategy', 'strategies'],
    [{ id: 'strategy-1', title: 'Deleted strategy', nodeCount: 3 }],
  );
  const removeSpy = vi.spyOn(client, 'removeQueries');
  const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
  return {
    client,
    removeSpy,
    invalidateSpy,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

beforeEach(() => {
  api.delete.mockReset();
});

describe('useDeleteStrategy cache invalidation (F08)', () => {
  it('clears the detail cache and refreshes the list on success', async () => {
    api.delete.mockResolvedValue({
      data: { id: 'strategy-1', archivedAt: '2026-09-10T00:00:00.000Z' },
    });
    const { client, removeSpy, invalidateSpy, wrapper } = harness();
    const hook = renderHook(() => useDeleteStrategy(), { wrapper });

    await act(async () => {
      await hook.result.current.mutateAsync('strategy-1');
    });

    expect(api.delete).toHaveBeenCalledWith('/strategy-api/strategies/strategy-1');
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ['strategy', 'strategy', 'strategy-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['strategy', 'strategies'] });
    expect(client.getQueryData(['strategy', 'strategy', 'strategy-1'])).toBeUndefined();
  });

  it('keeps the stale detail cache when the server rejects the delete', async () => {
    api.delete.mockRejectedValue(new Error('Conflict'));
    const { client, wrapper } = harness();
    const hook = renderHook(() => useDeleteStrategy(), { wrapper });

    await act(async () => {
      await hook.result.current.mutateAsync('strategy-1').catch(() => undefined);
    });

    // A failed delete must not blank a still-active strategy from the editor.
    expect(client.getQueryData(['strategy', 'strategy', 'strategy-1'])).toBeDefined();
  });
});
