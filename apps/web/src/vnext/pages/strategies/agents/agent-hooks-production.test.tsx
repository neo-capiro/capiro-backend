import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useExecuteRun,
  useMissions,
  usePlanExecution,
  useResumeRun,
  useRetryRun,
  useTransitionRun,
} from '../strategies-api.js';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => api }));

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  return {
    client, invalidate,
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  };
}
beforeEach(() => { api.get.mockReset(); api.post.mockReset(); });

describe('Agent API wiring regressions', () => {
  it('loads missions for the chosen strategy only when requested', async () => {
    const { wrapper } = harness();
    api.get.mockResolvedValue({ data: [] });
    const hook = renderHook(() => useMissions('strategy-one', false), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
    await act(async () => { await hook.result.current.refetch(); });
    expect(api.get).toHaveBeenCalledWith('/strategy-api/agents/missions?strategyId=strategy-one');
  });

  it('posts a plan without executing it and refreshes both execution views', async () => {
    const { wrapper, invalidate } = harness();
    api.post.mockResolvedValue({ data: { id: 'run-one', state: 'ready_for_review' } });
    const hook = renderHook(() => usePlanExecution(), { wrapper });
    const input = { missionId: 'mission-one', strategyId: 'strategy-one', nodeId: 'node-one', kind: 'workspace' as const };
    await act(async () => { await hook.result.current.mutateAsync(input); });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/strategy-api/agents/execution/plan', input);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['strategy', 'execution-runs'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['strategy', 'agent-run'] });
  });

  it('records the review transition and invalidates the firm review obligation', async () => {
    const { wrapper, invalidate } = harness();
    api.post.mockResolvedValue({ data: { id: 'run-one', state: 'completed' } });
    const hook = renderHook(() => useTransitionRun(), { wrapper });
    await act(async () => { await hook.result.current.mutateAsync({ id: 'run-one', to: 'completed' }); });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/strategy-api/agents/runs/run-one/transition', { to: 'completed' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['strategy', 'firm-review-runs'] });
  });

  it('requests a fresh failed-run attempt through the existing execution retry endpoint', async () => {
    const { wrapper, invalidate } = harness();
    api.post.mockResolvedValue({ data: { id: 'run-two', state: 'ready_for_review' } });
    const hook = renderHook(() => useRetryRun(), { wrapper });
    await act(async () => { await hook.result.current.mutateAsync({ id: 'run-one' }); });
    expect(api.post).toHaveBeenCalledWith('/strategy-api/agents/execution/runs/run-one/retry');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['strategy', 'execution-runs'] });
  });

  // F03: a client timeout aborts the browser request while the server may already
  // have moved the run. onSuccess-only left Ready for review + Execute plan on
  // screen until a full reload — invalidate on settle so the list reconciles live.
  it('refreshes execution runs after a timed-out Execute plan (ambiguous client abort)', async () => {
    const { wrapper, invalidate } = harness();
    const timeout = Object.assign(new Error('timeout of 30000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    api.post.mockRejectedValue(timeout);
    const hook = renderHook(() => useExecuteRun(), { wrapper });
    await act(async () => {
      await hook.result.current.mutateAsync({ id: 'run-one' }).catch(() => undefined);
    });
    expect(api.post).toHaveBeenCalledWith('/strategy-api/agents/execution/runs/run-one/execute');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['strategy', 'execution-runs'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['strategy', 'run-policy'] });
  });

  it('refreshes execution runs after a timed-out Resume (ambiguous client abort)', async () => {
    const { wrapper, invalidate } = harness();
    const timeout = Object.assign(new Error('timeout of 30000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    api.post.mockRejectedValue(timeout);
    const hook = renderHook(() => useResumeRun(), { wrapper });
    await act(async () => {
      await hook.result.current.mutateAsync({ id: 'run-one' }).catch(() => undefined);
    });
    expect(api.post).toHaveBeenCalledWith(
      '/strategy-api/agents/execution/runs/run-one/resume',
      {},
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['strategy', 'execution-runs'] });
  });
});
