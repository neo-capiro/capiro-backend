// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_CAPACITY_PLAN,
  type PlannerBootstrap,
  type PlannerCapacityAllocation,
} from '@capiro/strategy-verifier';
import { PlannerCapacity, plannerCapacityCsv } from './planner-capacity.js';
import { PlannerCapacityEditor } from './planner-capacity-editor.js';
const state = vi.hoisted(() => ({
  catalog: {} as any,
  plan: {} as any,
  save: vi.fn(),
  record: vi.fn(),
  weekly: vi.fn(),
}));
vi.mock('./planner-capacity-api.js', () => ({
  usePlannerCapacityCatalog: () => state.catalog,
  usePlannerCapacityPlan: () => state.plan,
  usePlannerCapacityMutations: () => ({
    record: { mutateAsync: state.record },
    allocations: { mutateAsync: state.save },
    weeklyCapacities: { mutateAsync: state.weekly },
  }),
  plannerLoadCapacity: vi.fn(),
}));
vi.mock('./planner-api.js', () => ({
  usePlannerKey: () => ['planner', 'org-a', 'owner'],
  usePlannerResources: () => ({ data: [] }),
  plannerError: (e: Error) => e.message,
}));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({}) }));
const p = {
  ...PLANNER_DEFAULT_PROJECT,
  id: '20000000-0000-4000-8000-000000000001',
  name: 'Launch',
  ownerId: 'owner',
  version: 1,
  access: 'admin' as const,
  archived: false,
  createdAt: '',
  updatedAt: '',
};
const bootstrap: PlannerBootstrap = {
  me: { id: 'owner', name: 'Owner' },
  people: [
    { id: 'owner', name: 'Owner' },
    { id: 'person', name: 'Jamie' },
  ],
  projects: [p],
};
const cp = {
  id: '80000000-0000-4000-8000-000000000001',
  name: 'Staffing',
  ownerId: 'owner',
  version: 3,
  access: 'admin',
  archived: false,
  data: { ...PLANNER_DEFAULT_CAPACITY_PLAN, projectIds: [p.id] },
};
const a: PlannerCapacityAllocation = {
  id: '80000000-0000-4000-8000-000000000004',
  name: 'Allocation',
  ownerId: 'owner',
  version: 4,
  access: 'admin',
  archived: false,
  projectId: p.id,
  projectName: p.name,
  personName: 'Owner',
  weeklyMinutes: 2400,
  teamId: null,
  jobTitle: '',
  data: {
    userId: 'owner',
    placeholderId: null,
    startOn: '2026-10-05',
    endOn: '2026-10-09',
    effort: { unit: 'percent', value: 50 },
  },
};
beforeEach(() => {
  state.catalog = { data: { plans: [cp], teams: [], placeholders: [] } };
  state.plan = {
    data: { plan: cp, allocations: [a], projectIds: [p.id], personIds: ['owner'], matched: 1 },
  };
  state.save.mockReset().mockResolvedValue({});
  state.record.mockReset().mockResolvedValue({ id: cp.id });
  state.weekly.mockReset().mockResolvedValue({ ok: true });
});
afterEach(cleanup);
describe('Capacity planning workflows', () => {
  it('opens individual limits from a row with no allocations and uses server grants and revision', async () => {
    state.plan.data = {
      ...state.plan.data,
      allocations: [],
      weeklyCapacities: [{ id: 'owner', weeklyMinutes: 1800, canEdit: true }],
      revision: 'opening',
    };
    render(<PlannerCapacity bootstrap={bootstrap} selectedId={cp.id} onSelect={vi.fn()} />);
    expect(screen.getByText('30 h / week')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Owner' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Adjust weekly capacity' }));
    fireEvent.input(screen.getByLabelText('Owner weekly hours'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save weekly capacity' }));
    await waitFor(() =>
      expect(state.weekly).toHaveBeenCalledWith({
        planId: cp.id,
        revision: 'opening',
        changes: [{ id: 'owner', weeklyMinutes: 0 }],
      }),
    );
  });
  it('shows portfolio rows from authorized live membership and deduplicates people across projects', () => {
    const second = {
      ...a,
      id: 'second',
      projectId: 'other',
      projectName: 'Other',
      data: { ...a.data, effort: { unit: 'hours' as const, value: 10 } },
    };
    state.plan.data = {
      ...state.plan.data,
      allocations: [a, second],
      portfolios: [{ id: 'portfolio', name: 'Team portfolio', projectIds: [p.id, 'other'] }],
    };
    render(<PlannerCapacity bootstrap={bootstrap} selectedId={cp.id} onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Capacity window start'), {
      target: { value: '2026-10-05' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }));
    expect(screen.getByLabelText('Team portfolio 2026-10-05 portfolio effort')).toHaveTextContent(
      '30 h',
    );
    fireEvent.change(screen.getByLabelText('Capacity display'), { target: { value: 'percent' } });
    expect(screen.getByLabelText('Team portfolio 2026-10-05 portfolio effort')).toHaveTextContent(
      '75%',
    );
    fireEvent.change(screen.getByLabelText('Capacity display'), { target: { value: 'count' } });
    expect(screen.getByLabelText('Team portfolio 2026-10-05 portfolio effort')).toHaveTextContent(
      '1',
    );
    fireEvent.change(screen.getByLabelText('Capacity display'), {
      target: { value: 'personMonths' },
    });
    expect(screen.getByLabelText('Team portfolio 2026-10-05 portfolio effort')).toHaveTextContent(
      '0.17 pm',
    );
    fireEvent.change(screen.getByLabelText('Filter capacity project'), { target: { value: p.id } });
    fireEvent.change(screen.getByLabelText('Capacity display'), { target: { value: 'hours' } });
    expect(screen.getByLabelText('Team portfolio 2026-10-05 portfolio effort')).toHaveTextContent(
      '20 h',
    );
  });
  it('switches People/Projects, zooms and filters without counting one allocation per timeline cell', () => {
    render(<PlannerCapacity bootstrap={bootstrap} selectedId={cp.id} onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Capacity window start'), {
      target: { value: '2026-10-05' },
    });
    expect(screen.getByLabelText('Owner 2026-10-05 planned effort')).toHaveTextContent('20 h');
    expect(screen.getByRole('heading', { name: 'Allocations · 1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }));
    expect(screen.getByRole('tab', { name: 'Projects' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(screen.getByLabelText('Capacity zoom'), { target: { value: 'day' } });
    fireEvent.change(screen.getByLabelText('Capacity display'), { target: { value: 'count' } });
    fireEvent.change(screen.getByLabelText('Search staffing'), { target: { value: 'absent' } });
    expect(screen.getByText('No allocations match this view.')).toBeInTheDocument();
  });
  it('sends source versions on bulk transfer and movement and keeps errors visible', async () => {
    render(<PlannerCapacity bootstrap={bootstrap} selectedId={cp.id} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Select allocation/ }));
    fireEvent.change(screen.getByLabelText('Transfer selected allocations to'), {
      target: { value: 'person' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer selected' }));
    await waitFor(() =>
      expect(state.save).toHaveBeenCalledWith({
        planId: cp.id,
        planVersion: 3,
        changes: [{ id: a.id, version: 4, data: { userId: 'person', placeholderId: null } }],
      }),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /Select allocation/ }));
    state.save.mockRejectedValueOnce(new Error('Source access changed'));
    fireEvent.click(screen.getByRole('button', { name: 'Move selected' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Source access changed');
  });
  it('uses new ids for duplication and expected versions for recoverable archive', async () => {
    render(<PlannerCapacity bootstrap={bootstrap} selectedId={cp.id} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Select allocation/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate selected' }));
    await waitFor(() => expect(state.save).toHaveBeenCalled());
    const c = state.save.mock.calls[0]![0].changes[0];
    expect(c.duplicateId).not.toBe(a.id);
    expect(c).toMatchObject({ id: a.id, version: 4, shiftDays: 7 });
  });
  it('keeps project viewers read-only even when they administer the plan', () => {
    state.plan.data.allocations = [{ ...a, access: 'viewer' }];
    render(<PlannerCapacity bootstrap={bootstrap} selectedId={cp.id} onSelect={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: /Select allocation/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Edit allocation' })).not.toBeInTheDocument();
  });
  it('preserves the calendar, layout and filters while switching archived allocations', () => {
    render(<PlannerCapacity bootstrap={bootstrap} selectedId={cp.id} onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Capacity window start'), {
      target: { value: '2026-12-21' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }));
    fireEvent.change(screen.getByLabelText('Capacity zoom'), { target: { value: 'month' } });
    fireEvent.change(screen.getByLabelText('Capacity display'), { target: { value: 'percent' } });
    fireEvent.change(screen.getByLabelText('Group capacity'), { target: { value: 'health' } });
    fireEvent.change(screen.getByLabelText('Search staffing'), { target: { value: 'Owner' } });
    fireEvent.change(screen.getByLabelText('Filter capacity person'), {
      target: { value: 'owner' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Archived allocations & staffing' }));
    expect(screen.getByLabelText('Capacity window start')).toHaveValue('2026-12-21');
    expect(screen.getByRole('tab', { name: 'Projects' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Capacity zoom')).toHaveValue('month');
    expect(screen.getByLabelText('Capacity display')).toHaveValue('percent');
    expect(screen.getByLabelText('Group capacity')).toHaveValue('health');
    expect(screen.getByLabelText('Search staffing')).toHaveValue('Owner');
    expect(screen.getByLabelText('Filter capacity person')).toHaveValue('owner');
  });
  it('archives selected allocations with Delete inside the timeline and ignores typing in the date control', async () => {
    render(<PlannerCapacity bootstrap={bootstrap} selectedId={cp.id} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Select allocation/ }));
    fireEvent.keyDown(screen.getByLabelText('Capacity window start'), { key: 'Delete' });
    expect(state.save).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('region', { name: 'Staffing timeline' }), { key: 'Delete' });
    await waitFor(() =>
      expect(state.save).toHaveBeenCalledWith({
        planId: cp.id,
        planVersion: 3,
        changes: [{ id: a.id, version: 4, archived: true }],
      }),
    );
  });
  it('starts an allocation from the selected timeline window and row', async () => {
    render(<PlannerCapacity bootstrap={bootstrap} selectedId={cp.id} onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Capacity window start'), {
      target: { value: '2026-10-05' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Allocate Owner from 2026-10-05 to 2026-10-11' }),
    );
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-10-05');
    expect(screen.getByLabelText('End date')).toHaveValue('2026-10-11');
    fireEvent.click(screen.getByRole('button', { name: 'Save allocation' }));
    await waitFor(() => expect(state.save).toHaveBeenCalled());
    expect(state.save.mock.calls[0]![0].changes[0]).toMatchObject({
      projectId: p.id,
      data: { userId: 'owner', placeholderId: null, startOn: '2026-10-05', endOn: '2026-10-11' },
    });
  });
  it('hides cached staffing and its export control after a failed grant recheck', () => {
    state.plan.isError = true;
    state.plan.error = new Error('Access revoked');
    render(<PlannerCapacity bootstrap={bootstrap} selectedId={cp.id} onSelect={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Access revoked');
    expect(screen.queryByRole('button', { name: 'Export allocations' })).not.toBeInTheDocument();
  });
  it('submits calendar dates and total-hour units and removes job titles of deselected team members', async () => {
    const save = vi.fn().mockResolvedValue({});
    render(
      <PlannerCapacityEditor
        editor={{ kind: 'allocation', row: a }}
        catalog={state.catalog.data}
        bootstrap={bootstrap}
        plan={cp as any}
        portfolios={[]}
        onSave={save}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Effort unit'), { target: { value: 'hours' } });
    fireEvent.change(screen.getByLabelText('Effort'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-10-12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save allocation' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0]).toMatchObject({
      id: a.id,
      version: 4,
      projectId: p.id,
      data: { endOn: '2026-10-12', effort: { unit: 'hours', value: 12.5 } },
    });
    expect(save.mock.calls[0]![0]).not.toHaveProperty('name');
    cleanup();
    save.mockClear();
    render(
      <PlannerCapacityEditor
        editor={{
          kind: 'teams',
          row: {
            id: cp.id,
            name: 'Team',
            ownerId: 'owner',
            version: 2,
            access: 'admin',
            archived: false,
            data: {
              privacy: 'private',
              members: [],
              peopleIds: ['person'],
              jobTitles: { person: 'Designer' },
            },
          },
        }}
        catalog={state.catalog.data}
        bootstrap={bootstrap}
        portfolios={[]}
        onSave={save}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(
      within(screen.getByRole('group', { name: 'People' })).getByRole('checkbox', {
        name: 'Jamie',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save team' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0].data.jobTitles).toEqual({});
  });
  it('exports one row per allocation and neutralizes spreadsheet formulas', () => {
    const csv = plannerCapacityCsv([{ ...a, projectName: '=DANGEROUS()' }], bootstrap.people);
    expect(csv.split('\r\n')).toHaveLength(2);
    expect(csv).toContain("'=DANGEROUS()");
    expect(csv).toContain('"percent","50","20","40"');
  });
  it('opens the exact project from a row menu without changing allocations', async () => {
    const open = vi.fn();
    render(
      <PlannerCapacity
        bootstrap={bootstrap}
        selectedId={cp.id}
        onSelect={vi.fn()}
        onProject={open}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Launch' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'View project details' }));
    expect(open).toHaveBeenCalledWith(p.id);
    expect(state.save).not.toHaveBeenCalled();
  });
  it('selects every matching row allocation for an explicit versioned transfer without writing on selection', async () => {
    const second = { ...a, id: '80000000-0000-4000-8000-000000000005', version: 7 };
    state.plan.data.allocations = [a, second];
    render(<PlannerCapacity bootstrap={bootstrap} selectedId={cp.id} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Owner' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Transfer allocations' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Transfer selected' })).toBeDisabled();
    expect(state.save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Transfer selected allocations to'), {
      target: { value: 'person' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer selected' }));
    await waitFor(() =>
      expect(state.save).toHaveBeenCalledWith({
        planId: cp.id,
        planVersion: 3,
        changes: [
          { id: a.id, version: 4, data: { userId: 'person', placeholderId: null } },
          { id: second.id, version: 7, data: { userId: 'person', placeholderId: null } },
        ],
      }),
    );
  });
  it('keeps restricted project editors read-only and excludes their projects from allocation choices', () => {
    state.plan.data.allocations = [{ ...a, access: 'viewer' }];
    const restricted = {
      ...bootstrap,
      projects: [{ ...p, access: 'editor' as const, allocationEditors: 'admins' as const }],
    };
    render(<PlannerCapacity bootstrap={restricted} selectedId={cp.id} onSelect={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Capacity window start'), {
      target: { value: '2026-10-05' },
    });
    expect(screen.queryByRole('button', { name: 'Allocate work' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Allocate Owner/ })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Select allocation/ })).toBeDisabled();
    cleanup();
    const editable = {
      ...p,
      id: '20000000-0000-4000-8000-000000000002',
      name: 'Editable',
      access: 'editor' as const,
    };
    render(
      <PlannerCapacityEditor
        editor={{ kind: 'allocation' }}
        catalog={state.catalog.data}
        bootstrap={{ ...restricted, projects: [...restricted.projects, editable] }}
        portfolios={[]}
        plan={cp as any}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const choices = within(screen.getByLabelText('Project'));
    expect(choices.queryByRole('option', { name: 'Launch' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Project')).toHaveValue(editable.id);
  });
  it('refuses to silently truncate a row transfer beyond the atomic batch limit', async () => {
    state.plan.data.allocations = Array.from({ length: 101 }, (_, i) => ({
      ...a,
      id: `allocation-${i}`,
    }));
    render(<PlannerCapacity bootstrap={bootstrap} selectedId={cp.id} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Owner' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Transfer allocations' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('more than 100 allocations');
    expect(screen.queryByText('100 selected')).not.toBeInTheDocument();
    expect(state.save).not.toHaveBeenCalled();
  });
  it('seeds a placeholder row allocation without assigning a user at the same time', async () => {
    const placeholderId = '80000000-0000-4000-8000-000000000099';
    state.catalog.data.placeholders = [
      {
        id: placeholderId,
        name: 'Open designer',
        archived: false,
        access: 'admin',
        data: { teamId: cp.id, jobTitle: 'Designer', weeklyMinutes: 1800 },
      },
    ];
    state.plan.data.personIds = [placeholderId];
    render(<PlannerCapacity bootstrap={bootstrap} selectedId={cp.id} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Open designer' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add allocation' }));
    expect(screen.getByLabelText('Person or placeholder')).toHaveValue(placeholderId);
    fireEvent.click(screen.getByRole('button', { name: 'Save allocation' }));
    await waitFor(() => expect(state.save).toHaveBeenCalled());
    expect(state.save.mock.calls[0]![0].changes[0].data).toMatchObject({
      userId: null,
      placeholderId,
    });
  });
});
