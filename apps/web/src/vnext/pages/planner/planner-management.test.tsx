import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlannerBootstrap, PlannerResource } from '@capiro/strategy-verifier';
import { PlannerManagement } from './planner-management.js';

const mocks = vi.hoisted(() => ({ resources: [] as PlannerResource[], share: vi.fn() }));
vi.mock('./planner-api.js', () => ({
  usePlannerResources: () => ({ data: mocks.resources, isPending: false, error: null }),
  usePlannerMutations: () => ({
    resource: { isPending: false, error: null },
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
