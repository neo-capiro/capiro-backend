import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientProfileShell } from './ClientProfileShell.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

const getMock = vi.hoisted(() => vi.fn());
const putMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, put: putMock }),
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

const sarah = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'sarah@example.com',
  firstName: 'Sarah',
  lastName: 'Martinez',
};
const jordan = {
  id: '22222222-2222-2222-2222-222222222222',
  email: 'jordan@example.com',
  firstName: 'Jordan',
  lastName: 'Clayton',
};

function renderShell(canAssign = true) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ClientProfileShell
          client={client}
          tab="overview"
          view={null}
          onNavigate={vi.fn()}
          onFillWithMeri={vi.fn()}
          onDataHealth={vi.fn()}
          canEditFocus={canAssign}
        >
          <div>body</div>
        </ClientProfileShell>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  putMock.mockReset();
  getMock.mockImplementation((url: string) => {
    if (url.endsWith('/options')) return Promise.resolve({ data: [sarah, jordan] });
    if (url.endsWith('/client-1')) {
      return Promise.resolve({
        data: { accountOwnerUserId: sarah.id, accountOwner: sarah },
      });
    }
    return Promise.reject(new Error(`unexpected get ${url}`));
  });
  putMock.mockResolvedValue({
    data: { accountOwnerUserId: jordan.id, accountOwner: jordan },
  });
});

describe('ClientProfileShell account owner', () => {
  it('shows the persisted owner and lets a user_admin assign another active tenant member', async () => {
    renderShell(true);

    const select = await screen.findByRole('combobox', { name: 'Account owner' });
    await waitFor(() => expect(select).toHaveValue(sarah.id));

    fireEvent.change(select, { target: { value: jordan.id } });

    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith('/api/client-account-owners/client-1', {
        accountOwnerUserId: jordan.id,
      }),
    );
    await waitFor(() => expect(select).toHaveValue(jordan.id));
  });

  it('renders the persisted owner read-only when assignment is not allowed', async () => {
    renderShell(false);

    expect(await screen.findByText('Sarah Martinez')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Account owner' })).not.toBeInTheDocument();
  });
});
