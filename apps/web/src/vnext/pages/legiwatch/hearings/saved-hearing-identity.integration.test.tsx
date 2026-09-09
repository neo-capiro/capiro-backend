import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ orgId: 'org-a' as string | null, userId: 'user-a' as string | null, isLoaded: true }));
const impersonation = vi.hoisted(() => ({ actAsTenantSlug: null as string | null }));
const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => auth }));
vi.mock('../../../../state/impersonation.js', () => ({ useImpersonation: () => impersonation }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGet }) }));

import { SavedHearingSessions } from './SavedHearingSessions.js';
import { ArchiveSubTab } from './ArchiveSubTab.js';

const HEARING_ID = '119-64382-2026-07-29';
type Pending = { url: string; signal?: AbortSignal; resolve: (data: unknown) => void };
const pending: Pending[] = [];
const clients: QueryClient[] = [];

function payload(url: string, tenant: string) {
  const savedSession = {
    id: `private-${tenant}`, title: `${tenant} private analyst recording`, status: 'ended',
    transcriptSegmentCount: tenant === 'A' ? 710 : 82,
    intelligenceMomentCount: tenant === 'A' ? 19 : 3,
    recordingPath: `/intelligence/hearing-watch/private-${tenant}`,
    association: 'hearing_id', sourceUrl: null, startedAt: null, endedAt: null,
  };
  if (url.endsWith('/sessions')) return { hearingId: HEARING_ID, savedSessionsState: 'available', sessions: [savedSession] };
  return {
    rows: [{
      id: HEARING_ID, title: 'TESTIMONY OF ANTHONY FAUCI', chamber: 'Senate',
      calendarDate: '2026-07-29', scheduledStart: null, time: null, timeZone: null,
      eventStatus: 'completed', publicAccessStatus: 'PUBLIC', eventType: 'hearing',
      committee: null, committeeName: 'Homeland Security', committeeSystemCode: 'ssga00',
      location: null, officialPageUrl: null, captureStatus: null,
      transcript: { available: false, segmentCount: 0, officialTranscriptId: null, gapSeconds: null },
      intelligenceCount: 0, transcriptHit: null, intelligenceHit: null, matchTier: null,
      savedSessions: [savedSession], savedTranscriptAvailable: true,
      detailPath: `/legiwatch/hearings/${HEARING_ID}`,
    }],
    total: 21, corpusTotal: 21, page: 1, pageSize: 20, hasMore: true,
    matchMode: null, query: null, savedSessionsState: 'available',
    facets: { chamber: [], committee: [], eventStatus: [] },
  };
}

function holdRequest(url: string, config?: { signal?: AbortSignal }) {
  return new Promise((resolve) => pending.push({ url, signal: config?.signal, resolve: (data) => resolve({ data }) }));
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SavedHearingSessions hearingId={HEARING_ID} />
        <ArchiveSubTab clientId="" />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, changeIdentity: () => view.rerender(tree()) };
}

function assertPrivateAHidden() {
  expect(screen.queryByText(/A private analyst recording/)).not.toBeInTheDocument();
  expect(screen.queryByText(/710 saved transcript segments|19 intelligence moments/)).not.toBeInTheDocument();
  expect(document.querySelector('a[href="/intelligence/hearing-watch/private-A"]')).toBeNull();
}

beforeEach(() => {
  Object.assign(auth, { orgId: 'org-a', userId: 'user-a', isLoaded: true });
  impersonation.actAsTenantSlug = null;
  pending.splice(0);
  apiGet.mockReset();
  apiGet.mockImplementation(async (url: string) => ({ data: payload(url, 'A') }));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe('LW-03 private metadata cache isolation', () => {
  it.each(['organization', 'user', 'impersonation', 'impersonation-end'] as const)(
    'removes old titles, counts, and links immediately after a %s change with the same hearing and search', async (change) => {
      if (change === 'impersonation-end') impersonation.actAsTenantSlug = 'tenant-a';
      const view = mount();
      await waitFor(() => expect(screen.getAllByRole('link', { name: /Open saved session: A private/ })).toHaveLength(2));
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search the hearing archive' }), { target: { value: 'Fauci' } });
      await waitFor(() => expect(apiGet.mock.calls.some(([url]) => url.includes('q=Fauci'))).toBe(true));
      await waitFor(() => expect(screen.getAllByRole('link', { name: /Open saved session: A private/ })).toHaveLength(2));
      apiGet.mockImplementation(holdRequest);
      if (change === 'organization') auth.orgId = 'org-b';
      if (change === 'user') auth.userId = 'user-b';
      // The slug deliberately equals the old organization ID: tuple namespaces must differ.
      if (change === 'impersonation') impersonation.actAsTenantSlug = 'org-a';
      if (change === 'impersonation-end') impersonation.actAsTenantSlug = null;
      view.changeIdentity();

      assertPrivateAHidden();
      expect(screen.getByRole('searchbox', { name: 'Search the hearing archive' })).toHaveValue('Fauci');
      await waitFor(() => expect(pending).toHaveLength(2));
      expect(pending.some((request) => request.url.includes(`events/${HEARING_ID}/sessions`))).toBe(true);
      expect(pending.some((request) => request.url.includes('q=Fauci'))).toBe(true);
      await act(async () => pending.forEach((request) => request.resolve(payload(request.url, 'B'))));
      await waitFor(() => expect(screen.getAllByRole('link', { name: /Open saved session: B private/ })).toHaveLength(2));
      assertPrivateAHidden();
    },
  );

  it('cannot repaint an old caller response even when its transport ignores cancellation', async () => {
    apiGet.mockImplementation(holdRequest);
    const view = mount();
    await waitFor(() => expect(pending).toHaveLength(2));
    const oldRequests = pending.splice(0);
    auth.orgId = 'org-b';
    view.changeIdentity();
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(oldRequests.every((request) => request.signal?.aborted)).toBe(true);
    await act(async () => pending.forEach((request) => request.resolve(payload(request.url, 'B'))));
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Open saved session: B private/ })).toHaveLength(2));
    await act(async () => oldRequests.forEach((request) => request.resolve(payload(request.url, 'A'))));
    assertPrivateAHidden();
    expect(screen.getAllByRole('link', { name: /Open saved session: B private/ })).toHaveLength(2);
  });

  it.each(['pending-auth', 'signed-out'] as const)('hides cached private content and does not query while %s', async (change) => {
    const view = mount();
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Open saved session: A private/ })).toHaveLength(2));
    const requestsBefore = apiGet.mock.calls.length;
    if (change === 'pending-auth') auth.isLoaded = false;
    else auth.userId = null;
    view.changeIdentity();
    assertPrivateAHidden();
    expect(screen.getByText('Checking saved sessions…')).toBeInTheDocument();
    expect(screen.queryByText(/No accessible saved session is linked/)).not.toBeInTheDocument();
    expect(apiGet.mock.calls).toHaveLength(requestsBefore);
  });

  it('retains the same caller’s previous archive page while paging, then drops it on an identity switch', async () => {
    const view = mount();
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Open saved session: A private/ })).toHaveLength(2));
    apiGet.mockImplementation(holdRequest);
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    await waitFor(() => expect(pending.some((request) => request.url.includes('page=2'))).toBe(true));
    expect(screen.getAllByRole('link', { name: /Open saved session: A private/ })).toHaveLength(2);
    auth.userId = 'user-b';
    view.changeIdentity();
    assertPrivateAHidden();
    await waitFor(() => expect(pending.filter((request) => request.url.includes('page=2'))).toHaveLength(2));
  });
});
