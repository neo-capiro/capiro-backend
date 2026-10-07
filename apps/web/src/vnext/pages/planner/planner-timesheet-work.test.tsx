import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_TASK,
  PLANNER_DEFAULT_TIME_OPTIONS,
  type PlannerBootstrap,
  type PlannerTimesheet,
  type PlannerTimesheetWorkRow,
} from '@capiro/strategy-verifier';
import { PlannerTimesheetWork } from './planner-timesheet-work.js';
const mocks = vi.hoisted(() => ({
  query: {} as any,
  prefs: {} as any,
  savePrefs: vi.fn(),
  saveWork: vi.fn(),
  event: vi.fn(),
  task: {} as any,
}));
vi.mock('./planner-api.js', () => ({
  usePlannerTimesheetWork: () => mocks.query,
  usePlannerTimePreferences: () => mocks.prefs,
  usePlannerTasks: () => ({ data: { pages: [{ items: [mocks.task] }] }, isError: false }),
  usePlannerTask: () => ({ data: mocks.task, isError: false }),
  usePlannerMutations: () => ({
    timePreferences: { mutateAsync: mocks.savePrefs, isPending: false },
    timesheetWork: { mutateAsync: mocks.saveWork, isPending: false },
    event: { mutateAsync: mocks.event, isPending: false },
  }),
  plannerError: String,
}));
const bootstrap = {
  me: { id: 'owner', name: 'Owner' },
  people: [],
  projects: [
    {
      ...PLANNER_DEFAULT_PROJECT,
      id: 'project',
      name: 'Launch',
      ownerId: 'owner',
      version: 1,
      archived: false,
      access: 'admin',
      createdAt: '',
      updatedAt: '',
    },
  ],
} as PlannerBootstrap;
const row = (): PlannerTimesheetWorkRow => ({
  key: 'task:project',
  taskId: 'task',
  projectId: 'project',
  taskName: 'Assigned work',
  projectName: 'Launch',
  origin: 'automatic',
  totalMinutes: 0,
  billableMinutes: 0,
  days: [{ date: '2026-10-05', totalMinutes: 0, billableMinutes: 0 }],
  canLogTime: true,
  canRemove: true,
});
const sheet = (): PlannerTimesheet => ({
  id: 'sheet',
  userId: 'owner',
  weekOn: '2026-10-05',
  throughOn: '2026-10-11',
  reviewerId: null,
  status: 'draft',
  version: 3,
  revision: 'a'.repeat(64),
  notes: '',
  correctedAfterApproval: false,
  totalMinutes: 0,
  billableMinutes: 0,
  days: row().days,
  matched: 0,
  unavailableEntries: false,
  items: [],
  nextCursor: null,
  actions: [],
  history: [],
  canLogTime: true,
  workRows: [row()],
  matchedWork: 1,
  nextWorkCursor: null,
});
const node = (value = sheet()) => (
  <MemoryRouter>
    <PlannerTimesheetWork
      bootstrap={bootstrap}
      sheet={value}
      options={PLANNER_DEFAULT_TIME_OPTIONS}
    />
  </MemoryRouter>
);
beforeEach(() => {
  mocks.savePrefs.mockReset().mockResolvedValue({});
  mocks.saveWork.mockReset().mockResolvedValue({});
  mocks.event.mockReset().mockResolvedValue({});
  mocks.task = {
    ...PLANNER_DEFAULT_TASK,
    id: 'task',
    name: 'Assigned work',
    memberships: [{ projectId: 'project', sectionId: null, position: 0 }],
  };
  mocks.prefs = { data: { version: 2, autoAddDueTasks: false }, isError: false };
  mocks.query = { data: { pages: [sheet()] }, isError: false };
});
afterEach(cleanup);
describe('Weekly timesheet work and personal prepopulation', () => {
  it('saves the opening personal preference version during a refetch', async () => {
    const rendered = render(node());
    fireEvent.click(screen.getByRole('button', { name: 'My timesheet settings' }));
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Auto-add tasks assigned to me that are due each week',
      }),
    );
    mocks.prefs = { data: { version: 8, autoAddDueTasks: false }, isError: false };
    rendered.rerender(node());
    expect(screen.getByRole('checkbox')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save my timesheet settings' }));
    await waitFor(() =>
      expect(mocks.savePrefs).toHaveBeenCalledWith({ version: 2, autoAddDueTasks: true }),
    );
  });
  it('adds selected work with the captured sheet version and revision without logging time', async () => {
    const rendered = render(node());
    fireEvent.click(screen.getByRole('button', { name: 'Add work to timesheet' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Work for timesheet' }), {
      target: { value: 'task' },
    });
    const changed = { ...sheet(), version: 9, revision: 'b'.repeat(64) };
    mocks.query.data.pages = [changed];
    rendered.rerender(node(changed));
    fireEvent.click(screen.getByRole('button', { name: 'Add zero-hour work row' }));
    await waitFor(() =>
      expect(mocks.saveWork).toHaveBeenCalledWith({
        week: '2026-10-05',
        userId: 'owner',
        version: 3,
        revision: 'a'.repeat(64),
        action: 'add',
        work: { taskId: 'task', projectId: 'project' },
      }),
    );
    expect(mocks.event).not.toHaveBeenCalled();
  });
  it('opens a selected calendar cell and logs through the authorized submitter and source', async () => {
    render(node());
    fireEvent.click(
      screen.getByRole('button', { name: 'Log time for Assigned work on 2026-10-05' }),
    );
    expect(screen.getByLabelText('Work date')).toHaveValue('2026-10-05');
    fireEvent.change(screen.getByLabelText('Log minutes'), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText('Time note'), { target: { value: 'Weekly work' } });
    fireEvent.click(screen.getByRole('button', { name: /^Log time$/ }));
    await waitFor(() =>
      expect(mocks.event).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task',
          loggerId: 'owner',
          kind: 'time',
          minutes: 45,
          text: 'Weekly work',
          time: expect.objectContaining({
            workedOn: '2026-10-05',
            projectId: 'project',
            billable: false,
          }),
        }),
      ),
    );
  });
  it('hides cached work after access/paging failure and disables edits to that snapshot', () => {
    const rendered = render(node());
    expect(screen.getByRole('link', { name: 'Assigned work' })).toBeInTheDocument();
    mocks.query = { ...mocks.query, isError: true, error: Error('Access changed') };
    rendered.rerender(node());
    expect(screen.queryByRole('link', { name: 'Assigned work' })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Access changed');
    expect(screen.getByRole('button', { name: 'Add work to timesheet' })).toBeDisabled();
  });
  it('requires removing logged entries before the work row and removes zero rows with the current revision', async () => {
    mocks.query.data.pages[0].workRows = [{ ...row(), totalMinutes: 30, canRemove: false }];
    const rendered = render(node());
    expect(screen.getByRole('button', { name: 'Remove work row' })).toBeDisabled();
    mocks.query.data.pages[0].workRows = [row()];
    rendered.rerender(node());
    fireEvent.click(screen.getByRole('button', { name: 'Remove work row' }));
    await waitFor(() =>
      expect(mocks.saveWork).toHaveBeenCalledWith({
        week: '2026-10-05',
        userId: 'owner',
        version: 3,
        revision: 'a'.repeat(64),
        action: 'remove',
        work: { taskId: 'task', projectId: 'project' },
      }),
    );
  });
});
