import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickNote } from './index.js';

/**
 * Quick Note's "Client" target used to write into a per-client text blob
 * (`intakeData.profileNotes` via `POST /api/clients/:id/notes`) that no vNext
 * screen renders back. The client's Timeline tab (Portfolio → Timeline →
 * Notes) reads a separate, real activity feed (`/api/clients/:id/activity`,
 * the same one its own "Add a note" quick-add writes to) — these assert Quick
 * Note now posts there instead, so a note actually lands somewhere visible.
 */

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock }),
}));

const CLIENTS = [{ id: 'client-1', name: 'Acme Corp', status: 'active' }];

function renderQuickNote() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <QuickNote />
    </QueryClientProvider>,
  );
}

async function openAndSelectClient() {
  fireEvent.click(screen.getByRole('button', { name: 'Quick Note' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Select a client…' }));
  fireEvent.click(await screen.findByText('Acme Corp'));
}

describe('QuickNote', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    getMock.mockImplementation((url: string) => {
      if (url === '/api/clients') return Promise.resolve({ data: CLIENTS });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    postMock.mockResolvedValue({ data: { id: 'activity-1' } });
  });

  it('logs a short client note as a Timeline activity, not the old profile-notes endpoint', async () => {
    renderQuickNote();
    await openAndSelectClient();

    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Called about the FY27 ask.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log note' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/api/clients/client-1/activity', {
      kind: 'note',
      title: 'Called about the FY27 ask.',
    });
  });

  it('splits a note longer than the activity title cap into a truncated title plus the full body', async () => {
    renderQuickNote();
    await openAndSelectClient();

    const longNote = 'x'.repeat(340);
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: longNote } });
    fireEvent.click(screen.getByRole('button', { name: 'Log note' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [, body] = postMock.mock.calls[0]!;
    expect(body.kind).toBe('note');
    expect(body.title.length).toBe(300);
    expect(body.title.endsWith('…')).toBe(true);
    expect(body.body).toBe(longNote);
  });

  it('describes the real destination — the client\'s Timeline, under Notes', async () => {
    renderQuickNote();
    fireEvent.click(screen.getByRole('button', { name: 'Quick Note' }));

    expect(screen.getByText('Saved to the client profile → Timeline → Notes.')).toBeInTheDocument();
  });
});
