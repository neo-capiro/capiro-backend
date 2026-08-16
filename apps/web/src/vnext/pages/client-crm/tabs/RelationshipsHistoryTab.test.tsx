import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ClientCrmHistoryProto } from './RelationshipsHistoryTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: vi.fn(), patch: vi.fn() }),
}));

const client: Client = {
  id: 'client-1',
  name: 'Overland AI',
  website: 'overland.ai',
  description: null,
  productDescription: null,
  primaryContactName: null,
  primaryContactEmail: null,
  primaryContactPhone: null,
  logoS3Key: null,
  logoContentType: null,
  logoUploadedAt: null,
  intakeData: null,
  status: 'active',
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
};

function renderHistory() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ClientCrmHistoryProto client={client} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
});

describe('ClientCrmHistoryProto', () => {
  it('shows a real empty state instead of the TIMELINE fixture when the client has no activity', async () => {
    getMock.mockResolvedValue({ data: [] });
    renderHistory();

    await waitFor(() =>
      expect(screen.getByText('No activity recorded for this client yet.')).toBeInTheDocument(),
    );
    // A TIMELINE fixture title must not leak through as if real.
    expect(screen.queryByText('Overland AI Strategy Review')).not.toBeInTheDocument();
  });
});
