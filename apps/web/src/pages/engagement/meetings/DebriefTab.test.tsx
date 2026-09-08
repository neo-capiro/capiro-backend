// QA gap coverage, same rationale as NotesTab.test.tsx's own header comment:
// DebriefTab is ALWAYS mocked wholesale in MeetingDetailPanel.test.tsx (repo
// convention), so it had no direct test file of its own. Written for the
// meeting-drawer navy reskin phase, which added the top-of-tab stage pill,
// the closing rule-reinforcement sentence, a real "restricted" panel (was a
// plain text line), and interactive (session-local) action-item checkboxes —
// real, new behavior that deserves real coverage against the actual
// component, not just via a mock.
import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { DebriefTab } from './DebriefTab.js';
import type { Meeting, MeetingDebrief } from './meetings-types.js';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPatchMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: apiPostMock,
    put: vi.fn(),
    patch: apiPatchMock,
    delete: vi.fn(),
  }),
}));

/** Routes the shared apiGetMock by URL — DebriefTab always fires BOTH
 *  useMeetingDebriefs (/debriefs) and useMeetingNotes (/notes) on mount, so a
 *  single blanket mockResolvedValue can't give each its own fixture. */
function mockGetResponses(responses: { debriefs?: MeetingDebrief[]; notes?: unknown[] }) {
  apiGetMock.mockImplementation((url: string) => {
    if (url.includes('/debriefs')) return Promise.resolve({ data: responses.debriefs ?? [] });
    if (url.includes('/notes')) return Promise.resolve({ data: responses.notes ?? [] });
    return Promise.resolve({ data: [] });
  });
}

function makeDebrief(overrides: Partial<MeetingDebrief> = {}): MeetingDebrief {
  return {
    id: 'd1',
    confidential: true,
    status: 'generated',
    sharedAt: null,
    sharedByUserId: null,
    authorUserId: null,
    author: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    body: 'Recap\nDiscussed the FY27 markup schedule.\n\nAction Items\n- Send the follow-up memo\n- Schedule the staffer call\n\nNotes\nStaffer flagged a scheduling conflict.',
    restricted: false,
    ...overrides,
  };
}

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1',
    subject: 'Budget sync',
    source: 'outlook',
    description: null,
    location: null,
    // Ended in the past by default, so most fixtures land unlocked without
    // each test having to restate it.
    startsAt: '2020-01-01T14:00:00.000Z',
    endsAt: '2020-01-01T14:30:00.000Z',
    organizerEmail: null,
    organizerName: null,
    status: 'confirmed',
    metadata: null,
    isVirtual: false,
    joinLink: null,
    provider: null,
    visibility: 'private',
    sharedAt: null,
    sharedByUserId: null,
    client: null,
    attendees: [],
    attachments: [],
    preps: [],
    notes: [],
    debriefs: [],
    notesApproved: false,
    meri: 'done',
    contributors: [],
    sharedBy: null,
    ...overrides,
  } as Meeting;
}

function buildTree(qc: QueryClient, props: Parameters<typeof DebriefTab>[0]): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <AntApp>
        <DebriefTab {...props} />
      </AntApp>
    </QueryClientProvider>
  );
}

describe('DebriefTab', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiPatchMock.mockReset();
  });

  test('an unfinished meeting shows the "Locked" stage pill and the locked panel', async () => {
    mockGetResponses({});
    const qc = new QueryClient();
    render(
      buildTree(qc, {
        meeting: makeMeeting({
          startsAt: '2099-01-01T10:00:00.000Z',
          endsAt: '2099-01-01T10:30:00.000Z',
          meri: null,
        }),
      }),
    );
    expect(screen.getByText('Locked')).toBeInTheDocument();
    expect(screen.getByText('Debrief locked')).toBeInTheDocument();
  });

  test.each(['cancelled', 'canceled'])('a %s meeting does not offer debrief generation', async (status) => {
    mockGetResponses({ debriefs: [], notes: [] });
    render(buildTree(new QueryClient(), { meeting: makeMeeting({ status }) }));
    expect(await screen.findByText('Meeting cancelled')).toBeInTheDocument();
    expect(screen.queryByText('Not started')).not.toBeInTheDocument();
    expect(screen.queryByText(/choose a source for this meeting/i)).not.toBeInTheDocument();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  test('cancellation preserves a saved debrief while removing regeneration', async () => {
    mockGetResponses({ debriefs: [makeDebrief()], notes: [] });
    render(buildTree(new QueryClient(), { meeting: makeMeeting({ status: 'cancelled', endsAt: '2099-01-01T10:30:00Z', meri: null }) }));
    expect(await screen.findByText('Discussed the FY27 markup schedule.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export/i })).toBeEnabled();
  });

  test('no debrief yet (unlocked) shows the "Not started" stage pill and the source picker', async () => {
    mockGetResponses({ debriefs: [], notes: [] });
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting() }));
    await waitFor(() => expect(screen.getByText('Not started')).toBeInTheDocument());
    expect(screen.getByText(/choose a source for this meeting's debrief/i)).toBeInTheDocument();
  });

  test('a restricted debrief (private to another author) shows a real blocked panel, not a plain text line', async () => {
    mockGetResponses({ debriefs: [makeDebrief({ restricted: true, body: null })] });
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting() }));
    await waitFor(() => expect(screen.getByText('Restricted')).toBeInTheDocument());
    expect(screen.getByText('A private debrief by another author exists')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The record is visible but its body is not exposed. Your own debrief is authored separately from the same meeting.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('This debrief is private to its author.')).toBeNull();
  });

  test('an approved debrief shows the "Approved" stage pill and its recap/action items', async () => {
    mockGetResponses({ debriefs: [makeDebrief({ status: 'approved' })] });
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting() }));
    await waitFor(() =>
      expect(screen.getByText('Discussed the FY27 markup schedule.')).toBeInTheDocument(),
    );
    // Two distinct navy "Approved" signals now coexist by design: the top
    // stage pill and ArtifactActionBar's own approved chip.
    expect(screen.getAllByText('Approved').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Send the follow-up memo')).toBeInTheDocument();
  });

  test('a generated (not yet approved) debrief shows the "Draft" stage pill', async () => {
    mockGetResponses({ debriefs: [makeDebrief({ status: 'generated' })] });
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting() }));
    await waitFor(() => expect(screen.getByText('Draft')).toBeInTheDocument());
  });

  test('a populated debrief body ends with the rule-reinforcement sentence', async () => {
    mockGetResponses({ debriefs: [makeDebrief()] });
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting() }));
    await waitFor(() =>
      expect(
        screen.getByText('Approval unlocks explicit sharing; export remains available either way.'),
      ).toBeInTheDocument(),
    );
  });

  test('action items are interactive checkboxes: clicking toggles a line-through and it is NOT persisted to the server', async () => {
    mockGetResponses({ debriefs: [makeDebrief()] });
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting() }));

    const item = await screen.findByText('Send the follow-up memo');
    const checkbox = screen.getAllByRole('checkbox')[0]!;
    expect(checkbox).toHaveAttribute('aria-checked', 'false');
    expect(item).toHaveStyle({ textDecoration: 'none' });

    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
    expect(item).toHaveStyle({ textDecoration: 'line-through' });
    // Session-local only — no PATCH/POST fired for the toggle itself.
    expect(apiPatchMock).not.toHaveBeenCalled();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(screen.getByText(/checking items off is for this session only/i)).toBeInTheDocument();

    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute('aria-checked', 'false');
    expect(item).toHaveStyle({ textDecoration: 'none' });
  });

  test('clicking Approve on a generated debrief POSTs the approve mutation with the exact meeting/debrief ids', async () => {
    mockGetResponses({ debriefs: [makeDebrief({ id: 'd77', status: 'generated' })] });
    apiPostMock.mockResolvedValue({ data: { id: 'd77', status: 'approved' } });
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting({ id: 'm99' }) }));

    await waitFor(() => expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/engagement/meetings/m99/debriefs/d77/approve',
      ),
    );
  });
});
