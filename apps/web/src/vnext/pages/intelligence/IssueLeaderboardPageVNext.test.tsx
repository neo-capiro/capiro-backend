/**
 * Issue Leaderboard vNext — behavioral coverage for the ported page. The
 * canonical page had no test file; these pin the contract the port preserves:
 * the endpoint + query key, the stat tiles, the NEW / shared-lobbyist
 * markers, the default filings-descending order, and the error state.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { IssueLeaderboardPageVNext } from './IssueLeaderboardPageVNext.js';

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock }),
}));

function renderPage(code = 'DEF') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/intelligence/issues/${code}`]}>
      <QueryClientProvider client={queryClient}>
        <IssueLeaderboardPageVNext code={code} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const leaderboard = {
  issueCode: 'DEF',
  issueName: 'Defense',
  totalFilings: 4210,
  registrants: [
    {
      name: 'Beacon Global Strategies',
      filingCount: 87,
      totalIncome: 2_400_000,
      isNewEntrant: false,
      firstFilingDate: '2019-02-11T00:00:00.000Z',
      sharedLobbyists: [],
    },
    {
      name: 'Meridian Hill Partners',
      filingCount: 143,
      totalIncome: 5_100_000,
      isNewEntrant: true,
      firstFilingDate: '2026-06-30T00:00:00.000Z',
      sharedLobbyists: ['Dana Whitfield', 'R. Okafor'],
    },
  ],
};

describe('IssueLeaderboardPageVNext', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue({ data: leaderboard });
  });

  test('fetches the canonical leaderboard endpoint for the pathname-parsed code', async () => {
    renderPage('DEF');

    expect(await screen.findByText('Meridian Hill Partners')).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith('/api/intelligence/issues/DEF/leaderboard');
    expect(screen.getByText('Issue Leaderboard: DEF')).toBeInTheDocument();
    expect(screen.getByText('Defense')).toBeInTheDocument();
  });

  test('renders stats, NEW entrant + shared-lobbyist markers, and money formatting', async () => {
    renderPage('DEF');

    expect(await screen.findByText('4,210')).toBeInTheDocument(); // total filings
    expect(screen.getByText('NEW')).toBeInTheDocument();
    expect(screen.getByText('2 shared lobbyists')).toBeInTheDocument();
    expect(screen.getByText('$5.1M')).toBeInTheDocument();
    expect(screen.getByText('$2.4M')).toBeInTheDocument();
    // Stat tiles: New Entrants (90d) = 1, Shared Lobbyist Overlap = 1.
    expect(screen.getByText('New Entrants (90d)')).toBeInTheDocument();
    expect(screen.getByText('Shared Lobbyist Overlap')).toBeInTheDocument();
  });

  test('defaults to filings descending — the busiest registrant leads the table', async () => {
    renderPage('DEF');

    await screen.findByText('Meridian Hill Partners');
    const rows = screen.getAllByRole('row').slice(1); // drop the header row
    expect(rows[0]).toHaveTextContent('Meridian Hill Partners'); // 143 filings
    expect(rows[1]).toHaveTextContent('Beacon Global Strategies'); // 87 filings
  });

  test('renders a failed request as an error, not an empty leaderboard', async () => {
    apiGetMock.mockRejectedValue(new Error('leaderboard unavailable'));
    renderPage('DEF');

    await waitFor(() =>
      expect(screen.getByText('Failed to load leaderboard')).toBeInTheDocument(),
    );
    expect(screen.getByText('leaderboard unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No registrants found')).toBeNull();
  });
});
