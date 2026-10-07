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
}));
vi.mock('./planner-capacity-api.js', () => ({
  usePlannerCapacityCatalog: () => state.catalog,
  usePlannerCapacityPlan: () => state.plan,
  usePlannerCapacityMutations: () => ({
    record: { mutateAsync: state.record },
    allocations: { mutateAsync: state.save },
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
});
afterEach(cleanup);
describe('Capacity planning workflows', () => {
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
});
