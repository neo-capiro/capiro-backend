import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { BillUpdatesDrawer } from './BillUpdatesDrawer.js';
import type { BoardBill } from '../../../../pages/clients/tracker/tracker-api.js';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock }),
}));
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => ({ enabled: false, ready: true }),
}));

const BILL: BoardBill = {
  billId: 'bill-5150',
  displayNum: 'H.R. 5150',
  title: 'Maritime Uncrewed Logistics Act',
  stage: 'introduced',
  probability: 0.62,
  tags: [],
  isManual: true,
  trackedAt: '2026-08-01T00:00:00.000Z',
  unread: true,
  change: null,
  jurisdiction: 'US',
  terminalRisk: false,
};

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

function renderDrawer() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/clients']}>
        <Routes>
          <Route
            path="/clients"
            element={
              <>
                <BillUpdatesDrawer open clientId="client-1" bill={BILL} onClose={() => {}} />
                <LocationProbe />
              </>
            }
          />
          <Route path="/legiwatch" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BillUpdatesDrawer — "Open full board" (Q07, evidence #58/#65)', () => {
  it('navigates to LegiWatch Bills, scoped to this client — not a bare /legiwatch (which lands on Hearings, all clients)', () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/intel-api/clients/client-1/bills/bill-5150/hearings') {
        return Promise.resolve({ data: { count: 0, hearings: [] } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    renderDrawer();

    fireEvent.click(screen.getByText('Open full board →'));

    // Q07: the old bare navigate('/legiwatch') dropped both the tab (landing
    // on Hearings, the wrong section) and the client filter (landing on all
    // clients). The fix must retain both, matching the board footer's own
    // sibling "Open full board" button in IntelligenceTab's LegislativePanel.
    expect(screen.getByTestId('location')).toHaveTextContent('/legiwatch?tab=bills&client=client-1');
  });
});
