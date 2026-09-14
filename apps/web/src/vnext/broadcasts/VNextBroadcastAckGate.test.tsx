/**
 * The acknowledgement gate is a hard gate: it renders the oldest pending
 * broadcast in a dialog with no close affordance, ignores Escape, and only
 * advances (or unmounts) once POST …/acknowledge succeeds.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useMeMock = vi.hoisted(() => vi.fn());
const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/me.js', () => ({ useMe: useMeMock }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => apiMock }));

import { CapiroToastProvider } from '../components/feedback/toast.js';
import { VNextBroadcastAckGate } from './VNextBroadcastAckGate.js';

const b1 = { id: 'b1', title: 'Scheduled maintenance', body: 'Tonight 9pm ET', createdAt: '2026-09-14T12:00:00Z' };
const b2 = { id: 'b2', title: 'New Meri skills', body: 'Try them out', createdAt: '2026-09-14T13:00:00Z' };

function renderGate() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CapiroToastProvider>
        <div className="capiro-vnext-root">
          <VNextBroadcastAckGate />
        </div>
      </CapiroToastProvider>
    </QueryClientProvider>,
  );
}

describe('VNextBroadcastAckGate', () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    useMeMock.mockReturnValue({
      isLoading: false,
      data: {
        user: { id: 'u1' },
        tenant: { id: 't1', slug: 'acme', name: 'Acme' },
        role: 'standard_user',
        billingAdmin: false,
        features: {},
      },
    });
  });

  it('renders nothing while /me is unresolved and nothing when there are no pending broadcasts', async () => {
    useMeMock.mockReturnValue({ isLoading: true, data: undefined });
    const { unmount } = renderGate();
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    unmount();

    useMeMock.mockReturnValue({ isLoading: false, data: { user: { id: 'u1' }, role: 'standard_user' } });
    apiMock.get.mockResolvedValue({ data: [] });
    renderGate();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/api/me/broadcasts/pending'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the oldest pending broadcast, ignores Escape, and advances only after acknowledging', async () => {
    const responses = [[b1, b2], [b2], []];
    apiMock.get.mockImplementation(async () => ({ data: responses.shift() ?? [] }));
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    renderGate();

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: 'Scheduled maintenance' })).toBeInTheDocument();
    expect(screen.getByText('Tonight 9pm ET')).toBeInTheDocument();
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith('/api/me/broadcasts/b1/acknowledge'),
    );
    expect(await screen.findByRole('heading', { name: 'New Meri skills' })).toBeInTheDocument();
    expect(screen.queryByText(/1 of 2/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith('/api/me/broadcasts/b2/acknowledge'),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the dialog up and surfaces an error toast when acknowledging fails', async () => {
    apiMock.get.mockResolvedValue({ data: [b1] });
    apiMock.post.mockRejectedValue(new Error('Network down'));

    renderGate();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));

    expect(await screen.findByText('Network down')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
