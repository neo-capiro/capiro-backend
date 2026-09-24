import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientBudgetWatches } from './ClientBudgetWatches.js';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
const endpoint = '/api/clients/client-1/defense-budget-watches';
const watch = { id: 'watch-1', targetType: 'pe', targetKey: '0603xx', clientReason: 'Track autonomy funding', events: [
  { id: 'update-1', eventType: 'material_update', materialReason: 'Markup increased by $4M', createdAt: '2026-09-24T12:00:00Z' },
] };
function renderPanel() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ClientBudgetWatches clientId="client-1" /></QueryClientProvider>);
}
beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockResolvedValue({ data: [watch] });
  api.post.mockResolvedValue({ data: {} });
});
describe('client defense budget watches', () => {
  it('shows client reason, material history and records an append decision', async () => {
    renderPanel();
    expect(await screen.findByText('Track autonomy funding')).toBeInTheDocument();
    expect(screen.getByText(/Markup increased by \$4M/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge update update-1' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${endpoint}/watch-1/updates/update-1/decision`, { decision: 'acknowledged' }));
  });
  it('creates a watch with explicit target and client reason', async () => {
    api.get.mockResolvedValue({ data: [] });
    renderPanel();
    fireEvent.change(await screen.findByLabelText('Target key'), { target: { value: '0603xx' } });
    fireEvent.change(screen.getByLabelText('Why this matters to the client'), { target: { value: 'Priority program' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add watch' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(endpoint, { targetType: 'program', targetKey: '0603xx', clientReason: 'Priority program' }));
  });
  it('offers a retry and the empty state', async () => {
    api.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: [] });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No defense budget watches/)).toBeInTheDocument();
  });
});
