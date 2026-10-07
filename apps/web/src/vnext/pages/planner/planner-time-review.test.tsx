import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANNER_DEFAULT_TIME_REVIEW } from '@capiro/strategy-verifier';
import { PlannerTimeReview } from './planner-time-review.js';
import { PlannerTimesheetHistory } from './planner-timesheet-history.js';
const mocks = vi.hoisted(() => ({
  preferences: {} as any,
  query: {} as any,
  history: {} as any,
  save: vi.fn(),
  next: vi.fn(),
  views: [] as any[],
}));
vi.mock('./planner-api.js', () => ({
  usePlannerTimePreferences: () => mocks.preferences,
  usePlannerTimeReviewPages: (_week: string, view: unknown) => {
    mocks.views.push(view);
    return mocks.query;
  },
  usePlannerTimesheetHistory: () => mocks.history,
  usePlannerMutations: () => ({ timePreferences: { mutateAsync: mocks.save, isPending: false } }),
  plannerError: String,
}));
const row = { userId: 'member', status: 'submitted', totalMinutes: 90, billableMinutes: 60 };
const page = () => ({
  revision: 'a',
  matched: 1,
  people: [{ id: 'member', name: 'Jamie Lee' }],
  items: [row],
  totalMinutes: 90,
  billableMinutes: 60,
  nextCursor: null,
});
beforeEach(() => {
  mocks.save.mockReset().mockResolvedValue({ ok: true, version: 5 });
  mocks.next.mockReset();
  mocks.views = [];
  mocks.preferences = {
    data: {
      version: 4,
      autoAddDueTasks: true,
      reviewView: structuredClone(PLANNER_DEFAULT_TIME_REVIEW),
    },
  };
  mocks.query = { data: { pages: [page()] }, fetchNextPage: mocks.next };
  mocks.history = {
    data: {
      pages: [
        {
          revision: 'a',
          history: [
            {
              id: 'one',
              actorId: 'member',
              text: 'Submitted timesheet',
              createdAt: '2026-10-07T12:00:00Z',
            },
          ],
        },
      ],
    },
    hasNextPage: true,
    fetchNextPage: mocks.next,
  };
});
afterEach(cleanup);
describe('Private reviewer views and complete status activity', () => {
  it('keeps the opening preference version when another preference update arrives', async () => {
    const node = () => <PlannerTimeReview week="2026-10-05" onSelect={vi.fn()} />;
    const ui = render(node());
    fireEvent.change(screen.getByLabelText('Review sort'), { target: { value: 'total' } });
    fireEvent.change(screen.getByLabelText('Review order'), { target: { value: 'desc' } });
    mocks.preferences = {
      data: {
        version: 9,
        autoAddDueTasks: false,
        reviewView: structuredClone(PLANNER_DEFAULT_TIME_REVIEW),
      },
    };
    ui.rerender(node());
    expect(screen.getByLabelText('Review sort')).toHaveValue('total');
    fireEvent.click(screen.getByRole('button', { name: 'Save review view' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        version: 4,
        reviewView: { ...PLANNER_DEFAULT_TIME_REVIEW, sort: 'total', direction: 'desc' },
      }),
    );
  });
  it('preserves a saved unassigned person and keeps a rejected save editable', async () => {
    mocks.preferences.data.reviewView.people = ['no-longer-assigned'];
    mocks.save.mockRejectedValue(Error('Settings changed'));
    render(<PlannerTimeReview week="2026-10-05" onSelect={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'No longer assigned (saved)' })).toBeInTheDocument();
    expect(screen.getByLabelText('Review people')).toHaveValue(['no-longer-assigned']);
    fireEvent.change(screen.getByLabelText('Review sort'), { target: { value: 'billable' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save review view' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings changed');
    expect(screen.getByLabelText('Review sort')).toHaveValue('billable');
    expect(mocks.save.mock.calls[0]![0].reviewView.people).toEqual(['no-longer-assigned']);
  });
  it('uses server totals over all pages and opens the exact submitter', () => {
    const select = vi.fn();
    mocks.query.hasNextPage = true;
    mocks.query.data.pages[0] = {
      ...page(),
      matched: 121,
      totalMinutes: 7260,
      billableMinutes: 3600,
    };
    render(<PlannerTimeReview week="2026-10-05" onSelect={select} />);
    expect(
      screen.getByText('121 matching submitters · 121 h total · 60 h billable'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View timesheet' }));
    expect(select).toHaveBeenCalledWith('member');
    fireEvent.click(screen.getByRole('button', { name: 'Load more submitters' }));
    expect(mocks.next).toHaveBeenCalledTimes(1);
  });
  it('hides retained review names and totals after access or page revision changes', () => {
    mocks.query.isError = true;
    mocks.query.error = Error('Access changed');
    const ui = render(<PlannerTimeReview week="2026-10-05" onSelect={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Access changed');
    expect(screen.queryByText('Jamie Lee')).not.toBeInTheDocument();
    mocks.query.isError = false;
    mocks.query.data.pages.push({ ...page(), revision: 'b' });
    ui.rerender(<PlannerTimeReview week="2026-10-05" onSelect={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Time changed while loading');
    expect(screen.queryByRole('button', { name: 'View timesheet' })).not.toBeInTheDocument();
  });
  it('loads additional status pages and hides retained history after access changes', () => {
    const sheet = { weekOn: '2026-10-05', userId: 'member', revision: 'a' } as any;
    const ui = render(<PlannerTimesheetHistory sheet={sheet} people={page().people} />);
    expect(screen.getByText('Submitted timesheet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more status activity' }));
    expect(mocks.next).toHaveBeenCalledTimes(1);
    mocks.history.isError = true;
    mocks.history.error = Error('Access changed');
    ui.rerender(<PlannerTimesheetHistory sheet={sheet} people={page().people} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Access changed');
    expect(screen.queryByText('Submitted timesheet')).not.toBeInTheDocument();
  });
  it('hides history when its revision no longer matches the selected sheet', () => {
    render(
      <PlannerTimesheetHistory
        sheet={{ weekOn: '2026-10-05', userId: 'member', revision: 'b' } as any}
        people={page().people}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Time changed while loading');
    expect(screen.queryByText('Submitted timesheet')).not.toBeInTheDocument();
  });
});
