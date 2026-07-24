import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ContactTripsSection } from './ContactTripsSection.js';
import type { DirectoryContactTripsPayload } from './directory-api.js';

function setupAntdBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const getContactTripsMock = vi.fn();
vi.mock('../../lib/use-api.js', () => ({ useApi: () => ({}) }));
vi.mock('./directory-api.js', () => ({
  getContactTrips: (...args: unknown[]) => getContactTripsMock(...args),
}));

function renderSection(contactId = 'member-500') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ContactTripsSection contactId={contactId} />
    </QueryClientProvider>,
  );
}

describe('ContactTripsSection', () => {
  beforeAll(setupAntdBrowserMocks);
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
