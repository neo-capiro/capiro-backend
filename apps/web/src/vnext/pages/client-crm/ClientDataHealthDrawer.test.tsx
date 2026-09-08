import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientDataHealthDrawer } from './ClientDataHealthDrawer.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: getMock }) }));

function renderHealth() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={queryClient}>
    <ClientDataHealthDrawer client={{ id: 'client-1', name: 'Example' } as Client} onClose={vi.fn()} />
  </QueryClientProvider>);
}

beforeEach(() => { getMock.mockReset(); });

describe('ClientDataHealthDrawer checked coverage', () => {
  it('waits for every checked section before claiming that the checked set answered', async () => {
    let finishKb!: (result: unknown) => void;
    getMock.mockImplementation((path: string) => path.endsWith('/status')
      ? new Promise((resolve) => { finishKb = resolve; })
      : Promise.resolve({ data: [] }));
    renderHealth();
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(6));
    expect(screen.queryByText(/All 6 checked profile sections answered/)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Checking/);
    finishKb({ data: { counts: { documents: 0 } } });
    expect(await screen.findByText('All 6 checked profile sections answered.')).toBeInTheDocument();
    expect(screen.getByText(/Intelligence feeds, opportunity matching, and upstream source freshness are not checked here/)).toBeInTheDocument();
    expect(screen.getAllByText(/Last read in this app:/)).toHaveLength(6);
    expect(screen.queryByText(/Every source behind this client answered/)).not.toBeInTheDocument();
  });

  it('reports a failed checked section as unknown instead of an empty profile gap', async () => {
    getMock.mockImplementation((path: string) => path.endsWith('/facilities')
      ? Promise.reject(new Error('Facilities unavailable'))
      : Promise.resolve({ data: [] }));
    renderHealth();
    expect(await screen.findByText('1 of 6 checked profile sections could not be read. Their record counts are unknown.')).toBeInTheDocument();
    expect(screen.getByText(/5 checked sections answered with nothing recorded yet/)).toBeInTheDocument();
    expect(screen.getByText('Facilities unavailable')).toBeInTheDocument();
    expect(screen.queryByText('All 6 checked profile sections answered.')).not.toBeInTheDocument();
  });
});
