import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, orgId: 'org-test', userId: 'user-test' }),
}));

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: (url: string) => apiGet(url) }),
}));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: undefined }) }));

import { HearingsTab } from './HearingsTab.js';
import { LwStateAllClear, LwStateEmpty } from '../states/SystemStates.js';

const COVERAGE_URL = '/api/legiwatch/live-hearings/coverage';
const CALENDAR_PREFIX = '/api/legiwatch/live-hearings/calendar?';
const HISTORY_PREFIX = '/intel-api/hearings/history?';
const SERVER_SESSIONS_PREFIX = '/api/legiwatch/live-hearings/server-sessions';

function session(id: string, status = 'completed') {
  return { id, title: `Hearing ${id}`, status, sourceType: 'official', audioSource: 'browser_tab', watchlistMatchCount: 0 };
}

const coveragePartial = {
  summary: { total: 83, healthy: 75, degraded: 0, failing: 1, unknown: 7 },
  sources: [{
    id: 'joint-tax', committeeSystemCode: 'jstx00', committeeName: 'Joint Committee on Taxation',
    chamber: 'joint', sourceType: 'committee', sourceUrl: 'https://www.jct.gov/events/',
    adapterKey: 'committee-events', sourceHealth: 'failing',
  }],
};

let historyData: Record<string, unknown>;
let coverageData: unknown;
let calendarData: Record<string, unknown>;
const clients: QueryClient[] = [];

function defaultResponse(url: string) {
  if (url === COVERAGE_URL) return Promise.resolve({ data: coverageData });
  if (url.startsWith(CALENDAR_PREFIX)) return Promise.resolve({ data: calendarData });
  if (url.startsWith(HISTORY_PREFIX)) return Promise.resolve({ data: historyData });
  if (url.startsWith(SERVER_SESSIONS_PREFIX))
    return Promise.resolve({ data: { rows: [], total: 0, page: 1, pageSize: 50 } });
  return Promise.reject(new Error(`Unexpected GET ${url}`));
}

beforeEach(() => {
  historyData = { items: [session('fauci', 'failed-recoverable')], total: 1, hasMore: false, nextCursor: null };
  coverageData = coveragePartial;
  calendarData = { items: [], total: 0 };
  apiGet.mockReset();
  apiGet.mockImplementation(defaultResponse);
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

function Destination() {
  return <div data-testid="destination">{useLocation().pathname}</div>;
}

function openHearings(url = '/legiwatch?sub=sessions') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/legiwatch" element={<HearingsTab scope="all" />} />
          <Route path="*" element={<Destination />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LW-02 — independent capture and source status', () => {
  it('shows failing sources and an older interrupted capture even with no live proceedings or watchlist matches', async () => {
    historyData = {
      items: [session('recent-1'), session('recent-2'), session('recent-3'), session('fauci', 'failed-recoverable')],
      total: 4, hasMore: false, nextCursor: null,
    };
    openHearings();

    expect(await screen.findByText('CAPTURE ATTENTION')).toBeInTheDocument();
    expect(screen.getByText(/1 interrupted capture in loaded session history/)).toBeInTheDocument();
    expect(await screen.findByText(/75 of 83 registered committee sources report healthy/)).toBeInTheDocument();
    expect(screen.getByText(/0 degraded · 1 failing · 7 unknown/)).toBeInTheDocument();
    expect(screen.getByText(/Failing: Joint Committee on Taxation/)).toBeInTheDocument();
    expect(screen.getByText('No live proceedings in the selected week and filters.')).toBeInTheDocument();
    expect(screen.queryByText(/ALL CLEAR|Every source is current|Nothing needs action|just now/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Hearing fauci' }));
    expect(await screen.findByTestId('destination')).toHaveTextContent('/intelligence/hearing-watch/fauci');
  });

  it('does not turn healthy registered sources into a complete-coverage or global all-clear claim', async () => {
    coverageData = { summary: { total: 83, healthy: 83, degraded: 0, failing: 0, unknown: 0 }, sources: [] };
    historyData = { items: [session('complete')], total: 1, hasMore: false, nextCursor: null };
    openHearings();

    expect(await screen.findByText(/83 of 83 registered committee sources report healthy/)).toBeInTheDocument();
    expect(screen.getByText(/does not establish complete coverage of every committee calendar/)).toBeInTheDocument();
    expect(screen.getByText('No interrupted captures in loaded session history.')).toBeInTheDocument();
    expect(screen.queryByText(/ALL CLEAR|Every source is current|Nothing needs action/)).not.toBeInTheDocument();
  });

  it('retains capture attention when the selected calendar also contains a live hearing', async () => {
    calendarData = { items: [{
      id: 'live-1', title: 'Live posture hearing', eventStatus: 'live', visibility: 'public',
      date: '2026-09-09', startsAt: '2026-09-09T14:00:00Z', committeeName: 'Armed Services',
    }], total: 1 };
    openHearings();
    expect(await screen.findByText('Live posture hearing')).toBeInTheDocument();
    expect(screen.getByText('CAPTURE ATTENTION')).toBeInTheDocument();
    expect(await screen.findByText('SOURCE FAILURES')).toBeInTheDocument();
  });

  it('keeps loading and absent source records unknown, never zero sessions or healthy coverage', async () => {
    apiGet.mockImplementation((url) => url === COVERAGE_URL || url.startsWith(HISTORY_PREFIX)
      ? new Promise(() => {}) : defaultResponse(url));
    const view = openHearings();
    expect(await screen.findByText('No live proceedings in the selected week and filters.')).toBeInTheDocument();
    expect(screen.getByText('Checking committee source health…')).toBeInTheDocument();
    expect(screen.getByText('Checking saved capture sessions…')).toBeInTheDocument();
    expect(screen.queryByText(/No sessions yet|No interrupted captures|sources report healthy/)).not.toBeInTheDocument();
    view.unmount();

    apiGet.mockImplementation(defaultResponse);
    coverageData = {};
    openHearings();
    expect(await screen.findByText('SOURCE STATUS UNKNOWN')).toBeInTheDocument();
    expect(screen.queryByText(/0 of 0|sources report healthy/)).not.toBeInTheDocument();
  });

  it('does not hide capture/source failures or navigation when the calendar fails, and supports source-status retry', async () => {
    let sourceFailed = true;
    apiGet.mockImplementation((url) => {
      if (
        url.startsWith(CALENDAR_PREFIX) ||
        url.startsWith(SERVER_SESSIONS_PREFIX) ||
        (url === COVERAGE_URL && sourceFailed)
      )
        return Promise.reject(new Error('unavailable'));
      return defaultResponse(url);
    });
    openHearings('/legiwatch');
    expect(await screen.findByText('Hearing schedule is unavailable')).toBeInTheDocument();
    expect(await screen.findByText('Committee source health is unavailable')).toBeInTheDocument();
    expect(screen.getByText('CAPTURE ATTENTION')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getByText('Server captures is unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/No server captures yet|No live proceedings in the selected/)).not.toBeInTheDocument();
    sourceFailed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh source status' }));
    expect(await screen.findByText(/75 of 83 registered committee sources report healthy/)).toBeInTheDocument();
  });

  it('does not report an empty or clean capture history when the history request fails', async () => {
    apiGet.mockImplementation((url) => url.startsWith(HISTORY_PREFIX) ? Promise.reject(new Error('unavailable')) : defaultResponse(url));
    openHearings();
    expect(await screen.findByText('Capture session status is unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Capture attention is unverified/)).toBeInTheDocument();
    expect(screen.queryByText(/No sessions yet|No interrupted captures/)).not.toBeInTheDocument();
    expect(await screen.findByText('SOURCE FAILURES')).toBeInTheDocument();
  });

  it('qualifies paginated attention and reveals an older failed session when the next page is checked', async () => {
    historyData = { items: [session('recent')], total: 2, hasMore: true, nextCursor: 'older-page' };
    apiGet.mockImplementation((url) => url.startsWith(HISTORY_PREFIX) && url.includes('cursor=older-page')
      ? Promise.resolve({ data: { items: [session('older', 'failed')], total: 2, hasMore: false, nextCursor: null } })
      : defaultResponse(url));
    openHearings();
    expect(await screen.findByText(/Older sessions have not been checked yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check older capture sessions' }));
    expect(await screen.findByText('CAPTURE ATTENTION')).toBeInTheDocument();
    const older = screen.getByRole('button', { name: 'Open Hearing older' });
    expect(within(older).getByText('NEEDS REVIEW')).toBeInTheDocument();
    expect(within(older).queryByText(/can resume|RECOVERABLE/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Older sessions have not been checked yet/)).not.toBeInTheDocument());
  });

  it('labels an empty agenda as proceedings without making claims about ingestion health', async () => {
    openHearings('/legiwatch');
    fireEvent.click(await screen.findByRole('tab', { name: 'Agenda' }));
    const schedule = screen.getByRole('region', { name: 'Schedule list' });
    expect(within(schedule).getByText('No proceedings matched these filters')).toBeInTheDocument();
    expect(within(schedule).queryByText(/alerts|sources are healthy|ingestion is still running/)).not.toBeInTheDocument();
  });
});

it('shared empty and no-match states cannot certify source health or absence of capture attention', () => {
  render(<><LwStateEmpty /><LwStateAllClear lastScan="10:00 AM" /></>);
  expect(screen.getByText('No watchlist matches in this feed')).toBeInTheDocument();
  expect(screen.getByText(/feed updated 10:00 AM/)).toBeInTheDocument();
  expect(screen.queryByText(/ALL CLEAR|Every source is current|Nothing needs action|sources are healthy/)).not.toBeInTheDocument();
});
