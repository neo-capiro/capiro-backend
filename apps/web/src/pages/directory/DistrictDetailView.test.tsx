import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { DistrictDetailView } from './DistrictDetailView.js';
import type { DirectoryDistrictDetail } from './directory-api.js';

function renderWithProviders(ui: JSX.Element) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

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
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
}

const AT_LARGE_DISTRICT: DirectoryDistrictDetail = {
  id: 'district-1',
  legistormDistrictId: 603,
  chamber: 'house',
  state: 'WY',
  districtNo: '00',
  name: 'Wyoming At-Large',
  status: 'C',
  effectiveDate: null,
  enactedDate: null,
  currentMembers: [
    {
      id: 'member-777',
      bioguideId: 'H000777',
      fullName: 'Jane Doe',
      partyName: 'Republican',
      chamber: 'House',
      photoUrl: null,
      outgoingStatus: null,
    },
  ],
  hasBoundary: false,
  syncedAt: '2026-07-20T00:00:00Z',
};

const NUMBERED_FUTURE_DISTRICT: DirectoryDistrictDetail = {
  id: 'district-2',
  legistormDistrictId: 604,
  chamber: 'house',
  state: 'TX',
  districtNo: '23',
  name: 'Texas 23rd',
  status: 'F',
  effectiveDate: '2027-01-03',
  enactedDate: '2026-06-01',
  currentMembers: [],
  hasBoundary: false,
  syncedAt: '2026-07-20T00:00:00Z',
};

const fakeApi = {} as AxiosInstance;

describe('DistrictDetailView', () => {
  beforeAll(setupAntdBrowserMocks);

  test('renders at-large label, current member link, and no-boundary empty state', () => {
    renderWithProviders(<DistrictDetailView district={AT_LARGE_DISTRICT} api={fakeApi} />);
    expect(screen.getByText('WY At-Large')).toBeInTheDocument();
    const memberLink = screen.getByRole('link', { name: 'Jane Doe' });
    expect(memberLink).toHaveAttribute('href', '/directory/members/member-777');
    expect(screen.getByText('Current map')).toBeInTheDocument();
    expect(screen.getByText('Boundary not yet fetched for this district')).toBeInTheDocument();
  });

  test('renders numbered district label, future-map tag, dates, and empty representative state', () => {
    renderWithProviders(<DistrictDetailView district={NUMBERED_FUTURE_DISTRICT} api={fakeApi} />);
    expect(screen.getByText('TX-23')).toBeInTheDocument();
    expect(screen.getByText('Enacted (future) map')).toBeInTheDocument();
    expect(screen.getByText('2026-06-01')).toBeInTheDocument();
    expect(screen.getByText('2027-01-03')).toBeInTheDocument();
    expect(screen.getByText('No current representative on record')).toBeInTheDocument();
  });
});
