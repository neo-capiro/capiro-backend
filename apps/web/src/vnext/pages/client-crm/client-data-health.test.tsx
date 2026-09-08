import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { dataHealthSources, useClientDataHealth } from './client-data-health.js';
import { relativeRefresh } from '../../adapters/legacy/useClientCrmOverviewModel.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import type { ReactNode } from 'react';

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: () => new Promise(() => {}) }) }));
const client = { id: 'client-1', name: 'Example' } as Client;

describe('profile section read time', () => {
  it('does not imply all sections were checked when only one has answered', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    queryClient.setQueryData(dataHealthSources(client.id)[0]!.queryKey, [], { updatedAt: Date.now() });
    const { result } = renderHook(() => useClientDataHealth(client), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });
    expect(result.current.settled).toBe(false);
    expect(result.current.refreshedLabel).toBeNull();
  });

  it('uses the oldest successful section read rather than the latest isolated response', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const oldestRead = Date.now() - 3_600_000;
    dataHealthSources(client.id).forEach((source, index) => {
      queryClient.setQueryData(source.queryKey, [], { updatedAt: index === 0 ? oldestRead : Date.now() });
    });
    const { result } = renderHook(() => useClientDataHealth(client), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });
    expect(result.current.refreshedLabel).toBe(relativeRefresh(oldestRead));
    expect(result.current.rows[0]!.fetchedAt).toBe(oldestRead);
  });
});
