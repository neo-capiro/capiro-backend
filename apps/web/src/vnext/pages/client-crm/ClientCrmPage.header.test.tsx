/**
 * Client CRM — header/shell wiring added by the wire-audit quick wins
 * (items 21, 22/26, 23, 25). The tab bodies are mocked (as in
 * ClientCrmPage.test.tsx) so only the shell and its real drawers are under
 * test; `use-api.js` is mocked the same way the rest of the repo's tests do.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ClientCrmPage } from './ClientCrmPage.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({ data: { role: 'user_admin' } }),
}));
vi.mock('./tabs/OverviewTab.js', () => ({ ClientCrmOverviewProto: () => <div>overview</div> }));
vi.mock('./tabs/CapabilitiesTab.js', () => ({ ClientCrmCapabilitiesProto: () => <div>capabilities</div> }));
vi.mock('./tabs/RelationshipsOrgTab.js', () => ({ ClientCrmOrganizationProto: () => <div>organization</div> }));
vi.mock('./tabs/RelationshipsGovTab.js', () => ({ ClientCrmGovernmentProto: () => <div>government</div> }));
vi.mock('./tabs/RelationshipsHistoryTab.js', () => ({ ClientCrmHistoryProto: () => <div>history</div> }));
vi.mock('./tabs/WorkTab.js', () => ({ ClientCrmWorkProto: () => <div>work</div> }));
vi.mock('./tabs/IntelligenceTab.js', () => ({ ClientCrmIntelligenceProto: () => <div>intelligence</div> }));
vi.mock('./tabs/FilesTab.js', () => ({ ClientCrmFilesProto: () => <div>files</div> }));

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock }),
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
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
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
  it('opens the Fill with Meri drawer immediately and auto-starts a real run (no fake delay/toast)', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Fill with Meri' }));

    // No setTimeout gate: the drawer is visible on the very next tick, and
    // the fabricated "Meri proposed 7 field changes" toast is gone.
    expect(await screen.findByText('Fill with Meri — Overland AI')).toBeInTheDocument();
    expect(screen.queryByText('Meri proposed 7 field changes for review')).not.toBeInTheDocument();

    // Auto-start fired a real run rather than waiting on a manual "Start
    // enrichment" click.
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(expect.stringContaining('/fill-with-meri/runs'), {}));
  });

  it('opens the real ClientDataHealthDrawer (not the fixture) from the profile-gap crumb', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: '1 profile gap' }));

    expect(await screen.findByText('Data health — Overland AI')).toBeInTheDocument();
    // The old fixture drawer's fabricated 92%/Arlington-facility copy must be gone.
    expect(screen.queryByText(/Arlington partner lab/)).not.toBeInTheDocument();
  });

  it('navigates the Portfolio and Clients breadcrumbs to /clients', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Portfolio' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/clients');

    fireEvent.click(screen.getByRole('button', { name: 'Clients' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/clients');
  });
});
