import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DirectoryContactTripsPayload } from '../../../pages/directory/directory-api.js';

/**
 * Parity suite for the shared vNext profile primitives: the trips section
 * mirrors the canonical `ContactTripsSection.test.tsx` (same query, same
 * vanish-when-empty rule), and the back link mirrors ProfileBackLink's
 * pop-history-vs-fallback decision (shared via historyCanGoBack).
 */

const getContactTripsMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({}) }));
vi.mock('../../../pages/directory/directory-api.js', async () => {
  const real = await vi.importActual<typeof import('../../../pages/directory/directory-api.js')>(
    '../../../pages/directory/directory-api.js',
  );
  return { ...real, getContactTrips: (...args: unknown[]) => getContactTripsMock(...args) };
});

const { ContactTripsSectionVNext, ProfileBackLink } = await import('./profile-primitives.js');

function renderSection(contactId = 'member-500') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ContactTripsSectionVNext contactId={contactId} />
    </QueryClientProvider>,
  );
}

describe('ContactTripsSectionVNext', () => {
  beforeEach(() => getContactTripsMock.mockReset());

  // Covers both "loaded, zero trips" and "still loading / errored" (undefined
  // data) — the component's `!trips || trips.length === 0` guard treats both
  // identically, so one test on the resolved-empty case exercises the same
  // branch a rejected-fetch case would.
  test('renders nothing when the contact has no trips on record', async () => {
    const payload: DirectoryContactTripsPayload = { contactId: 'member-500', trips: [] };
    getContactTripsMock.mockResolvedValue(payload);
    const { container } = renderSection();
    await waitFor(() => expect(getContactTripsMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  test('renders traveler and approver roles distinctly, with destinations/sponsors/cost', async () => {
    const payload: DirectoryContactTripsPayload = {
      contactId: 'member-500',
      trips: [
        {
          id: 1,
          role: 'traveler',
          otherPartyName: 'Acme Foundation',
          companionName: null,
          startDate: '2026-03-01',
          endDate: '2026-03-05',
          durationDays: 4,
          purpose: 'Policy conference',
          totalCost: 2500,
          destinations: [{ id: 1, name: 'London, UK', stateId: null }],
          sponsors: [{ id: 1, name: 'Acme Foundation' }],
          filedDate: '2026-03-10',
        },
        {
          id: 2,
          role: 'approver',
          otherPartyName: 'Jane Staffer',
          companionName: 'Spouse',
          startDate: null,
          endDate: null,
          durationDays: null,
          purpose: null,
          totalCost: null,
          destinations: [],
          sponsors: [],
          filedDate: null,
        },
      ],
    };
    getContactTripsMock.mockResolvedValue(payload);
    renderSection();

    expect(await screen.findByText('Privately funded travel (2)')).toBeInTheDocument();
    expect(screen.getByText('Traveled')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText(/with Acme Foundation/)).toBeInTheDocument();
    expect(screen.getByText(/for Jane Staffer/)).toBeInTheDocument();
    expect(screen.getByText(/companion: Spouse/)).toBeInTheDocument();
    expect(screen.getByText(/London, UK/)).toBeInTheDocument();
    expect(screen.getByText(/\$2,500/)).toBeInTheDocument();
    expect(screen.getByText('Sponsor: Acme Foundation')).toBeInTheDocument();
  });
});

describe('ProfileBackLink (vNext)', () => {
  test('pops in-app history when there is history to pop', () => {
    window.history.replaceState({ idx: 3 }, '');
    const navigate = vi.fn();
    render(<ProfileBackLink navigate={navigate} />);
    fireEvent.click(screen.getByTestId('profile-back-link'));
    expect(navigate).toHaveBeenCalledWith(-1);
  });

  test('falls back to /directory on a cold deep-link (idx 0)', () => {
    window.history.replaceState({ idx: 0 }, '');
    const navigate = vi.fn();
    render(<ProfileBackLink navigate={navigate} />);
    fireEvent.click(screen.getByTestId('profile-back-link'));
    expect(navigate).toHaveBeenCalledWith('/directory');
  });
});
