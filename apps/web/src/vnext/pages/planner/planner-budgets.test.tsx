import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLANNER_DEFAULT_PROJECT,
  plannerDefaultBudget,
  PLANNER_DEFAULT_BUDGET_ALERT,
  type PlannerBootstrap,
  type PlannerProjectBudget,
} from '@capiro/strategy-verifier';
import { PlannerBudget, PlannerPortfolioBudget } from './planner-budgets.js';
const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), scope: 'org-one' }));
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: mocks.get, patch: mocks.patch }),
}));
vi.mock('./planner-api.js', () => ({
  usePlannerKey: () => ['planner', mocks.scope, 'alex'],
  plannerError: (e: unknown) => String(e),
}));
const bootstrap: PlannerBootstrap = {
  me: { id: 'alex', name: 'Alex' },
  people: [
    { id: 'alex', name: 'Alex' },
    { id: 'jamie', name: 'Jamie' },
  ],
  projects: [
    {
      ...PLANNER_DEFAULT_PROJECT,
      name: 'Launch',
      id: 'project',
      ownerId: 'alex',
      access: 'admin',
      version: 1,
      archived: false,
      createdAt: '2026-10-07',
      updatedAt: '2026-10-07',
    },
  ],
};
const value = (): PlannerProjectBudget => ({
  projectId: 'project',
  projectName: 'Launch',
  version: 4,
  data: {
    ...plannerDefaultBudget(),
    measurement: 'cost',
    budgetMinor: '10000',
    rates: [{ userId: 'alex', name: 'Alex', hourlyMinor: '10000' }],
  },
  alert: { ...PLANNER_DEFAULT_BUDGET_ALERT },
  estimatedMinutes: 120,
  actualMinutes: 60,
  billableMinutes: 60,
  nonbillableMinutes: 0,
  estimatedMinor: '20000',
  actualMinor: '10000',
  unratedEstimatedMinutes: 0,
  unratedActualMinutes: 0,
  people: [
    {
      userId: 'alex',
      name: 'Alex',
      active: true,
      hourlyMinor: '10000',
      estimatedMinutes: 120,
      actualMinutes: 60,
      estimatedMinor: '20000',
      actualMinor: '10000',
    },
  ],
});
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  mocks.scope = 'org-one';
  mocks.get.mockReset().mockResolvedValue({ data: value() });
  mocks.patch.mockReset().mockResolvedValue({ data: { ...value(), version: 5 } });
});
afterEach(() => {
  cleanup();
  client.clear();
});
const node = (data = bootstrap) => (
  <QueryClientProvider client={client}>
    <PlannerBudget projectId="project" bootstrap={data} />
  </QueryClientProvider>
);
const load = async () => {
  render(node());
  await screen.findByRole('button', { name: 'Set budget' });
};
describe('Private project budget controls', () => {
  it('does not request financial data for a project editor', () => {
    render(node({ ...bootstrap, projects: [{ ...bootstrap.projects[0]!, access: 'editor' }] }));
    expect(screen.getByText(/Project admin access is required/)).toBeVisible();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('shows exact rated totals and warns when costs omit unrated time', async () => {
    mocks.get.mockResolvedValue({
      data: { ...value(), unratedEstimatedMinutes: 60, unratedActualMinutes: 30 },
    });
    await load();
    expect(screen.getByText('Rated actual cost')).toBeVisible();
    expect(screen.getByText(/Unrated time: 1 h estimated · 0.5 h actual/)).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'Budget used' })).toHaveValue(100);
  });
  it('saves hours and billable inclusion with the opening budget version', async () => {
    await load();
    fireEvent.click(screen.getByRole('button', { name: 'Set budget' }));
    fireEvent.change(screen.getByLabelText('Budget measurement'), { target: { value: 'time' } });
    fireEvent.change(screen.getByLabelText('Budget hours'), { target: { value: '10.5' } });
    fireEvent.change(screen.getByLabelText('Actual time included'), {
      target: { value: 'billable' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith('/strategy-api/planner/projects/project/budget', {
        version: 4,
        data: { measurement: 'time', budgetMinutes: 630, actualFilter: 'billable' },
      }),
    );
  });
  it('rounds added rates to two decimals and keeps people identities without granting access', async () => {
    await load();
    fireEvent.click(screen.getByRole('button', { name: 'Manage rates' }));
    fireEvent.change(screen.getByLabelText('Add person'), { target: { value: 'jamie' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to rate pool' }));
    fireEvent.change(screen.getByLabelText('Hourly rate for Jamie'), {
      target: { value: '75.555' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save rates' }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith('/strategy-api/planner/projects/project/budget', {
        version: 4,
        data: {
          rates: [
            { userId: 'alex', name: 'Alex', hourlyMinor: '10000' },
            { userId: 'jamie', name: 'Jamie', hourlyMinor: '7556' },
          ],
        },
      }),
    );
  });
  it('captures the version when an editor opens and does not overwrite a concurrent update', async () => {
    await load();
    fireEvent.click(screen.getByRole('button', { name: 'Set budget' }));
    act(() =>
      client.setQueryData(['planner', 'org-one', 'alex', 'budget', 'project'], {
        ...value(),
        version: 9,
      }),
    );
    fireEvent.change(screen.getByLabelText('Budget cost (USD)'), { target: { value: '200' } });
    mocks.patch.mockRejectedValue(Error('Budget changed. Refresh before saving again.'));
    fireEvent.click(screen.getByRole('button', { name: 'Save budget' }));
    await screen.findByRole('alert');
    expect(mocks.patch.mock.calls[0]?.[1].version).toBe(4);
    expect(screen.getByRole('dialog', { name: 'Set project budget' })).toBeVisible();
  });
  it('enables a personal alert using its own opening version and rejects bad thresholds', async () => {
    await load();
    fireEvent.click(screen.getByRole('button', { name: 'My budget alert' }));
    fireEvent.click(screen.getByLabelText('Notify me when actual work reaches the threshold'));
    fireEvent.change(screen.getByLabelText('Threshold percent'), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Save my alert' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Threshold percent'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Compare actual work with'), {
      target: { value: 'estimate' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save my alert' }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith(
        '/strategy-api/planner/projects/project/budget/alert',
        { version: 0, data: { enabled: true, percent: 90, comparison: 'estimate' } },
      ),
    );
  });
  it('does not keep cached financial data visible after a failed access recheck', async () => {
    await load();
    mocks.get.mockRejectedValue(Error('Project unavailable'));
    await act(() =>
      client.invalidateQueries({ queryKey: ['planner', 'org-one', 'alex', 'budget', 'project'] }),
    );
    await screen.findByRole('alert');
    expect(screen.queryByText('Budget and costs')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
  it('separates organization caches and cancels an unfinished source read', async () => {
    let signal: AbortSignal | undefined;
    mocks.get.mockImplementation((_url, config) => {
      signal = config.signal;
      return new Promise(() => {});
    });
    const rendered = render(node());
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    mocks.scope = 'org-two';
    mocks.get.mockResolvedValue({ data: value() });
    rendered.rerender(node());
    await screen.findByRole('button', { name: 'Set budget' });
    expect(signal?.aborted).toBe(true);
  });
  it('disables changes to archived project budgets while leaving history readable', async () => {
    render(node({ ...bootstrap, projects: [{ ...bootstrap.projects[0]!, archived: true }] }));
    await screen.findByRole('button', { name: 'Set budget' });
    expect(screen.getByRole('button', { name: 'Set budget' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Manage rates' })).toBeDisabled();
    expect(screen.getByRole('table')).toBeVisible();
  });
  it('loads portfolio rollups on demand and keeps currency totals separate', async () => {
    mocks.get.mockResolvedValue({
      data: {
        projects: [],
        estimatedMinutes: 120,
        actualMinutes: 60,
        budgetMinutes: 600,
        currencies: [
          {
            currency: 'USD',
            estimatedMinor: '20000',
            actualMinor: '10000',
            budgetMinor: '10000',
            unratedActualMinutes: 0,
            unratedEstimatedMinutes: 0,
          },
          {
            currency: 'EUR',
            estimatedMinor: '5000',
            actualMinor: '0',
            budgetMinor: '20000',
            unratedActualMinutes: 0,
            unratedEstimatedMinutes: 0,
          },
        ],
      },
    });
    render(
      <QueryClientProvider client={client}>
        <PlannerPortfolioBudget id="portfolio" onProject={() => {}} />
      </QueryClientProvider>,
    );
    expect(mocks.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Budget rollup' }));
    await screen.findByText(/USD: \$200.00 rated estimate/);
    expect(screen.getByText(/EUR: €50.00 rated estimate/)).toBeVisible();
    expect(mocks.get.mock.calls[0]?.[0]).toBe('/strategy-api/planner/portfolios/portfolio/budgets');
  });
});
