import { describe, expect, test, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PipelineBoardView } from '../../pages/funding-opportunities/funding-opportunities-domain.js';
import {
  freshnessLabel,
  pursuingCount,
  useClientFundingOpportunitiesV2,
} from './useClientFundingOpportunitiesV2.js';
import { refreshOpportunityQueries } from '../../pages/funding-opportunities/opportunity-query-cache.js';
import { sourceLabel } from './useClientFundingOpportunitiesV2.js';
import { createReferenceFixtureApi } from '../../testing/visual/funding-opportunities-v2-fixture-api.js';

const hookMocks = vi.hoisted(() => ({ api: vi.fn(), flags: {} as Record<string, boolean> }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => hookMocks.api() }));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (key: string) => ({ ready: true, enabled: hookMocks.flags[key] === true }),
}));

const board = (inPipeline: number, pursuing: number): PipelineBoardView => ({
  clientId: 'client-1',
  counts: {
    stages: [
      { stage: 'reviewing', count: inPipeline - pursuing },
      { stage: 'pursuing', count: pursuing },
    ],
    unstaged: { suggested: 0, expired: 0, other: 0 },
    total: inPipeline,
    derivedFromWorkflowStatus: 0,
  },
  cards: [],
  cardsTruncated: false,
  summary: {
    inPipeline,
    deadlinesInside30Days: null,
    unassigned: null,
    awaitingAward: null,
    lastStageChange: null,
  },
});

describe('canonical client funding mapper', () => {
  test.each([
    [{ funding_opportunities_pipeline_v2: true }, true],
    [{ funding_opportunities_pipeline: true }, false],
    [{}, false],
  ] as const)(
    'requests the board only for the current enabled feature flag (%j)',
    async (flags, enabled) => {
      hookMocks.flags = { funding_opportunities: true, ...flags };
      const api = createReferenceFixtureApi();
      const get = vi.spyOn(api, 'get');
      hookMocks.api.mockReturnValue(api);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children);
      const view = renderHook(() => useClientFundingOpportunitiesV2('overland'), { wrapper });
      await waitFor(() => expect(view.result.current.search.isSuccess).toBe(true));
      if (enabled) await waitFor(() => expect(view.result.current.pipeline.isSuccess).toBe(true));
      const requests = get.mock.calls.filter(
        ([url]) => url === '/api/intelligence/clients/overland/pipeline',
      );
      expect(requests).toHaveLength(enabled ? 1 : 0);
      if (!enabled) expect(view.result.current.pipeline.data).toBeUndefined();
      view.unmount();
      client.clear();
    },
  );

  test('uses the pursuing stage count, not inPipeline aggregate, including zero', () => {
    expect(pursuingCount(board(13, 3))).toBe(3);
    expect(pursuingCount(board(13, 0))).toBe(0);
  });

  test('uses shared source presentation labels', () => {
    expect(sourceLabel('dibbs')).toBe('DLA bid board');
    expect(sourceLabel('sbir_sttr')).toBe('SBIR / STTR');
  });

  test('does not call partial or unknown freshness current', () => {
    const common = {
      source: 'grants_gov' as const,
      recordCount: 3,
      activeRecordCount: 2,
      lastSyncedAt: '2026-09-24',
      latestAttemptAt: '2026-09-24',
      lastSuccessAt: null,
    };
    expect(freshnessLabel({ ...common, state: 'initial_partial' })).toMatch(/partial/);
    expect(freshnessLabel({ ...common, state: 'unknown' })).toMatch(/unknown/);
    expect(freshnessLabel({ ...common, state: 'error_cached' })).toMatch(/degraded/);
    expect(freshnessLabel({ ...common, state: 'not_enabled' })).toMatch(/not enabled/);
  });

  test('refresh invalidates canonical search and pipeline caches', async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    await refreshOpportunityQueries({ invalidateQueries } as never, 'client-1');
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['funding-opportunities-v2'] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['funding-opportunity-pipeline'] });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['funding-opportunity-pipeline', 'client-1'],
    });
  });
});
