import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

function renderHistory() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/clients']}>
        <Routes>
          <Route
            path="/clients"
            element={
              <>
                <ClientCrmHistoryProto client={client} />
                <LocationProbe />
              </>
            }
          />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
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

  it('opens "Open meeting" on the meeting\'s own date, not today\'s — the calendar used to ignore it entirely', async () => {
    getMock.mockResolvedValue({
      data: [
        {
          id: 'act-1',
          kind: 'meeting',
          // Noon UTC — stays the same local calendar day across every
          // realistic CI/test-runner timezone, so this assertion isn't
          // flaky next to the UTC-midnight boundary.
          occurredAt: '2026-08-13T12:00:00.000Z',
          title: 'Quarterly check-in',
          body: null,
          personId: null,
          sourceType: 'meeting',
          sourceId: 'meeting-42',
          pinned: false,
          dueAt: null,
          settledAt: null,
          origin: 'derived',
        },
      ],
    });
    renderHistory();

    const openButton = await screen.findByRole('button', { name: 'Open meeting' });
    fireEvent.click(openButton);

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/engagement/meetings/meeting-42?date=2026-08-13'),
    );
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
  /**
   * Row actions have to be scoped to `.rel-hist-row-action`: the filter chips
   * render synchronously with their own accessible names, so a bare role query
   * can resolve against a chip before the activity query settles. Waiting for
   * the row's own title first is the other half of that.
   */
  async function clickRowAction(name: string) {
    await screen.findByText('Follow-up scheduling');
    const action = screen
      .getAllByRole('button', { name })
      .find((element) => element.classList.contains('rel-hist-row-action'))!;
    fireEvent.click(action);
  }

  const CC_PLACEHOLDER = 'name@example.com, another@example.com';

  beforeEach(() => {
    mockGetByUrl({
      '/api/clients/client-1/activity': EMAIL_ACTIVITY,
      '/api/engagement/mail-threads/thread-1': THREAD_1,
      '/api/me/email-signature': { html: null, enabled: false },
    });
  });

  it('replies to the real other participants, never to your own connected mailbox', async () => {
    renderHistory();
    await clickRowAction('Reply');

    // "To" is the client contact who was actually on the message — not
    // jordan@capiro.ai, which is what the old "reply to the last sender"
    // logic would have produced here since jordan sent the last message.
    expect(await screen.findByText('Pat Client <client@example.com>')).toBeInTheDocument();
    expect(screen.queryByText(/jordan@capiro\.ai/)).not.toBeInTheDocument();
  });

  it('Reply copies nobody — that is what Reply all is for', async () => {
    renderHistory();
    await clickRowAction('Reply');
    await screen.findByText('Pat Client <client@example.com>');

    // The Cc row is not even opened, so the cc'd colleague on that message
    // cannot be mailed by accident. #1445 pre-filled this field on every
    // reply, with one control and no way to choose.
    expect(screen.queryByPlaceholderText(CC_PLACEHOLDER)).toBeNull();
    expect(screen.queryByText(/colleague@example\.com/)).not.toBeInTheDocument();
  });

  it("Reply all copies everyone else on the message, on an explicit second click", async () => {
    renderHistory();
    await clickRowAction('Reply all');

    expect(await screen.findByText('Pat Client <client@example.com>')).toBeInTheDocument();
    expect(await screen.findByPlaceholderText(CC_PLACEHOLDER)).toHaveValue('colleague@example.com');
    // And the widened audience is stated in words, not left as a populated
    // text box the user has to notice.
    expect(
      screen.getByText(/Reply all — 1 person is copied on this reply: colleague@example\.com/),
    ).toBeInTheDocument();
  });

  it('still excludes your own mailbox when the thread carries no connectionEmail', async () => {
    mockGetByUrl({
      '/api/clients/client-1/activity': EMAIL_ACTIVITY,
      '/api/engagement/mail-threads/thread-1': { ...THREAD_1, connectionEmail: null },
      // Longer key first: mockGetByUrl matches by prefix in insertion order,
      // so a '/api/me' entry placed above would swallow the signature request.
      '/api/me/email-signature': { html: null, enabled: false },
      // Mixed case and a trailing space, which the old single `.toLowerCase()`
      // equality would not have normalized away.
      '/api/me': { user: { email: 'Jordan@Capiro.ai ' } },
    });
    renderHistory();
    await clickRowAction('Reply');

    expect(await screen.findByText('Pat Client <client@example.com>')).toBeInTheDocument();
    expect(screen.queryByText(/jordan@capiro\.ai/i)).not.toBeInTheDocument();
  });

  it('says so inline when it cannot identify your own address, and still opens the window', async () => {
    mockGetByUrl({
      '/api/clients/client-1/activity': EMAIL_ACTIVITY,
      '/api/engagement/mail-threads/thread-1': { ...THREAD_1, connectionEmail: null },
      '/api/me/email-signature': { html: null, enabled: false },
      '/api/me': { user: { email: null } },
    });
    renderHistory();
    await clickRowAction('Reply');

    // Inline, not a toast: renderHistory mounts no CapiroToastProvider, so
    // useCapiroToast() falls back to a no-op and a toast would render nothing.
    expect(await screen.findByText(/check them before sending/i)).toBeInTheDocument();
    // The action still works — a warning, not a block.
    expect(screen.getByPlaceholderText('Subject')).toHaveValue('Re: Follow-up scheduling');
  });

  it('does not crash when a message\'s recipient Json is not an array', async () => {
    mockGetByUrl({
      '/api/clients/client-1/activity': EMAIL_ACTIVITY,
      '/api/engagement/mail-threads/thread-1': {
        ...THREAD_1,
        messages: [
          THREAD_1.messages[0]!,
          // Prisma `Json` columns: neither shape is an array, and an
          // unguarded for-of over them threw "is not iterable", which the
          // catch turned into "Could not open this email thread."
          { ...THREAD_1.messages[1]!, toRecipients: null, ccRecipients: { email: 'x@y.com' } },
        ],
      },
      '/api/me/email-signature': { html: null, enabled: false },
    });
    renderHistory();
    await clickRowAction('Reply');

    // The last message yields nothing usable (its sender is you, its recipient
    // Json is unreadable), so the scan falls back to the older message.
    expect(await screen.findByText('Pat Client <client@example.com>')).toBeInTheDocument();
  });

  it('finds someone to reply to when the last message has no other party', async () => {
    mockGetByUrl({
      '/api/clients/client-1/activity': EMAIL_ACTIVITY,
      '/api/engagement/mail-threads/thread-1': {
        ...THREAD_1,
        messages: [
          THREAD_1.messages[0]!,
          // A note you mailed to yourself: every address on it is yours.
          {
            ...THREAD_1.messages[1]!,
            toRecipients: [{ email: 'jordan@capiro.ai', name: 'Jordan Clayton' }],
            ccRecipients: [],
          },
        ],
      },
      '/api/me/email-signature': { html: null, enabled: false },
    });
    renderHistory();
    await clickRowAction('Reply');

    // #1445 read only the final message, emptied the pool, and opened no
    // compose window at all on a thread that plainly had someone to reply to.
    expect(await screen.findByText('Pat Client <client@example.com>')).toBeInTheDocument();
  });

  it("falls back to the thread's participants when no message yields another party", async () => {
    mockGetByUrl({
      '/api/clients/client-1/activity': EMAIL_ACTIVITY,
      '/api/engagement/mail-threads/thread-1': {
        ...THREAD_1,
        participants: [{ email: 'client@example.com', name: 'Pat Client', role: 'to' }],
        messages: [
          {
            ...THREAD_1.messages[1]!,
            toRecipients: [{ email: 'jordan@capiro.ai', name: 'Jordan Clayton' }],
            ccRecipients: [],
          },
        ],
      },
      '/api/me/email-signature': { html: null, enabled: false },
    });
    renderHistory();
    await clickRowAction('Reply');

    expect(await screen.findByText('Pat Client <client@example.com>')).toBeInTheDocument();
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
    const toggles = screen.getAllByRole('button', { name: 'Read more' });
    const firstToggle = toggles[0]!;
    const secondToggle = toggles[1]!;

    fireEvent.click(firstToggle);
    expect(await screen.findByText('Hi Jordan, thanks for the call today.')).toBeInTheDocument();

    fireEvent.click(secondToggle);
    expect(await screen.findByText('Here is the redlined contract for your review.')).toBeInTheDocument();
    // Expanding the second row closed the first.
    expect(screen.queryByText('Hi Jordan, thanks for the call today.')).not.toBeInTheDocument();
  });
});

/* ── Persistent first load — don't re-fetch on every tab revisit ─────────── */

describe('ClientCrmHistoryProto — persistent first load', () => {
  it('reuses the cached activity/email history on remount instead of re-fetching it', async () => {
    mockGetByUrl({ '/api/clients/client-1/activity': EMAIL_ACTIVITY });
    // One shared QueryClient across both mounts — matching the real app,
    // which has a single app-wide QueryClient, not a fresh one per tab visit.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderOnce = () =>
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/clients']}>
            <ClientCrmHistoryProto client={client} />
          </MemoryRouter>
        </QueryClientProvider>,
      );

    const { unmount } = renderOnce();
    await screen.findByText('Follow-up scheduling');
    // Scoped to the activity endpoint specifically — the component also
    // fires its own /api/me lookup on every render (see useMe() above),
    // so a bare getMock.toHaveBeenCalledTimes count would include that
    // unrelated call and isn't what this test is about.
    const activityCalls = () =>
      getMock.mock.calls.filter(([url]) => url === '/api/clients/client-1/activity').length;
    expect(activityCalls()).toBe(1);

    // Leaving the Relationships tab and coming back unmounts and remounts
    // this component; the query cache must survive that.
    unmount();
    renderOnce();

    await screen.findByText('Follow-up scheduling');
    // Still just the one network call — no fresh fetch on revisit.
    expect(activityCalls()).toBe(1);
  });

  it('fetches a mail thread again after it is genuinely evicted, not merely re-expanded', async () => {
    mockGetByUrl({
      '/api/clients/client-1/activity': EMAIL_ACTIVITY,
      '/api/engagement/mail-threads/thread-1': THREAD_1,
    });
    renderHistory();

    await screen.findByText('Follow-up scheduling');
    fireEvent.click(screen.getByRole('button', { name: 'Read more' }));
    await screen.findByText('Hi Jordan, thanks for the call today.');
    expect(getMock).toHaveBeenCalledWith('/api/engagement/mail-threads/thread-1');
    const callsAfterFirstExpand = getMock.mock.calls.length;

    // Collapse, then immediately re-expand — the thread's own query is still
    // fresh, so this must not issue a second network call for it.
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read more' }));
    await screen.findByText('Hi Jordan, thanks for the call today.');
    expect(getMock.mock.calls.length).toBe(callsAfterFirstExpand);
  });
});
