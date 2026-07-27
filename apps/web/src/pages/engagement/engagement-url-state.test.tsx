import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { EngagementPage } from './EngagementPage.js';

/**
 * Phase 2 §2a1/§2a4 — EngagementPage owns the Meetings v2 URL state (view
 * mode, cursor date, selection, detail tab) and hands it down to MeetingsV2 as
 * controlled props. MeetingsV2 and OutreachView are mocked wholesale (repo
 * precedent: DistrictNexusMap.js in DistrictNexusPage.test.tsx) so these tests
 * isolate EngagementPage's own URL sync effects instead of re-exercising
 * MeetingsV2's internals (covered separately in MeetingsV2.test.tsx).
 */

function setupBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
}
setupBrowserMocks();

vi.mock('../../lib/me.js', () => ({
  useMe: () => ({
    data: {
      user: { id: 'u1', clerkUserId: 'c1', email: 'a@x.com', firstName: 'A', lastName: 'B' },
      tenant: { id: 't1', slug: 'acme', name: 'Acme' },
      role: 'user_admin',
      billingAdmin: false,
      features: { meetingsV2: true, meriDockUndockUi: true },
    },
    isLoading: false,
  }),
}));

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: apiPostMock,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }),
}));

vi.mock('./meetings/MeetingsV2.js', () => ({
  // Exposes every controlled prop as a probe + every callback as a trigger, so
  // these tests can assert on EngagementPage's own state directly (rather than
  // reverse-engineering it from the real calendar's rendered DOM) and drive
  // the state→URL direction the same way the real component would.
  MeetingsV2: (props: {
    viewMode: string;
    cursor: Date;
    selectedMeetingId: string | null;
    detailTab: string;
    onViewModeChange: (m: string) => void;
    onCursorChange: (d: Date) => void;
    onSelectedMeetingChange: (id: string | null) => void;
    onDetailTabChange: (t: string) => void;
    onCreateMeeting: (d?: Date) => void;
  }) => (
    <div data-testid="meetings-v2-probe">
      <span data-testid="mv2-view-mode">{props.viewMode}</span>
      <span data-testid="mv2-cursor">{props.cursor.toISOString().slice(0, 10)}</span>
      <span data-testid="mv2-selected">{props.selectedMeetingId ?? ''}</span>
      <span data-testid="mv2-detail-tab">{props.detailTab}</span>
      <button onClick={() => props.onViewModeChange('month')}>set-month</button>
      <button onClick={() => props.onSelectedMeetingChange(null)}>clear-selection</button>
      <button onClick={() => props.onCreateMeeting(props.cursor)}>trigger-create</button>
    </div>
  ),
}));

vi.mock('./OutreachView.js', () => ({ OutreachView: () => <div data-testid="outreach-probe" /> }));

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location-probe" data-pathname={location.pathname} data-search={location.search}>
      {location.pathname}
      {location.search}
    </div>
  );
}

function NavControls() {
  const navigate = useNavigate();
  return (
    <div>
      <button onClick={() => navigate(-1)}>nav-back</button>
      <button onClick={() => navigate(1)}>nav-forward</button>
    </div>
  );
}

function renderPage(initialEntries: string[], initialIndex?: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>
        <MemoryRouter initialEntries={initialEntries} initialIndex={initialIndex}>
          <NavControls />
          <LocationProbe />
          <EngagementPage />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

function searchOf(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId('location-probe').getAttribute('data-search') ?? '');
}

function routeGet(url: string): Promise<{ data: unknown }> {
  if (url === '/api/clients') return Promise.resolve({ data: [] });
  if (url === '/api/engagement/capabilities') {
    return Promise.resolve({
      data: {
        ai: { activeProvider: 'anthropic' },
        notes: { encryptedNotesConfigured: true },
        attachments: { s3Configured: true, maxBytes: 10_000_000 },
      },
    });
  }
  if (url === '/api/engagement/tasks') return Promise.resolve({ data: [] });
  if (url === '/api/engagement/mail-threads') return Promise.resolve({ data: [] });
  if (url === '/api/engagement/reports/overview') {
    return Promise.resolve({
      data: {
        cycle: { period: 'current', label: 'Current Cycle', from: null, to: null },
        summary: {
          targetOffices: 0,
          meetingsHeld: 0,
          outreachSent: 0,
          submissionsFiled: 0,
          pendingActions: 0,
        },
        rows: [],
      },
    });
  }
  return Promise.resolve({ data: [] });
}

describe('EngagementPage — Meetings v2 URL state', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiGetMock.mockImplementation((url: string) => routeGet(url));
    apiPostMock.mockResolvedValue({ data: {} });
  });

  test('legacy view=calendar maps to the canonical month view and the URL is rewritten', async () => {
    renderPage(['/engagement/meetings?view=calendar']);

    await waitFor(() => expect(screen.getByTestId('mv2-view-mode')).toHaveTextContent('month'));
    await waitFor(() => expect(searchOf().get('view')).toBe('month'));
    expect(screen.getByTestId('location-probe').getAttribute('data-search')).not.toContain('calendar');
  });

  test('canonical serialization always writes view=month, never view=calendar', async () => {
    renderPage(['/engagement/meetings']);
    await waitFor(() => expect(screen.getByTestId('meetings-v2-probe')).toBeInTheDocument());

    fireEvent.click(screen.getByText('set-month'));

    await waitFor(() => expect(searchOf().get('view')).toBe('month'));
    expect(screen.getByTestId('location-probe').getAttribute('data-search')).not.toContain('calendar');
  });

  test('deep link restores meeting/tab/view/date exactly after a fresh mount (full reload)', async () => {
    renderPage(['/engagement/meetings/m-123?detail=notes&view=list&date=2026-07-20']);

    await waitFor(() => {
      expect(screen.getByTestId('mv2-selected')).toHaveTextContent('m-123');
      expect(screen.getByTestId('mv2-detail-tab')).toHaveTextContent('notes');
      expect(screen.getByTestId('mv2-view-mode')).toHaveTextContent('list');
      expect(screen.getByTestId('mv2-cursor')).toHaveTextContent('2026-07-20');
    });
  });

  test('browser back/forward follows the URL without a clobber loop', async () => {
    renderPage(
      ['/engagement/meetings?view=list&date=2026-07-01', '/engagement/meetings?view=month&date=2026-07-15'],
      1,
    );
    await waitFor(() => expect(screen.getByTestId('mv2-view-mode')).toHaveTextContent('month'));
    expect(screen.getByTestId('mv2-cursor')).toHaveTextContent('2026-07-15');

    fireEvent.click(screen.getByText('nav-back'));
    await waitFor(() => expect(screen.getByTestId('mv2-view-mode')).toHaveTextContent('list'));
    expect(screen.getByTestId('mv2-cursor')).toHaveTextContent('2026-07-01');

    fireEvent.click(screen.getByText('nav-forward'));
    await waitFor(() => expect(screen.getByTestId('mv2-view-mode')).toHaveTextContent('month'));
    expect(screen.getByTestId('mv2-cursor')).toHaveTextContent('2026-07-15');
  });

  test('v2 disables the legacy meetings query entirely', async () => {
    renderPage(['/engagement/meetings']);
    await waitFor(() => expect(screen.getByTestId('meetings-v2-probe')).toBeInTheDocument());

    const legacyMeetingsCalls = apiGetMock.mock.calls.filter(([url]) => url === '/api/engagement/meetings');
    expect(legacyMeetingsCalls).toHaveLength(0);
  });

  test('the header New meeting button is visible under v2 and opens the create-meeting modal', async () => {
    renderPage(['/engagement/meetings']);
    await waitFor(() => expect(screen.getByTestId('meetings-v2-probe')).toBeInTheDocument());

    const newMeetingButton = screen.getByRole('button', { name: /new meeting/i });
    fireEvent.click(newMeetingButton);

    expect(await screen.findByRole('dialog', { name: /new meeting/i })).toBeInTheDocument();
  });

  test('Add target office is visible in the Reports header and empty state, and opens the modal', async () => {
    renderPage(['/engagement/reports']);
    await waitFor(() => expect(screen.getByText('Office Engagement Tracker')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/No Target Offices Are Linked/i)).toBeInTheDocument());

    const addButtons = screen.getAllByRole('button', { name: /add target office/i });
    // Header control + the empty-state's own action (spec Phase 2 §2b2).
    expect(addButtons.length).toBeGreaterThanOrEqual(2);
    const [headerAddButton] = addButtons;
    if (!headerAddButton) throw new Error('expected at least one Add target office button');

    fireEvent.click(headerAddButton);
    expect(await screen.findByRole('dialog', { name: /add target office/i })).toBeInTheDocument();
  });
});
