/**
 * Client CRM — header/shell wiring added by the wire-audit quick wins
 * (items 21, 22/26, 23, 25). The tab bodies are mocked (as in
 * ClientCrmPage.test.tsx) so only the shell and its real drawers are under
 * test; `use-api.js` is mocked the same way the rest of the repo's tests do.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ClientCrmPage } from './ClientCrmPage.js';
import { CapiroToastProvider } from '../../components/feedback/toast.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({ data: { role: 'user_admin' } }),
}));
vi.mock('./tabs/OverviewTab.js', () => ({ ClientCrmOverviewProto: () => <div>overview</div> }));
vi.mock('./tabs/CapabilitiesTab.js', () => ({
  ClientCrmCapabilitiesProto: () => <div>capabilities</div>,
}));
vi.mock('./tabs/RelationshipsOrgTab.js', () => ({
  ClientCrmOrganizationProto: () => <div>organization</div>,
}));
vi.mock('./tabs/RelationshipsGovTab.js', () => ({
  ClientCrmGovernmentProto: () => <div>government</div>,
}));
vi.mock('./tabs/RelationshipsHistoryTab.js', () => ({
  ClientCrmHistoryProto: () => <div>history</div>,
}));
// This file tests header/drawer wiring, not AdvocacyMattersTab's own query
// behavior, so every record surface remains mocked.
vi.mock('./tabs/AdvocacyMattersTab.js', () => ({
  ClientCrmAdvocacyMattersProto: () => <div>advocacy</div>,
}));
vi.mock('./tabs/WorkTab.js', () => ({ ClientCrmWorkProto: () => <div>work</div> }));
vi.mock('./tabs/IntelligenceTab.js', () => ({
  ClientCrmIntelligenceProto: () => <div>intelligence</div>,
}));
vi.mock('./tabs/FilesTab.js', () => ({ ClientCrmFilesProto: () => <div>files</div> }));

const openMeriMock = vi.hoisted(() => vi.fn());
vi.mock('../../../components/chat/meri-window.js', () => ({
  openMeriWorkspaceWithContext: openMeriMock,
}));

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const putMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock, put: putMock, delete: deleteMock }),
}));

const client: Client = {
  id: 'client-1',
  name: 'Overland AI',
  website: 'overland.ai',
  description: null,
  productDescription: null,
  primaryContactName: null,
  primaryContactEmail: null,
  primaryContactPhone: null,
  logoS3Key: null,
  logoContentType: null,
  logoUploadedAt: null,
  intakeData: null,
  status: 'active',
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
};

const COMPLETED_RUN = {
  id: 'run-1',
  clientId: client.id,
  status: 'completed',
  requestedSources: [],
  sourceStates: {},
  summary: {},
  error: null,
  startedAt: '2026-08-15T00:00:00.000Z',
  completedAt: '2026-08-15T00:00:05.000Z',
  findings: [],
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CapiroToastProvider>
        <MemoryRouter initialEntries={['/clients']}>
          <Routes>
            <Route
              path="/clients"
              element={
                <div className="capiro-vnext-root">
                  <ClientCrmPage client={client} />
                  <LocationProbe />
                </div>
              }
            />
          </Routes>
        </MemoryRouter>
      </CapiroToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  putMock.mockReset();
  deleteMock.mockReset();
  getMock.mockImplementation((url: string) => {
    if (url.includes('/fill-with-meri/latest')) return Promise.resolve({ data: null });
    if (url.includes('/fill-with-meri/runs/')) return Promise.resolve({ data: COMPLETED_RUN });
    return Promise.resolve({ data: [] }); // data-health sources default to EMPTY
  });
  postMock.mockImplementation((url: string) => {
    if (url.includes('/fill-with-meri/runs')) return Promise.resolve({ data: COMPLETED_RUN });
    return Promise.reject(new Error(`unexpected post ${url}`));
  });
});

describe('ClientCrmPage header wiring', () => {
  it('opens the Fill with Meri drawer immediately and starts a real run on request (no fake delay/toast)', async () => {
    renderPage();

    // Fill with Meri moved into the Meri Actions rich menu (one Meri entry
    // point on the record) — open the menu, then select the item.
    fireEvent.click(screen.getByRole('button', { name: /Meri Actions/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Fill with Meri/ }));

    // No setTimeout gate: the drawer is visible on the very next tick, and
    // the fabricated "Meri proposed 7 field changes" toast is gone.
    const fillDrawer = await screen.findByRole('dialog', { name: 'Fill with Meri' });
    expect(within(fillDrawer).getByText('Overland AI')).toBeInTheDocument();
    expect(screen.queryByText('Meri proposed 7 field changes for review')).not.toBeInTheDocument();

    // No auto-start on open (see ClientFillWithMeriDrawer.contract.test.ts):
    // the backend resumes any run still within its 15-minute staleness
    // window regardless of the new request, so an eager auto-start would
    // silently swallow a document picked moments later instead of reading it.
    const startButton = await screen.findByRole('button', { name: 'Start the review' });
    expect(postMock).not.toHaveBeenCalled();

    // Clicking through still fires a real run, not a fabricated toast.
    fireEvent.click(startButton);
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        expect.stringContaining('/fill-with-meri/runs'),
        // Prefills the live client website when one is on the profile; empty
        // body is only correct when the client has no website recorded.
        expect.objectContaining({ website: 'overland.ai' }),
      ),
    );
  });

  it('opens the real ClientDataHealthDrawer (not the fixture) from the profile-gap crumb', async () => {
    renderPage();

    // Item 12: the count is now real. Every mocked source answers with an
    // empty array, so all six are genuine gaps — not the old hardcoded 1.
    fireEvent.click(await screen.findByRole('button', { name: '6 profile gaps' }));

    expect(await screen.findByText('Data health — Overland AI')).toBeInTheDocument();
    // The old fixture drawer's fabricated 92%/Arlington-facility copy must be gone.
    expect(screen.queryByText(/Arlington partner lab/)).not.toBeInTheDocument();
  });

  it('navigates the prototype All clients back link to /clients', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'All clients' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/clients');
  });

  it('opens the real Meri workspace scoped to this client from the Meri Actions menu', async () => {
    openMeriMock.mockReturnValue({ focus: vi.fn() });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Meri Actions/ }));
    fireEvent.click(screen.getByText('Ask Meri about this client'));

    // clientId must be carried, and a prompt must be present — Meri's own
    // readContextRequest() drops a clientId that arrives without one.
    await waitFor(() =>
      expect(openMeriMock).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'client-1',
          prompt: expect.stringContaining('Overland AI'),
        }),
      ),
    );
  });

  it('QA-04: gives visible feedback instead of silently doing nothing when the Meri popup is blocked', async () => {
    // A blocked popup: window.open resolves to null, no thrown error — this
    // is exactly the silent-dead-click bug (the item did nothing, no dialog,
    // no navigation, no console error).
    openMeriMock.mockReturnValue(null);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Meri Actions/ }));
    fireEvent.click(screen.getByText('Ask Meri about this client'));

    await waitFor(() => expect(openMeriMock).toHaveBeenCalled());
    // The menu item now surfaces a real toast rather than doing nothing.
    expect(await screen.findByText(/Meri window was blocked/i)).toBeInTheDocument();
  });
});

/* ═══════ wire-audit "3 Compose extend" items 9-12 ════════════════════════ */

describe('ClientCrmPage — Archive client (item 9)', () => {
  it('confirms first, then archives via the real endpoint and leaves the profile', async () => {
    deleteMock.mockResolvedValue({ data: { id: 'client-1', status: 'archived' } });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    fireEvent.click(screen.getByText('Archive client'));

    // Nothing is written on the menu click alone — this is destructive-ish and
    // list-wide, so it asks first.
    expect(deleteMock).not.toHaveBeenCalled();
    expect(await screen.findByText('Archive Overland AI?')).toBeInTheDocument();
    // The copy must not imply deletion: archive flips status, it removes nothing.
    expect(screen.getByText(/Nothing is deleted/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Archive client' }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/api/clients/client-1'));
    // The profile we were on no longer belongs in any list.
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/clients'));
  });
});

describe('ClientCrmPage — Focus Add (item 10)', () => {
  it('appends the tag while preserving the rest of intakeData', async () => {
    putMock.mockResolvedValue({
      data: { ...client, intakeData: { city: 'Seattle', tags: ['Autonomy', 'Shipbuilding'] } },
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <div className="capiro-vnext-root">
            <ClientCrmPage
              client={{ ...client, intakeData: { city: 'Seattle', tags: ['Autonomy'] } }}
            />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add focus' }));
    fireEvent.change(screen.getByLabelText('New focus tag'), { target: { value: 'Shipbuilding' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // PUT replaces intakeData wholesale, so the unrelated `city` must ride
    // along — sending `{tags}` alone would silently wipe the rest of intake.
    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith('/api/clients/client-1', {
        intakeData: { city: 'Seattle', tags: ['Autonomy', 'Shipbuilding'] },
      }),
    );
  });

  it('refuses a focus that is already on the client', () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <div className="capiro-vnext-root">
            <ClientCrmPage client={{ ...client, intakeData: { tags: ['Autonomy'] } }} />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add focus' }));
    // Case-insensitive: the same focus, differently typed.
    fireEvent.change(screen.getByLabelText('New focus tag'), { target: { value: 'autonomy' } });

    expect(screen.getByText('Already a focus')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe('ClientCrmPage — breadcrumb freshness (item 11)', () => {
  it('reports when the sources were actually read, not a hardcoded 2h', async () => {
    renderPage();

    expect(await screen.findByText(/^Profile sections read /)).toBeInTheDocument();
    expect(screen.queryByText('Intel refreshed 2h ago')).not.toBeInTheDocument();
  });

  it('says a source is unavailable rather than claiming a fresh read', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('/fill-with-meri/latest')) return Promise.resolve({ data: null });
      if (url.includes('/fill-with-meri/runs/')) return Promise.resolve({ data: COMPLETED_RUN });
      if (url.includes('/capabilities')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ data: [] });
    });
    renderPage();

    expect(await screen.findByText('1 profile section unavailable')).toBeInTheDocument();
    // A failed source is not a gap — we do not know what it holds, and calling
    // an outage a gap sends the user to re-enter data that may already exist.
    expect(await screen.findByRole('button', { name: '5 profile gaps' })).toBeInTheDocument();
  });
});

/* ── Sync — a real re-read, not a 1500ms timeout ──────────────────────────── */

describe('ClientCrmPage — Sync', () => {
  it('refetches every source, recomputes recommendations, and reports the real counts', async () => {
    let sourceReads = 0;
    getMock.mockImplementation((url: string) => {
      if (url.includes('/fill-with-meri/latest')) return Promise.resolve({ data: null });
      if (url.includes('/fill-with-meri/runs/')) return Promise.resolve({ data: COMPLETED_RUN });
      sourceReads += 1;
      return Promise.resolve({ data: [] });
    });
    postMock.mockImplementation((url: string) => {
      if (url.includes('/fill-with-meri/runs')) return Promise.resolve({ data: COMPLETED_RUN });
      if (url.includes('/target-recommendations/refresh')) return Promise.resolve({ data: {} });
      return Promise.reject(new Error(`unexpected post ${url}`));
    });
    renderPage();

    // Let the initial source reads settle so the re-read count is unambiguous.
    await screen.findByRole('button', { name: '6 profile gaps' });
    const initialReads = sourceReads;

    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));

    // A real server-side recompute — the only per-client one this product has.
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/clients/client-1/target-recommendations/refresh'),
    );
    // And a real re-read of the sources, not a setTimeout.
    await waitFor(() => expect(sourceReads).toBeGreaterThan(initialReads));
    expect(getMock).toHaveBeenCalledWith('/api/intelligence/clients/client-1/district-nexus-v2');
    expect(getMock).toHaveBeenCalledWith('/api/intelligence/clients/client-1/fec-money-flow');
    expect(getMock).toHaveBeenCalledWith('/api/intelligence/clients/client-1/lda-filings');

    // The toast reports what came back; the old copy was hardcoded.
    expect(await screen.findByText(/9 of 9 sources answered/)).toBeInTheDocument();
    expect(screen.queryByText('Sources refreshed · 6 of 6 connected')).not.toBeInTheDocument();
  });

  it('reports the sources that did not answer rather than claiming a clean sync', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('/fill-with-meri/latest')) return Promise.resolve({ data: null });
      if (url.includes('/fill-with-meri/runs/')) return Promise.resolve({ data: COMPLETED_RUN });
      if (url.includes('/capabilities')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ data: [] });
    });
    postMock.mockImplementation((url: string) => {
      if (url.includes('/fill-with-meri/runs')) return Promise.resolve({ data: COMPLETED_RUN });
      if (url.includes('/target-recommendations/refresh')) return Promise.resolve({ data: {} });
      return Promise.reject(new Error(`unexpected post ${url}`));
    });
    renderPage();

    await screen.findByText('1 profile section unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));

    // Reported from the refetch results, so a source that failed mid-sync is
    // counted rather than read as "still loading".
    expect(await screen.findByText('8 of 9 sources answered · 1 unavailable')).toBeInTheDocument();
  });

  it('still reports the re-read when the slow recompute fails', async () => {
    postMock.mockImplementation((url: string) => {
      if (url.includes('/fill-with-meri/runs')) return Promise.resolve({ data: COMPLETED_RUN });
      // The recompute is expensive and allowed to fail — a re-read that worked
      // must not be reported as a failed sync because of it.
      return Promise.reject(new Error('recompute timed out'));
    });
    renderPage();

    await screen.findByRole('button', { name: '6 profile gaps' });
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));

    expect(
      await screen.findByText('9 of 9 sources answered · recommendations unavailable'),
    ).toBeInTheDocument();
  });
});
