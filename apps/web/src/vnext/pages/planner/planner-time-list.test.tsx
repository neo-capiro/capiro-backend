// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PLANNER_DEFAULT_TASK,
  type PlannerTask,
  type PlannerTimeTreeNode,
} from '@capiro/strategy-verifier';
import { PlannerHierarchyList } from './planner-time-list.js';
const parent: PlannerTask = {
  ...PLANNER_DEFAULT_TASK,
  id: 'parent',
  name: 'Parent',
  ownerId: 'me',
  access: 'editor',
  version: 1,
  archived: false,
  completedAt: null,
  createdAt: '2026-10-07T12:00:00Z',
  updatedAt: '2026-10-07T12:00:00Z',
  estimateMinutes: 60,
  actualMinutes: 60,
};
const child = {
  ...parent,
  id: 'child',
  name: 'Child',
  parentId: 'parent',
  estimateMinutes: 30,
  actualMinutes: 45,
};
const leaf = {
  ...parent,
  id: 'leaf',
  name: 'Leaf',
  parentId: 'child',
  estimateMinutes: 15,
  actualMinutes: 30,
};
const tasks = [parent, child, leaf];
const nodes: PlannerTimeTreeNode[] = tasks.map((task) => ({
  id: task.id,
  parentId: task.parentId,
  version: 1,
  scoped: true,
  estimateMinutes: task.estimateMinutes,
  actualMinutes: task.actualMinutes,
}));
const props = {
  tasks,
  people: [],
  onOpen: vi.fn(),
  onPatch: vi.fn(),
  disabled: false,
  nodes,
  renderChildren: (task: PlannerTask, rows: (tasks: PlannerTask[]) => React.ReactNode) =>
    rows(tasks.filter((t) => t.parentId === task.id)),
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('Hierarchy time values and distinct section totals', () => {
  it('does not repeat a separately grouped child inside an expanded parent', () => {
    render(
      <PlannerHierarchyList
        {...props}
        tasks={[parent, { ...child, status: 'done' }]}
        groupBy="status"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand first-level subtasks' }));
    expect(screen.getAllByRole('button', { name: 'Child' })).toHaveLength(1);
    expect(
      within(screen.getByRole('region', { name: 'Done' })).getByRole('button', { name: 'Child' }),
    ).toBeTruthy();
    expect(screen.getByLabelText('Total task time')).toHaveTextContent('Actual 2:15');
  });
  it('changes only first-level expansion while preserving deeper choices and totals', () => {
    render(<PlannerHierarchyList {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand first-level subtasks' }));
    expect(screen.getByRole('button', { name: 'Child' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Leaf' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand subtasks of Child' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse first-level subtasks' }));
    expect(screen.queryByRole('button', { name: 'Child' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand first-level subtasks' }));
    expect(screen.getByRole('button', { name: 'Leaf' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all groups' }));
    expect(screen.queryByRole('button', { name: 'Parent' })).toBeNull();
    expect(screen.getByLabelText('Total task time')).toHaveTextContent('Actual 2:15');
    fireEvent.click(screen.getByRole('button', { name: 'Expand all groups' }));
    expect(screen.getByRole('button', { name: 'Leaf' })).toBeTruthy();
  });
  it('uses restored personal layout state and emits a captured preference change without modifying tasks', () => {
    const save = vi.fn();
    const layout = {
      data: {
        scope: 'mine' as const,
        projectId: null,
        view: 'list' as const,
        expandedTaskIds: ['parent', 'child'],
        collapsedGroupIds: [],
        hideUnscheduled: false,
      },
      disabled: false,
      save,
    };
    const { rerender } = render(<PlannerHierarchyList {...props} layout={layout} />);
    expect(screen.getByRole('button', { name: 'Leaf' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse first-level subtasks' }));
    expect(save).toHaveBeenLastCalledWith({ expandedTaskIds: ['child'] });
    expect(props.onPatch).not.toHaveBeenCalled();
    rerender(
      <PlannerHierarchyList
        {...props}
        layout={{
          ...layout,
          data: { ...layout.data, expandedTaskIds: [], collapsedGroupIds: ['section:'] },
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Parent' })).toBeNull();
    rerender(<PlannerHierarchyList {...props} layout={{ ...layout, disabled: true }} />);
    expect(screen.getByRole('button', { name: 'Collapse first-level subtasks' })).toBeDisabled();
  });
  it('sorts by full collapsed time and keeps that order while expanding', () => {
    const other = {
      ...parent,
      id: 'other',
      name: 'Other',
      actualMinutes: 100,
      estimateMinutes: 80,
    };
    const otherNode = {
      id: 'other',
      parentId: null,
      version: 1,
      scoped: true,
      actualMinutes: 100,
      estimateMinutes: 80,
    };
    render(
      <PlannerHierarchyList
        {...props}
        tasks={[other, ...tasks]}
        nodes={[...nodes, otherNode]}
        timeSort="actual"
      />,
    );
    const order = () =>
      screen
        .getAllByRole('button')
        .filter(
          (button) =>
            button.getAttribute('aria-label') === 'Parent' ||
            button.getAttribute('aria-label') === 'Other',
        )
        .map((button) => button.getAttribute('aria-label'));
    expect(order()).toEqual(['Parent', 'Other']);
    fireEvent.click(screen.getByRole('button', { name: 'Expand subtasks of Parent' }));
    expect(order()).toEqual(['Parent', 'Other']);
  });
  it('shows rolled-up collapsed time without repeating explicitly listed subtasks', () => {
    render(<PlannerHierarchyList {...props} />);
    expect(screen.getByLabelText('Estimated time for Parent')).toHaveTextContent('1:45');
    expect(
      screen.getByRole('button', { name: 'Actual time for Parent: 2:15' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Child' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Time totals for Tasks')).toHaveTextContent(
      'Estimated 1:45 · Actual 2:15',
    );
    expect(screen.getByLabelText('Total task time')).toHaveTextContent(
      '3 tasks and subtasks, counted once.',
    );
  });
  it('shows separate own values at each expanded level and restores totals on collapse', () => {
    render(<PlannerHierarchyList {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand subtasks of Parent' }));
    expect(
      screen.getByRole('button', { name: 'Actual time for Parent: 1:00' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actual time for Child: 1:15' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand subtasks of Child' }));
    expect(screen.getByRole('button', { name: 'Actual time for Child: 0:45' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actual time for Leaf: 0:30' })).toBeInTheDocument();
    expect(screen.getByLabelText('Time totals for Tasks')).toHaveTextContent('Actual 2:15');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse subtasks of Parent' }));
    expect(
      screen.getByRole('button', { name: 'Actual time for Parent: 2:15' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leaf' })).not.toBeInTheDocument();
  });
  it('opens the exact parent history and child task while completion remains independent', () => {
    render(<PlannerHierarchyList {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actual time for Parent: 2:15' }));
    expect(props.onOpen).toHaveBeenLastCalledWith('parent');
    fireEvent.click(screen.getByRole('button', { name: 'Expand subtasks of Parent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Child' }));
    expect(props.onOpen).toHaveBeenLastCalledWith('child');
    fireEvent.click(screen.getByRole('button', { name: 'Complete Child' }));
    expect(props.onPatch).toHaveBeenLastCalledWith(child, { status: 'done' });
  });
  it('keeps filtered descendants visible as independent roots when no matching ancestor is present', () => {
    render(<PlannerHierarchyList {...props} tasks={[leaf]} />);
    expect(screen.getByRole('button', { name: 'Leaf' })).toBeInTheDocument();
    expect(screen.getByLabelText('Total task time')).toHaveTextContent(
      'Estimated 0:15 · Actual 0:30 · 1 tasks',
    );
    expect(screen.queryByRole('button', { name: 'Parent' })).not.toBeInTheDocument();
  });
  it('counts each sectionâ€™s accessible subtree once and the full result once across overlapping groups', () => {
    render(
      <PlannerHierarchyList
        {...props}
        tasks={[parent, { ...child, status: 'done' }]}
        groupBy="status"
      />,
    );
    expect(
      within(screen.getByRole('region', { name: 'To do' })).getByLabelText('Time totals for To do'),
    ).toHaveTextContent('Actual 2:15');
    expect(
      within(screen.getByRole('region', { name: 'Done' })).getByLabelText('Time totals for Done'),
    ).toHaveTextContent('Actual 1:15');
    expect(screen.getByLabelText('Total task time')).toHaveTextContent('Actual 2:15');
  });
  it('drops stale source records absent from the authorized graph and applies revised time', () => {
    const { rerender } = render(<PlannerHierarchyList {...props} />);
    const revised = nodes
      .filter((n) => n.id !== 'leaf')
      .map((n) => (n.id === 'child' ? { ...n, actualMinutes: 20 } : n));
    rerender(<PlannerHierarchyList {...props} nodes={revised} />);
    expect(
      screen.getByRole('button', { name: 'Actual time for Parent: 1:20' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand subtasks of Parent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Child' }));
    expect(
      screen.queryByRole('button', { name: 'Expand subtasks of Child' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leaf' })).not.toBeInTheDocument();
  });
});
