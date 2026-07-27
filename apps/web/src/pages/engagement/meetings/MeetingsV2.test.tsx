import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MeetingsV2, type MeetingsV2Props } from './MeetingsV2.js';
import type { Meeting } from './meetings-types.js';

/**
 * Phase 2 §2a2 — MeetingsV2 is now a fully controlled component: view mode,
 * cursor date, selection, and detail tab are all props, and it only calls the
 * on*Change callbacks. These tests mock every heavy child (MonthView,
 * MeetingRow, MeetingDetailPanel, the library view, the two side modals) so
 * they isolate MeetingsV2's own wiring — same precedent as mocking
 * DistrictNexusMap.js in DistrictNexusPage.test.tsx.
 */

const useMeetingsMock = vi.fn();
const useMeetingMock = vi.fn();
vi.mock('./meetings-api.js', () => ({
  useMeetings: (...args: unknown[]) => useMeetingsMock(...args),
  useMeeting: (...args: unknown[]) => useMeetingMock(...args),
}));

vi.mock('./MonthView.js', () => ({
  MonthView: ({
    meetings,
    onSelect,
    onOpenDay,
  }: {
    meetings: Meeting[];
    onSelect: (m: Meeting) => void;
    onOpenDay: (d: Date) => void;
  }) => (
    <div data-testid="month-view">
      {meetings.map((m) => (
        <button key={m.id} onClick={() => onSelect(m)}>
          {m.subject}
        </button>
      ))}
      <button onClick={() => onOpenDay(new Date(2026, 6, 21))}>open-day</button>
    </div>
  ),
}));

vi.mock('./MeetingRow.js', () => ({
  MeetingRow: ({
    meeting,
    selected,
    onSelect,
  }: {
    meeting: Meeting;
    selected: boolean;
    onSelect: (m: Meeting) => void;
  }) => (
    <button data-testid={`row-${meeting.id}`} data-selected={selected} onClick={() => onSelect(meeting)}>
      {meeting.subject}
    </button>
  ),
}));

vi.mock('./MeetingDetailPanel.js', () => ({
  MeetingDetailPanel: ({
    meeting,
    activeTab,
    onTabChange,
    onClose,
  }: {
    meeting: Meeting | null;
    activeTab: string;
    onTabChange: (t: string) => void;
    onClose: () => void;
  }) =>
    meeting ? (
      <div data-testid="detail-panel">
        <span data-testid="detail-panel-meeting">{meeting.id}</span>
        <span data-testid="detail-panel-tab">{activeTab}</span>
        <button onClick={() => onTabChange('debrief')}>set-debrief-tab</button>
        <button onClick={onClose}>close-panel</button>
      </div>
    ) : null,
}));

vi.mock('./SendMeriModal.js', () => ({ SendMeriModal: () => null }));
vi.mock('./ShareConfirmation.js', () => ({ ShareConfirmation: () => null }));

vi.mock('./MeetingLibraryView.js', () => ({
  MeetingLibraryView: ({
    onBack,
    onOpenMeeting,
  }: {
    onBack: () => void;
    onOpenMeeting: (m: Meeting) => void;
  }) => (
    <div data-testid="library-view">
      <button onClick={onBack}>back</button>
      <button
        onClick={() =>
          onOpenMeeting({
            id: 'lib-1',
            subject: 'Library meeting',
            source: 'outlook',
            description: null,
            location: null,
            startsAt: new Date(2026, 6, 20, 9, 0).toISOString(),
            endsAt: new Date(2026, 6, 20, 9, 30).toISOString(),
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
            meri: null,
            contributors: [],
            sharedBy: null,
          })
        }
      >
        open-lib-meeting
      </button>
    </div>
  ),
}));

// Local midnight, July 20 2026 — matches the Monday-start week containing it.
const CURSOR = new Date(2026, 6, 20, 0, 0, 0, 0);

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm-fixed',
    subject: 'Kickoff call',
    source: 'outlook',
    description: null,
    location: null,
    startsAt: new Date(2026, 6, 20, 10, 0).toISOString(),
    endsAt: new Date(2026, 6, 20, 10, 30).toISOString(),
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
    meri: null,
    contributors: [],
    sharedBy: null,
    ...overrides,
  };
}

function defaultProps(overrides: Partial<MeetingsV2Props> = {}): MeetingsV2Props {
  return {
    clientId: null,
    aiConfigured: true,
    libraryOpen: false,
    onLibraryOpenChange: vi.fn(),
    viewMode: 'day',
    cursor: CURSOR,
    selectedMeetingId: null,
    detailTab: 'prep',
    onViewModeChange: vi.fn(),
    onCursorChange: vi.fn(),
    onSelectedMeetingChange: vi.fn(),
    onDetailTabChange: vi.fn(),
    onCreateMeeting: vi.fn(),
    ...overrides,
  };
}

describe('MeetingsV2', () => {
  beforeEach(() => {
    useMeetingsMock.mockReset();
    useMeetingMock.mockReset();
    useMeetingsMock.mockReturnValue({ data: [], isLoading: false, isError: false });
    useMeetingMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      isFetched: false,
    });
  });

  test('viewMode is fully controlled by the parent — no internal state to diverge', () => {
    const meeting = makeMeeting();
    useMeetingsMock.mockReturnValue({ data: [meeting], isLoading: false, isError: false });
    const { rerender } = render(<MeetingsV2 {...defaultProps({ viewMode: 'day' })} />);
    expect(screen.queryByTestId('month-view')).not.toBeInTheDocument();

    rerender(<MeetingsV2 {...defaultProps({ viewMode: 'month' })} />);
    expect(screen.getByTestId('month-view')).toBeInTheDocument();

    // Clicking a toggle button only ever calls back to the parent — there is no
    // local viewMode to flip, so the rendered body stays on 'month' until the
    // parent actually re-renders with a new prop.
    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    expect(screen.getByTestId('month-view')).toBeInTheDocument();
  });

  test('toolbar navigation calls the parent callbacks instead of managing state locally', () => {
    const onViewModeChange = vi.fn();
    const onCursorChange = vi.fn();
    render(
      <MeetingsV2 {...defaultProps({ viewMode: 'day', cursor: CURSOR, onViewModeChange, onCursorChange })} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    expect(onViewModeChange).toHaveBeenCalledWith('month');

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onCursorChange).toHaveBeenCalledWith(new Date(2026, 6, 19, 0, 0, 0, 0));

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onCursorChange).toHaveBeenCalledWith(new Date(2026, 6, 21, 0, 0, 0, 0));

    fireEvent.click(screen.getByRole('button', { name: /today/i }));
    expect(onCursorChange).toHaveBeenCalledTimes(3);
  });

  test('opening a meeting from a row picks the best default tab exactly once per meeting-open', () => {
    const onSelectedMeetingChange = vi.fn();
    const onDetailTabChange = vi.fn();
    const meeting = makeMeeting();
    useMeetingsMock.mockReturnValue({ data: [meeting], isLoading: false, isError: false });
    const { rerender } = render(
      <MeetingsV2
        {...defaultProps({
          viewMode: 'day',
          cursor: CURSOR,
          selectedMeetingId: null,
          onSelectedMeetingChange,
          onDetailTabChange,
        })}
      />,
    );

    fireEvent.click(screen.getByText(meeting.subject));
    expect(onSelectedMeetingChange).toHaveBeenCalledWith(meeting.id);
    // Fresh meeting: no debrief, no notes → best tab is 'prep'.
    expect(onDetailTabChange).toHaveBeenCalledWith('prep');
    expect(onDetailTabChange).toHaveBeenCalledTimes(1);

    // Parent applies the change; selectedMeetingId now matches this meeting.
    // Re-clicking the SAME (already-open) meeting must not re-fire the tab pick
    // — otherwise it would clobber a manual tab change made in between.
    rerender(
      <MeetingsV2
        {...defaultProps({
          viewMode: 'day',
          cursor: CURSOR,
          selectedMeetingId: meeting.id,
          onSelectedMeetingChange,
          onDetailTabChange,
        })}
      />,
    );
    fireEvent.click(screen.getByText(meeting.subject));
    expect(onDetailTabChange).toHaveBeenCalledTimes(1);
  });

  test('detail panel close/tab-change route through the parent callbacks', () => {
    const onSelectedMeetingChange = vi.fn();
    const onDetailTabChange = vi.fn();
    const meeting = makeMeeting();
    useMeetingsMock.mockReturnValue({ data: [meeting], isLoading: false, isError: false });
    render(
      <MeetingsV2
        {...defaultProps({
          selectedMeetingId: meeting.id,
          detailTab: 'prep',
          onSelectedMeetingChange,
          onDetailTabChange,
        })}
      />,
    );

    expect(screen.getByTestId('detail-panel-meeting')).toHaveTextContent(meeting.id);
    expect(screen.getByTestId('detail-panel-tab')).toHaveTextContent('prep');

    fireEvent.click(screen.getByText('set-debrief-tab'));
    expect(onDetailTabChange).toHaveBeenCalledWith('debrief');

    fireEvent.click(screen.getByText('close-panel'));
    expect(onSelectedMeetingChange).toHaveBeenCalledWith(null);
  });

  test('New meeting button is visible in the empty state and calls onCreateMeeting with the cursor', () => {
    const onCreateMeeting = vi.fn();
    useMeetingsMock.mockReturnValue({ data: [], isLoading: false, isError: false });
    // List view's empty body only trips when the whole visible week has zero
    // meetings (Day view always renders its single day-key regardless).
    render(<MeetingsV2 {...defaultProps({ viewMode: 'list', cursor: CURSOR, onCreateMeeting })} />);

    // Honest empty state — no mock/placeholder meetings ever render.
    expect(screen.queryByText(/mock/i)).not.toBeInTheDocument();

    const button = screen.getByRole('button', { name: /new meeting/i });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(onCreateMeeting).toHaveBeenCalledWith(CURSOR);
  });

  test('libraryOpen renders the Library view and routes its callbacks', () => {
    const onLibraryOpenChange = vi.fn();
    const onSelectedMeetingChange = vi.fn();
    render(
      <MeetingsV2
        {...defaultProps({ libraryOpen: true, onLibraryOpenChange, onSelectedMeetingChange })}
      />,
    );

    expect(screen.getByTestId('library-view')).toBeInTheDocument();
    fireEvent.click(screen.getByText('back'));
    expect(onLibraryOpenChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByText('open-lib-meeting'));
    expect(onSelectedMeetingChange).toHaveBeenCalledWith('lib-1');
  });

  test('a selected id outside the fetched range falls back to useMeeting()', () => {
    useMeetingsMock.mockReturnValue({ data: [], isLoading: false, isError: false });
    const fallbackMeeting = makeMeeting({ id: 'outside-range', subject: 'Deep-linked meeting' });
    useMeetingMock.mockReturnValue({
      data: fallbackMeeting,
      isLoading: false,
      isError: false,
      isFetched: true,
    });

    render(<MeetingsV2 {...defaultProps({ selectedMeetingId: 'outside-range' })} />);

    expect(useMeetingMock).toHaveBeenCalledWith('outside-range');
    expect(screen.getByTestId('detail-panel-meeting')).toHaveTextContent('outside-range');
  });

  test('a deleted/inaccessible selected id shows a not-found state instead of the detail panel', () => {
    useMeetingsMock.mockReturnValue({ data: [], isLoading: false, isError: false });
    useMeetingMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      isFetched: true,
    });

    render(<MeetingsV2 {...defaultProps({ selectedMeetingId: 'gone' })} />);

    expect(screen.queryByTestId('detail-panel')).not.toBeInTheDocument();
    expect(screen.getByText(/meeting not found/i)).toBeInTheDocument();
  });
});
