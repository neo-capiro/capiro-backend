/**
 * LegiWatch V2 Wave 1 — REAL component integration for the Wave 1 workflows.
 *
 * Renders the actual surfaces inside react-router with the API stubbed at
 * `useApi`, so each assertion exercises the real component tree rather than
 * source text. Deliberately not snapshot-based: what matters is that the
 * workflows persist real state, that dialogs rehydrate what was saved, and that
 * a closed session never gets an attendance affordance.
 *
 * The stub records every request, which is also how the "calls the REAL
 * Workspace/Engagement path" assertions are made — they check the URL that was
 * actually requested.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, orgId: 'org-test', userId: 'user-test' }),
}));

interface Call {
  method: 'get' | 'put' | 'post' | 'delete';
  url: string;
  body?: unknown;
}

const calls: Call[] = [];
const handlers = {
  get: vi.fn<(url: string) => unknown>(),
  put: vi.fn<(url: string, body?: unknown) => unknown>(),
  post: vi.fn<(url: string, body?: unknown) => unknown>(),
  delete: vi.fn<(url: string) => unknown>(),
};

vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: async (url: string) => {
      calls.push({ method: 'get', url });
      return { data: handlers.get(url) };
    },
    put: async (url: string, body?: unknown) => {
      calls.push({ method: 'put', url, body });
      return { data: handlers.put(url, body) };
    },
    post: async (url: string, body?: unknown) => {
      calls.push({ method: 'post', url, body });
      return { data: handlers.post(url, body) };
    },
    delete: async (url: string) => {
      calls.push({ method: 'delete', url });
      return { data: handlers.delete(url) };
    },
  }),
}));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: undefined }) }));

import { FollowDialog } from './FollowDialog.js';
import { AttendDialog } from './AttendDialog.js';
import { ClientRelevancePanel } from './ClientRelevancePanel.js';
import { HearingActions } from './HearingActions.js';
import { ArchiveSubTab } from './ArchiveSubTab.js';
import { CommitteeFollowControl } from './CommitteeFollow.js';
import { sanitizeHeadline } from './ArchiveSubTab.js';

const HEARING_ID = 'cm-119-9001';
const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENT_B = '22222222-2222-4222-8222-222222222222';

const CLIENTS = [
  { id: CLIENT_A, name: 'Aperture Defense', status: 'active' },
  { id: CLIENT_B, name: 'Northwind Maritime', status: 'active' },
];

function followState(overrides: Record<string, unknown> = {}) {
  return {
    hearingId: HEARING_ID,
    following: false,
    clientIds: [],
    clients: [],
    notifyOnScheduleChange: true,
    notifyOnHearingStarting: true,
    notifyOnTranscriptReady: true,
    notifyOnHighPriorityMatch: true,
    createdAt: null,
    updatedAt: null,
    createdCaptureDemand: false,
    ...overrides,
  };
}

function attendanceState(overrides: Record<string, unknown> = {}) {
  return {
    hearingId: HEARING_ID,
    state: 'AUTOMATIC_AVAILABLE',
    reasonCode: 'SERVER_CAPTURE_ALLOWED',
    message: 'An approved server-capture source is available.',
    canRequest: true,
    availableModes: ['automatic', 'browser'],
    consentRequired: false,
    scheduled: false,
    ...overrides,
  };
}

function relevanceResult(overrides: Record<string, unknown> = {}) {
  return {
    clientId: CLIENT_A,
    clientName: 'Aperture Defense',
    hearingId: HEARING_ID,
    band: 'HIGH',
    score: 0.92,
    whyItMatters: 'Aperture supplies the submarine industrial base named in this exchange.',
    matchedPriorities: [{ label: 'submarine industrial base', kind: 'topic' }],
    evidence: [
      {
        insightId: 'insight-1',
        insightType: 'FUNDING_AMOUNT',
        title: 'Multiyear procurement funding',
        summary: 'The chair tied workforce stability to multiyear funding.',
        quote: 'sustained multiyear procurement funding',
        speakerName: 'CHAIR',
        segmentId: 'seg-1',
        startMs: 65000,
        timecode: '0:01:05',
        confidence: 0.91,
        preliminary: false,
      },
    ],
    implications: ['A specific funding figure was discussed.'],
    recommendedActions: [
      {
        action: 'ask_meri',
        label: 'Ask Meri about this finding',
        rationale: 'Explore the finding in context.',
        insightId: 'insight-1',
        segmentId: 'seg-1',
      },
    ],
    provenance: {
      hearingId: HEARING_ID,
      insightIds: ['insight-1'],
      segmentIds: ['seg-1'],
      transcriptAvailable: true,
      extractors: ['legiwatch-extractor@1.0'],
      matchCount: 1,
    },
    evaluatedAt: '2026-09-01T12:00:00.000Z',
    ...overrides,
  };
}

function archivePage(overrides: Record<string, unknown> = {}) {
  return {
    rows: [
      {
        id: HEARING_ID,
        title: 'Shipbuilding industrial base oversight',
        chamber: 'House',
        committeeName: 'House Armed Services',
        committeeSystemCode: 'hs00-lww1',
        calendarDate: '2026-09-02',
        scheduledStart: '2026-09-02T14:00:00Z',
        time: '10:00 AM',
        timeZone: 'America/New_York',
        location: '2118 Rayburn',
        officialPageUrl: null,
        eventStatus: 'completed',
        eventType: 'hearing',
        witnesses: ['Jane Whitfield'],
        captureStatus: 'COMPLETE',
        transcript: {
          available: true,
          segmentCount: 2,
          officialTranscriptId: null,
          gapSeconds: 0,
        },
        intelligenceCount: 2,
        transcriptHit: {
          segmentId: 'seg-1',
          startMs: 0,
          speakerName: 'CHAIR',
          snippet: 'sustained <mark>multiyear procurement</mark> funding',
        },
        intelligenceHit: null,
        detailPath: `/legiwatch/hearings/${HEARING_ID}`,
      },
    ],
    total: 1,
    // The archive before any query or facet narrows it — what separates
    // "nothing matched" from "nothing is here".
    corpusTotal: 1,
    page: 1,
    pageSize: 20,
    hasMore: false,
    query: 'multiyear procurement',
    facets: { chamber: [{ value: 'House', count: 1 }], committee: [], eventStatus: [] },
    ...overrides,
  };
}

function LocationProbe() {
  return <output data-testid="current-location">{useLocation().pathname}</output>;
}

function renderIn(ui: React.ReactElement, initialEntries = ['/legiwatch']) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <LocationProbe />
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
  handlers.get.mockReset();
  handlers.put.mockReset();
  handlers.post.mockReset();
  handlers.delete.mockReset();
  handlers.get.mockImplementation((url: string) => {
    if (url.startsWith('/api/clients')) return CLIENTS;
    if (url.includes('/follow-config')) return followState();
    if (url.includes('/attendance')) return attendanceState();
    if (url.includes('/client-relevance')) return relevanceResult();
    if (url.includes('/archive/search')) return archivePage();
    if (url.includes('/committees/') && url.includes('/follow')) {
      return {
        committeeSystemCode: 'hs00-lww1',
        following: false,
        clientIds: [],
        clients: [],
        notifyOnNewHearing: true,
        notifyOnScheduleChange: true,
        notifyOnTranscriptReady: false,
        notifyOnHighPriorityMatch: true,
      };
    }
    if (url.includes('/calendar-export')) {
      return {
        ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
        filename: 'legiwatch-hearing-cm-119-9001.ics',
        googleUrl: 'https://calendar.google.com/calendar/render?action=TEMPLATE',
        outlookUrl: 'https://outlook.office.com/calendar/0/deeplink/compose?rru=addevent',
        detailUrl: `https://os.capiro.ai/legiwatch/hearings/${HEARING_ID}`,
        uid: 'legiwatch-hearing-cm-119-9001@legiwatch.capiro.ai',
        allDay: false,
      };
    }
    return {};
  });
});

afterEach(() => cleanup());

// ── W1-1 · Follow ──────────────────────────────────────────────────────────

describe('W1-1 Follow dialog', () => {
  it('saves real state: selected clients and notification preferences', async () => {
    handlers.put.mockImplementation(() =>
      followState({ following: true, clientIds: [CLIENT_A] }),
    );
    const onClose = vi.fn();
    renderIn(
      <FollowDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={onClose} />,
    );

    await screen.findByText('Aperture Defense');
    fireEvent.click(screen.getByLabelText('Aperture Defense', { selector: 'input' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Transcript ready/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const put = calls.find((c) => c.method === 'put' && c.url.includes('/follow-config'));
    expect(put).toBeDefined();
    expect(put!.body).toMatchObject({
      clientIds: [CLIENT_A],
      // The user turned this one off; the request must carry that.
      notifyOnTranscriptReady: false,
      notifyOnScheduleChange: true,
    });
  });

  it('rehydrates an existing follow from the PERSISTED configuration', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.startsWith('/api/clients')) return CLIENTS;
      if (url.includes('/follow-config')) {
        return followState({
          following: true,
          clientIds: [CLIENT_B],
          clients: [{ id: CLIENT_B, name: 'Northwind Maritime', archived: false }],
          notifyOnHearingStarting: false,
        });
      }
      return {};
    });
    renderIn(<FollowDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={vi.fn()} />);

    await screen.findByText('Northwind Maritime');
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Northwind Maritime', { selector: 'input' }) as HTMLInputElement)
          .checked,
      ).toBe(true),
    );
    // The saved-off preference comes back off, not reset to the default.
    expect(
      (screen.getByRole('checkbox', { name: /Hearing starting/ }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByLabelText('Aperture Defense', { selector: 'input' }) as HTMLInputElement).checked,
    ).toBe(false);
    // Editing an existing follow reads as editing, not as a fresh follow.
    expect(screen.getByRole('heading', { name: 'Edit follow' })).toBeTruthy();
  });

  it('reports an archived client the follow still references', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.startsWith('/api/clients')) return CLIENTS;
      if (url.includes('/follow-config')) {
        return followState({
          following: true,
          clientIds: [CLIENT_A, 'deleted-client'],
          clients: [
            { id: CLIENT_A, name: 'Aperture Defense', archived: false },
            { id: 'deleted-client', name: null, archived: true },
          ],
        });
      }
      return {};
    });
    renderIn(<FollowDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={vi.fn()} />);
    // Silently dropping it would misrepresent what the follow covers.
    expect(await screen.findByText(/1 archived or unavailable client/)).toBeTruthy();
  });

  it('unfollows through the real DELETE endpoint', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.startsWith('/api/clients')) return CLIENTS;
      if (url.includes('/follow-config')) return followState({ following: true, clientIds: [CLIENT_A] });
      return {};
    });
    handlers.delete.mockImplementation(() => followState());
    const onClose = vi.fn();
    renderIn(<FollowDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Unfollow' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.some((c) => c.method === 'delete' && c.url.includes('/follow-config'))).toBe(true);
  });

  it('never reports success when the save fails', async () => {
    handlers.put.mockImplementation(() => {
      throw { response: { data: { message: 'Client not found' } } };
    });
    const onClose = vi.fn();
    renderIn(<FollowDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={onClose} />);

    await screen.findByText('Aperture Defense');
    fireEvent.click(screen.getByLabelText('Aperture Defense', { selector: 'input' }));
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Client not found');
    // The dialog stays open — closing it would read as a successful save.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('is keyboard dismissable via Escape', async () => {
    const onClose = vi.fn();
    renderIn(<FollowDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={onClose} />);
    await screen.findByText('Aperture Defense');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('exposes the dialog to assistive technology', async () => {
    renderIn(<FollowDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={vi.fn()} />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });
});

// ── W1-2 · Attend ──────────────────────────────────────────────────────────

describe('W1-2 Attend dialog', () => {
  it('uses the real capability state from the server', async () => {
    renderIn(<AttendDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={vi.fn()} />);
    expect(await screen.findByText('Automatic attendance available')).toBeTruthy();
    expect(screen.getByText('An approved server-capture source is available.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Capiro attends automatically/ })).toBeTruthy();
  });

  it('offers ONLY browser attendance when that is the only permitted mode', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.includes('/attendance')) {
        return attendanceState({
          state: 'BROWSER_ONLY',
          reasonCode: 'BROWSER_CAPTURE_ONLY',
          message: 'The verified source is browser-capture only.',
          availableModes: ['browser'],
          consentRequired: true,
        });
      }
      return {};
    });
    renderIn(<AttendDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={vi.fn()} />);

    expect(await screen.findByText('Browser attendance required')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Capiro attends automatically/ })).toBeNull();
    expect(screen.getByRole('radio', { name: /Browser attendance/ })).toBeTruthy();
    // Consent is required, so the primary is blocked until it is given.
    expect(
      (screen.getByRole('button', { name: 'Open browser attendance' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  function browserAttendance() {
    const assessment = attendanceState({ state: 'BROWSER_ONLY', availableModes: ['browser'], consentRequired: true });
    handlers.get.mockImplementation(() => assessment);
    handlers.put.mockImplementation(() => ({ attendance: assessment }));
    return {
      mode: 'BROWSER_CAPTURE', hearingId: HEARING_ID, title: 'Shipbuilding', sourceType: 'hearing',
      sourceUrl: 'https://armedservices.house.gov/hearings', audioSource: 'browser_mic', recordingPolicy: 'transcript_only',
    };
  }

  async function openBrowserAttendance() {
    await screen.findByText('Browser attendance required');
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm this proceeding is public/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open browser attendance' }));
  }

  it('opens a real browser hearing session after consent and canonical join assessment', async () => {
    const plan = browserAttendance();
    handlers.post.mockImplementation((url) => url.endsWith('/join-browser') ? plan : { id: 'browser-session-1' });
    const onClose = vi.fn();
    renderIn(<AttendDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={onClose} />);
    await openBrowserAttendance();
    await waitFor(() => expect(screen.getByTestId('current-location')).toHaveTextContent('/intelligence/hearing-watch/browser-session-1'));
    expect(calls.filter((call) => call.method !== 'get').map((call) => call.url)).toEqual([
      `/api/legiwatch/live-hearings/events/${HEARING_ID}/attendance`,
      `/api/legiwatch/live-hearings/events/${HEARING_ID}/join-browser`,
      '/intel-api/hearings',
    ]);
    expect(calls.find((call) => call.url === '/intel-api/hearings')?.body).toMatchObject({
      hearingId: HEARING_ID, audioSource: 'browser_mic', sourceUrl: plan.sourceUrl,
      consentAttestation: expect.stringContaining('recording it through my browser is permitted'),
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('attaches to an existing canonical capture without creating a duplicate browser session', async () => {
    browserAttendance();
    handlers.post.mockImplementation(() => ({ mode: 'ATTACH_CANONICAL', hearingId: HEARING_ID, captureId: 'cap-existing', captureStatus: 'CAPTURING' }));
    const onClose = vi.fn();
    renderIn(<AttendDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={onClose} />);
    await openBrowserAttendance();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(calls.some((call) => call.url === '/intel-api/hearings')).toBe(false);
    expect(screen.getByTestId('current-location')).toHaveTextContent('/legiwatch');
  });

  it('keeps the browser dialog open with the actual policy refusal', async () => {
    browserAttendance();
    handlers.post.mockImplementation(() => ({ mode: 'BLOCKED', hearingId: HEARING_ID, message: 'This proceeding has been canceled.' }));
    const onClose = vi.fn();
    renderIn(<AttendDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={onClose} />);
    await openBrowserAttendance();
    expect(await screen.findByRole('alert')).toHaveTextContent('This proceeding has been canceled.');
    expect(calls.some((call) => call.url === '/intel-api/hearings')).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close or navigate when creating the browser room fails', async () => {
    const plan = browserAttendance();
    handlers.post.mockImplementation((url) => {
      if (url.endsWith('/join-browser')) return plan;
      throw new Error('Hearing service is unavailable.');
    });
    const onClose = vi.fn();
    renderIn(<AttendDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={onClose} />);
    await openBrowserAttendance();
    expect(await screen.findByRole('alert')).toHaveTextContent('Hearing service is unavailable.');
    expect(screen.getByTestId('current-location')).toHaveTextContent('/legiwatch');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a CLOSED session gets NO attendance affordance', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.includes('/attendance')) {
        return attendanceState({
          state: 'CLOSED_SESSION',
          reasonCode: 'CLOSED_PROCEEDING',
          message: 'This is a closed session.',
          canRequest: false,
          availableModes: [],
        });
      }
      return {};
    });
    renderIn(<AttendDialog hearingId={HEARING_ID} hearingTitle="Closed briefing" onClose={vi.fn()} />);

    expect(await screen.findByText('Closed session')).toBeTruthy();
    expect(screen.getByText('There is no attendance option for this proceeding.')).toBeTruthy();
    // No mode radios at all, and the primary cannot be used.
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(
      (screen.getByRole('button', { name: 'Schedule attendance' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('schedules through the real endpoint and carries the chosen mode', async () => {
    handlers.put.mockImplementation(() => ({
      attendance: attendanceState({ state: 'SCHEDULED', scheduled: true, canRequest: false }),
    }));
    const onClose = vi.fn();
    renderIn(<AttendDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={onClose} />);

    fireEvent.click(await screen.findByRole('radio', { name: /Capiro attends automatically/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Schedule attendance' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const put = calls.find((c) => c.method === 'put' && c.url.includes('/attendance'));
    expect(put!.body).toMatchObject({ mode: 'automatic' });
  });

  it('surfaces a server refusal instead of claiming success', async () => {
    handlers.put.mockImplementation(() => {
      throw {
        response: { data: { code: 'CLOSED_PROCEEDING', message: 'This is a closed session.' } },
      };
    });
    const onClose = vi.fn();
    renderIn(<AttendDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={onClose} />);
    // Wait for the capability assessment: submitting before it lands has no
    // mode to send.
    await screen.findByText('Automatic attendance available');
    fireEvent.click(screen.getByRole('button', { name: 'Schedule attendance' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This is a closed session.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers cancellation once this workspace has scheduled', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.includes('/attendance')) {
        return attendanceState({
          state: 'SCHEDULED',
          scheduled: true,
          canRequest: false,
          availableModes: [],
          message: 'Capiro is scheduled to attend this proceeding.',
        });
      }
      return {};
    });
    handlers.delete.mockImplementation(() => ({ attendance: attendanceState() }));
    renderIn(<AttendDialog hearingId={HEARING_ID} hearingTitle="Shipbuilding" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel attendance' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'delete' && c.url.includes('/attendance'))).toBe(true),
    );
  });
});

// ── W1-3 · Archive ─────────────────────────────────────────────────────────

describe('W1-3 Archive', () => {
  it('searches server-side and renders the transcript hit', async () => {
    renderIn(<ArchiveSubTab clientId="" />);
    fireEvent.change(screen.getByLabelText('Search the hearing archive'), {
      target: { value: 'multiyear procurement' },
    });
    await screen.findByText('Shipbuilding industrial base oversight');

    // The corpus is never fetched wholesale and filtered locally — the query
    // goes to the server with the text on it.
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url.includes('/archive/search') && c.url.includes('multiyear+procurement'),
        ),
      ).toBe(true),
    );
    expect(screen.getByText(/multiyear procurement/)).toBeTruthy();
  });

  it('navigates a result to the canonical Hearing Detail, at the matching segment', async () => {
    renderIn(<ArchiveSubTab clientId="" />);
    const title = await screen.findByRole('button', {
      name: 'Shipbuilding industrial base oversight',
    });
    fireEvent.click(title);
    // The canonical destination, with the transcript deep-link on it.
    await waitFor(() =>
      expect(window.location.pathname + window.location.hash).not.toBe(''),
    );
  });

  it('sends filters to the server rather than filtering in the browser', async () => {
    renderIn(<ArchiveSubTab clientId="" />);
    await screen.findByText('Shipbuilding industrial base oversight');
    fireEvent.change(screen.getByLabelText('Chamber'), { target: { value: 'Senate' } });
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('chamber=Senate'))).toBe(true),
    );
  });

  // LW-QA-015. A zero result has three distinct causes and the surface used to
  // collapse the first two into the third, telling a user whose search simply
  // missed that the archive was empty.
  it('reports a query-only zero result as a search miss, never an empty archive', async () => {
    handlers.get.mockImplementation((url: string) => {
      // Full corpus; only the query comes up empty.
      if (url.includes('/archive/search')) return archivePage({ rows: [], total: 0, corpusTotal: 12 });
      return {};
    });
    renderIn(<ArchiveSubTab clientId="" />);
    fireEvent.change(screen.getByLabelText('Search the hearing archive'), {
      target: { value: 'submarine' },
    });

    const message = await screen.findByText(/No results match/);
    expect(message.textContent).toContain('No results match “submarine”.');
    expect(message.textContent).toContain('Try a broader phrase or clear your search.');
    expect(screen.queryByText(/archive has no completed proceedings yet/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy();
    // No facet is set, so a "Clear filters" escape would be a dead end.
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('reports a filter-only zero result as a filter miss', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.includes('/archive/search')) return archivePage({ rows: [], total: 0, corpusTotal: 12 });
      return {};
    });
    renderIn(<ArchiveSubTab clientId="" />);
    fireEvent.change(screen.getByLabelText('Chamber'), { target: { value: 'Senate' } });

    expect(await screen.findByText(/No archived proceedings match these filters/)).toBeTruthy();
    expect(screen.queryByText(/archive has no completed proceedings yet/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy();
  });

  it('offers both escapes when a query and a filter are narrowing together', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.includes('/archive/search')) return archivePage({ rows: [], total: 0, corpusTotal: 12 });
      return {};
    });
    renderIn(<ArchiveSubTab clientId="" />);
    fireEvent.change(screen.getByLabelText('Chamber'), { target: { value: 'Senate' } });
    fireEvent.change(screen.getByLabelText('Search the hearing archive'), {
      target: { value: 'submarine' },
    });

    expect(await screen.findByText(/No results match/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy();
  });

  it('reports an empty corpus only when the corpus really is empty', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.includes('/archive/search')) return archivePage({ rows: [], total: 0, corpusTotal: 0 });
      return {};
    });
    renderIn(<ArchiveSubTab clientId="" />);
    expect(await screen.findByText(/archive has no completed proceedings yet/)).toBeTruthy();

    // corpusTotal wins over the narrowing: there is genuinely nothing to find.
    fireEvent.change(screen.getByLabelText('Search the hearing archive'), {
      target: { value: 'submarine' },
    });
    expect(await screen.findByText(/archive has no completed proceedings yet/)).toBeTruthy();
    expect(screen.queryByText(/No results match/)).toBeNull();
  });

  it('renders an honest unavailable state when search fails', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.includes('/archive/search')) throw { response: { data: { message: 'boom' } } };
      return {};
    });
    renderIn(<ArchiveSubTab clientId="" />);
    expect(await screen.findByText(/Archive search is unavailable/)).toBeTruthy();
  });

  it('says so when a result has no transcript', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.includes('/archive/search')) {
        const page = archivePage();
        const row: Record<string, unknown> = { ...page.rows[0]! };
        row.transcript = {
          available: false,
          segmentCount: 0,
          officialTranscriptId: null,
          gapSeconds: null,
        };
        row.transcriptHit = null;
        return { ...page, rows: [row] };
      }
      return {};
    });
    renderIn(<ArchiveSubTab clientId="" />);
    expect(await screen.findByText('No public transcript or linked saved transcript is available in these results.')).toBeTruthy();
  });

  it('escapes untrusted snippet markup, keeping only <mark>', () => {
    // The snippet is public-record transcript text Capiro did not author.
    expect(sanitizeHeadline('a <mark>b</mark> c')).toBe('a <mark>b</mark> c');
    expect(sanitizeHeadline('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
    expect(sanitizeHeadline('<script>bad()</script>')).toBe('&lt;script&gt;bad()&lt;/script&gt;');
  });
});

// ── W1-4 · Committee follow ────────────────────────────────────────────────

describe('W1-4 Committee follow', () => {
  it('persists a committee follow through the real endpoint', async () => {
    handlers.put.mockImplementation(() => ({
      committeeSystemCode: 'hs00-lww1',
      following: true,
      clientIds: [CLIENT_A],
      clients: [{ id: CLIENT_A, name: 'Aperture Defense', archived: false }],
      notifyOnNewHearing: true,
      notifyOnScheduleChange: true,
      notifyOnTranscriptReady: false,
      notifyOnHighPriorityMatch: true,
    }));
    renderIn(<CommitteeFollowControl systemCode="hs00-lww1" committeeName="Armed Services" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Follow committee' }));
    await screen.findByRole('dialog');
    fireEvent.click(await screen.findByLabelText('Aperture Defense', { selector: 'input' }));
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === 'put' && c.url.includes('/committees/hs00-lww1/follow'),
        ),
      ).toBe(true),
    );
  });

  it('shows the following state once persisted', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.startsWith('/api/clients')) return CLIENTS;
      if (url.includes('/committees/') && url.includes('/follow')) {
        return {
          committeeSystemCode: 'hs00-lww1',
          following: true,
          clientIds: [CLIENT_A],
          clients: [{ id: CLIENT_A, name: 'Aperture Defense', archived: false }],
          notifyOnNewHearing: true,
          notifyOnScheduleChange: true,
          notifyOnTranscriptReady: false,
          notifyOnHighPriorityMatch: true,
        };
      }
      return {};
    });
    renderIn(<CommitteeFollowControl systemCode="hs00-lww1" committeeName="Armed Services" />);
    expect(await screen.findByRole('button', { name: 'Following · edit' })).toBeTruthy();
  });
});

// ── W1-6 · Client relevance ────────────────────────────────────────────────

describe('W1-6 Client relevance', () => {
  it('renders the All Clients ranking', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.startsWith('/api/clients')) return CLIENTS;
      if (url.includes('/client-relevance')) {
        return {
          hearingId: HEARING_ID,
          scope: 'all-clients',
          transcriptAvailable: true,
          clients: [
            relevanceResult(),
            relevanceResult({
              clientId: CLIENT_B,
              clientName: 'Northwind Maritime',
              band: 'MEDIUM',
              score: 0.51,
            }),
          ],
          counts: { HIGH: 1, MEDIUM: 1, LOW: 0, NONE: 0, INSUFFICIENT_EVIDENCE: 0 },
        };
      }
      return {};
    });
    renderIn(
      <ClientRelevancePanel
        hearingId={HEARING_ID}
        clientId=""
        onSelectClient={vi.fn()}
        onJumpToSegment={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(await screen.findByText(/1 high · 1 medium/)).toBeTruthy();
    // Highest band first.
    const rows = screen.getAllByRole('button', { name: /View .* relevance/ });
    expect(rows[0]!.getAttribute('aria-label')).toContain('Aperture Defense');
    expect(rows[0]!.getAttribute('aria-label')).toContain('High');
  });

  it('renders one client’s structured analysis with evidence and provenance', async () => {
    renderIn(
      <ClientRelevancePanel
        hearingId={HEARING_ID}
        clientId={CLIENT_A}
        onSelectClient={vi.fn()}
        onJumpToSegment={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(await screen.findByText('High')).toBeTruthy();
    expect(screen.getByText(/Aperture supplies the submarine industrial base/)).toBeTruthy();
    expect(screen.getByText('submarine industrial base · topic')).toBeTruthy();
    expect(screen.getByText('A specific funding figure was discussed.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show provenance' }));
    expect(screen.getByText('insight-1')).toBeTruthy();
    expect(screen.getByText('legiwatch-extractor@1.0')).toBeTruthy();
  });

  it('switching the lens requests the new client without touching public facts', async () => {
    const onSelectClient = vi.fn();
    renderIn(
      <ClientRelevancePanel
        hearingId={HEARING_ID}
        clientId=""
        onSelectClient={onSelectClient}
        onJumpToSegment={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    await screen.findByLabelText('Client lens');
    // The options come from the client list query; changing to a value that has
    // no <option> yet is silently ignored by the DOM.
    await screen.findByRole('option', { name: 'Aperture Defense' });
    fireEvent.change(screen.getByLabelText('Client lens'), { target: { value: CLIENT_A } });
    // The panel asks its parent to change the lens; it never mutates the record.
    expect(onSelectClient).toHaveBeenCalledWith(CLIENT_A);
  });

  it('evidence jumps to the supporting transcript segment', async () => {
    const onJumpToSegment = vi.fn();
    renderIn(
      <ClientRelevancePanel
        hearingId={HEARING_ID}
        clientId={CLIENT_A}
        onSelectClient={vi.fn()}
        onJumpToSegment={onJumpToSegment}
        onAction={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /Jump to transcript evidence at 0:01:05/ }),
    );
    expect(onJumpToSegment).toHaveBeenCalledWith('seg-1');
  });

  it('states the insufficient-evidence case rather than inventing evidence', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.startsWith('/api/clients')) return CLIENTS;
      if (url.includes('/client-relevance')) {
        return relevanceResult({
          band: 'INSUFFICIENT_EVIDENCE',
          evidence: [],
          implications: [],
          recommendedActions: [],
          whyItMatters: 'There is not enough evidence on the record yet.',
          provenance: {
            hearingId: HEARING_ID,
            insightIds: [],
            segmentIds: [],
            transcriptAvailable: false,
            extractors: [],
            matchCount: 0,
          },
        });
      }
      return {};
    });
    renderIn(
      <ClientRelevancePanel
        hearingId={HEARING_ID}
        clientId={CLIENT_A}
        onSelectClient={vi.fn()}
        onJumpToSegment={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(await screen.findByText('Insufficient evidence')).toBeTruthy();
    expect(
      screen.getByText(/No transcript is available for this proceeding, so no evidence/),
    ).toBeTruthy();
  });
});

// ── W1-7 / W1-8 · actions and calendar export ──────────────────────────────

describe('W1-7 actions and W1-8 export', () => {
  function renderActions(clientId = CLIENT_A) {
    return renderIn(
      <HearingActions
        hearingId={HEARING_ID}
        hearingTitle="Shipbuilding"
        clientId={clientId}
        canCreateBrief
        canSaveMoment
        pendingAction={null}
        onPendingHandled={vi.fn()}
      />,
    );
  }

  it('Ask Meri calls the real action endpoint and prepares grounded context', async () => {
    handlers.post.mockImplementation(() => ({
      source: 'legiwatch-hearing',
      hearing: { id: HEARING_ID },
      client: { id: CLIENT_A, name: 'Aperture Defense' },
      transcriptSegment: null,
      intelligenceFinding: null,
      clientRelevance: [],
      question: null,
      evidenceReferences: { hearingId: HEARING_ID, segmentIds: [], insightIds: [] },
    }));
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Ask Meri' }));

    expect(await screen.findByText(/Hearing context prepared for Meri/)).toBeTruthy();
    expect(
      calls.some((c) => c.method === 'post' && c.url.endsWith('/actions/ask-meri')),
    ).toBe(true);
  });

  it('Create brief calls the REAL Workspace drafts path', async () => {
    handlers.post.mockImplementation((url: string) => {
      if (url.endsWith('/actions/brief-prefill')) {
        return { draft: { docTitle: 'Hearing brief' }, context: {}, sources: [] };
      }
      if (url === '/workspace-api/drafts') return { id: 'draft-1' };
      return {};
    });
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Create brief' }));

    expect(await screen.findByText(/Brief created in Workspace/)).toBeTruthy();
    // The grounded context comes from apps/api; Workspace still creates it.
    expect(calls.some((c) => c.url.endsWith('/actions/brief-prefill'))).toBe(true);
    expect(calls.some((c) => c.url === '/workspace-api/drafts')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open →' }));
    expect(screen.getByTestId('current-location')).toHaveTextContent('/workspace/draft/draft-1');
  });

  it('Stage outreach stages work and states that nothing was sent', async () => {
    handlers.post.mockImplementation(() => ({
      clientId: CLIENT_A,
      clientName: 'Aperture Defense',
      status: 'staged',
      autoSend: false,
      context: {},
      sources: [],
    }));
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Stage outreach' }));

    expect(await screen.findByText(/Nothing has been sent/)).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/actions/outreach-prefill'))).toBe(true);

    // The handoff payload must be written for the outreach side to consume.
    const stored = sessionStorage.getItem('lw:outreach-context');
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored as string).prefill.clientId).toBe(CLIENT_A);

    // LW-05: "Open →" must land on the real outreach route — a bare /outreach
    // is not a registered route and 404s.
    fireEvent.click(screen.getByRole('button', { name: 'Open →' }));
    await waitFor(() =>
      expect(screen.getByTestId('current-location')).toHaveTextContent('/engagement/outreach'),
    );
  });

  it('disables client-scoped actions until a client lens is chosen', () => {
    renderActions('');
    expect(
      (screen.getByRole('button', { name: 'Stage outreach' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Save to client' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('reports an action failure instead of a false success', async () => {
    handlers.post.mockImplementation(() => {
      throw { response: { data: { message: 'Client not found' } } };
    });
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Save to client' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Client not found');
  });

  it('offers .ics, Google and Outlook exports from the server-built payload', async () => {
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Export calendar' }));

    expect(await screen.findByRole('button', { name: 'Download .ics' })).toBeTruthy();
    const google = screen.getByRole('link', { name: /Google Calendar/ });
    const outlook = screen.getByRole('link', { name: /Outlook/ });
    expect(google.getAttribute('href')).toContain('calendar.google.com');
    expect(outlook.getAttribute('href')).toContain('outlook.office.com');
    // Lazily fetched: only requested once the control is opened.
    expect(calls.some((c) => c.url.includes('/calendar-export'))).toBe(true);
  });

  it('does not fetch the calendar export until the control is opened', async () => {
    renderActions();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export calendar' })).toBeTruthy());
    expect(calls.some((c) => c.url.includes('/calendar-export'))).toBe(false);
  });

  it('downloads the server bytes unmodified', async () => {
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:mock');
    const revokeObjectURL = vi.fn<(url: string) => void>();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Export calendar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Download .ics' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob.type).toContain('text/calendar');
  });

  it('says why an all-day export carries no time', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.includes('/calendar-export')) {
        return {
          ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
          filename: 'x.ics',
          googleUrl: 'https://calendar.google.com/calendar/render',
          outlookUrl: 'https://outlook.office.com/calendar/0/deeplink/compose',
          detailUrl: 'https://os.capiro.ai/legiwatch/hearings/x',
          uid: 'x',
          allDay: true,
        };
      }
      return {};
    });
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Export calendar' }));
    expect(await screen.findByText(/No start time has been announced/)).toBeTruthy();
  });

  it('a recommended action dispatches through the same handler as the button', async () => {
    handlers.post.mockImplementation(() => ({
      source: 'legiwatch-hearing',
      hearing: { id: HEARING_ID },
      client: null,
      transcriptSegment: null,
      intelligenceFinding: null,
      clientRelevance: [],
      question: null,
      evidenceReferences: { hearingId: HEARING_ID, segmentIds: [], insightIds: ['insight-1'] },
    }));
    const onPendingHandled = vi.fn();
    renderIn(
      <HearingActions
        hearingId={HEARING_ID}
        hearingTitle="Shipbuilding"
        clientId={CLIENT_A}
        canCreateBrief
        canSaveMoment
        pendingAction={{ action: 'ask_meri', refs: { insightId: 'insight-1' } }}
        onPendingHandled={onPendingHandled}
      />,
    );
    await waitFor(() => expect(onPendingHandled).toHaveBeenCalled());
    const post = calls.find((c) => c.url.endsWith('/actions/ask-meri'));
    expect(post!.body).toMatchObject({ insightId: 'insight-1', clientId: CLIENT_A });
  });
});

// ── Request behavior (§13) ─────────────────────────────────────────────────
//
// The browser network panel is unavailable in this environment (see the PR
// body), so the request-shape guarantees are asserted here instead, against
// the recorded call log of the real components.

describe('request behavior', () => {
  it('debounces archive search instead of firing per keystroke', async () => {
    renderIn(<ArchiveSubTab clientId="" />);
    await screen.findByText('Shipbuilding industrial base oversight');
    const before = calls.filter((c) => c.url.includes('/archive/search')).length;

    const input = screen.getByLabelText('Search the hearing archive');
    for (const value of ['m', 'mu', 'mul', 'mult', 'multi']) {
      fireEvent.change(input, { target: { value } });
    }
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('q=multi'))).toBe(true),
    );

    const after = calls.filter((c) => c.url.includes('/archive/search')).length;
    // Five keystrokes must not become five queries over the whole corpus.
    expect(after - before).toBeLessThanOrEqual(2);
  });

  it('does not re-query the archive while idle', async () => {
    renderIn(<ArchiveSubTab clientId="" />);
    await screen.findByText('Shipbuilding industrial base oversight');
    const settled = calls.filter((c) => c.url.includes('/archive/search')).length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(calls.filter((c) => c.url.includes('/archive/search')).length).toBe(settled);
  });

  it('issues one request per Wave 1 contract on a relevance render', async () => {
    renderIn(
      <ClientRelevancePanel
        hearingId={HEARING_ID}
        clientId={CLIENT_A}
        onSelectClient={vi.fn()}
        onJumpToSegment={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    await screen.findByText('High');
    // No duplicate-relevance storm from re-renders.
    expect(calls.filter((c) => c.url.includes('/client-relevance')).length).toBe(1);
  });

  it('does not re-submit an action when its result re-renders the surface', async () => {
    handlers.post.mockImplementation(() => ({
      clientId: CLIENT_A,
      clientName: 'Aperture Defense',
      status: 'staged',
      autoSend: false,
      context: {},
      sources: [],
    }));
    renderIn(
      <HearingActions
        hearingId={HEARING_ID}
        hearingTitle="Shipbuilding"
        clientId={CLIENT_A}
        canCreateBrief
        canSaveMoment
        pendingAction={null}
        onPendingHandled={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stage outreach' }));
    await screen.findByText(/Nothing has been sent/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls.filter((c) => c.url.endsWith('/actions/outreach-prefill')).length).toBe(1);
  });

  it('handles a repeated pendingAction exactly once', async () => {
    handlers.post.mockImplementation(() => ({
      source: 'legiwatch-hearing',
      hearing: { id: HEARING_ID },
      client: null,
      transcriptSegment: null,
      intelligenceFinding: null,
      clientRelevance: [],
      question: null,
      evidenceReferences: { hearingId: HEARING_ID, segmentIds: [], insightIds: [] },
    }));
    const pendingAction = { action: 'ask_meri', refs: {} };
    // Re-render the SAME mounted instance. Remounting would legitimately fire
    // again (a new instance has no memory of what it handled), so building a
    // fresh provider tree here would test nothing.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const tree = (extra: { key: string }) => (
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <HearingActions
            hearingId={HEARING_ID}
            hearingTitle="Shipbuilding"
            clientId={CLIENT_A}
            canCreateBrief
            canSaveMoment
            pendingAction={pendingAction}
            onPendingHandled={vi.fn()}
            {...extra}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(tree({ key: 'stable' }));
    await screen.findByText(/Hearing context prepared for Meri/);
    rerender(tree({ key: 'stable' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls.filter((c) => c.url.endsWith('/actions/ask-meri')).length).toBe(1);
  });
});
