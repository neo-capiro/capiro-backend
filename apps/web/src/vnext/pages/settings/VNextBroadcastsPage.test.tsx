/**
 * Settings → Broadcasts console: pick a tenant, compose, choose recipients,
 * confirm, send. Exercises the exact payloads POSTed to
 * /api/capiro-admin/broadcasts for both audiences.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => apiMock }));

import { CapiroToastProvider } from '../../components/feedback/toast.js';
import { VNextBroadcastsPage } from './VNextBroadcastsPage.js';

const acme = { id: 't1', slug: 'acme', name: 'Acme Lobbying', status: 'active', _count: { memberships: 2 } };
const members = [
  { userId: 'u1', email: 'ana@acme.com', firstName: 'Ana', lastName: 'Diaz', role: 'user_admin', status: 'active' },
  { userId: 'u2', email: 'bo@acme.com', firstName: null, lastName: null, role: 'standard_user', status: 'invited' },
];
const sent = {
  id: 'b1',
  tenantId: 't1',
  title: 'Maintenance',
  body: 'Tonight',
  audience: 'all_users',
  createdAt: '2026-09-14T12:00:00Z',
  archivedAt: null,
  createdBy: { id: 's1', email: 'staff@capiro.ai', firstName: 'Neo', lastName: null },
  recipientCount: 2,
  acknowledgedCount: 1,
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CapiroToastProvider>
        <div className="capiro-vnext-root">
          <div className="settings-vnext">
            <VNextBroadcastsPage />
          </div>
        </div>
      </CapiroToastProvider>
    </QueryClientProvider>,
  );
}

async function pickAcme() {
  fireEvent.click(await screen.findByRole('button', { name: /Choose a tenant/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Acme Lobbying/ }));
  await screen.findByText('New broadcast');
}

describe('VNextBroadcastsPage', () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.get.mockImplementation(async (url: string) => {
      if (url === '/api/capiro-admin/tenants') return { data: [acme] };
      if (url === '/api/capiro-admin/broadcasts/tenant-members') return { data: members };
      if (url === '/api/capiro-admin/broadcasts') return { data: [sent] };
      throw new Error(`unexpected GET ${url}`);
    });
    apiMock.post.mockResolvedValue({ data: { ...sent, recipientCount: 2 } });
  });

  it('asks for a tenant first, then shows compose + sent history for it', async () => {
    renderPage();
    expect(await screen.findByText('Pick a tenant to get started')).toBeInTheDocument();
    await pickAcme();

    expect(apiMock.get).toHaveBeenCalledWith('/api/capiro-admin/broadcasts', {
      params: { tenantId: 't1' },
    });
    expect(await screen.findByText('Maintenance')).toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    expect(screen.getByText('Awaiting 1')).toBeInTheDocument();
  });

  it('validates before sending and posts an all_users broadcast after confirmation', async () => {
    renderPage();
    await pickAcme();

    fireEvent.click(screen.getByRole('button', { name: 'Send broadcast' }));
    expect(await screen.findByText('A title is required')).toBeInTheDocument();
    expect(screen.getByText('A message is required')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();

    // The inline error renders inside the field's <label>, so match by prefix.
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Scheduled maintenance' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Tonight 9pm ET' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send broadcast' }));

    const confirm = await screen.findByRole('dialog', { name: /Send to 2 users of Acme Lobbying\?/ });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send now' }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith('/api/capiro-admin/broadcasts', {
        tenantId: 't1',
        title: 'Scheduled maintenance',
        body: 'Tonight 9pm ET',
        audience: 'all_users',
      }),
    );
    expect(await screen.findByText('Broadcast sent to 2 users')).toBeInTheDocument();
  });

  it('sends only the checked members for a selected_users broadcast', async () => {
    renderPage();
    await pickAcme();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Hello Ana' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Just you' } });
    fireEvent.click(screen.getByRole('button', { name: 'Specific users' }));

    fireEvent.click(screen.getByRole('button', { name: 'Send broadcast' }));
    expect(await screen.findByText('Choose at least one user')).toBeInTheDocument();

    const list = screen.getByRole('group', { name: 'Choose recipients' });
    const boxes = within(list).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(within(list).getByText('Ana Diaz')).toBeInTheDocument();
    expect(within(list).getByText(/bo@acme.com/)).toBeInTheDocument();
    fireEvent.click(boxes[0]!);

    fireEvent.click(screen.getByRole('button', { name: 'Send broadcast' }));
    const confirm = await screen.findByRole('dialog', { name: /Send to 1 user of Acme Lobbying\?/ });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send now' }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith('/api/capiro-admin/broadcasts', {
        tenantId: 't1',
        title: 'Hello Ana',
        body: 'Just you',
        audience: 'selected_users',
        userIds: ['u1'],
      }),
    );
  });
});
