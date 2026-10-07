import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlannerEvent, PlannerResource } from '@capiro/strategy-verifier';
import {
  GoalReminderEditor,
  GoalUpdateComposer,
  PlannerGoalActivity,
  PlannerGoalHistory,
} from './planner-goal-activity.js';
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  save: vi.fn(),
  follow: vi.fn(),
  comment: vi.fn(),
  events: [] as PlannerEvent[],
}));
vi.mock('./planner-api.js', () => ({
  usePlannerEvents: () => ({
    data: { pages: [{ items: mocks.events, goalContext: { audienceCount: 2, following: false } }] },
    error: null,
    isPending: false,
    hasNextPage: false,
  }),
  usePlannerMutations: () => ({
    goalUpdate: { mutateAsync: mocks.post, isPending: false },
    resource: { mutateAsync: mocks.save, isPending: false },
    followGoal: { mutateAsync: mocks.follow, isPending: false },
    event: { mutateAsync: mocks.comment, isPending: false },
    reviseEvent: { mutateAsync: vi.fn(), isPending: false },
  }),
  plannerError: (e: unknown) =>
    (e as { response?: { status?: number } }).response?.status === 409
      ? 'Someone else updated this item. Refresh it before saving your changes.'
      : String(e),
}));
const goal: PlannerResource = {
  id: 'goal-one',
  kind: 'goal',
  name: 'Reduce incidents',
  projectId: null,
  ownerId: 'owner',
  version: 3,
  access: 'admin',
  archived: false,
  data: {
    ownerId: 'owner',
    status: 'on_track',
    progress: 'manual',
    current: 70,
    target: 0,
    startValue: 100,
    direction: 'decrease',
    unit: 'incidents',
    followers: [],
  },
};
const bootstrap = {
  me: { id: 'owner', name: 'Owner' },
  people: [{ id: 'owner', name: 'Owner' }],
  projects: [],
};
beforeEach(() => {
  mocks.events = [];
  mocks.post.mockReset().mockResolvedValue({});
  mocks.save.mockReset().mockResolvedValue({});
  mocks.follow.mockReset().mockResolvedValue({});
  mocks.comment.mockReset().mockResolvedValue({});
});
afterEach(cleanup);
describe('Planner goal posts and reminders', () => {
  it('offers the responsible owner atomic reminder settings in a status post and validates native date inputs', async () => {
    render(<PlannerGoalActivity goal={goal} bootstrap={bootstrap} />);
    fireEvent.click(screen.getByRole('button', { name: 'Post status update' }));
    fireEvent.change(screen.getByLabelText('Update title'), {
      target: { value: 'Review and remind' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Set reminders with this update' }));
    fireEvent.change(screen.getByLabelText('Reminder cadence'), { target: { value: 'quarterly' } });
    fireEvent.input(screen.getByLabelText('First reminder'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Post update' })).toBeDisabled();
    fireEvent.input(screen.getByLabelText('First reminder'), { target: { value: '2043-01-31' } });
    fireEvent.input(screen.getByLabelText('Reminder time'), { target: { value: '09:45' } });
    fireEvent.change(screen.getByLabelText('Reminder time zone'), { target: { value: 'UTC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post update' }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: goal.id,
          version: 3,
          title: 'Review and remind',
          timeZone: 'UTC',
          reminder: {
            cadence: 'quarterly',
            anchorOn: '2043-01-31',
            time: '09:45',
            timeZone: 'UTC',
          },
        }),
      ),
    );
  });
  it('posts named structured sections with manual progress and keeps the opening version across refreshes', async () => {
    const close = vi.fn(),
      mutation = { mutateAsync: mocks.post, isPending: false };
    const view = render(
      <GoalUpdateComposer goal={goal} audience={2} mutation={mutation} onClose={close} />,
    );
    expect(screen.getByText(/2 people receive goal updates/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Update title'), { target: { value: 'Weekly review' } });
    fireEvent.change(screen.getByLabelText('Update status'), { target: { value: 'at_risk' } });
    fireEvent.change(screen.getByLabelText('Progress value (incidents)'), {
      target: { value: '20' },
    });
    fireEvent.change(screen.getByLabelText('Section 1 text'), {
      target: { value: '**Down** to twenty.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add update section' }));
    fireEvent.change(screen.getByLabelText('Section 4 heading'), {
      target: { value: 'Next review' },
    });
    view.rerender(
      <GoalUpdateComposer
        goal={{ ...goal, version: 8 }}
        audience={2}
        mutation={mutation}
        onClose={close}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Post update' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(mocks.post).toHaveBeenCalledWith(
      expect.objectContaining({
        id: goal.id,
        version: 3,
        title: 'Weekly review',
        status: 'at_risk',
        current: 20,
        sections: expect.arrayContaining([
          expect.objectContaining({ title: 'Summary', text: '**Down** to twenty.' }),
          expect.objectContaining({ title: 'Next review' }),
        ]),
      }),
    );
  });
  it('takes automatic progress from connected work and retains a conflicting post draft', async () => {
    mocks.post.mockRejectedValue({ response: { status: 409 } });
    const close = vi.fn();
    render(
      <GoalUpdateComposer
        goal={{ ...goal, data: { ...goal.data, progress: 'project_task_completion' } }}
        mutation={{ mutateAsync: mocks.post, isPending: false }}
        onClose={close}
      />,
    );
    expect(screen.queryByLabelText(/Progress value/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Update title'), {
      target: { value: 'Do not lose this draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Post update' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Refresh it before saving');
    expect(screen.getByLabelText('Update title')).toHaveValue('Do not lose this draft');
    expect(mocks.post.mock.calls[0]![0]).not.toHaveProperty('current');
    expect(close).not.toHaveBeenCalled();
  });
  it('saves cadence, first date, local time and zone without adopting a competing version', async () => {
    const close = vi.fn(),
      mutation = { mutateAsync: mocks.save, isPending: false };
    const view = render(<GoalReminderEditor goal={goal} mutation={mutation} onClose={close} />);
    fireEvent.change(screen.getByLabelText('Reminder cadence'), { target: { value: 'monthly' } });
    fireEvent.input(screen.getByLabelText('First reminder'), { target: { value: '2043-01-31' } });
    fireEvent.input(screen.getByLabelText('Reminder time'), { target: { value: '09:30' } });
    fireEvent.change(screen.getByLabelText('Reminder time zone'), {
      target: { value: 'America/New_York' },
    });
    view.rerender(
      <GoalReminderEditor goal={{ ...goal, version: 8 }} mutation={mutation} onClose={close} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save reminders' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(mocks.save).toHaveBeenCalledWith({
      id: goal.id,
      version: 3,
      data: {
        timeZone: 'America/New_York',
        reminder: {
          cadence: 'monthly',
          anchorOn: '2043-01-31',
          time: '09:30',
          timeZone: 'America/New_York',
        },
      },
    });
  });
  it('leaves numeric gaps for revoked history and preserves original units and targets in the table', () => {
    const snapshot = {
      status: 'on_track',
      measurement: 'manual',
      value: 70,
      percentage: 30,
      startValue: 100,
      target: 0,
      direction: 'decrease',
      unit: 'incidents',
    } as const;
    const event = {
      id: 'old',
      createdAt: '2026-01-01T09:00:00Z',
      goalSnapshot: snapshot,
    } as PlannerEvent;
    const { container } = render(
      <PlannerGoalHistory
        events={[
          event,
          {
            ...event,
            id: 'private',
            createdAt: '2026-01-02T09:00:00Z',
            goalSnapshot: { ...snapshot, value: undefined, percentage: undefined },
          },
          {
            ...event,
            id: 'new',
            createdAt: '2026-01-03T09:00:00Z',
            goalSnapshot: { ...snapshot, value: 200, percentage: 50, target: 400, unit: 'USD' },
          },
        ]}
      />,
    );
    expect(screen.getByRole('table')).toHaveTextContent('70 incidents (start 100, target 0)');
    expect(screen.getByRole('table')).toHaveTextContent('200 USD (start 100, target 400)');
    expect(screen.getByText('Unavailable with current access')).toBeInTheDocument();
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    expect(container.querySelector('path')?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
  });
  it('allows viewers to follow existing grants while restricting posts, comments and reminder settings', async () => {
    render(
      <PlannerGoalActivity
        goal={{ ...goal, access: 'viewer' }}
        bootstrap={{ ...bootstrap, me: { id: 'viewer', name: 'Viewer' } }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Post status update' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Goal comment')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit reminders' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Follow goal' }));
    await waitFor(() =>
      expect(mocks.follow).toHaveBeenCalledWith({ id: goal.id, version: 3, following: true }),
    );
  });
  it('renders formatted updates and permits comments without offering immutable status edits', async () => {
    mocks.events = [
      {
        id: 'post',
        taskId: null,
        projectId: null,
        resourceId: goal.id,
        actorId: 'owner',
        kind: 'goal_status',
        text: 'Weekly **ready**',
        minutes: null,
        createdAt: '2026-01-01T09:00:00Z',
      },
    ];
    render(<PlannerGoalActivity goal={goal} bootstrap={bootstrap} />);
    expect(screen.getByText('ready').tagName).toBe('STRONG');
    expect(screen.queryByRole('button', { name: 'Edit comment' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Goal comment'), {
      target: { value: 'A useful comment' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    await waitFor(() =>
      expect(mocks.comment).toHaveBeenCalledWith({
        resourceId: goal.id,
        kind: 'comment',
        text: 'A useful comment',
      }),
    );
  });
});
