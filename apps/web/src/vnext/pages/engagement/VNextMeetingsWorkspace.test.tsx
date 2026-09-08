import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { VNextMeetingsWorkspace } from './VNextMeetingsWorkspace.js';
import { dayKey } from '../../../pages/engagement/meetings/meetings-format.js';
import type { Meeting } from '../../../pages/engagement/meetings/meetings-types.js';

/**
 * VNextMeetingsWorkspace — the vNext-only Meetings surface (see the phase
 * brief: a genuinely new component, not a re-skin of the canonical
 * MeetingsV2/MeetingRow/MonthView). Mocks the canonical data-layer hooks
 * (meetings-api.js) and useApi (Clerk-backed, throws without a provider) the
 * same way ClientCrmPage.test.tsx and MeetingsV2.test.tsx already do, so
 * these tests isolate this component's own toolbar/state/calendar-state
 * wiring rather than exercising the real network layer.
 *
 * The drawer phase mounts the REAL canonical MeetingDetailPanel (reused, not
 * forked) once a meeting is selected, so meetings-api.js can no longer be
 * replaced wholesale the way it was in Phase 1a — that would leave every
 * OTHER hook the drawer's tree imports (useGeneratePrep, useMeetingDebriefs,
 * useMeetingNotes, useClientOptions, etc.) undefined and throw the moment a
 * meeting is selected. Spreading the real module and overriding only
 * useMeetings/useMeeting (the two THIS component calls directly) keeps this
 * file's own calendar-state control while letting the drawer's hooks run for
 * real against the mocked useApi below — same convention NotesTab.test.tsx /
 * DebriefTab.test.tsx already use for the real components they exercise.
 */

const useMeetingsMock = vi.fn();
const useMeetingMock = vi.fn();
vi.mock('../../../pages/engagement/meetings/meetings-api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../pages/engagement/meetings/meetings-api.js')>();
  return {
    ...actual,
    meetingsListKey: 'meetings-v2',
    useMeetings: (...args: unknown[]) => useMeetingsMock(...args),
    useMeeting: (...args: unknown[]) => useMeetingMock(...args),
  };
});

// useApi pulls in Clerk's useAuth, which throws without a ClerkProvider — same
// mock shape ClientCrmPage.test.tsx already uses for the identical reason.
// `get` is a blanket empty-list/empty-object response for whichever endpoint
// asks (calendar, capabilities, client options, notes, debriefs — none of the
// stage-pill fixtures below need a populated one); `patch` was added for the
// drawer's real useUpdatePrep/useUpdateNote/useSaveDebrief, unused by
// Phase 1a's own tests but now reachable once a meeting is selected.
/**
 * `apiGet` / `apiPost` are module-level so a test can steer a specific endpoint
 * (the calendar-sync tests need `/api/engagement/integrations` to return real
 * connections) and assert on the exact URLs posted. Defaults reproduce the
 * previous blanket empty-list / created-meeting behaviour, so every other test
 * in this file is unaffected.
 */
const apiGet = vi.fn((url: string) => {
  void url;
  return Promise.resolve({ data: [] as unknown });
});
const apiPost = vi.fn((url: string, ..._rest: unknown[]) => {
  void url;
  void _rest;
  return Promise.resolve({
    data: { id: 'created-1', startsAt: new Date().toISOString() },
  });
});

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: (url: string, ...rest: unknown[]) => apiGet(url, ...(rest as [])),
    post: (url: string, ...rest: unknown[]) => apiPost(url, ...(rest as [])),
    put: () => Promise.resolve({ data: {} }),
    patch: () => Promise.resolve({ data: {} }),
    delete: () => Promise.resolve({ data: {} }),
  }),
}));

/** Makes `/api/engagement/integrations` answer with one connected mailbox. */
function withConnectedMailbox(provider: 'microsoft_365' | 'google' = 'microsoft_365') {
  apiGet.mockImplementation((url: string) => {
    if (url === '/api/engagement/integrations') {
      return Promise.resolve({
        data: [{ id: 'conn-1', provider, status: 'connected', accountEmail: 'neo@capiro.ai' }],
      });
    }
    return Promise.resolve({ data: [] });
  });
}

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm-1',
    subject: 'Kickoff call',
    source: 'outlook',
    description: null,
    location: 'Rayburn 2154',
    startsAt: new Date(2026, 7, 19, 10, 0).toISOString(),
    endsAt: new Date(2026, 7, 19, 10, 30).toISOString(),
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

/** Renders a tiny sibling that surfaces the router's current location so
 *  tests can assert on the `view`/`date`/`meeting` URL contract without
 *  reaching into react-router internals. */
function LocationSpy() {
  const location = useLocation();
  return <div data-testid="location-spy">{location.pathname}{location.search}</div>;
}

function renderWorkspace(initialEntry = '/engagement/meetings?date=2026-08-19') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <VNextMeetingsWorkspace clientId={null} />
        <LocationSpy />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function locationSearch(): string {
  return screen.getByTestId('location-spy').textContent ?? '';
}

describe('VNextMeetingsWorkspace', () => {
  beforeEach(() => {
    useMeetingsMock.mockReset();
    useMeetingMock.mockReset();
    // apiGet is steered per-test by withConnectedMailbox(); reset it back to
    // the blanket empty response so mailbox state cannot leak between tests.
    apiGet.mockReset();
    apiGet.mockImplementation(() => Promise.resolve({ data: [] }));
    apiPost.mockClear();
    useMeetingsMock.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    useMeetingMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      isFetched: false,
    });
  });

  describe('four calendar states', () => {
    test('loading renders three skeleton cards and the mono caption, without disabling the toolbar', () => {
      useMeetingsMock.mockReturnValue({
        data: undefined,
        isLoading: true,
        isError: false,
        isFetching: true,
        refetch: vi.fn(),
      });
      const { container } = renderWorkspace();

      expect(container.querySelectorAll('.vmtg-skeleton-card')).toHaveLength(3);
      expect(
        screen.getByText(/loading calendar · selected meeting loads independently/i),
      ).toBeInTheDocument();
      // The toolbar stays fully interactive while the calendar loads — same
      // contract the canonical MeetingsV2.test.tsx asserts for its toolbar.
      expect(screen.getByRole('button', { name: 'Month' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Day' })).toBeEnabled();
    });

    test('error renders the real failure panel and Retry calendar calls the query\'s own refetch', () => {
      const refetch = vi.fn();
      useMeetingsMock.mockReturnValue({
        data: [],
        isLoading: false,
        isError: true,
        isFetching: false,
        refetch,
      });
      renderWorkspace();

      expect(screen.getByText(/calendar could not be reached/i)).toBeInTheDocument();
      expect(
        screen.getByText(/the selected meeting, outreach and reports remain usable/i),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /retry calendar/i }));
      expect(refetch).toHaveBeenCalledTimes(1);
    });

    test('empty offers real New meeting and Sync calendar actions', () => {
      useMeetingsMock.mockReturnValue({
        data: [],
        isLoading: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      });
      renderWorkspace();

      expect(screen.getByText(/no meetings in this period/i)).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /new meeting/i }).length).toBeGreaterThan(0);
      // Sync now lives in the toolbar as well as the empty state, so there is
      // more than one. Both must be the same control.
      expect(screen.getAllByRole('button', { name: /sync calendar/i }).length).toBeGreaterThan(1);
    });

    /*
     * Calendar sync used to be `window.dispatchEvent(new Event('capiro:sync-inbox'))`.
     * The only listener for that event is in components/AppShell.tsx, which
     * App.tsx never mounts on the vNext surface — so on os.capiro.ai the button
     * did nothing, silently. These two tests pin the replacement: a disabled
     * control with a stated reason when there is nothing to sync, and real
     * provider calls when there is.
     */
    test('Sync calendar is disabled with a stated reason when no mailbox is connected', async () => {
      useMeetingsMock.mockReturnValue({
        data: [],
        isLoading: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      });
      renderWorkspace();

      const buttons = screen.getAllByRole('button', { name: /sync calendar/i });
      for (const button of buttons) expect(button).toBeDisabled();
      // The integrations query is in flight on first paint, so the reason starts
      // as "Checking your connected mailboxes..." and only settles once the
      // empty list resolves. Wait for the settled sentence, not just for the
      // disabled state - the button is disabled in both.
      await waitFor(() =>
        expect(
          screen.getByText(/no mailbox is connected, so there is no calendar to sync/i),
        ).toBeInTheDocument(),
      );
      for (const button of screen.getAllByRole('button', { name: /sync calendar/i })) {
        expect(button).toBeDisabled();
      }

      fireEvent.click(buttons[0]!);
      expect(
        apiPost.mock.calls.filter(([url]) => String(url).includes('/sync')),
      ).toHaveLength(0);
    });

    test('Sync calendar posts the real provider sync endpoints when a mailbox is connected', async () => {
      withConnectedMailbox('microsoft_365');
      useMeetingsMock.mockReturnValue({
        data: [],
        isLoading: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      });
      renderWorkspace();

      const button = (await waitFor(() => {
        const found = screen.getAllByRole('button', { name: /sync calendar/i })[0]!;
        expect(found).toBeEnabled();
        return found;
      })) as HTMLElement;

      fireEvent.click(button);

      await waitFor(() =>
        expect(
          apiPost.mock.calls.some(([url]) =>
            String(url).includes('/api/engagement/integrations/microsoft/conn-1/sync'),
          ),
        ).toBe(true),
      );
      // The calendar window is set before the sync, so the sync has a range to
      // pull. Meetings is the surface; `calendar=true` is the whole point.
      expect(
        apiPost.mock.calls.some(([url]) =>
          String(url).includes('/api/engagement/integrations/microsoft/conn-1/calendar-window'),
        ),
      ).toBe(true);
      const syncCall = apiPost.mock.calls.find(([url]) =>
        String(url).endsWith('/microsoft/conn-1/sync'),
      );
      expect((syncCall?.[2] as { params?: Record<string, string> })?.params).toMatchObject({
        calendar: 'true',
      });
    });

    test('ready renders the week strip and the real meeting row with its status pill', () => {
      const meeting = makeMeeting({ subject: 'Budget markup prep', isInternal: true });
      useMeetingsMock.mockReturnValue({
        data: [meeting],
        isLoading: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      });
      const { container } = renderWorkspace();

      expect(screen.getByText('Budget markup prep')).toBeInTheDocument();
      // isInternal: true maps to the `internal`/gray tone per README §2.3.
      expect(screen.getByText('Internal')).toBeInTheDocument();
      // Day view's week strip renders as a 7-cell grid, with cursor's own
      // cell (the 19th) marked selected and carrying the real meeting count.
      const weekCells = container.querySelectorAll('.vmtg-weekstrip button');
      expect(weekCells).toHaveLength(7);
      const selectedCell = container.querySelector('.vmtg-weekstrip button[data-selected]');
      expect(selectedCell).not.toBeNull();
      expect(within(selectedCell as HTMLElement).getByText('19')).toBeInTheDocument();
      expect(within(selectedCell as HTMLElement).getByText('1')).toBeInTheDocument();
    });

    test('Load earlier meetings only appears in List view — widening the window never changes what Day view shows', () => {
      const meeting = makeMeeting();
      useMeetingsMock.mockReturnValue({
        data: [meeting],
        isLoading: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      });
      renderWorkspace('/engagement/meetings?date=2026-08-19');
      expect(screen.queryByRole('button', { name: /load earlier meetings/i })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'List' }));
      expect(screen.getByRole('button', { name: /load earlier meetings/i })).toBeInTheDocument();
    });
  });

  describe('QA-07 history rendering', () => {
    function mockWindow(meetings: Meeting[]) {
      useMeetingsMock.mockImplementation(({ from, to }: { from: string; to: string }) => ({
        data: meetings.filter((m) => m.startsAt >= from && m.startsAt < to),
        isLoading: false, isError: false, isFetching: false, refetch: vi.fn(),
      }));
    }

    test('successive loads reveal older groups, retain current rows, and reset on navigation', () => {
      mockWindow([
        makeMeeting({ id: 'current', subject: 'Current week' }),
        makeMeeting({ id: 'earlier', subject: 'Earlier week', startsAt: new Date(2026, 7, 5, 10).toISOString(), endsAt: new Date(2026, 7, 5, 11).toISOString() }),
        makeMeeting({ id: 'oldest', subject: 'Oldest week', startsAt: new Date(2026, 6, 22, 10).toISOString(), endsAt: new Date(2026, 6, 22, 11).toISOString() }),
      ]);
      renderWorkspace('/engagement/meetings?date=2026-08-19&view=list');
      expect(screen.getByText('Current week')).toBeInTheDocument();
      expect(screen.queryByText('Earlier week')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /load earlier meetings/i }));
      expect(screen.getByText('Earlier week')).toBeInTheDocument();
      expect(screen.getByText('Current week')).toBeInTheDocument();
      expect(screen.queryByText('Oldest week')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /load earlier meetings/i }));
      expect(screen.getByText('Oldest week')).toBeInTheDocument();
      expect(screen.getAllByText('Earlier week')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Next period' }));
      expect(screen.queryByText('Earlier week')).not.toBeInTheDocument();
    });

    test('an empty week can load existing older meetings', () => {
      mockWindow([makeMeeting({ subject: 'Older only', startsAt: new Date(2026, 7, 5, 10).toISOString(), endsAt: new Date(2026, 7, 5, 11).toISOString() })]);
      renderWorkspace('/engagement/meetings?date=2026-08-19&view=list');
      expect(screen.getByText('No meetings in this period')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /load earlier meetings/i }));
      expect(screen.getByText('Older only')).toBeInTheDocument();
      expect(screen.queryByText('No meetings in this period')).not.toBeInTheDocument();
    });
  });

  test.each(['cancelled', 'canceled'])('QA-10 displays %s instead of a prep/debrief obligation', (status) => {
    useMeetingsMock.mockReturnValue({ data: [makeMeeting({ status })], isLoading: false, isError: false, isFetching: false });
    renderWorkspace();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByText(/needs prep|debrief not completed/i)).not.toBeInTheDocument();
  });

  describe('period stepping', () => {
    test('Day view steps the cursor by exactly one real day', () => {
      renderWorkspace('/engagement/meetings?date=2026-08-19');
      fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
      expect(locationSearch()).toContain('date=2026-08-18');

      fireEvent.click(screen.getByRole('button', { name: 'Next period' }));
      expect(locationSearch()).toContain('date=2026-08-19');
    });

    test('List view steps the cursor by exactly seven real days', () => {
      renderWorkspace('/engagement/meetings?date=2026-08-19&view=list');
      fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
      expect(locationSearch()).toContain('date=2026-08-12');
      expect(locationSearch()).toContain('view=list');
    });

    test('Month view steps by a calendar month, not a fixed day count', () => {
      renderWorkspace('/engagement/meetings?date=2026-08-19&view=month');
      fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
      // Aug → Jul, collapsing to the 1st (matches the canonical MeetingsV2's
      // shift() — a real calendar-month step, not a literal -30 days).
      expect(locationSearch()).toContain('date=2026-07-01');

      fireEvent.click(screen.getByRole('button', { name: 'Next period' }));
      expect(locationSearch()).toContain('date=2026-08-01');
    });

    test('Today resets to Day view at the real current date, unlike the canonical handler', () => {
      renderWorkspace('/engagement/meetings?date=2026-08-19&view=month');
      fireEvent.click(screen.getByRole('button', { name: /today/i }));

      const expectedToday = dayKey(new Date());
      expect(locationSearch()).toContain(`date=${expectedToday}`);
      expect(locationSearch()).not.toContain('view=');
    });

    test('switching view segments persists to the URL and gives the selected segment data-active', () => {
      renderWorkspace('/engagement/meetings?date=2026-08-19');
      const monthButton = screen.getByRole('button', { name: 'Month' });
      fireEvent.click(monthButton);
      expect(monthButton.getAttribute('data-active')).toBe('true');
      expect(locationSearch()).toContain('view=month');
    });
  });

  describe('row time format', () => {
    test('shows a regular 12-hour clock with AM/PM, not military time', () => {
      const meetings = [
        makeMeeting({
          id: 'am',
          subject: 'Morning check-in',
          startsAt: new Date(2026, 7, 19, 10, 30).toISOString(),
          endsAt: new Date(2026, 7, 19, 11, 0).toISOString(),
        }),
        makeMeeting({
          id: 'pm',
          subject: 'Afternoon review',
          startsAt: new Date(2026, 7, 19, 14, 0).toISOString(),
          endsAt: new Date(2026, 7, 19, 14, 30).toISOString(),
        }),
      ];
      useMeetingsMock.mockReturnValue({
        data: meetings,
        isLoading: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      });
      renderWorkspace();

      expect(screen.getByText('10:30 AM')).toBeInTheDocument();
      // 14:00 in a real 12-hour clock is 2:00 PM, not the old military "14:00".
      expect(screen.getByText('2:00 PM')).toBeInTheDocument();
      expect(screen.queryByText('14:00')).not.toBeInTheDocument();
    });

    test('the drawer beside the row shows the SAME clock, not military time', () => {
      // The half-conversion this covers: PR #1443 converted the row but left
      // MeetingDetailPanel's layout="inline" branch on formatTimeRange24, so
      // a 14:00 meeting read "2:00 PM" in the row and "14:00–14:30" in the
      // drawer 12px to its right.
      const meeting = makeMeeting({
        id: 'pm-drawer',
        subject: 'Afternoon review',
        startsAt: new Date(2026, 7, 19, 14, 0).toISOString(),
        endsAt: new Date(2026, 7, 19, 14, 30).toISOString(),
      });
      useMeetingsMock.mockReturnValue({
        data: [meeting],
        isLoading: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      });
      renderWorkspace('/engagement/meetings?date=2026-08-19&meeting=pm-drawer');

      // The when-line is a leaf <span> holding "<day title> · <range>".
      // Matching on the span keeps this pinned to that node; `content`
      // arrives whitespace-normalized, which is what lets a plain space match
      // modern ICU's U+202F before the meridiem. – is the en dash
      // formatTimeRange joins with.
      expect(
        screen.getByText(
          (content, el) => el?.tagName === 'SPAN' && content.includes('2:00 PM–2:30 PM'),
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText('14:00–14:30')).not.toBeInTheDocument();
    });
  });

  describe('month view chip cap', () => {
    test('a day with several meetings shows exactly one chip plus a +N more affordance', () => {
      const sameDay = [
        makeMeeting({ id: 'a', subject: 'Early call', startsAt: new Date(2026, 7, 19, 9, 0).toISOString(), endsAt: new Date(2026, 7, 19, 9, 30).toISOString() }),
        makeMeeting({ id: 'b', subject: 'Midday call', startsAt: new Date(2026, 7, 19, 12, 0).toISOString(), endsAt: new Date(2026, 7, 19, 12, 30).toISOString() }),
        makeMeeting({ id: 'c', subject: 'Late call', startsAt: new Date(2026, 7, 19, 16, 0).toISOString(), endsAt: new Date(2026, 7, 19, 16, 30).toISOString() }),
      ];
      useMeetingsMock.mockReturnValue({
        data: sameDay,
        isLoading: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      });
      const { container } = renderWorkspace('/engagement/meetings?date=2026-08-19&view=month');

      expect(container.querySelectorAll('.vmtg-month__chip')).toHaveLength(1);
      expect(screen.getByText('+2 more')).toBeInTheDocument();
    });

    test('clicking the cell background (not the chip) switches to Day view for that date', () => {
      const meeting = makeMeeting({
        id: 'a',
        subject: 'Only meeting',
        startsAt: new Date(2026, 7, 20, 9, 0).toISOString(),
        endsAt: new Date(2026, 7, 20, 9, 30).toISOString(),
      });
      useMeetingsMock.mockReturnValue({
        data: [meeting],
        isLoading: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      });
      renderWorkspace('/engagement/meetings?date=2026-08-19&view=month');

      const cell = screen.getByRole('button', { name: /open thu aug 20 2026 in day view/i });
      fireEvent.click(cell);

      expect(locationSearch()).toContain('date=2026-08-20');
      expect(locationSearch()).not.toContain('view=');
    });

    test('clicking the chip itself selects that meeting and stays in Month view', () => {
      const meeting = makeMeeting({
        id: 'chip-target',
        subject: 'Only meeting',
        startsAt: new Date(2026, 7, 20, 9, 0).toISOString(),
        endsAt: new Date(2026, 7, 20, 9, 30).toISOString(),
      });
      useMeetingsMock.mockReturnValue({
        data: [meeting],
        isLoading: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      });
      renderWorkspace('/engagement/meetings?date=2026-08-19&view=month');

      fireEvent.click(screen.getByText('Only meeting'));

      expect(locationSearch()).toContain('meeting=chip-target');
      expect(locationSearch()).toContain('view=month');
    });
  });

  describe('selection panels', () => {
    test('no selection shows the explanatory eyebrow card', () => {
      renderWorkspace();
      expect(screen.getByText('Selected meeting')).toBeInTheDocument();
      expect(screen.getByText(/no meeting selected/i)).toBeInTheDocument();
    });

    test('a deleted/inaccessible selected id shows the not-found panel with a working Back button', () => {
      useMeetingMock.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
        isFetched: true,
      });
      renderWorkspace('/engagement/meetings?date=2026-08-19&meeting=gone');

      expect(screen.getByText(/meeting not found/i)).toBeInTheDocument();
      expect(
        screen.getByText(/this meeting is deleted or not authorized for you/i),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /back to day view/i }));
      expect(locationSearch()).not.toContain('meeting=');
    });

    test('a selected id outside the fetched range still resolves via useMeeting and mounts the real drawer', () => {
      const fallback = makeMeeting({ id: 'outside-range', subject: 'Deep-linked meeting' });
      useMeetingMock.mockReturnValue({
        data: fallback,
        isLoading: false,
        isError: false,
        isFetched: true,
      });
      renderWorkspace('/engagement/meetings?date=2026-08-19&meeting=outside-range');

      expect(useMeetingMock).toHaveBeenCalledWith('outside-range');
      // The real MeetingDetailPanel (canonical, reused) now mounts in place of
      // the Phase 1a placeholder — its own header renders the subject as an
      // <h1>, and (since this meeting has no preps yet) Prep's real
      // "Not started" stage pill, confirming the actual drawer is live, not a
      // stand-in.
      expect(screen.getByRole('heading', { name: 'Deep-linked meeting' })).toBeInTheDocument();
      expect(screen.getByText('Not started')).toBeInTheDocument();
    });
  });

  describe('drawer mount (real MeetingDetailPanel, reused from the canonical Meetings module)', () => {
    test('Prep tab: a meeting with no preps yet shows the real "Not started" stage pill', () => {
      const meeting = makeMeeting({ id: 'prep-fixture', preps: [] });
      useMeetingsMock.mockReturnValue({
        data: [meeting],
        isLoading: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      });
      renderWorkspace('/engagement/meetings?date=2026-08-19&meeting=prep-fixture');

      expect(screen.getByRole('heading', { name: 'Kickoff call' })).toBeInTheDocument();
      expect(screen.getByText('Not started')).toBeInTheDocument();
      expect(screen.getByText('No prep generated yet')).toBeInTheDocument();
    });

    test('Notes tab: a non-virtual meeting with no notes shows the real "Unavailable" stage pill', () => {
      const meeting = makeMeeting({
        id: 'notes-fixture',
        isVirtual: false,
        joinLink: null,
        meri: null,
      });
      useMeetingsMock.mockReturnValue({
        data: [meeting],
        isLoading: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      });
      // `tab=notes` deep-links straight onto the tab — the URL→state sync
      // effect applies an explicit `tab` param even for a meeting selected in
      // the same URL write (bestDetailTab's auto-jump only fires on an
      // in-app row/chip click, per selectMeeting's own comment).
      renderWorkspace('/engagement/meetings?date=2026-08-19&meeting=notes-fixture&tab=notes');

      expect(screen.getByText('Unavailable')).toBeInTheDocument();
      expect(screen.getByText('Notes unavailable')).toBeInTheDocument();
    });

    test('Debrief tab: an ended meeting with no debrief yet shows the real "Not started" stage pill and the source picker', async () => {
      // Ended (endsAt in the past) so Debrief is unlocked and its own tab
      // button is clickable — a still-locked meeting would auto-redirect
      // straight back to Prep (MeetingDetailPanel's own debriefLocked guard,
      // covered by MeetingDetailPanel.test.tsx), so it can't stably show
      // anything on Debrief to assert against here.
      const meeting = makeMeeting({
        id: 'debrief-fixture',
        startsAt: new Date(2020, 0, 1, 10, 0).toISOString(),
        endsAt: new Date(2020, 0, 1, 10, 30).toISOString(),
        meri: 'done',
      });
      useMeetingsMock.mockReturnValue({
        data: [meeting],
        isLoading: false,
        isError: false,
        isFetching: false,
        refetch: vi.fn(),
      });
      renderWorkspace('/engagement/meetings?date=2026-08-19&meeting=debrief-fixture');

      fireEvent.click(screen.getByRole('button', { name: 'Debrief' }));
      await screen.findByText('Not started');
      expect(screen.getByText(/choose a source for this meeting's debrief/i)).toBeInTheDocument();
    });
  });

  describe('New meeting', () => {
    test('the toolbar button is real — it opens a composer that actually posts to the API', async () => {
      renderWorkspace();
      // The default fixture (no meetings, Day view) also renders the empty
      // state's own "New meeting" button, so two exist — the toolbar's is
      // always the first in document order.
      fireEvent.click(screen.getAllByRole('button', { name: /new meeting/i })[0]!);

      const dialog = await screen.findByRole('dialog');
      const subjectInput = within(dialog).getByPlaceholderText(/weekly check-in/i);
      fireEvent.change(subjectInput, { target: { value: 'Staffer sync' } });

      const saveButton = within(dialog).getByRole('button', { name: /save meeting/i });
      expect(saveButton).toBeEnabled();
      fireEvent.click(saveButton);

      // Dialog closes once the (mocked) create call resolves and selects the
      // newly created meeting.
      await screen.findByText(/no meeting selected|selected meeting/i, undefined, { timeout: 2000 });
    });
  });
});
