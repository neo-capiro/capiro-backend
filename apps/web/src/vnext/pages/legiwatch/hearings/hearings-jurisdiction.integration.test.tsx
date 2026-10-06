/**
 * Hearings calendar jurisdiction — the public Florida feed must be reachable
 * for EVERY tenant. These tests render the real HearingsTab with the API
 * stubbed and assert the jurisdiction query param is forwarded for a tenant
 * WITHOUT the legacy `legiwatch_state_calendar_v1` flag, and that the default
 * is inclusive (All jurisdictions) rather than Federal-only.
 */
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, orgId: 'org-no-fl-flag', userId: 'user-test' }),
}));

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
const apiPost = vi.fn<(url: string, body?: unknown) => Promise<{ data: unknown }>>();
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: (url: string) => apiGet(url),
    post: (url: string, body?: unknown) => apiPost(url, body),
  }),
}));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: undefined }) }));

import { HearingsTab } from './HearingsTab.js';

const CALENDAR_PREFIX = '/api/legiwatch/live-hearings/calendar?';
const HISTORY_PREFIX = '/intel-api/hearings/history?';
const COVERAGE_URL = '/api/legiwatch/live-hearings/coverage';
const CALENDAR_COVERAGE_PREFIX = '/api/legiwatch/live-hearings/calendar/coverage?';
const SCOPE_URL = '/intel-api/legiwatch/calendar/scope';
const FEATURE_FLAGS_URL = '/intel-api/feature-flags';
const DEADLINES_PREFIX = '/intel-api/legiwatch/research/deadlines?';

let calendarData: Record<string, unknown>;
let latestCalendarData: Record<string, unknown>;
let featureFlags: Record<string, boolean>;
let deadlineData: { rows: Array<Record<string, string>> };
let sourceCoverageData: { rows: Array<Record<string, unknown>>; asOf?: string };
const clients: QueryClient[] = [];

function JurisdictionProbe() {
  const [params] = useSearchParams();
  return <output data-testid="jurisdiction">{params.get('jurisdiction') ?? '(none)'}</output>;
}

function defaultResponse(url: string) {
  // Tenant WITHOUT the legacy Florida/stateCalendar flag — flags map is empty.
  if (url === FEATURE_FLAGS_URL) return Promise.resolve({ data: featureFlags });
  if (url === COVERAGE_URL)
    return Promise.resolve({ data: { summary: { total: 0, healthy: 0, degraded: 0, failing: 0, unknown: 0 }, sources: [] } });
  if (url.startsWith(CALENDAR_COVERAGE_PREFIX))
    return Promise.resolve({ data: sourceCoverageData });
  if (url.startsWith(DEADLINES_PREFIX)) return Promise.resolve({ data: deadlineData });
  if (url.startsWith(CALENDAR_PREFIX))
    return Promise.resolve({
      data: url.includes('sort=desc') ? latestCalendarData : calendarData,
    });
  if (url.startsWith(HISTORY_PREFIX))
    return Promise.resolve({ data: { items: [], total: 0, hasMore: false, nextCursor: null } });
  return Promise.reject(new Error(`Unexpected GET ${url}`));
}

beforeEach(() => {
  calendarData = { items: [], total: 0 };
  latestCalendarData = { items: [], total: 0 };
  featureFlags = {};
  deadlineData = { rows: [] };
  sourceCoverageData = { rows: [] };
  apiGet.mockReset();
  apiPost.mockReset();
  apiGet.mockImplementation(defaultResponse);
  apiPost.mockImplementation((url) => {
    if (url === SCOPE_URL) return Promise.resolve({ data: { folders: [], billIds: [], matches: [] } });
    return Promise.resolve({ data: {} });
  });
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

function openSchedule(url = '/legiwatch') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/legiwatch"
            element={
              <>
                <JurisdictionProbe />
                <HearingsTab scope="all" />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function calendarCalls() {
  return apiGet.mock.calls.map(([url]) => url).filter((u) => u.startsWith(CALENDAR_PREFIX));
}

describe('Hearings calendar jurisdiction (public Florida feed)', () => {
  it('defaults to ALL jurisdictions and forwards jurisdiction=ALL for a tenant without the legacy flag', async () => {
    openSchedule();
    // The jurisdiction control is visible even without the stateCalendar flag.
    const select = await screen.findByLabelText('Calendar jurisdiction');
    expect((select as HTMLSelectElement).value).toBe('ALL');
    await waitFor(() => expect(calendarCalls().length).toBeGreaterThan(0));
    expect(calendarCalls().some((u) => u.includes('jurisdiction=ALL'))).toBe(true);
    expect(calendarCalls().some((u) => u.includes('jurisdiction=US'))).toBe(false);
  });

  it('switches to Florida-only and forwards jurisdiction=FL', async () => {
    openSchedule();
    const select = await screen.findByLabelText('Calendar jurisdiction');
    fireEvent.change(select, { target: { value: 'FL' } });
    await waitFor(() => expect(calendarCalls().some((u) => u.includes('jurisdiction=FL'))).toBe(true));
  });

  it('switches to Federal-only and forwards jurisdiction=US', async () => {
    openSchedule();
    const select = await screen.findByLabelText('Calendar jurisdiction');
    fireEvent.change(select, { target: { value: 'US' } });
    await waitFor(() => expect(calendarCalls().some((u) => u.includes('jurisdiction=US'))).toBe(true));
  });

  it('honors a saved FL filter instead of forcing the default', async () => {
    openSchedule('/legiwatch?jurisdiction=FL');
    const select = await screen.findByLabelText('Calendar jurisdiction');
    expect((select as HTMLSelectElement).value).toBe('FL');
    await waitFor(() => expect(calendarCalls().some((u) => u.includes('jurisdiction=FL'))).toBe(true));
  });

  it('offers only Federal, Florida, and All — not all fifty states', async () => {
    openSchedule();
    const select = (await screen.findByLabelText('Calendar jurisdiction')) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values.sort()).toEqual(['ALL', 'FL', 'US']);
  });

  it('renders returned Florida proceedings in the shared calendar and agenda without the legacy flag', async () => {
    calendarData = {
      items: [
        {
          id: 'state-fl-parity-1',
          title: 'Florida housing committee meeting',
          date: '2026-09-17',
          geographicJurisdiction: 'FL',
          eventType: 'committee',
          committee: { name: 'Housing Committee' },
        },
      ],
      total: 1,
    };

    openSchedule('/legiwatch?jurisdiction=FL&calendarDate=2026-09-20');

    const calendar = await screen.findByLabelText('Week calendar');
    expect(
      await within(calendar).findByRole('button', { name: /Florida housing committee meeting/i }),
    ).toBeTruthy();
    expect(calendar.textContent).toContain('1 proceedings');

    fireEvent.click(within(screen.getByLabelText('Schedule view')).getByText('Agenda'));
    const agenda = await screen.findByLabelText('Schedule list');
    expect(within(agenda).getByText('Florida housing committee meeting')).toBeTruthy();
  });

  it('certifies a source-verified empty Florida week and keeps the latest proceeding inside the shared calendar', async () => {
    const latestEvent = {
      id: 'cm-fl-jlbc-2026-09-11',
      title: 'Joint Legislative Budget Commission',
      date: '2026-09-11',
      geographicJurisdiction: 'FL',
      eventType: 'committee',
      committee: { name: 'Joint Legislative Budget Commission' },
    };
    latestCalendarData = { items: [latestEvent], total: 1 };
    sourceCoverageData = {
      asOf: '2026-09-20T18:00:00.000Z',
      rows: ['house', 'senate'].map((chamber) => ({
        chamber,
        status: 'complete',
        checkedAt: '2026-09-20T17:30:00.000Z',
        from: '2026-09-14',
        to: '2026-09-20',
        items: 0,
        details: { expected: 0, found: 0, issues: [] },
      })),
    };
    apiGet.mockImplementation((url) => {
      if (
        url.startsWith(CALENDAR_PREFIX) &&
        !url.includes('sort=desc') &&
        url.includes('from=2026-09-07') &&
        url.includes('to=2026-09-13')
      )
        return Promise.resolve({ data: { items: [latestEvent], total: 1 } });
      return defaultResponse(url);
    });

    openSchedule('/legiwatch?jurisdiction=FL&calendarDate=2026-09-20');

    const calendar = await screen.findByLabelText('Week calendar');
    const availability = await within(calendar).findByLabelText('Florida calendar availability');
    expect(availability.textContent).toContain(
      'No Florida proceedings were published for Sep 14–20, 2026.',
    );
    expect(availability.textContent).toContain(
      'Latest published proceeding: Joint Legislative Budget Commission · Sep 11, 2026',
    );
    expect(screen.getByText(/Florida calendar checks · Healthy/)).toBeTruthy();

    fireEvent.click(
      within(availability).getByRole('button', { name: 'View latest Florida hearings' }),
    );
    await waitFor(() =>
      expect(
        calendarCalls().some(
          (url) => url.includes('from=2026-09-07') && url.includes('to=2026-09-13'),
        ),
      ).toBe(true),
    );
    expect(
      await within(await screen.findByLabelText('Week calendar')).findByRole('button', {
        name: /Joint Legislative Budget Commission/i,
      }),
    ).toBeTruthy();
  });

  it.each([
    {
      state: 'partial',
      summary: 'Partial check',
      rows: [
        { chamber: 'house', status: 'partial', checkedAt: '2026-09-20T17:30:00.000Z' },
        { chamber: 'senate', status: 'complete', checkedAt: '2026-09-20T17:30:00.000Z' },
      ],
    },
    {
      state: 'stale',
      summary: 'Stale check',
      rows: [
        { chamber: 'house', status: 'complete', checkedAt: '2026-09-18T17:30:00.000Z' },
        { chamber: 'senate', status: 'complete', checkedAt: '2026-09-18T17:30:00.000Z' },
      ],
    },
    {
      state: 'failed',
      summary: 'Failed check',
      rows: [
        { chamber: 'house', status: 'failed', checkedAt: '2026-09-20T17:30:00.000Z' },
        { chamber: 'senate', status: 'complete', checkedAt: '2026-09-20T17:30:00.000Z' },
      ],
    },
    {
      state: 'missing one chamber',
      summary: 'Coverage not verified',
      rows: [{ chamber: 'house', status: 'complete', checkedAt: '2026-09-20T17:30:00.000Z' }],
    },
    {
      state: 'not overlapping the full week',
      summary: 'Coverage not verified',
      rows: [
        {
          chamber: 'house',
          status: 'complete',
          checkedAt: '2026-09-20T17:30:00.000Z',
          from: '2026-09-15',
        },
        { chamber: 'senate', status: 'complete', checkedAt: '2026-09-20T17:30:00.000Z' },
      ],
    },
  ])('never claims an empty Florida week when coverage is $state', async ({ rows, summary }) => {
    sourceCoverageData = {
      asOf: '2026-09-20T18:00:00.000Z',
      rows: rows.map((row) => ({
        from: '2026-09-14',
        to: '2026-09-20',
        ...row,
        items: 0,
        details: { expected: 0, found: 0, issues: [] },
      })),
    };

    openSchedule('/legiwatch?jurisdiction=FL&calendarDate=2026-09-20');

    const availability = await screen.findByLabelText('Florida calendar availability');
    expect(availability.textContent).toContain(
      'Florida proceeding availability is not verified for Sep 14–20, 2026.',
    );
    expect(availability.textContent).not.toContain('No Florida proceedings were published');
    expect(screen.getByText(new RegExp(`Florida calendar checks · ${summary}`))).toBeTruthy();
  });

  it('keeps a failed coverage request distinct from a verified empty Florida week', async () => {
    apiGet.mockImplementation((url) =>
      url.startsWith(CALENDAR_COVERAGE_PREFIX)
        ? Promise.reject(new Error('coverage unavailable'))
        : defaultResponse(url),
    );

    openSchedule('/legiwatch?jurisdiction=FL&calendarDate=2026-09-20');

    const availability = await screen.findByLabelText('Florida calendar availability');
    expect(availability.textContent).toContain('Florida proceeding availability is not verified');
    expect(availability.textContent).toContain('The source coverage check could not be loaded.');
    expect(availability.textContent).not.toContain('No Florida proceedings were published');
    expect(screen.getByText(/Florida calendar checks · Check unavailable/)).toBeTruthy();
  });

  it('leaves the empty Federal calendar behavior unchanged', async () => {
    openSchedule('/legiwatch?jurisdiction=US&calendarDate=2026-09-20');
    const calendar = await screen.findByLabelText('Week calendar');
    expect(within(calendar).queryByLabelText('Florida calendar availability')).toBeNull();
    expect(within(calendar).getAllByText('No proceedings')).toHaveLength(7);
  });

  it('keeps Florida legal-date reminders after the shared calendar and agenda surface', async () => {
    featureFlags = {
      legiwatch_state_calendar_v1: true,
      legiwatch_research_v1: true,
    };
    deadlineData = {
      rows: [
        {
          id: 'deadline-1',
          kind: 'comment_end',
          date_only: '2026-09-20',
          raw_wording: 'Comments close September 20, 2026.',
          notice_id: 'FL-31365937',
        },
      ],
    };
    latestCalendarData = {
      items: [
        {
          id: 'fl-latest-1',
          title: 'Latest Florida committee meeting',
          date: '2026-09-10',
          geographicJurisdiction: 'FL',
        },
      ],
      total: 1,
    };

    openSchedule('/legiwatch?jurisdiction=FL&calendarDate=2026-09-20');

    const calendar = await screen.findByLabelText('Week calendar');
    const latest = await screen.findByRole('button', { name: 'View latest Florida hearings' });
    expect(
      calendar.compareDocumentPosition(latest) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    const reminderToggle = screen.getByRole('checkbox', {
      name: 'Include date-only reminders',
    });
    expect((reminderToggle as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText('Published legal dates')).toBeNull();
    expect(apiGet.mock.calls.some(([url]) => url.startsWith(DEADLINES_PREFIX))).toBe(false);

    fireEvent.click(reminderToggle);
    const reminders = await screen.findByLabelText('Published legal dates');
    await waitFor(() =>
      expect(apiGet.mock.calls.some(([url]) => url.startsWith(DEADLINES_PREFIX))).toBe(true),
    );
    expect(
      calendar.compareDocumentPosition(reminders) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(reminders.querySelector('details')?.open).toBe(false);

    const scheduleView = screen.getByLabelText('Schedule view');
    expect(within(scheduleView).getByText('Calendar')).toBeTruthy();
    expect(within(scheduleView).getByText('Agenda')).toBeTruthy();
    expect(screen.getByLabelText('Committee')).toBeTruthy();
    expect(screen.getByLabelText('Proceeding type')).toBeTruthy();
    expect(screen.getByLabelText('Search proceedings')).toBeTruthy();
    expect(screen.getByLabelText('Calendar range')).toBeTruthy();
    expect(await within(reminders).findByText('FL-31365937')).toBeTruthy();

    fireEvent.click(within(scheduleView).getByText('Agenda'));
    const agenda = await screen.findByLabelText('Schedule list');
    expect(
      agenda.compareDocumentPosition(reminders) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    fireEvent.click(reminderToggle);
    expect(screen.queryByLabelText('Published legal dates')).toBeNull();
  });
});

it('names and clears a folder calendar scope while preserving jurisdiction', async () => {
  featureFlags = { legiwatch_state_calendar_v1: true };
  apiPost.mockImplementation(async () => ({ data: { folders: [{ id: 'folder-a', name: 'Defense priorities' }], billIds: [], matches: [] } }));
  openSchedule('/legiwatch?jurisdiction=FL&calendarFolder=folder-a');
  const scope = await screen.findByRole('status', { name: 'Active calendar folder scope' });
  await waitFor(() => expect(scope.textContent).toContain('Defense priorities'));
  fireEvent.click(within(scope).getByRole('button', { name: 'Clear folder scope' }));
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Active calendar folder scope' })).toBeNull());
  expect((screen.getByLabelText('Calendar jurisdiction') as HTMLSelectElement).value).toBe('FL');
});
