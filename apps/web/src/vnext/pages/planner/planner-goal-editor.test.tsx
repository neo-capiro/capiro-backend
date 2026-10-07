import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PLANNER_DEFAULT_PROJECT,
  type PlannerGoalData,
  type PlannerResource,
  type PlannerBootstrap,
} from '@capiro/strategy-verifier';
import { PlannerGoalEditor } from './planner-goal-editor.js';
import { PlannerGoalDetail } from './planner-goal-detail.js';
const data = (patch: Partial<PlannerGoalData> = {}): PlannerGoalData => ({
  description: '',
  privacy: 'private',
  members: [],
  projectIds: [],
  ownerId: null,
  dueOn: null,
  status: 'on_track',
  progress: 'manual',
  current: 0,
  target: 100,
  unit: '%',
  ...patch,
});
const resource = (id: string, patch: Partial<PlannerGoalData> = {}): PlannerResource => ({
  id,
  kind: 'goal',
  projectId: null,
  ownerId: 'me',
  name: id,
  data: data(patch) as unknown as Record<string, unknown>,
  version: 1,
  archived: false,
  access: 'admin',
});
const goals = [
  resource('current'),
  resource('parent', { subgoalIds: ['current'] }),
  resource('child', { current: 50 }),
  resource('dollars', { unit: 'USD' }),
];
const bootstrap: PlannerBootstrap = {
  me: { id: 'me', name: 'Me' },
  people: [{ id: 'me', name: 'Me' }],
  projects: ['first', 'second'].map((id) => ({
    ...PLANNER_DEFAULT_PROJECT,
    id,
    name: id,
    ownerId: 'me',
    version: 1,
    access: 'admin',
    archived: false,
    createdAt: '',
    updatedAt: '',
  })),
};
function Editor({ initial }: { initial: PlannerGoalData }) {
  const [goal, setGoal] = useState(initial);
  return (
    <>
      <PlannerGoalEditor
        goal={goal}
        id="current"
        goals={goals}
        bootstrap={bootstrap}
        tasks={[]}
        edit={(patch) => setGoal((old) => ({ ...old, ...patch }))}
      />
      <output data-testid="goal">{JSON.stringify(goal)}</output>
    </>
  );
}
const current = () => JSON.parse(screen.getByTestId('goal').textContent!) as PlannerGoalData;
const selectMultiple = (name: string, ids: string[]) => {
  const el = screen.getByRole('listbox', { name }) as HTMLSelectElement;
  for (const option of el.options) option.selected = ids.includes(option.value);
  fireEvent.change(el);
};
afterEach(cleanup);
describe('Planner goal editing and progress detail', () => {
  it('retains native date input changes and clears dates explicitly', () => {
    render(<Editor initial={data()} />);
    fireEvent.input(screen.getByLabelText('Start date'), { target: { value: '2043-01-01' } });
    fireEvent.input(screen.getByLabelText('Due date'), { target: { value: '2043-01-08' } });
    expect(current()).toMatchObject({ startOn: '2043-01-01', dueOn: '2043-01-08' });
    fireEvent.input(screen.getByLabelText('Due date'), { target: { value: '' } });
    expect(current().dueOn).toBeNull();
  });
  it('changes progress sources without discarding related work and resets percentage settings', () => {
    render(
      <Editor
        initial={data({
          subgoalIds: ['child'],
          projectIds: ['first'],
          taskIds: ['retained'],
          current: 40,
          target: 1000,
          unit: 'USD',
          startValue: 100,
          direction: 'increase',
        })}
      />,
    );
    fireEvent.change(screen.getByLabelText('Progress measurement'), {
      target: { value: 'project_task_completion' },
    });
    expect(current()).toMatchObject({
      progress: 'project_task_completion',
      target: 100,
      unit: '%',
      startValue: 0,
      direction: 'increase',
      subgoalIds: ['child'],
      taskIds: ['retained'],
      projectIds: ['first'],
    });
    expect(screen.queryByLabelText('Current value')).not.toBeInTheDocument();
  });
  it('edits custom weights, preserves them when unrelated links change, and rebalances after progress sources change', () => {
    render(
      <Editor
        initial={data({ progress: 'project_task_completion', projectIds: ['first', 'second'] })}
      />,
    );
    fireEvent.change(screen.getByLabelText('Progress weights'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Weight for first (%)'), { target: { value: '75' } });
    fireEvent.change(screen.getByLabelText('Weight for second (%)'), { target: { value: '25' } });
    selectMultiple('Connected subgoals', ['child']);
    expect(current().weights).toEqual([
      { sourceId: 'first', weight: 75 },
      { sourceId: 'second', weight: 25 },
    ]);
    expect(screen.getByText('Total: 100.00% · Must equal 100%.')).toBeInTheDocument();
    selectMultiple('Connected projects', ['first']);
    expect(current().weights).toEqual([{ sourceId: 'first', weight: 100 }]);
    expect(current().subgoalIds).toEqual(['child']);
  });
  it('prevents known parent cycles and incompatible numeric contributors while keeping ordinary children available', () => {
    render(<Editor initial={data({ progress: 'subgoal_total' })} />);
    const selector = within(screen.getByRole('listbox', { name: 'Connected subgoals' }));
    expect(selector.getByRole('option', { name: 'parent' })).toBeDisabled();
    expect(selector.getByRole('option', { name: 'dollars' })).toBeDisabled();
    expect(selector.getByRole('option', { name: 'child' })).not.toBeDisabled();
    expect(selector.queryByRole('option', { name: 'current' })).not.toBeInTheDocument();
  });
  it('retains selected task references while task-name pages load', () => {
    render(<Editor initial={data({ taskIds: ['retained'] })} />);
    const selector = screen.getByRole('listbox', { name: 'Connected tasks' });
    expect(
      within(selector).getByRole('option', { name: 'Connected task (loading name)' }),
    ).toHaveProperty('selected', true);
    selectMultiple('Connected tasks', ['retained']);
    expect(current().taskIds).toEqual(['retained']);
  });
  it('shows decreasing progress from a nonzero start toward a zero target', () => {
    const g = resource('current', {
      current: 25,
      startValue: 100,
      target: 0,
      direction: 'decrease',
      unit: 'incidents',
    });
    render(
      <PlannerGoalDetail
        goal={g}
        goals={goals}
        bootstrap={bootstrap}
        tasks={[]}
        onGoal={() => {}}
        onProject={() => {}}
        onTask={() => {}}
        onEdit={() => {}}
      />,
    );
    expect(screen.getByRole('progressbar', { name: 'current progress' })).toHaveAttribute(
      'value',
      '75',
    );
    expect(screen.getByText(/Starting at 100 incidents/)).toBeInTheDocument();
  });
  it('shows authoritative progress and contribution navigation even when task pages are empty', () => {
    const g = resource('current', {
      progress: 'task_list_completion',
      taskIds: ['persisted-task'],
    });
    g.goalProgress = {
      value: 100,
      percentage: 100,
      sources: [{ id: 'persisted-task', kind: 'task', value: 100, percentage: 100, weight: 100 }],
    };
    const onTask = vi.fn();
    render(
      <PlannerGoalDetail
        goal={g}
        goals={goals}
        bootstrap={bootstrap}
        tasks={[]}
        onGoal={() => {}}
        onProject={() => {}}
        onTask={onTask}
        onEdit={() => {}}
      />,
    );
    const contributions = within(screen.getByRole('region', { name: 'Progress contributions' }));
    expect(contributions.getByRole('cell', { name: '100.0%' })).toBeInTheDocument();
    fireEvent.click(contributions.getByRole('button', { name: 'Open connected work' }));
    expect(onTask).toHaveBeenCalledWith('persisted-task');
  });
});
