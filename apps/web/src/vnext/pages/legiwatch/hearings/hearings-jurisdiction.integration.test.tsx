/**
 * Hearings calendar jurisdiction — the public Florida feed must be reachable
 * for EVERY tenant. These tests render the real HearingsTab with the API
 * stubbed and assert the jurisdiction query param is forwarded for a tenant
 * WITHOUT the legacy `legiwatch_state_calendar_v1` flag, and that the default
 * is inclusive (All jurisdictions) rather than Federal-only.
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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
const SCOPE_URL = '/intel-api/legiwatch/calendar/scope';
const FEATURE_FLAGS_URL = '/intel-api/feature-flags';

let calendarData: Record<string, unknown>;
const clients: QueryClient[] = [];

function JurisdictionProbe() {
  const [params] = useSearchParams();
  return <output data-testid="jurisdiction">{params.get('jurisdiction') ?? '(none)'}</output>;
}

function defaultResponse(url: string) {
  // Tenant WITHOUT the legacy Florida/stateCalendar flag — flags map is empty.
  if (url === FEATURE_FLAGS_URL) return Promise.resolve({ data: {} });
  if (url === COVERAGE_URL)
    return Promise.resolve({ data: { summary: { total: 0, healthy: 0, degraded: 0, failing: 0, unknown: 0 }, sources: [] } });
  if (url.startsWith(CALENDAR_PREFIX)) return Promise.resolve({ data: calendarData });
  if (url.startsWith(HISTORY_PREFIX))
    return Promise.resolve({ data: { items: [], total: 0, hasMore: false, nextCursor: null } });
  return Promise.reject(new Error(`Unexpected GET ${url}`));
}

beforeEach(() => {
  calendarData = { items: [], total: 0 };
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
});
