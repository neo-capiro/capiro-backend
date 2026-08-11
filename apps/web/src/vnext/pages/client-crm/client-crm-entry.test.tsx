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
 * These lock the entry path: vNext owns `/clients` outright, and the picker is
 * what turns a click into the `?clientId=` URL the CRM reads.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { VNextClientPicker } from './VNextClientPicker.js';

const clients = [
  { id: 'c-1', name: 'Overland AI', status: 'active', sectorTag: 'defense', website: 'overland.ai' },
  { id: 'c-2', name: 'Acme Robotics', status: 'active', sectorTag: null, website: null },
];

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: async () => ({ data: clients }) }),
}));

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
                <VNextClientPicker />
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
