/**
 * Regression test for the bug that made the shipped CRM invisible.
 *
 * `VNextRouter` originally intercepted `/clients` only when the URL carried a
 * `clientId`. But the canonical `ClientWorkspacePage` selects a client with
 * local React state (`setSelectedId`) and never writes `clientId` into the URL,
 * so clicking a client produced no URL for the router to match — and the
 * canonical profile rendered on the vNext surface. The UI "looked the same"
 * even though the correct build was deployed.
 *
 * These lock the current entry path: vNext owns `/clients` outright, and the
 * Portfolio index turns a click into the `?clientId=` URL the CRM reads.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { VNextClientCrmRoute } from './VNextClientCrmRoute.js';

const clients = [
  { id: 'c-1', name: 'Overland AI', status: 'active', sectorTag: 'defense', website: 'overland.ai' },
  { id: 'c-2', name: 'Acme Robotics', status: 'active', sectorTag: null, website: null },
];
const rejectedRequests = vi.hoisted(() => [] as string[]);

// Exercise the real route, Portfolio screen, data model and route-state helper.
// Unrelated auth, dialogs, charts and profile rendering stay outside this entry
// regression; every HTTP operand is explicit and unexpected calls fail closed.
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: async (path: string) => {
      if (path === '/api/clients') return { data: clients };
      const client = clients.find((row) => path === `/api/clients/${row.id}`);
      if (client) return { data: client };
      if (path === '/api/client-account-owners') return { data: {} };
      if (path === '/api/intelligence/portfolio-summary') {
        return { data: { activeClients: 2, needAttention: 0, ldaSpendQtd: 0,
          billsTracked: 0, activeRegulations: 0, meetingsThisWeek: 0, activeStrategies: 0 } };
      }
      if (path === '/strategy-api/strategies' || path === '/api/engagement/meetings') return { data: [] };
      if (path === '/api/intelligence/portfolio-rollup') return { data: { rollup: {} } };
      if (path === '/api/intelligence/portfolio-pe-summary') {
        return { data: { netDeltaPct: null, peAttribution: {}, watchedCount: 0 } };
      }
      if (path === '/api/intelligence/portfolio-engagement-trend') {
        throw new Error('Entry regression does not load chart data');
      }
      rejectedRequests.push(`GET ${path}`);
      throw new Error(`Unexpected entry-regression GET ${path}`);
    },
    post: () => { rejectedRequests.push('POST'); throw new Error('Unexpected entry-regression POST'); },
    put: () => { rejectedRequests.push('PUT'); throw new Error('Unexpected entry-regression PUT'); },
    patch: () => { rejectedRequests.push('PATCH'); throw new Error('Unexpected entry-regression PATCH'); },
    delete: () => { rejectedRequests.push('DELETE'); throw new Error('Unexpected entry-regression DELETE'); },
  }),
}));
vi.mock('../../../lib/me.js', () => ({ useMe: () => ({ data: undefined }) }));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => ({ enabled: false, ready: true }),
}));
vi.mock('../../components/actions/index.js', () => ({
  CapiroButton: ({ children, variant: _variant, size: _size, ...props }:
    ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode; variant?: string; size?: string }) =>
    <button {...props}>{children}</button>,
}));
vi.mock('../../components/feedback/index.js', () => ({ CapiroErrorState: () => <div>Profile unavailable</div> }));
vi.mock('../../components/feedback/toast.js', () => ({
  useCapiroToast: () => ({ error: () => { throw new Error('Unexpected entry-regression toast'); } }),
}));
vi.mock('../../adapters/legacy/useClientCrmOverviewModel.js', () => ({ initialsFor: () => 'CL' }));
vi.mock('./useClientAccountOwner.js', () => ({ clientAccountOwnerLabel: () => null }));
vi.mock('@capiro/shared', () => ({ hasAtLeast: () => false, SECTOR_LABELS: {}, normalizeSector: () => null }));
vi.mock('./ClientCrmPage.js', () => ({
  ClientCrmPage: ({ client }: { client: { name: string } }) => <div>{client.name}</div>,
}));
vi.mock('../business-development/BusinessDevelopmentPage.js', () => ({
  BusinessDevelopmentPage: () => { throw new Error('Unexpected Business Development entry'); },
}));
vi.mock('./ClientFormDialogVNext.js', () => ({ ClientFormDialogVNext: () => null }));
vi.mock('../portfolio/ImportWithLdaModal.js', () => ({ ImportWithLdaModal: () => null }));
vi.mock('../portfolio/PortfolioProgramElements.js', () => ({ PortfolioProgramElements: () => null }));
vi.mock('recharts', () => {
  const unexpected = () => { throw new Error('Unexpected entry-regression chart rendering'); };
  return { Bar: unexpected, BarChart: unexpected, CartesianGrid: unexpected, Legend: unexpected,
    ResponsiveContainer: unexpected, Tooltip: unexpected, XAxis: unexpected, YAxis: unexpected };
});
afterAll(() => expect(rejectedRequests).toEqual([]));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderPicker() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/clients']}>
        <Routes>
          <Route
            path="/clients"
            element={
              <div className="capiro-vnext-root">
                <VNextClientCrmRoute />
                <LocationProbe />
              </div>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('vNext client entry path', () => {
  it('puts clientId in the URL when a client is opened', async () => {
    renderPicker();
    const row = await screen.findByRole('button', { name: /Overland AI/ });
    fireEvent.click(row);
    // The whole point: selection must reach the URL, or the router cannot see it.
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/clients?clientId=c-1'),
    );
  });

  it('lists the portfolio so there is a way in at all', async () => {
    renderPicker();
    expect(await screen.findByRole('button', { name: /Overland AI/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Acme Robotics/ })).toBeInTheDocument();
  });
});
