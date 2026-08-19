/**
 * PeProfileVNext — behavior tests for the native vNext line profile.
 *
 * Ported from the canonical V2 profile's assertions where they carry meaning
 * (real derived money values, stage labels, missing-≠-zero state words, load /
 * failure states, watch + data-issue endpoints). Mock values deliberately use
 * DISTINGUISHING figures (215.3 / 310.5 → +44.2%) so a fixture-echo can never
 * pass vacuously.
 *
 * The component is mounted WITHOUT a param route — VNextRouter mounts above
 * the canonical param <Route>s, so the PE code must come from the pathname
 * (Phase 3 lesson #2); the first test proves exactly that.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PeProfileVNext } from './PeProfileVNext.js';
import type { ProgramElementDetail } from '../../../../pages/program-element/types.js';

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGet, post: apiPost }),
}));

const DETAIL: ProgramElementDetail = {
  peCode: '0601102A',
  title: 'Defense Research Sciences',
  description: 'Basic research program.',
  service: 'ARMY',
  budgetActivity: '6.1 Basic Research',
  appropriationType: 'RDT&E',
  status: 'active',
  firstSeenFy: 2019,
  lastSyncedAt: '2026-08-01T00:00:00.000Z',
  currentUserIsWatching: false,
  years: [
    {
      id: 'y-2026',
      fy: 2026,
      request: 200,
      conference: null,
      enacted: 250,
    },
    {
      id: 'y-2027',
      fy: 2027,
      request: 215.3,
      hacDMark: 310.5,
      conference: null,
      enacted: null,
    },
  ],
  projectCount: 1,
  sourceCount: 3,
  billCount: 2,
  currentCycleFy: 2027,
  fundingSummary: null,
  openReconciliationConflictCount: 0,
  unsupportedSourceFamily: false,
};

function mockEndpoints(detail: ProgramElementDetail | (() => Promise<never>) = DETAIL) {
  apiGet.mockImplementation(async (url: string) => {
    if (url === '/api/program-elements/0601102A') {
      if (typeof detail === 'function') return detail();
      return { data: detail };
    }
    if (url.includes('/deltas')) return { data: { data: [], total: 0, page: 1, limit: 25 } };
    if (url === '/api/intelligence/actions') return { data: { data: [], total: 0, page: 1, limit: 100 } };
    if (url.includes('/client-relevance')) return { data: [] };
    return { data: [] };
  });
  apiPost.mockResolvedValue({ data: { id: 'issue-abcdef1234', status: 'open' } });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{`${location.pathname}${location.search}`}</div>;
}

function renderProfile(initialEntry = '/program-elements/0601102a') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <PeProfileVNext />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PeProfileVNext', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
  });

  test('parses the PE code from the pathname (useParams is empty under VNextRouter) and renders real derived figures', async () => {
    mockEndpoints();
    renderProfile('/program-elements/0601102a');

    // Detail fetched with the UPPERCASED code parsed from the path.
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith('/api/program-elements/0601102A'),
    );

    expect(await screen.findByText('Defense Research Sciences')).toBeInTheDocument();
    expect(screen.getByText('0601102A')).toBeInTheDocument();
    // Header meta: appropriation, friendly service label, budget activity.
    expect(screen.getByText('RDT&E, Army · 6.1 Basic Research')).toBeInTheDocument();
    // Current = furthest-along FY27 stage (HAC-D 310.5), NOT the FY26 enacted.
    // (The figure also labels the FY27 bar; the stage also appears in WHAT CHANGED.)
    expect(screen.getAllByText('$310.5M').length).toBeGreaterThan(0);
    expect(screen.getAllByText('HAC-D').length).toBeGreaterThan(0);
    // Delta sentence derives from current − request: +95.2 / 215.3 = +44.2%.
    expect(screen.getByText('+$95.2M · +44.2% vs FY2027 request')).toBeInTheDocument();
    // Trust strip facts.
    expect(screen.getByText('3 verified sources')).toBeInTheDocument();
    expect(screen.getByText('No blocking conflicts')).toBeInTheDocument();
    // Overview tab is the default and renders the FY bar chart with real bars.
    expect(screen.getByRole('img', { name: 'Funding by fiscal year bar chart' })).toBeInTheDocument();
    // FY26 enacted bar (250) + FY27 current bar (310.5): both money labels present.
    expect(screen.getByText('$250.0M')).toBeInTheDocument();
  });

  test('deep link ?tab=funding selects the Funding tab and renders the stage ladders with missing-≠-zero words', async () => {
    mockEndpoints();
    renderProfile('/program-elements/0601102A?tab=funding');

    await screen.findByText('Defense Research Sciences');

    const fundingTab = screen.getByRole('tab', { name: 'Funding & lifecycle' });
    expect(fundingTab).toHaveAttribute('aria-selected', 'true');

    // Both parallel tracks render.
    expect(await screen.findByText('AUTHORIZATION')).toBeInTheDocument();
    expect(screen.getByText('APPROPRIATIONS')).toBeInTheDocument();
    // The absent enacted stage says NOT ENACTED — never a coerced zero.
    expect(screen.getAllByText('NOT ENACTED').length).toBeGreaterThan(0);
    // Unfiled marks say NOT FILED (auth track has none filed beyond request).
    expect(screen.getAllByText(/NOT FILED/).length).toBeGreaterThan(0);
    // HAC-D carries the real filed value and its delta vs request.
    expect(screen.getAllByText('+$95.2M vs request').length).toBeGreaterThan(0);
    // The current stage is badged on the ladder.
    expect(screen.getAllByText('CURRENT').length).toBeGreaterThan(0);
  });

  test('switching tabs updates the ?tab= URL param (replace) like the canonical page', async () => {
    mockEndpoints();
    renderProfile('/program-elements/0601102A');

    await screen.findByText('Defense Research Sciences');
    fireEvent.click(screen.getByRole('tab', { name: 'Sources & proof' }));

    expect(screen.getByTestId('location-probe')).toHaveTextContent(
      '/program-elements/0601102A?tab=sources',
    );
    expect(await screen.findByText(/evidence coverage/)).toBeInTheDocument();
    expect(screen.getByText('MISSING IS NEVER ZERO · EVERY CELL STATES WHAT EXISTS')).toBeInTheDocument();

    // Back to Overview clears the param (canonical behavior).
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(screen.getByTestId('location-probe')).toHaveTextContent(/\/program-elements\/0601102A$/);
  });

  test('Monitor toggles the watch state through the canonical endpoint', async () => {
    mockEndpoints();
    apiPost.mockResolvedValue({ data: { peCode: '0601102A', watching: true } });
    renderProfile();

    await screen.findByText('Defense Research Sciences');
    fireEvent.click(screen.getByRole('button', { name: 'Monitor' }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/program-elements/0601102A/watch', {
        watching: true,
      }),
    );
  });

  test('Report issue opens the data-issue modal; validation blocks an empty description; a valid report posts to the canonical endpoint', async () => {
    mockEndpoints();
    renderProfile();

    await screen.findByText('Defense Research Sciences');
    fireEvent.click(screen.getByRole('button', { name: 'Report issue' }));

    const modal = await screen.findByTestId('pe-data-issue-modal');
    expect(within(modal).getByText(/Reports are tenant-scoped feedback/)).toBeInTheDocument();

    // Empty description fails validation with the canonical message — no POST.
    fireEvent.click(within(modal).getByRole('button', { name: 'Submit report' }));
    expect(await within(modal).findByText('Describe the issue')).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();

    // URL validation matches the canonical rule. (Queried by placeholder: once
    // the error renders, it becomes part of the wrapping label's text.)
    fireEvent.change(within(modal).getByPlaceholderText('https://…'), {
      target: { value: 'not-a-url' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Submit report' }));
    expect(await within(modal).findByText('Must be an http(s) URL')).toBeInTheDocument();
    fireEvent.change(within(modal).getByPlaceholderText('https://…'), {
      target: { value: '' },
    });

    fireEvent.change(within(modal).getByPlaceholderText('What looks wrong, and why?'), {
      target: { value: 'The HAC-D mark disagrees with the committee report table.' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Submit report' }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/program-elements/0601102A/data-issues',
        expect.objectContaining({
          issueType: 'value_incorrect',
          description: 'The HAC-D mark disagrees with the committee report table.',
          fy: 2027,
          suggestedSourceUrl: null,
        }),
      ),
    );
    // Modal closes after success.
    await waitFor(() => expect(screen.queryByTestId('pe-data-issue-modal')).not.toBeInTheDocument());
  });

  test('a 404 renders the not-found state, never an empty profile', async () => {
    mockEndpoints(() => Promise.reject({ response: { status: 404 } }));
    renderProfile();

    expect(await screen.findByTestId('pe-state-not-found')).toBeInTheDocument();
    expect(
      screen.getByText('No PE record exists for 0601102A. This is not an empty watch page.'),
    ).toBeInTheDocument();
  });

  test('a non-404 failure renders the failed state with a retry affordance', async () => {
    mockEndpoints(() => Promise.reject({ response: { status: 500 } }));
    renderProfile();

    expect(await screen.findByTestId('pe-state-failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  test('an unsupported source family fails closed with no fabricated figures', async () => {
    mockEndpoints({ ...DETAIL, unsupportedSourceFamily: true });
    renderProfile();

    expect(await screen.findByTestId('pe-state-unsupported')).toBeInTheDocument();
    expect(screen.queryByText('$310.5M')).not.toBeInTheDocument();
  });

  test('a known identity with no ingested budget years says so explicitly', async () => {
    mockEndpoints({ ...DETAIL, years: [] });
    renderProfile();

    expect(await screen.findByText('Not yet ingested')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The Program Element identity is known, but no budget-year rows have been ingested for this code.',
      ),
    ).toBeInTheDocument();
    // NO POSITION headline — a missing figure is stated, never zeroed.
    expect(screen.getByText('NO POSITION')).toBeInTheDocument();
  });
});
