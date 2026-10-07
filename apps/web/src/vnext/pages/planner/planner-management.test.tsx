import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlannerBootstrap, PlannerResource } from '@capiro/strategy-verifier';
import { PlannerManagement } from './planner-management.js';

const mocks = vi.hoisted(() => ({
  resources: [] as PlannerResource[],
  share: vi.fn(),
  save: vi.fn(),
}));
vi.mock('./planner-api.js', () => ({
  usePlannerResources: () => ({ data: mocks.resources, isPending: false, error: null }),
  usePlannerMutations: () => ({
    resource: { isPending: false, error: null, mutate: mocks.save, reset: vi.fn() },
    instantiate: { error: null },
    shareForm: { isPending: false, error: null, mutateAsync: mocks.share },
  }),
  usePlannerEvents: vi.fn(),
  plannerError: String,
}));
const form: PlannerResource = {
  id: 'form-one',
  kind: 'form',
  projectId: 'project-one',
  ownerId: 'owner',
  name: 'Intake',
  data: { enabled: true, audience: 'public' },
  version: 1,
  archived: false,
  access: 'admin',
  publicShared: true,
};
const bootstrap: PlannerBootstrap = {
  me: { id: 'owner', name: 'Owner' },
  people: [],
  projects: [],
};
const view = () => (
  <PlannerManagement
    kind="form"
    bootstrap={bootstrap}
    tasks={[]}
    onProject={() => {}}
    onTask={() => {}}
  />
);
beforeEach(() => {
  mocks.resources = [structuredClone(form)];
  mocks.share.mockReset().mockResolvedValue({ token: 'synthetic-capability' });
  mocks.save.mockReset();
});
describe('Planner goal browsing and duplication', () => {
  const goal: PlannerResource = {
    ...form,
    id: 'goal-one',
    kind: 'goal',
    projectId: null,
    name: 'Launch outcome',
    data: {
      description: '',
      privacy: 'team',
      members: [{ userId: 'member', role: 'viewer' }],
      ownerId: 'owner',
      projectIds: [],
      subgoalIds: ['archived-child'],
      taskIds: [],
      status: 'on_track',
      progress: 'subgoal_percentage',
      current: 0,
      target: 100,
      unit: '%',
      weightMode: 'custom',
      weights: [{ sourceId: 'archived-child', weight: 100 }],
      goalType: 'company',
      timePeriod: 'Q4 2026',
    },
    goalProgress: { value: 62.5, percentage: 62.5, sources: [] },
  };
  const goalsView = (selectedGoalId: string | null, onGoal: (id: string | null) => void) => (
    <PlannerManagement
      kind="goal"
      bootstrap={bootstrap}
      tasks={[]}
      onProject={() => {}}
      onTask={() => {}}
      selectedGoalId={selectedGoalId}
      onGoal={onGoal}
    />
  );
  it('opens the selected goal through its navigation callback and reports inaccessible deep links', async () => {
    mocks.resources = [goal];
    const open = vi.fn();
    const view = render(goalsView(null, open));
    expect(screen.getByText('63%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View goal' }));
    expect(open).toHaveBeenCalledWith(goal.id);
    view.rerender(goalsView(goal.id, open));
    expect(await screen.findByRole('dialog', { name: 'Goal details' })).toBeInTheDocument();
    view.rerender(goalsView('unavailable', open));
    expect(screen.getByRole('alert')).toHaveTextContent('This goal is unavailable');
  });
  it('filters goals by type and time period and distinguishes filtered emptiness', () => {
    mocks.resources = [goal];
    render(goalsView(null, () => {}));
    fireEvent.change(screen.getByLabelText('Filter goal type'), { target: { value: 'team' } });
    expect(screen.getByText('No goals match these filters')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filter goal type'), { target: { value: 'company' } });
    fireEvent.change(screen.getByLabelText('Filter goal time period'), {
      target: { value: 'Q4 2026' },
    });
    expect(screen.getByRole('heading', { name: 'Launch outcome' })).toBeInTheDocument();
  });
  it('preserves authorized task connections when task-name pages have not loaded', () => {
    mocks.resources = [
      {
        ...goal,
        data: {
          ...goal.data,
          progress: 'task_list_completion',
          subgoalIds: [],
          taskIds: ['not-yet-loaded'],
          weights: [{ sourceId: 'not-yet-loaded', weight: 100 }],
        },
      },
    ];
    render(goalsView(null, () => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate goal' }));
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskIds: ['not-yet-loaded'],
          weights: [{ sourceId: 'not-yet-loaded', weight: 100 }],
        }),
      }),
    );
  });
  it('duplicates privately, excludes archived contributors and removes invalid empty custom weights', () => {
    mocks.resources = [
      goal,
      {
        ...goal,
        id: 'archived-child',
        name: 'Archived child',
        archived: true,
        data: { ...goal.data, subgoalIds: [], weightMode: 'equal', weights: [] },
      },
    ];
    render(goalsView(null, () => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate goal' }));
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'goal',
        name: 'Launch outcome copy',
        data: expect.objectContaining({
          privacy: 'private',
          members: [],
          ownerId: 'owner',
          subgoalIds: [],
          weightMode: 'equal',
          weights: [],
        }),
      }),
    );
    expect(goal.data.privacy).toBe('team');
  });
});
afterEach(cleanup);

describe('Planner public-link panel lifecycle', () => {
  it.each([
    [
      'organization-only',
      { data: { enabled: true, audience: 'organization' }, publicShared: false },
    ],
    ['closed', { data: { enabled: false, audience: 'public' } }],
    ['revoked', { publicShared: false }],
    ['archived', { archived: true }],
    ['lost editing access', { access: 'viewer' }],
    ['no longer accessible', null],
  ] as const)('removes a displayed capability after the form becomes %s', async (_label, patch) => {
    const rendered = render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Create new public link' }));
    await screen.findByLabelText('Public form link');
    expect(screen.getByLabelText('Public form link')).toHaveValue(
      `${window.location.origin}/planner/forms/synthetic-capability`,
    );
    mocks.resources = patch ? [{ ...form, ...patch }] : [];
    rendered.rerender(view());
    await waitFor(() =>
      expect(screen.queryByLabelText('Public form link')).not.toBeInTheDocument(),
    );
    // Reopening access must not resurrect a capability whose panel was cleared.
    mocks.resources = [form];
    rendered.rerender(view());
    expect(screen.queryByLabelText('Public form link')).not.toBeInTheDocument();
  });
  it('retains a current public link through unrelated form changes', async () => {
    const rendered = render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Create new public link' }));
    await screen.findByLabelText('Public form link');
    mocks.resources = [{ ...form, name: 'Renamed intake', version: 2 }];
    rendered.rerender(view());
    expect(screen.getByLabelText('Public form link')).toBeInTheDocument();
  });
});
