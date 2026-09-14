import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientNotetakerAction } from './ClientNotetakerAction.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { NOTETAKER_CONSENT_COPY as consent } from '../../../pages/engagement/notetaker-consent-copy.js';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
const client = { id: 'c1', name: 'Acme' } as Client;
const url = '/api/engagement/clients/c1/notetaker';
function renderAction() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ClientNotetakerAction client={client} onDialogChange={() => {}} />
  </QueryClientProvider>);
}
beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockResolvedValue({ data: { enabled: false, stopping: false } });
  api.post.mockResolvedValue({ data: { enabled: true, stopping: false } });
  api.delete.mockResolvedValue({ data: { enabled: false, stopping: false } });
});
describe('client automatic notetaker', () => {
  it('uses the individual meeting consent and saves only after both affirmations', async () => {
    renderAction();
    const action = screen.getByRole('menuitem');
    await waitFor(() => expect(action).toBeEnabled());
    fireEvent.click(action);
    expect(screen.getByText(consent.intro)).toBeInTheDocument();
    const enable = screen.getByRole('button', { name: 'Enable automatic attendance' });
    expect(enable).toBeDisabled();
    fireEvent.click(screen.getByLabelText(consent.authorizedLabel));
    expect(enable).toBeDisabled();
    fireEvent.click(screen.getByLabelText(consent.notifiedLabel));
    fireEvent.click(enable);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(url, { authorizedToRecord: true, allPartiesWillBeNotified: true }));
    await waitFor(() => expect(screen.getByRole('menuitem')).toHaveTextContent('Turn off Meri for Meetings'));
  });
  it('does not save on cancel and clears consent when reopened', async () => {
    renderAction();
    await waitFor(() => expect(screen.getByRole('menuitem')).toBeEnabled());
    fireEvent.click(screen.getByRole('menuitem'));
    fireEvent.click(screen.getByLabelText(consent.authorizedLabel));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('menuitem'));
    expect(screen.getByLabelText(consent.authorizedLabel)).not.toBeChecked();
    expect(api.post).not.toHaveBeenCalled();
  });
  it('restores the saved setting and can turn it off', async () => {
    api.get.mockResolvedValue({ data: { enabled: true, stopping: false } });
    renderAction();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Turn off Meri/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(url));
    await waitFor(() => expect(screen.getByRole('menuitem')).toHaveTextContent('Send Meri to Meetings'));
  });
  it('keeps failed saves visible and does not claim attendance is on', async () => {
    api.post.mockRejectedValue(new Error('offline'));
    renderAction();
    await waitFor(() => expect(screen.getByRole('menuitem')).toBeEnabled());
    fireEvent.click(screen.getByRole('menuitem'));
    fireEvent.click(screen.getByLabelText(consent.authorizedLabel));
    fireEvent.click(screen.getByLabelText(consent.notifiedLabel));
    fireEvent.click(screen.getByRole('button', { name: 'Enable automatic attendance' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update');
    expect(screen.getByRole('menuitem')).toHaveTextContent('Send Meri to Meetings');
  });
});
