import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { FederalSpendingPageVNext } from './FederalSpendingPageVNext.js';

const get = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get }) }));
vi.mock('./FederalMarketDetailDrawerVNext.js', () => ({ FederalMarketDetailDrawerVNext: () => null }));

describe('federal market client scope', () => {
  it('removes the prior client’s rows and count immediately while the new client loads', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/api/clients') return Promise.resolve({ data: [
        { id: 'client-1', name: 'Anduril' }, { id: 'client-2', name: 'L3 Harris' },
      ] });
      if (url.includes('clientId=client-2')) return new Promise(() => {});
      return Promise.resolve({ data: {
        items: [{ id: 'award-1', awardId: 'EXAMPLE-1', recipientName: 'ANDURIL INDUSTRIES, INC.', recipientUei: null,
          awardingAgency: 'Department of Defense', amount: 94_000_000, description: null,
          actionDate: null, state: null, district: null, districtKey: null, source: 'usaspending', sourceUpdatedAt: null }],
        total: 3, page: 1, pageSize: 25, source: 'USAspending', asOf: null, generatedAt: '2026-09-09T00:00:00Z',
      } });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/intelligence/federal-spending?clientId=client-1']}>
          <FederalSpendingPageVNext />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('ANDURIL INDUSTRIES, INC.');
    expect(screen.getByText('3 records')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Client' }), { target: { value: 'client-2' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/federal-spending/market/contracts?clientId=client-2&page=1&pageSize=25'));
    expect(screen.queryByText('ANDURIL INDUSTRIES, INC.')).not.toBeInTheDocument();
    expect(screen.queryByText('3 records')).not.toBeInTheDocument();
    expect(screen.queryByText('No records match this view.')).not.toBeInTheDocument();
  });
});
