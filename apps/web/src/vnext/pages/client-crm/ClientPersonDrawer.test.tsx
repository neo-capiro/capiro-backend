/**
 * ClientPersonDrawer — the two fire-and-forget actions that used to void their
 * promises. A failed "Return to automatic placement" or "Remove contact" (e.g.
 * a 503) escaped as an uncaught page error with no visible feedback and the
 * record silently unchanged. Both now catch, render a retryable error, and
 * only close/dismiss on success.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientPersonDrawer } from './ClientPersonDrawer.js';
import type { ClientPerson } from '../../adapters/legacy/useClientOrganizationModel.js';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: getMock, post: vi.fn() }) }));

const person: ClientPerson = {
  id: 'person-1',
  clientId: 'client-1',
  name: 'QA Contact Error Controls',
  title: 'Leadership',
  email: null,
  phone: null,
  role: null,
  lastContact: null,
  notes: null,
  hierarchyLevel: 'leadership',
  reportsToPersonId: null,
  placementSource: 'manual',
  placementConfidence: null,
  reviewRequired: false,
  createdAt: '2026-09-15T00:00:00.000Z',
};

function renderDrawer(overrides: Partial<Parameters<typeof ClientPersonDrawer>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ClientPersonDrawer
          clientId="client-1"
          person={person}
          people={[person]}
          onClose={onClose}
          onSave={vi.fn().mockResolvedValue({})}
          {...overrides}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onClose };
}

beforeEach(() => {
  getMock.mockReset();
  getMock.mockResolvedValue({ data: [] });
});

describe('ClientPersonDrawer — fire-and-forget actions report failure', () => {
  it('failed "Return to automatic placement" reports an error and keeps the drawer open', async () => {
    const onPlace = vi.fn().mockRejectedValue(
      Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } }),
    );
    const { onClose } = renderDrawer({ onPlace });

    fireEvent.click(screen.getByRole('button', { name: 'Return to automatic placement' }));

    // The rejection is caught and shown — not an uncaught page error — and the
    // drawer does NOT close (the placement never happened).
    expect(await screen.findByRole('alert')).toHaveTextContent(/503|Could not|failed/i);
    expect(onClose).not.toHaveBeenCalled();

    // Retry once the server recovers: succeeds and closes.
    onPlace.mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole('button', { name: 'Return to automatic placement' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('failed "Remove contact" reports an error and keeps the record; success dismisses', async () => {
    const onDelete = vi.fn().mockRejectedValue(
      Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } }),
    );
    renderDrawer({ onDelete });

    // Open the confirm dialog via the drawer's quiet Remove action.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove contact' });
    // Confirm inside the dialog (the primary Remove).
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

    // Error visible in the dialog; dialog stays open for retry.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/503|Could not|failed/i);
    expect(screen.getByText('Remove contact')).toBeInTheDocument();

    // Retry succeeds -> dialog dismisses.
    onDelete.mockResolvedValueOnce({});
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Remove contact')).not.toBeInTheDocument());
  });
});
