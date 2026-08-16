import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmCapabilitiesProto } from './CapabilitiesTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock }),
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

function renderCapabilities(onFillWithMeri?: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ClientCrmCapabilitiesProto client={client} onFillWithMeri={onFillWithMeri} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
});

describe('ClientCrmCapabilitiesProto', () => {
  it('shows a real empty state instead of the design fixture when the client has no capabilities', async () => {
    getMock.mockResolvedValue({ data: [] });
    renderCapabilities();

    await waitFor(() => expect(screen.getByText('No capability areas recorded yet.')).toBeInTheDocument());
    // The CAP_AREAS fixture's designed cards must not leak through as if real.
    expect(screen.queryByText('Autonomous ground maneuver')).not.toBeInTheDocument();
  });

  it('calls the passed-down Fill with Meri handler when the tab button is clicked', async () => {
    getMock.mockResolvedValue({
      data: [{ id: 'cap-1', name: 'Autonomy stack', type: 'platform', tags: [], peNumbers: [] }],
    });
    const onFillWithMeri = vi.fn();
    renderCapabilities(onFillWithMeri);

    await screen.findByText('Autonomy stack');
    fireEvent.click(screen.getByRole('button', { name: 'Fill with Meri' }));

    expect(onFillWithMeri).toHaveBeenCalledTimes(1);
  });
});
