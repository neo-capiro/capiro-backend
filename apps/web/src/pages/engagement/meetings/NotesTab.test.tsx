// QA gap coverage (independent verification pass): NotesTab is ALWAYS mocked
// wholesale in MeetingDetailPanel.test.tsx (by explicit repo convention) and
// has no test file of its own — meaning Phase 2 §3.e/§3.j's actual behavior
// (Draft/Edited/Approved/Shared status pill, inline edit, approve) had zero
// direct coverage anywhere. This exercises the real component against a
// mocked transport (useApi), not a mocked NotesTab.
import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { NotesTab } from './NotesTab.js';
import type { Meeting, MeetingNote } from './meetings-types.js';

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();
const apiPostMock = vi.fn();
const apiDeleteMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: apiPostMock,
    put: vi.fn(),
    patch: apiPatchMock,
    delete: apiDeleteMock,
  }),
}));

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1',
    subject: 'Budget sync',
    source: 'outlook',
    description: null,
    location: null,
    startsAt: '2020-01-01T14:00:00.000Z',
    endsAt: '2020-01-01T14:30:00.000Z',
    organizerEmail: null,
    organizerName: null,
    status: 'confirmed',
    metadata: null,
    isVirtual: true,
    joinLink: 'https://meet.example/x',
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

function makeNote(overrides: Partial<MeetingNote> = {}): MeetingNote {
  return {
    id: 'n1',
    confidential: false,
    status: 'draft',
    approvedAt: null,
    approvedByUserId: null,
    sharedAt: null,
    sharedByUserId: null,
    authorUserId: null,
    author: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    body: 'We discussed the FY27 markup schedule.',
    restricted: false,
    ...overrides,
  } as MeetingNote;
}

function buildTree(qc: QueryClient, props: Parameters<typeof NotesTab>[0]): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <AntApp>
        <NotesTab {...props} />
      </AntApp>
    </QueryClientProvider>
  );
}

function defaultProps(overrides: Partial<Parameters<typeof NotesTab>[0]> = {}) {
  return {
    meeting: makeMeeting(),
    onSendMeri: vi.fn(),
    onGoToDebrief: vi.fn(),
    ...overrides,
  };
}

describe('NotesTab', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPostMock.mockReset();
    apiDeleteMock.mockReset();
  });

  test('a Meri-scheduled meeting with no notes yet shows the "Meri Attending" empty state', async () => {
    apiGetMock.mockResolvedValue({ data: [] });
    const qc = new QueryClient();
    render(buildTree(qc, defaultProps({ meeting: makeMeeting({ meri: 'scheduled' }) })));
    await waitFor(() => expect(screen.getByText('Meri Attending')).toBeTruthy());
  });

  test('an eligible, not-yet-scheduled meeting with no notes shows "No notes yet" + Send Meri', async () => {
    apiGetMock.mockResolvedValue({ data: [] });
    const qc = new QueryClient();
    render(buildTree(qc, defaultProps({ meeting: makeMeeting({ meri: null }) })));
    await waitFor(() => expect(screen.getByText('No notes yet')).toBeTruthy());
  });

  test('an ineligible meeting (no join link) with no notes shows "Notes unavailable"', async () => {
    apiGetMock.mockResolvedValue({ data: [] });
    const qc = new QueryClient();
    render(
      buildTree(
        qc,
        defaultProps({ meeting: makeMeeting({ meri: null, isVirtual: false, joinLink: null }) }),
      ),
    );
    await waitFor(() => expect(screen.getByText('Notes unavailable')).toBeTruthy());
  });

  test('while Meri is summarizing (attended, no notes yet), shows the generating state, not an empty state', async () => {
    apiGetMock.mockResolvedValue({ data: [] });
    const qc = new QueryClient();
    render(buildTree(qc, defaultProps({ meeting: makeMeeting({ meri: 'attended' }) })));
    expect(screen.getByText('Meri is summarizing the meeting…')).toBeTruthy();
    expect(screen.queryByText('No notes yet')).toBeNull();
  });

  test('a Draft note shows the "Draft" pill — completion (Summarized) is a SEPARATE signal from approval', async () => {
    apiGetMock.mockResolvedValue({ data: [makeNote({ status: 'draft' })] });
    const qc = new QueryClient();
    render(buildTree(qc, defaultProps()));
    await waitFor(() => expect(screen.getByText('We discussed the FY27 markup schedule.')).toBeTruthy());
    expect(screen.getByText('Summarized')).toBeTruthy(); // completion indicator, always present once notes exist
    expect(screen.getByText('Draft')).toBeTruthy(); // approval/share indicator, independent of completion
    expect(screen.queryByText('Approved')).toBeNull();
    expect(screen.queryByText('Shared')).toBeNull();
  });

  test('an approved note shows "Approved", not "Draft", and offers no Approve button', async () => {
    apiGetMock.mockResolvedValue({ data: [makeNote({ status: 'approved', approvedAt: '2026-07-02T00:00:00Z' })] });
    const qc = new QueryClient();
    render(buildTree(qc, defaultProps()));
    await waitFor(() => expect(screen.getByText('Approved')).toBeTruthy());
    expect(screen.queryByText('Approve')).toBeNull();
  });

  test('a SHARED note shows "Shared" even though its status is "approved" — sharedAt takes priority in display', async () => {
    apiGetMock.mockResolvedValue({
      data: [makeNote({ status: 'approved', approvedAt: '2026-07-02T00:00:00Z', sharedAt: '2026-07-03T00:00:00Z' })],
    });
    const qc = new QueryClient();
    render(buildTree(qc, defaultProps()));
    await waitFor(() => expect(screen.getByText('Shared')).toBeTruthy());
    expect(screen.queryByText('Approved')).toBeNull();
  });

  test('clicking Approve on a draft note POSTs the approve endpoint with the exact meeting/note ids', async () => {
    apiGetMock.mockResolvedValue({ data: [makeNote({ id: 'n42', status: 'draft' })] });
    apiPostMock.mockResolvedValue({ data: makeNote({ id: 'n42', status: 'approved' }) });
    const qc = new QueryClient();
    render(buildTree(qc, defaultProps({ meeting: makeMeeting({ id: 'm77' }) })));
    await waitFor(() => expect(screen.getByText('Approve')).toBeTruthy());
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith('/api/engagement/meetings/m77/notes/n42/approve'));
  });

  test('editing a note: Edit shows a textarea seeded with the current body; Save PATCHes the new body', async () => {
    apiGetMock.mockResolvedValue({ data: [makeNote({ id: 'n1', body: 'Original text.' })] });
    apiPatchMock.mockResolvedValue({ data: makeNote({ id: 'n1', body: 'Updated text.', status: 'edited' }) });
    const qc = new QueryClient();
    render(buildTree(qc, defaultProps({ meeting: makeMeeting({ id: 'm1' }) })));
    await waitFor(() => expect(screen.getByText('Original text.')).toBeTruthy());
    fireEvent.click(screen.getByText('Edit'));
    const textarea = screen.getByDisplayValue('Original text.');
    fireEvent.change(textarea, { target: { value: 'Updated text.' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(apiPatchMock).toHaveBeenCalledWith('/api/engagement/meetings/m1/notes/n1', { body: 'Updated text.' }),
    );
  });

  test('canceling an edit discards the draft text and leaves the original body displayed', async () => {
    apiGetMock.mockResolvedValue({ data: [makeNote({ body: 'Original text.' })] });
    const qc = new QueryClient();
    render(buildTree(qc, defaultProps()));
    await waitFor(() => expect(screen.getByText('Original text.')).toBeTruthy());
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByDisplayValue('Original text.'), { target: { value: 'Throwaway edit' } });
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.getByText('Original text.')).toBeTruthy();
    expect(apiPatchMock).not.toHaveBeenCalled();
  });

  test('"Draft a debrief from these notes" calls onGoToDebrief', async () => {
    apiGetMock.mockResolvedValue({ data: [makeNote()] });
    const onGoToDebrief = vi.fn();
    const qc = new QueryClient();
    render(buildTree(qc, defaultProps({ onGoToDebrief })));
    await waitFor(() => expect(screen.getByText('Draft a debrief from these notes')).toBeTruthy());
    fireEvent.click(screen.getByText('Draft a debrief from these notes'));
    expect(onGoToDebrief).toHaveBeenCalledTimes(1);
  });

  test('a restricted note (ethical wall) is never rendered, even though it was returned by the API', async () => {
    apiGetMock.mockResolvedValue({
      data: [makeNote({ id: 'visible', body: 'Visible note' }), makeNote({ id: 'walled', body: 'Walled note', restricted: true })],
    });
    const qc = new QueryClient();
    render(buildTree(qc, defaultProps()));
    await waitFor(() => expect(screen.getByText('Visible note')).toBeTruthy());
    expect(screen.queryByText('Walled note')).toBeNull();
  });
});
