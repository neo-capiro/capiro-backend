// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANNER_DEFAULT_TASK, type PlannerTask } from '@capiro/strategy-verifier';
import { PlannerSubtaskList } from './planner-subtask-list.js';
const base: PlannerTask = {
  ...PLANNER_DEFAULT_TASK,
  id: 'one',
  name: 'First',
  ownerId: 'me',
  access: 'editor',
  version: 3,
  archived: false,
  completedAt: null,
  createdAt: '2026-10-08T12:00:00Z',
  updatedAt: '2026-10-08T12:00:00Z',
  actualMinutes: 0,
  assigneeId: 'me',
  dueOn: '2026-10-09',
};
const tasks = [
  base,
  {
    ...base,
    id: 'two',
    name: 'Second',
    status: 'done' as const,
    assigneeId: 'other',
    dueOn: '2026-10-10',
  },
  { ...base, id: 'three', name: 'Undated', assigneeId: null, dueOn: null },
];
const props = {
  tasks,
  people: [
    { id: 'me', name: 'Me' },
    { id: 'other', name: 'Other' },
  ],
  loading: false,
  failed: false,
  disabled: false,
  onOpen: vi.fn(),
  onPatch: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('Task detail subtask controls', () => {
  it('combines hide-completed, assignee and inclusive dates, then restores the complete list', () => {
    render(<PlannerSubtaskList {...props} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide completed subtasks' }));
    expect(screen.queryByRole('button', { name: 'Second' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Subtask assignee'), { target: { value: 'me' } });
    fireEvent.input(screen.getByLabelText('Subtasks due from'), {
      target: { value: '2026-10-09' },
    });
    fireEvent.input(screen.getByLabelText('Subtasks due through'), {
      target: { value: '2026-10-09' },
    });
    expect(screen.getByText('1 of 3 subtasks')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'First' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset subtask controls' }));
    expect(screen.getByText('3 of 3 subtasks')).toBeTruthy();
    expect(props.onPatch).not.toHaveBeenCalled();
  });
  it('sorts due dates with undated tasks last and discloses an invalid range', () => {
    render(<PlannerSubtaskList {...props} tasks={[tasks[2]!, tasks[1]!, tasks[0]!]} />);
    fireEvent.change(screen.getByLabelText('Sort subtasks'), { target: { value: 'due' } });
    const rows = within(screen.getByRole('region', { name: 'Subtask list' }))
      .getAllByRole('button')
      .filter((b) => ['First', 'Second', 'Undated'].includes(b.textContent!));
    expect(rows.map((b) => b.textContent)).toEqual(['First', 'Second', 'Undated']);
    fireEvent.input(screen.getByLabelText('Subtasks due from'), {
      target: { value: '2026-10-11' },
    });
    fireEvent.input(screen.getByLabelText('Subtasks due through'), {
      target: { value: '2026-10-09' },
    });
    expect(screen.getByRole('alert').textContent).toContain('on or before');
    expect(screen.queryByRole('button', { name: 'First' })).toBeNull();
  });
  it('does not publish partially loaded or failed subtasks and keeps navigation separate from completion', () => {
    const { rerender } = render(<PlannerSubtaskList {...props} loading />);
    expect(screen.getByRole('status').textContent).toContain('Loading all');
    expect(screen.queryByRole('button', { name: 'First' })).toBeNull();
    rerender(<PlannerSubtaskList {...props} failed />);
    expect(screen.queryByRole('button', { name: 'First' })).toBeNull();
    rerender(<PlannerSubtaskList {...props} tasks={[{ ...base, access: 'viewer' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'First' }));
    expect(props.onOpen).toHaveBeenCalledWith('one');
    expect(screen.getByRole('button', { name: 'Complete First' })).toBeDisabled();
    expect(props.onPatch).not.toHaveBeenCalled();
  });
});
