import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, orgId: 'org-test', userId: 'user-test' }),
}));
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGet }) }));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: undefined }) }));

import { HearingDetailRoute } from './HearingDetailRoute.js';
import { SavedHearingSessions } from './SavedHearingSessions.js';
import { ArchiveSubTab } from './ArchiveSubTab.js';
import type { SavedHearingSessionsResponse } from '../lib/saved-hearing-sessions.js';

const HEARING_ID = '119-64382-2026-07-29';
const SESSION_ID = 'browser-fauci-regression';
const BASE = `/api/legiwatch/live-hearings/events/${HEARING_ID}`;
const savedResponse: SavedHearingSessionsResponse = {
  hearingId: HEARING_ID,
  savedSessionsState: 'available',
  sessions: [{
    id: SESSION_ID,
    title: 'Hearings to examine the testimony of Anthony Fauci',
    status: 'ended',
    transcriptSegmentCount: 710,
    intelligenceMomentCount: 19,
    recordingPath: `/intelligence/hearing-watch/${SESSION_ID}`,
    association: 'hearing_id',
    sourceUrl: 'https://example.senate.gov/hearings/fauci',
    startedAt: '2026-07-29T14:00:00Z',
    endedAt: '2026-07-29T17:13:36Z',
  }],
};
const publicHearing = {
  id: HEARING_ID,
  title: 'TESTIMONY OF ANTHONY FAUCI',
  chamber: 'Senate',
  date: '2026-07-29',
  eventStatus: 'completed',
  visibility: 'public',
  eventType: 'hearing',
  committeeName: 'Homeland Security and Governmental Affairs Committee',
  committeeSystemCode: 'ssga00',
  witnesses: [],
  capture: null,
};

function renderPage(kind: 'detail' | 'panel' | 'archive') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[kind === 'detail' ? `/legiwatch/hearings/${HEARING_ID}` : '/test']}>
        <Routes>
          <Route path="/legiwatch/hearings/:hearingId" element={<HearingDetailRoute />} />
          <Route path="/test" element={kind === 'archive' ? <ArchiveSubTab clientId="" /> : <SavedHearingSessions hearingId={HEARING_ID} />} />
          <Route path="/intelligence/hearing-watch/:sessionId" element={<div>Saved recording room reached</div>} />
          <Route path="/legiwatch" element={<div>My Sessions reached</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation(async (url) => {
    if (url === `${BASE}/sessions`) return { data: savedResponse };
    if (url === BASE) return { data: publicHearing };
    if (url.startsWith(`${BASE}/transcript`)) return { data: { items: [], total: 0, nextCursor: null } };
    if (url.startsWith(`${BASE}/intelligence`)) return { data: { items: [], status: 'READY' } };
    if (url === `${BASE}/follow`) return { data: { following: false, clients: [] } };
    if (url === `${BASE}/attendance`) return { data: { state: 'NOT_ELIGIBLE', message: 'Proceeding completed.', canRequest: false, scheduled: false } };
    throw new Error(`unexpected GET ${url}`);
  });
});
afterEach(cleanup);

describe('LW-03 saved sessions in the hearing journey', () => {
  it('opens the saved recording from a completed public hearing with no automatic capture', async () => {
    renderPage('detail');
    const panel = await screen.findByRole('region', { name: 'Saved hearing sessions' });
    const link = await within(panel).findByRole('link', { name: /Open saved session:.*Fauci/ });
    expect(panel).toHaveTextContent('710 saved transcript segments');
    expect(panel).toHaveTextContent('19 intelligence moments');
    // "No automatic capture requested" is inside the Live & Capture tab
    fireEvent.click(screen.getByRole('tab', { name: 'Live & Capture' }));
    expect(screen.getByText('No automatic capture requested')).toBeInTheDocument();
    expect(screen.queryByText(/Capiro has no transcript for this proceeding/)).not.toBeInTheDocument();
    // Return to Overview to access the saved sessions panel
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    const panelAgain = await screen.findByRole('region', { name: 'Saved hearing sessions' });
    const linkAgain = await within(panelAgain).findByRole('link', { name: /Open saved session:.*Fauci/ });
    expect(linkAgain).toHaveAttribute('href', `/intelligence/hearing-watch/${SESSION_ID}`);
    fireEvent.click(linkAgain);
    expect(await screen.findByText('Saved recording room reached')).toBeInTheDocument();
  });

  it('keeps a failed session lookup distinct from zero and retries', async () => {
    apiGet.mockRejectedValue(new Error('temporary lookup failure'));
    renderPage('panel');
    expect(await screen.findByRole('alert')).toHaveTextContent('does not mean no recording exists');
    expect(screen.queryByText(/No accessible saved session is linked/)).not.toBeInTheDocument();
    apiGet.mockResolvedValue({ data: savedResponse });
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved sessions' }));
    expect(await screen.findByRole('link', { name: /Open saved session/ })).toBeInTheDocument();
  });

  it('does not render a mismatched hearing response as a valid association', async () => {
    apiGet.mockResolvedValue({ data: { ...savedResponse, hearingId: 'different-proceeding' } });
    renderPage('panel');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open saved session/ })).not.toBeInTheDocument();
  });

  it('labels a rollout-unavailable response as unknown', async () => {
    apiGet.mockResolvedValue({ data: { ...savedResponse, savedSessionsState: 'unavailable', sessions: [] } });
    renderPage('panel');
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be checked');
    expect(screen.queryByText(/No accessible saved session is linked/)).not.toBeInTheDocument();
  });

  it('offers My Sessions when no verified association is found', async () => {
    apiGet.mockResolvedValue({ data: { ...savedResponse, sessions: [] } });
    renderPage('panel');
    const link = await screen.findByRole('link', { name: 'Browse My Sessions' });
    expect(screen.getByText(/recordings without a verified hearing link/)).toBeInTheDocument();
    fireEvent.click(link);
    expect(await screen.findByText('My Sessions reached')).toBeInTheDocument();
  });

  it('retains separate public counts and opens a saved transcript from Archive Available results', async () => {
    apiGet.mockImplementation(async (url) => {
      if (!url.startsWith('/api/legiwatch/live-hearings/archive/search?')) throw new Error(url);
      return { data: {
        rows: [{
          ...publicHearing,
          calendarDate: '2026-07-29', scheduledStart: null, time: null, timeZone: null,
          location: null, officialPageUrl: null, captureStatus: null,
          transcript: { available: false, segmentCount: 0, officialTranscriptId: null, gapSeconds: null },
          intelligenceCount: 0, transcriptHit: null, intelligenceHit: null, matchTier: null,
          savedSessions: savedResponse.sessions, savedTranscriptAvailable: true,
          detailPath: `/legiwatch/hearings/${HEARING_ID}`,
        }],
        total: 1, corpusTotal: 1, page: 1, pageSize: 20, hasMore: false,
        matchMode: null, query: null, savedSessionsState: 'available',
        facets: { chamber: [], committee: [], eventStatus: [] },
      } };
    });
    renderPage('archive');
    await screen.findByText('Saved transcript');
    const transcriptFilter = screen.getByRole('combobox', { name: 'Transcript availability' });
    fireEvent.change(transcriptFilter, { target: { value: 'true' } });
    await waitFor(() => expect(apiGet.mock.calls.some(([url]) => url.includes('hasTranscript=true'))).toBe(true));
    expect(screen.queryByText(/No public transcript or linked saved transcript/)).not.toBeInTheDocument();
    const link = await screen.findByRole('link', { name: /Open saved session/ });
    fireEvent.click(link);
    expect(await screen.findByText('Saved recording room reached')).toBeInTheDocument();
  });
});
