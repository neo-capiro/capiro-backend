import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { useClientFacilities } from './use-client-facilities.js';

const get = vi.hoisted(() => vi.fn());
vi.mock('../../lib/use-api.js', () => ({ useApi: () => ({ get }) }));

test('a completed background geocode refreshes district and representation views after the editor has closed', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending = { id: 'f1', geocodeStatus: 'pending', latitude: null, longitude: null };
  get.mockResolvedValue({ data: [pending] });
  for (const key of [
    'client-representation',
    'client-district-nexus',
    'client-district-nexus-v2',
    'pf-district-nexus-v2',
  ]) {
    qc.setQueryData([key, 'c1'], { districts: [] });
    qc.setQueryData([key, 'other-client'], { districts: [] });
  }
  const { result } = renderHook(() => useClientFacilities('c1'), {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(result.current.data).toHaveLength(1));
  act(() =>
    qc.setQueryData(
      ['client-facilities', 'c1'],
      [
        {
          ...pending,
          geocodeStatus: 'matched',
          latitude: 30,
          longitude: -80,
          congressionalDistrict: '08',
        },
      ],
    ),
  );
  await waitFor(() =>
    expect(qc.getQueryState(['pf-district-nexus-v2', 'c1'])?.isInvalidated).toBe(true),
  );
  expect(qc.getQueryState(['client-representation', 'c1'])?.isInvalidated).toBe(true);
  expect(qc.getQueryState(['pf-district-nexus-v2', 'other-client'])?.isInvalidated).toBe(false);
});
