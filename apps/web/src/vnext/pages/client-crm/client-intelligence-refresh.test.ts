import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { refreshClientFootprint } from './client-intelligence-refresh.js';

function apiWithResponses(responses: Record<string, unknown>): AxiosInstance {
  return {
    get: vi.fn(async (url: string) => {
      if (!(url in responses)) throw new Error(`unexpected GET ${url}`);
      const value = responses[url];
      if (value instanceof Error) throw value;
      return { data: value };
    }),
  } as unknown as AxiosInstance;
}

describe('refreshClientFootprint', () => {
  it('actively re-reads District Nexus v2 and includes it in the reported source count', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = apiWithResponses({
      '/api/intelligence/clients/client-1/district-nexus-v2': { clientId: 'client-1' },
      '/api/intelligence/clients/client-1/fec-money-flow': [],
      '/api/intelligence/clients/client-1/lda-filings': [],
    });

    await expect(refreshClientFootprint(qc, api, 'client-1')).resolves.toEqual({
      total: 3,
      failures: 0,
    });
    expect(api.get).toHaveBeenCalledWith('/api/intelligence/clients/client-1/district-nexus-v2');
    expect(qc.getQueryData(['pf-district-nexus-v2', 'client-1'])).toEqual({ clientId: 'client-1' });
  });

  it('reports a v2 refresh failure instead of hiding it behind cache invalidation', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = apiWithResponses({
      '/api/intelligence/clients/client-1/district-nexus-v2': new Error('v2 unavailable'),
      '/api/intelligence/clients/client-1/fec-money-flow': [],
      '/api/intelligence/clients/client-1/lda-filings': [],
    });

    await expect(refreshClientFootprint(qc, api, 'client-1')).resolves.toEqual({
      total: 3,
      failures: 1,
    });
  });
});
