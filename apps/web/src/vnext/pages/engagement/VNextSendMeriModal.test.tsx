import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VNextSendMeriModal } from './VNextSendMeriModal.js';
import type { Meeting } from '../../../pages/engagement/meetings/meetings-types.js';

/**
 * `dispatch()` (notetaker.service.ts) throws a specific, actionable reason for
 * every gate it checks — tenant not enabled, unsupported join URL, a
 * notetaker already assigned, etc — but the dialog used to discard all of it
 * behind one generic "Could not send Meri. Try again.", regardless of why the
 * request actually failed. These assert the real backend reason now surfaces.
 */

const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ post: postMock }),
}));

function httpError(message: string) {
  return Object.assign(new Error('Request failed with status code 400'), {
    isAxiosError: true,
    response: { status: 400, data: { message } },
  });
}

const meeting: Meeting = {
  id: 'meeting-1',
  subject: 'Constantin + Jordan',
  source: 'outlook',
  description: null,
  location: null,
  startsAt: '2026-09-05T15:00:00.000Z',
  endsAt: '2026-09-05T15:30:00.000Z',
  organizerEmail: 'constantin@example.com',
  organizerName: 'Constantin',
  status: 'confirmed',
  metadata: null,
  isVirtual: true,
  joinLink: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc123',
  provider: 'teams',
  visibility: 'private',
  sharedAt: null,
  sharedByUserId: null,
  contributors: [],
  sharedBy: null,
  client: null,
  attendees: [],
  attachments: [],
  preps: [],
  notes: [],
  debriefs: [],
  notesApproved: false,
  meri: null,
};

function renderModal() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <VNextSendMeriModal meeting={meeting} open onClose={() => {}} />
    </QueryClientProvider>,
  );
}

async function checkBothConsentBoxesAndSend() {
  const checkboxes = screen.getAllByRole('checkbox');
  fireEvent.click(checkboxes[0]!);
  fireEvent.click(checkboxes[1]!);
  fireEvent.click(screen.getByRole('button', { name: /Send Meri/ }));
}

describe('VNextSendMeriModal', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('shows the backend\'s specific reason when the dispatch is rejected', async () => {
    postMock.mockRejectedValue(
      httpError('A notetaker is already assigned to this meeting'),
    );
    renderModal();

    await checkBothConsentBoxesAndSend();

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'A notetaker is already assigned to this meeting',
      ),
    );
    expect(screen.queryByText('Could not send Meri. Try again.')).not.toBeInTheDocument();
  });

  it('falls back to a generic message when the failure carries no backend reason', async () => {
    postMock.mockRejectedValue(new Error('Network Error'));
    renderModal();

    await checkBothConsentBoxesAndSend();

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not send Meri. Try again.'),
    );
  });
});
