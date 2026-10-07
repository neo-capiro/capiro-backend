import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import {
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_TASK,
  PLANNER_DEFAULT_TIME_OPTIONS,
  plannerTimeDateBounds,
  plannerTimeToday,
  plannerWeekDate,
  type PlannerBootstrap,
  type PlannerTimeEntry,
  type PlannerTimesheet,
} from '@capiro/strategy-verifier';
import { PlannerTimeForm } from './planner-time-form.js';
import { PlannerTimesheets, plannerTimeCsv, plannerLoadTimeExport } from './planner-timesheets.js';
const mocks = vi.hoisted(() => ({
  query: {} as any,
  config: {} as any,
  review: {} as any,
  preferences: { data: { version: 1, autoAddDueTasks: false } },
  save: vi.fn(),
  revise: vi.fn(),
  get: vi.fn(),
  scope: 'org_qa',
}));
vi.mock('./planner-api.js', () => ({
  usePlannerTimesheet: () => mocks.query,
  usePlannerTimeSettings: () => mocks.config,
  usePlannerTimeReview: () => mocks.review,
  usePlannerTimeReviewPages: () => ({
    ...mocks.review,
    data: {
      pages: [
        {
          revision: 'review',
          items: mocks.review.data ?? [],
          people: bootstrap.people,
          matched: mocks.review.data?.length ?? 0,
          totalMinutes: 0,
          billableMinutes: 0,
        },
      ],
    },
  }),
  usePlannerTimePreferences: () => mocks.preferences,
  usePlannerTimesheetHistory: () => ({ data: mocks.query.data }),
  usePlannerKey: () => ['planner', mocks.scope, 'owner', null],
  usePlannerTasks: () => ({ data: { pages: [{ items: [] }] } }),
  usePlannerTask: () => ({}),
  usePlannerMutations: () => ({
    timesheet: { mutateAsync: mocks.save, isPending: false },
    timeSettings: { mutateAsync: mocks.save, isPending: false },
    reviseEvent: { mutateAsync: mocks.revise, isPending: false },
    timePreferences: { mutateAsync: mocks.save, isPending: false },
  }),
  plannerError: String,
}));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: mocks.get }) }));
const bootstrap: PlannerBootstrap = {
  me: { id: 'owner', name: 'Owner' },
  people: [
    { id: 'owner', name: 'Owner' },
    { id: 'reviewer', name: 'Reviewer' },
  ],
  projects: [
    {
      ...PLANNER_DEFAULT_PROJECT,
      id: 'project-one',
      name: 'Launch',
      ownerId: 'owner',
      version: 1,
      archived: false,
      access: 'admin',
      createdAt: '2026-10-07T12:00:00Z',
      updatedAt: '2026-10-07T12:00:00Z',
    },
  ],
};
const entry = (id = 'entry-one'): PlannerTimeEntry => ({
  id,
  taskId: null,
  projectId: 'project-one',
  actorId: 'owner',
  kind: 'time',
  text: 'Planning',
  minutes: 60,
  version: 0,
  createdAt: '2026-10-07T12:00:00Z',
  time: {
    workedOn: '2026-10-05',
    billable: true,
    timeZone: 'America/New_York',
    projectId: 'project-one',
    category: 'Planning',
  },
  taskName: null,
  projectName: 'Launch',
  canEdit: true,
});
const sheet = (): PlannerTimesheet => ({
  id: 'sheet-one',
  userId: 'owner',
  weekOn: '2026-10-05',
  throughOn: '2026-10-11',
  reviewerId: 'reviewer',
  status: 'draft',
  version: 7,
  revision: 'a'.repeat(64),
  notes: '',
  correctedAfterApproval: false,
  totalMinutes: 60,
  billableMinutes: 60,
  days: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-10-${String(5 + i).padStart(2, '0')}`,
    totalMinutes: i === 0 ? 60 : 0,
    billableMinutes: i === 0 ? 60 : 0,
  })),
  matched: 1,
  unavailableEntries: false,
  items: [entry()],
  nextCursor: null,
  actions: ['submit'],
  history: [],
});
const view = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);
beforeEach(() => {
  mocks.save.mockReset().mockResolvedValue({});
  mocks.revise.mockReset().mockResolvedValue({});
  mocks.get.mockReset();
  mocks.scope = 'org_qa';
  mocks.query = { data: { pages: [sheet()] }, isPending: false, isError: false };
  mocks.config = { data: { canManage: false, version: 1, reviewers: { owner: 'reviewer' } } };
  mocks.review = { data: [], isPending: false, isError: false };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe('Planner dated time controls and weekly review', () => {
  it('captures settings versions, preserves multiline category input and sends the edited options', async () => {
    mocks.config = {
      data: {
        canManage: true,
        version: 4,
        reviewers: { owner: 'reviewer' },
        options: structuredClone(PLANNER_DEFAULT_TIME_OPTIONS),
      },
    };
    const node = () => (
      <PlannerTimesheets bootstrap={bootstrap} week="2026-10-05" userId={null} onSelect={vi.fn()} />
    );
    const rendered = view(node());
    fireEvent.click(screen.getByRole('button', { name: 'Time settings' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'New entries are billable by default' }));
    fireEvent.change(screen.getByLabelText('Configured time categories'), {
      target: { value: 'Research\n' },
    });
    expect(screen.getByLabelText('Configured time categories')).toHaveValue('Research\n');
    fireEvent.change(screen.getByLabelText('Configured time categories'), {
      target: { value: ' Research\nDelivery\n' },
    });
    fireEvent.change(screen.getByLabelText('Submission workflow'), { target: { value: 'simple' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send a weekly submission reminder' }));
    fireEvent.change(screen.getByLabelText('Submission reminder day'), { target: { value: '1' } });
    fireEvent.input(screen.getByLabelText('Submission reminder time'), {
      target: { value: '09:00' },
    });
    fireEvent.change(screen.getByLabelText('Submission reminder week'), {
      target: { value: 'previous' },
    });
    mocks.config = {
      data: {
        ...mocks.config.data,
        version: 9,
        options: { ...PLANNER_DEFAULT_TIME_OPTIONS, categories: ['Other edit'] },
      },
    };
    rendered.rerender(<MemoryRouter>{node()}</MemoryRouter>);
    expect(screen.getByLabelText('Configured time categories')).toHaveValue(
      ' Research\nDelivery\n',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save time settings' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        version: 4,
        reviewers: { owner: 'reviewer' },
        options: {
          ...PLANNER_DEFAULT_TIME_OPTIONS,
          billableDefault: true,
          approvalProcess: 'simple',
          categories: ['Research', 'Delivery'],
          submissionReminder: { weekday: 1, time: '09:00', week: 'previous' },
        },
      }),
    );
  });
  it('uses configured billable defaults and organization dates with native date limits', () => {
    const options = {
      ...PLANNER_DEFAULT_TIME_OPTIONS,
      billableDefault: true,
      categories: ['Delivery'],
      timeZone: 'Pacific/Kiritimati',
      pastLockWeeks: 0,
      futureWeeks: 0,
    };
    view(
      <PlannerTimeForm
        projects={bootstrap.projects}
        projectId="project-one"
        options={options}
        onSave={vi.fn()}
      />,
    );
    const bounds = plannerTimeDateBounds(options);
    expect(screen.getByLabelText('Work date')).toHaveValue(plannerTimeToday(options.timeZone));
    expect(screen.getByLabelText('Work date')).toHaveAttribute('min', bounds.minOn!);
    expect(screen.getByLabelText('Work date')).toHaveAttribute('max', bounds.maxOn!);
    expect(screen.getByRole('checkbox', { name: 'Billable time' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Time category' })).toBeInTheDocument();
    fireEvent.input(screen.getByLabelText('Work date'), {
      target: { value: plannerWeekDate(bounds.maxOn!, 1) },
    });
    expect(screen.getByRole('button', { name: 'Log time' })).toBeDisabled();
  });
  it('preserves historical retired labels and lets old billable entries become non-billable', () => {
    const options = {
      ...PLANNER_DEFAULT_TIME_OPTIONS,
      billableEnabled: false,
      categories: ['Delivery'],
    };
    view(
      <PlannerTimeForm
        projects={bootstrap.projects}
        initial={entry()}
        options={options}
        onSave={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('option', { name: 'Planning (no longer configured)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Time category' })).toHaveValue('Planning');
    const billable = screen.getByRole('checkbox', { name: 'Billable time' });
    expect(billable).toBeChecked();
    expect(billable).toBeEnabled();
    fireEvent.click(billable);
    expect(billable).not.toBeChecked();
    expect(billable).toBeDisabled();
  });
  it('shows policy notices and simple submission without a missing-reviewer prompt', () => {
    mocks.query.data.pages = [
      {
        ...sheet(),
        reviewerId: null,
        approvalProcess: 'simple',
        canLogTime: false,
        timeNotice: 'Time tracking is disabled.',
      },
    ];
    view(
      <PlannerTimesheets
        bootstrap={bootstrap}
        week="2026-10-05"
        userId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Add time' })).toBeDisabled();
    expect(screen.getByText('Time tracking is disabled.')).toBeInTheDocument();
    expect(screen.getByText(/Submission without approval/)).toBeInTheDocument();
    expect(screen.queryByText(/Ask an organization admin/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit timesheet' })).toBeEnabled();
  });
  it('saves native calendar input, billable attribution, category and description', async () => {
    const save = vi.fn().mockResolvedValue({});
    view(<PlannerTimeForm projects={bootstrap.projects} projectId="project-one" onSave={save} />);
    fireEvent.input(screen.getByLabelText('Work date'), { target: { value: '2026-10-10' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Billable time' }));
    fireEvent.change(screen.getByLabelText('Log minutes'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Time category'), { target: { value: 'Research' } });
    fireEvent.change(screen.getByLabelText('Time note'), { target: { value: 'Policy research' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log time' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        minutes: 90,
        text: 'Policy research',
        time: expect.objectContaining({
          workedOn: '2026-10-10',
          billable: true,
          projectId: 'project-one',
          category: 'Research',
        }),
      }),
    );
  });
  it('preserves readable historical attribution after a task leaves its original project', async () => {
    const save = vi.fn().mockResolvedValue({});
    view(
      <PlannerTimeForm
        projects={[
          ...bootstrap.projects,
          { ...bootstrap.projects[0]!, id: 'unrelated', name: 'Other project' },
        ]}
        task={{
          ...PLANNER_DEFAULT_TASK,
          id: 'task-one',
          ownerId: 'owner',
          version: 2,
          archived: false,
          completedAt: null,
          createdAt: '',
          updatedAt: '',
          access: 'admin',
          actualMinutes: 60,
        }}
        initial={{ ...entry(), taskId: 'task-one' }}
        onSave={save}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Project for time' })).toHaveValue('project-one');
    expect(screen.getByRole('option', { name: 'Launch' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Other project' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Edit logged minutes'), { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save time entry' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          minutes: 75,
          time: expect.objectContaining({ projectId: 'project-one' }),
        }),
      ),
    );
  });
  it('keeps entered time visible after a locked-week rejection', async () => {
    view(
      <PlannerTimeForm
        projects={bootstrap.projects}
        projectId="project-one"
        onSave={vi.fn().mockRejectedValue(Error('Recall this timesheet'))}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Log time' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Recall this timesheet');
    expect(screen.getByLabelText('Log minutes')).toHaveValue(30);
  });
  it('keeps the opening version and revision while a status review is in progress', async () => {
    const node = () => (
      <PlannerTimesheets bootstrap={bootstrap} week="2026-10-05" userId={null} onSelect={vi.fn()} />
    );
    const rendered = view(node());
    fireEvent.click(screen.getByRole('button', { name: 'Submit timesheet' }));
    mocks.query = {
      data: { pages: [{ ...sheet(), version: 9, revision: 'b'.repeat(64) }] },
      isError: false,
    };
    rendered.rerender(<MemoryRouter>{node()}</MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Review notes'), {
      target: { value: 'Ready for review' },
    });
    fireEvent.click(
      screen
        .getByRole('dialog', { name: 'Submit timesheet' })
        .querySelector('button.planner-primary')!,
    );
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        week: '2026-10-05',
        userId: 'owner',
        version: 7,
        revision: 'a'.repeat(64),
        action: 'submit',
        notes: 'Ready for review',
      }),
    );
  });
  it('hides retained cached work after an access failure', () => {
    mocks.query = { data: { pages: [sheet()] }, isError: true, error: Error('Access changed') };
    view(
      <PlannerTimesheets
        bootstrap={bootstrap}
        week="2026-10-05"
        userId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Access changed');
    expect(screen.queryByText('Planning')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit timesheet' })).not.toBeInTheDocument();
  });
  it('opens the selected submitter from the time review list', () => {
    const select = vi.fn();
    mocks.review = {
      data: [{ ...sheet(), userId: 'reviewer', reviewerId: 'owner' }],
      isPending: false,
    };
    view(
      <PlannerTimesheets bootstrap={bootstrap} week="2026-10-05" userId={null} onSelect={select} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Time review' }));
    fireEvent.click(screen.getByRole('button', { name: 'View timesheet' }));
    expect(select).toHaveBeenCalledWith('2026-10-05', 'reviewer');
  });
  it('cancels export when the signed-in scope changes and does not create a file', async () => {
    let resolve!: (value: unknown) => void;
    mocks.get.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const create = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const node = () => (
      <PlannerTimesheets bootstrap={bootstrap} week="2026-10-05" userId={null} onSelect={vi.fn()} />
    );
    const rendered = view(node());
    fireEvent.click(screen.getByRole('button', { name: 'Export time entries' }));
    expect(mocks.get.mock.calls[0]![1].signal.aborted).toBe(false);
    mocks.scope = 'org_other';
    rendered.rerender(<MemoryRouter>{node()}</MemoryRouter>);
    expect(mocks.get.mock.calls[0]![1].signal.aborted).toBe(true);
    resolve({ data: sheet() });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export time entries' })).toBeEnabled(),
    );
    expect(create).not.toHaveBeenCalled();
  });
});
describe('complete authorized time export', () => {
  it('loads all 101 entries using one revision and escapes formula-like content', async () => {
    const first = {
      ...sheet(),
      matched: 101,
      items: Array.from({ length: 100 }, (_, i) => entry('entry-' + i)),
      nextCursor: 'entry-99',
    };
    const load = vi.fn().mockResolvedValue({
      ...sheet(),
      matched: 101,
      items: [{ ...entry('entry-100'), text: '=SUM(A1:A9)' }],
      nextCursor: null,
    });
    const rows = await plannerLoadTimeExport(first, load);
    expect(rows).toHaveLength(101);
    expect(load).toHaveBeenCalledWith('entry-99', first.revision);
    const csv = plannerTimeCsv(rows, bootstrap.people);
    expect(csv.split('\r\n')).toHaveLength(102);
    expect(csv).toContain("'=SUM(A1:A9)");
    expect(csv).toContain('"2026-10-05","Owner","Launch","","60","Yes"');
  });
  it('rejects a later access failure, changed revision and incomplete file', async () => {
    const first = { ...sheet(), matched: 2, nextCursor: 'entry-one' };
    await expect(
      plannerLoadTimeExport(first, vi.fn().mockRejectedValue(Error('Access changed'))),
    ).rejects.toThrow('Access changed');
    await expect(
      plannerLoadTimeExport(
        first,
        vi.fn().mockResolvedValue({ ...sheet(), revision: 'b'.repeat(64) }),
      ),
    ).rejects.toThrow('Time changed');
    await expect(plannerLoadTimeExport({ ...first, nextCursor: null }, vi.fn())).rejects.toThrow(
      'incomplete',
    );
  });
});
