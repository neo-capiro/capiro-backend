import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ClientCrmHistoryProto } from './RelationshipsHistoryTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

const getMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: vi.fn(), patch: patchMock }),
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
  patchMock.mockReset();
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

/* ── Removed affordances: Export, Calls and Documents filters ─────────────── */

const ACTIVITY = [
  {
    id: 'act-1',
    kind: 'call',
    occurredAt: '2026-08-04T15:30:00.000Z',
    // Deliberately absent from portfolio-fixtures.ts, so the assertions cannot
    // pass against the TIMELINE fixture.
    title: 'Quarterly check-in with program office',
    body: 'Discussed FY27 timing, budget posture, and the "next" steps',
    personId: null,
    sourceType: null,
    sourceId: null,
    pinned: true,
    dueAt: null,
    settledAt: null,
    origin: 'recorded',
  },
  {
    id: 'act-2',
    kind: 'meeting',
    occurredAt: '2026-07-30T13:00:00.000Z',
    title: 'Site visit debrief',
    body: null,
    personId: null,
    sourceType: 'meeting',
    sourceId: 'meet-9',
    pinned: false,
    dueAt: null,
    settledAt: null,
    origin: 'derived',
  },
];

describe('ClientCrmHistoryProto — removed affordances', () => {
  it('no longer offers a timeline Export button', async () => {
    getMock.mockResolvedValue({ data: ACTIVITY });
    renderHistory();

    await screen.findByText('Quarterly check-in with program office');
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
  });

  it('no longer offers Calls or Documents filter chips', async () => {
    getMock.mockResolvedValue({ data: ACTIVITY });
    renderHistory();

    await screen.findByText('Quarterly check-in with program office');
    expect(screen.queryByRole('button', { name: 'Calls' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Documents' })).not.toBeInTheDocument();
    // The surviving chips still filter.
    for (const label of ['All', 'Meetings', 'Email', 'Notes', 'Outreach']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('still lists a logged call under All — only the chip went away', async () => {
    getMock.mockResolvedValue({ data: ACTIVITY });
    renderHistory();

    // The row itself keeps its real group and eyebrow label.
    expect(await screen.findByText('Quarterly check-in with program office')).toBeInTheDocument();
    expect(screen.getByText('Client call')).toBeInTheDocument();
  });
});

/* ── Open commitments rail (item 8, wire-audit "3 Compose extend") ────────── */

const COMMITMENTS = [
  {
    id: 'act-due',
    kind: 'commitment',
    occurredAt: '2026-08-01T12:00:00.000Z',
    // Absent from portfolio-fixtures.ts, so these cannot pass against OV_ATTN.
    title: 'Send the revised cost narrative',
    body: null,
    personId: null,
    sourceType: null,
    sourceId: null,
    pinned: false,
    dueAt: '2026-08-30T12:00:00.000Z',
    settledAt: null,
    origin: 'recorded',
  },
  {
    id: 'act-undated',
    kind: 'commitment',
    occurredAt: '2026-08-02T12:00:00.000Z',
    title: 'Introduce the team to committee staff',
    body: null,
    personId: null,
    sourceType: null,
    sourceId: null,
    pinned: false,
    dueAt: null,
    settledAt: null,
    origin: 'recorded',
  },
  {
    id: 'act-settled',
    kind: 'commitment',
    occurredAt: '2026-07-01T12:00:00.000Z',
    title: 'Already handled commitment',
    body: null,
    personId: null,
    sourceType: null,
    sourceId: null,
    pinned: false,
    dueAt: '2026-07-30T12:00:00.000Z',
    settledAt: '2026-07-29T12:00:00.000Z',
    origin: 'recorded',
  },
];

/** The rail lives inside the "Relationship controls" sub-section of the
 *  combined "Account relationship timeline" card; the same activity also
 *  appears in the timeline column, so every rail assertion is scoped to the
 *  rail's own container — the <aside> landmark, not the whole card. */
async function railCard() {
  const heading = await screen.findByText('Relationship controls');
  const card = heading.closest('aside');
  if (!card) throw new Error('Relationship controls rail not found');
  return within(card);
}

describe('ClientCrmHistoryProto — consolidated timeline + controls card', () => {
  it('renders "Account relationship timeline" and "Relationship controls" inside one card', async () => {
    getMock.mockResolvedValue({ data: ACTIVITY });
    renderHistory();

    await screen.findByText('Quarterly check-in with program office');
    const timelineHeading = screen.getByRole('heading', { name: 'Account relationship timeline' });
    const card = timelineHeading.closest('section');
    if (!card) throw new Error('Account relationship timeline card not found');
    // "Relationship controls" is a sub-section INSIDE this card, not its own
    // Card — the old duplicate two-card layout is gone.
    expect(within(card).getByText('Relationship controls')).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { name: 'Account relationship timeline' })).toHaveLength(1);
  });
});

describe('ClientCrmHistoryProto — open commitments rail', () => {
  it('lists real open commitments, including one with no due date, and drops settled ones', async () => {
    getMock.mockResolvedValue({ data: COMMITMENTS });
    renderHistory();

    const rail = await railCard();
    await waitFor(() => expect(rail.getByText('Send the revised cost narrative')).toBeInTheDocument());
    // An undated commitment is still outstanding — it just has no date to show.
    expect(rail.getByText('Introduce the team to committee staff')).toBeInTheDocument();
    expect(rail.getByText('No due date')).toBeInTheDocument();
    // Settled means off the rail.
    expect(rail.queryByText('Already handled commitment')).not.toBeInTheDocument();
    // The OV_ATTN fixture rows this rail used to borrow must not leak through.
    expect(screen.queryByText('Client requested an Army procurement assessment')).not.toBeInTheDocument();
    expect(screen.queryByText('Conference restoration memo has no source pack')).not.toBeInTheDocument();
  });

  it('settles a commitment through the real activity endpoint', async () => {
    getMock.mockResolvedValue({ data: COMMITMENTS });
    patchMock.mockResolvedValue({ data: { id: 'act-due' } });
    renderHistory();

    fireEvent.click(await screen.findByRole('button', { name: 'Settle Send the revised cost narrative' }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-1/activity/act-due', { settled: true }),
    );
  });

  it('offers no Settle on an undated commitment — the API refuses those', async () => {
    getMock.mockResolvedValue({ data: COMMITMENTS });
    renderHistory();

    // Wait for the rail to be real before asserting an absence.
    await screen.findByRole('button', { name: 'Settle Send the revised cost narrative' });
    expect(
      screen.queryByRole('button', { name: 'Settle Introduce the team to committee staff' }),
    ).not.toBeInTheDocument();
  });

  it('shows a real empty rail once activity resolves to nothing, not the fixture', async () => {
    getMock.mockResolvedValue({ data: [] });
    renderHistory();

    await waitFor(() => expect(screen.getByText('Nothing outstanding.')).toBeInTheDocument());
    // And the invented "pinned note" sentence is gone once we know there is none.
    expect(screen.getByText(/No pinned note yet/)).toBeInTheDocument();
    expect(
      screen.queryByText('Client prefers concise written updates before live strategy discussions.'),
    ).not.toBeInTheDocument();
  });

  it('keeps the fixture rail while the fetch is still in flight', () => {
    getMock.mockImplementation(() => new Promise(() => {})); // never resolves
    renderHistory();

    expect(screen.queryByText('Nothing outstanding.')).not.toBeInTheDocument();
  });
});

/* ── Email reply: real participants, never yourself ────────────────────── */

const EMAIL_ACTIVITY = [
  {
    id: 'act-email-1',
    kind: 'email',
    occurredAt: '2026-08-10T10:00:00.000Z',
    title: 'Follow-up scheduling',
    body: 'Thanks for the note — sending revised numbers shortly.',
    personId: null,
    sourceType: 'mail_thread',
    sourceId: 'thread-1',
    pinned: false,
    dueAt: null,
    settledAt: null,
    origin: 'derived',
  },
];

// The most recent message on this thread was sent by "me" (jordan@capiro.ai)
// — the exact shape that used to make "reply" address the email back to
// yourself, since the old code always replied to the last message's sender
// with no notion of which address was your own.
const THREAD_1 = {
  id: 'thread-1',
  clientId: 'client-1',
  subject: 'Follow-up scheduling',
  snippet: 'Thanks for the note — sending revised numbers shortly.',
  participants: [],
  lastMessageAt: '2026-08-10T10:00:00.000Z',
  connectionEmail: 'jordan@capiro.ai',
  messages: [
    {
      id: 'msg-1',
      threadId: 'thread-1',
      fromEmail: 'client@example.com',
      fromName: 'Pat Client',
      toRecipients: [{ email: 'jordan@capiro.ai', name: 'Jordan Clayton' }],
      ccRecipients: [],
      subject: 'Follow-up scheduling',
      bodyText: 'Hi Jordan, thanks for the call today.',
      sentAt: '2026-08-09T10:00:00.000Z',
      receivedAt: '2026-08-09T10:00:00.000Z',
      createdAt: '2026-08-09T10:00:00.000Z',
    },
    {
      id: 'msg-2',
      threadId: 'thread-1',
      fromEmail: 'jordan@capiro.ai',
      fromName: 'Jordan Clayton',
      toRecipients: [{ email: 'client@example.com', name: 'Pat Client' }],
      ccRecipients: [{ email: 'colleague@example.com', name: 'Alex Colleague' }],
      subject: 'Follow-up scheduling',
      bodyText: 'Thanks for the note — sending revised numbers shortly.',
      sentAt: '2026-08-10T10:00:00.000Z',
      receivedAt: null,
      createdAt: '2026-08-10T10:00:00.000Z',
    },
  ],
};

function mockGetByUrl(routes: Record<string, unknown>) {
  getMock.mockImplementation((url: string) => {
    for (const [prefix, data] of Object.entries(routes)) {
      if (url === prefix || url.startsWith(prefix)) return Promise.resolve({ data });
    }
    return Promise.resolve({ data: null });
  });
}

describe('ClientCrmHistoryProto — email reply pre-fill', () => {
  it('replies to the real other participants, never to your own connected mailbox', async () => {
    mockGetByUrl({
      '/api/clients/client-1/activity': EMAIL_ACTIVITY,
      '/api/engagement/mail-threads/thread-1': THREAD_1,
      '/api/me/email-signature': { html: null, enabled: false },
    });
    renderHistory();

    fireEvent.click(await screen.findByRole('button', { name: 'Email' }));

    // "To" is the client contact who was actually on the message — not
    // jordan@capiro.ai, which is what the old "reply to the last sender"
    // logic would have produced here since jordan sent the last message.
    expect(await screen.findByText('Pat Client <client@example.com>')).toBeInTheDocument();
    expect(screen.queryByText(/jordan@capiro\.ai/)).not.toBeInTheDocument();

    // Everyone else on that message (here, the cc'd colleague) is pulled in
    // automatically rather than being dropped.
    const ccInput = await screen.findByPlaceholderText('name@example.com, another@example.com');
    expect(ccInput).toHaveValue('colleague@example.com');
  });
});

/* ── Expand to read the full message, one at a time ───────────────────── */

const TWO_EMAIL_ACTIVITY = [
  EMAIL_ACTIVITY[0],
  {
    id: 'act-email-2',
    kind: 'email',
    occurredAt: '2026-08-05T10:00:00.000Z',
    title: 'Contract review',
    body: 'Sending the redline for your review.',
    personId: null,
    sourceType: 'mail_thread',
    sourceId: 'thread-2',
    pinned: false,
    dueAt: null,
    settledAt: null,
    origin: 'derived',
  },
];

const THREAD_2 = {
  ...THREAD_1,
  id: 'thread-2',
  subject: 'Contract review',
  messages: [
    {
      ...THREAD_1.messages[0],
      id: 'msg-3',
      threadId: 'thread-2',
      bodyText: 'Here is the redlined contract for your review.',
    },
  ],
};

describe('ClientCrmHistoryProto — expand to read the full message', () => {
  it('expands an email row to show the full message, hidden until asked for', async () => {
    mockGetByUrl({
      '/api/clients/client-1/activity': EMAIL_ACTIVITY,
      '/api/engagement/mail-threads/thread-1': THREAD_1,
    });
    renderHistory();

    await screen.findByText('Follow-up scheduling');
    // The full first message isn't fetched or shown until expanded.
    expect(screen.queryByText('Hi Jordan, thanks for the call today.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Read more' }));
    expect(await screen.findByText('Hi Jordan, thanks for the call today.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText('Hi Jordan, thanks for the call today.')).not.toBeInTheDocument();
  });

  it('closes the open row when a different one is expanded — only one open at a time', async () => {
    mockGetByUrl({
      '/api/clients/client-1/activity': TWO_EMAIL_ACTIVITY,
      '/api/engagement/mail-threads/thread-1': THREAD_1,
      '/api/engagement/mail-threads/thread-2': THREAD_2,
    });
    renderHistory();

    await screen.findByText('Follow-up scheduling');
    const [firstToggle, secondToggle] = screen.getAllByRole('button', { name: 'Read more' });

    fireEvent.click(firstToggle);
    expect(await screen.findByText('Hi Jordan, thanks for the call today.')).toBeInTheDocument();

    fireEvent.click(secondToggle);
    expect(await screen.findByText('Here is the redlined contract for your review.')).toBeInTheDocument();
    // Expanding the second row closed the first.
    expect(screen.queryByText('Hi Jordan, thanks for the call today.')).not.toBeInTheDocument();
  });
});
