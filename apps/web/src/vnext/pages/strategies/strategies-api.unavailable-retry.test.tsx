/**
 * F08 — terminal-status retry policy for the strategy detail query.
 *
 * The editor's manual Retry control is only half the fix: react-query's own
 * automatic retry must also stop for terminal responses. The app-level
 * QueryClient default is `retry: 1` (apps/web/src/main.tsx) — without a
 * status-aware override, a deleted strategy re-fires its doomed GET on every
 * window refocus.
 *
 * This suite runs the REAL `useStrategy` hook (only `useApi` is mocked) and
 * asserts the retry classification via the number of GETs actually fired.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStrategy } from './strategies-api.js';

const api = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), {
    response: { status, data: { statusCode: status, message } },
  });
}

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

beforeEach(() => {
  api.get.mockReset();
});

describe('useStrategy retry classification (F08)', () => {
  it('does NOT auto-retry a 410 Gone (deleted strategy)', async () => {
    api.get.mockRejectedValue(httpError(410, 'This strategy is archived'));
    const { wrapper } = harness();
    const hook = renderHook(() => useStrategy('strategy-1'), { wrapper });

    await waitFor(() => expect(hook.result.current.isError).toBe(true), { timeout: 5000 });
    // One call only: react-query must not have re-fired the doomed GET.
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-retry a 404 Not Found', async () => {
    api.get.mockRejectedValue(httpError(404, 'Strategy not found'));
    const { wrapper } = harness();
    const hook = renderHook(() => useStrategy('strategy-1'), { wrapper });

    await waitFor(() => expect(hook.result.current.isError).toBe(true), { timeout: 5000 });
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-retry a 403 Forbidden', async () => {
    api.get.mockRejectedValue(httpError(403, 'Forbidden'));
    const { wrapper } = harness();
    const hook = renderHook(() => useStrategy('strategy-1'), { wrapper });

    await waitFor(() => expect(hook.result.current.isError).toBe(true), { timeout: 5000 });
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('DOES auto-retry a transient 500 exactly once under the app default', async () => {
    api.get.mockRejectedValue(httpError(500, 'Internal server error'));
    const { wrapper } = harness();
    const hook = renderHook(() => useStrategy('strategy-1'), { wrapper });

    await waitFor(() => expect(hook.result.current.isError).toBe(true), { timeout: 8000 });
    // The app default `retry: 1` means exactly one automatic retry: two GETs
    // total before the error state surfaces.
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('a 401 does not enter the strategy error retry loop', async () => {
    api.get.mockRejectedValue(httpError(401, 'Unauthorized'));
    const { wrapper } = harness();
    const hook = renderHook(() => useStrategy('strategy-1'), { wrapper });

    await waitFor(() => expect(hook.result.current.isError).toBe(true), { timeout: 5000 });
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('a network failure (no HTTP response) retries once, then surfaces the error', async () => {
    api.get.mockRejectedValue(new Error('Network Error'));
    const { wrapper } = harness();
    const hook = renderHook(() => useStrategy('strategy-1'), { wrapper });

    await waitFor(() => expect(hook.result.current.isError).toBe(true), { timeout: 8000 });
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});