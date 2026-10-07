// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANNER_DEFAULT_TASK, type PlannerTask } from '@capiro/strategy-verifier';
import {
  PlannerBoard,
  PlannerCalendar,
  PlannerList,
  PlannerTimeline,
  plannerDate,
  shiftPlannerDate,
  TaskCheck,
} from './planner-views.js';
const task: PlannerTask = {
  ...PLANNER_DEFAULT_TASK,
  id: 'task-1',
  name: 'Verify dates',
  ownerId: 'owner',
  assigneeId: 'owner',
  access: 'editor',
  version: 1,
  archived: false,
  completedAt: null,
  createdAt: '2026-10-06T12:00:00Z',
  updatedAt: '2026-10-06T12:00:00Z',
  actualMinutes: 0,
  dueOn: '2026-10-16',
};
afterEach(cleanup);
describe('Planner task views', () => {
  it('moves timeline dates with the keyboard and resizes the due date independently', () => {
    const scheduled = { ...task, startOn: '2026-10-14' };
    const onPatch = vi.fn();
    render(
      <PlannerTimeline
        tasks={[scheduled]}
        people={[]}
        onOpen={vi.fn()}
        onPatch={onPatch}
        disabled={false}
        gantt
      />,
    );
    const bar = screen
      .getAllByRole('button', { name: 'Verify dates' })
      .find((el) => el.classList.contains('planner-timeline-bar'))!;
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(onPatch).toHaveBeenLastCalledWith(scheduled, {
      startOn: '2026-10-15',
      dueOn: '2026-10-17',
    });
    fireEvent.keyDown(bar, { key: 'ArrowLeft', shiftKey: true });
    expect(onPatch).toHaveBeenLastCalledWith(scheduled, {
      startOn: '2026-10-14',
      dueOn: '2026-10-15',
    });
    expect(shiftPlannerDate('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('draws a Gantt connection for a visible predecessor and bounds tick rendering', () => {
    render(
      <PlannerTimeline
        tasks={[
          task,
          {
            ...task,
            id: 'task-2',
            name: 'Dependent',
            dueOn: '2040-10-16',
            dependencies: [task.id],
          },
        ]}
        people={[]}
        onOpen={vi.fn()}
        onPatch={vi.fn()}
        disabled={false}
        gantt
      />,
    );
    expect(
      screen.getByLabelText('Task dependency connections').querySelectorAll('path').length,
    ).toBeGreaterThan(1);
    expect(
      document.querySelectorAll('.planner-timeline-head > div > span').length,
    ).toBeLessThanOrEqual(120);
  });
  it('renders calendar dates at local noon without interpreting midnight UTC', () =>
    expect(plannerDate('2026-10-16')).toMatch(/16/));
  it('opens the exact task and toggles completion independently', () => {
    const onOpen = vi.fn();
    const onPatch = vi.fn();
    render(
      <PlannerList
        tasks={[task]}
        people={[{ id: 'owner', name: 'Owner' }]}
        onOpen={onOpen}
        onPatch={onPatch}
        disabled={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Verify dates' }));
    expect(onOpen).toHaveBeenCalledWith('task-1');
    fireEvent.click(screen.getByRole('button', { name: 'Complete Verify dates' }));
    expect(onPatch).toHaveBeenCalledWith(task, { status: 'done' });
  });
  it('disables completion and dragging for a viewer', () => {
    const readonly = { ...task, access: 'viewer' as const };
    render(
      <PlannerBoard
        tasks={[readonly]}
        people={[]}
        onOpen={vi.fn()}
        onPatch={vi.fn()}
        disabled={false}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Complete Verify dates' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole('article').draggable).toBe(false);
  });
  it('reopens a completed task', () => {
    const onPatch = vi.fn();
    render(<TaskCheck task={{ ...task, status: 'done' }} onPatch={onPatch} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reopen Verify dates' }));
    expect(onPatch.mock.calls[0]![1]).toEqual({ status: 'todo' });
  });
  it('discloses undated tasks rather than dropping them silently from calendar', () => {
    render(
      <PlannerCalendar
        tasks={[{ ...task, dueOn: null }]}
        people={[]}
        onOpen={vi.fn()}
        onPatch={vi.fn()}
        disabled={false}
      />,
    );
    expect(screen.getByText(/1 tasks have no due date/)).toBeTruthy();
  });
});
