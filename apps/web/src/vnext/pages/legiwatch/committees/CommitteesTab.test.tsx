import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGet }) }));
vi.mock('../../../../lib/use-api-scope.js', () => ({
  useApiScope: () => 'tenant-test:self:user-test',
}));
import { CommitteesTab } from './CommitteesTab.js';

const federal = {
  rows: [
    {
      systemCode: 'HSAS',
      name: 'House Armed Services Committee',
      chamber: 'House',
      isSubcommittee: false,
      upcomingEventCount: 2,
      lastSyncedAt: '2026-09-21T12:00:00.000Z',
      sourceHealth: 'healthy',
      sourceHealthInheritedFrom: null,
      following: true,
    },
  ],
  total: 1,
  parentCount: 1,
  subcommitteeCount: 0,
  asOf: '2026-09-21T12:00:00.000Z',
};
const florida = [
  {
    id: 'fl-lower-health',
    name: 'Health & Human Services Committee',
    state: 'FL',
    chamber: 'lower',
    legislativeSession: '2027',
    officialSourceKey: 'FL:H:HEALTH',
    sourceUrl: 'https://www.flhouse.gov/Sections/Committees/committeesdetail.aspx?CommitteeId=1',
    lastSyncedAt: '2026-09-21T12:00:00.000Z',
  },
  {
    id: 'fl-upper-rules',
    name: 'Rules Committee',
    state: 'FL',
    chamber: 'upper',
    legislativeSession: '2026',
    officialSourceKey: 'FL:S:RULES',
    sourceUrl: 'https://www.flsenate.gov/Committees/Show/RC',
    lastSyncedAt: '2026-09-21T12:00:00.000Z',
  },
];

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}
function renderTab(entry = '/legiwatch?tab=committees') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/legiwatch" element={<CommitteesTab />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation((url: string) =>
    Promise.resolve({ data: url.endsWith('/state-committees') ? florida : federal }),
  );
});
afterEach(() => vi.clearAllMocks());

describe('CommitteesTab jurisdiction parity', () => {
  it('keeps the existing federal directory as the default', async () => {
    const { queryClient } = renderTab();
    expect(await screen.findByText('House Armed Services Committee')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Federal' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(apiGet).toHaveBeenCalledWith('/api/legiwatch/live-hearings/committees');
    expect(
      queryClient.getQueryData([
        'lw-vnext',
        'committees-directory',
        'tenant-test:self:user-test',
        'US',
      ]),
    ).toEqual(federal);
  });

  it('loads Florida and filters by chamber and session', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Florida' }));
    expect(await screen.findByText('Health & Human Services Committee')).toBeTruthy();
    expect(screen.getByText('Rules Committee')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'House' }));
    expect(screen.queryByText('Rules Committee')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Florida legislative session' }), {
      target: { value: '2026' },
    });
    await waitFor(() => expect(screen.queryByText('Health & Human Services Committee')).toBeNull());
    expect(screen.getByText('No Florida committees match these filters')).toBeTruthy();
  });

  it('preserves the selected client when a Florida room opens', async () => {
    renderTab('/legiwatch?tab=committees&client=client-7');
    fireEvent.click(screen.getByRole('button', { name: 'Florida' }));
    await screen.findByText('Health & Human Services Committee');
    fireEvent.click(screen.getAllByRole('button', { name: 'Enter Florida Committee Room →' })[0]!);
    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/legiwatch/committees/FL/fl-lower-health?client=client-7',
    );
  });
});
