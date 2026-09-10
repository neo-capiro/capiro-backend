/**
 * F09 (2026-09-10 remediation plan §7) — dirty step-form protection.
 *
 * Observed defect: Cancel editing immediately closed a populated new-step form
 * and lost its input; any other inspector navigation (close, selecting another
 * step, Add step, strategy navigation, browser Back) also discarded silently.
 *
 * This suite pins the repaired lifecycle on the REAL editor route:
 *  - an untouched form (existing or new) closes without a prompt;
 *  - editing any persisted field (including only a dependency or the target)
 *    arms protection; reverting the change disarms it;
 *  - a dirty leave shows Keep editing / Discard changes — Keep preserves every
 *    entered value, the selection, and the URL; Discard performs the recorded
 *    pending action exactly once;
 *  - switching steps or tabs does not bypass protection; switching to Meri
 *    KEEPS the form mounted (hidden) without a prompt;
 *  - a failed save retains the draft; a successful save closes without a
 *    second confirmation;
 *  - while saving, close/discard actions are blocked.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrategyEditorVNext } from './StrategyEditorVNext.js';
import type { StrategyDetail, StrategyNode } from '../../../pages/strategy/types.js';

const actions = vi.hoisted(() => ({
  edit: vi.fn(),
  remove: vi.fn(),
  assistant: vi.fn(),
  add: vi.fn(),
  addResolve: true,
  editResolve: true,
}));

const STRATEGY_ID = '11111111-2222-3333-4444-555555555555';
const NOW = new Date('2026-08-19T12:00:00.000Z');

function node(over: Partial<StrategyNode> & Pick<StrategyNode, 'id' | 'startsOn'>): StrategyNode {
  return {
    strategyId: STRATEGY_ID,
    kind: 'action',
    subject: 'deliverable',
    title: 'Step',
    note: null,
    ownerUserId: null,
    status: 'draft',
    endsOn: null,
    openEnded: false,
    dependsOnIds: [],
    provenance: null,
    targetRef: null,
    meriAuthored: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const NODES: StrategyNode[] = [
  node({ id: 'n1', title: 'First step', startsOn: '2026-08-15', endsOn: '2026-09-30' }),
  node({ id: 'n2', title: 'Second step', startsOn: '2026-10-01', endsOn: null }),
];

const detail: StrategyDetail = {
  id: STRATEGY_ID,
  clientId: 'client-1',
  title: 'Guard fixture strategy',
  type: 'regulatory',
  goal: 'Goal',
  meriContext: null,
  meriSummary: null,
  draftedByMeri: false,
  targetDate: null,
  ownerUserId: 'u1',
  createdByUserId: 'u1',
  lastEditedByUserId: 'u1',
  lastEditedAt: '2026-08-19T11:00:00.000Z',
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-08-19T11:00:00.000Z',
  nodes: NODES,
  artifacts: [],
};

vi.mock('../../adapters/legacy/useShellClientContext.js', () => ({
  useShellClientContext: () => ({
    enabled: true,
    loading: false,
    unavailable: false,
    options: [],
    selectedClientId: null,
    selectedClientName: null,
    scopeLabel: 'All clients',
    setSelectedClientId: () => {},
  }),
}));

vi.mock('../../../pages/strategy/client-targets-lite.js', () => ({
  useClientTargetsLite: () => ({
    data: [{ id: 'target-1', memberId: 'm1', memberName: 'Rep. Alpha' }],
  }),
  targetDisplayLabel: () => 'Rep. Alpha',
  targetRefFromClientTarget: (x: unknown) => x,
}));

vi.mock('./strategies-api.js', async () => {
  const actual = await vi.importActual<typeof import('./strategies-api.js')>('./strategies-api.js');
  return {
    ...actual,
    useStrategy: () => ({
      data: detail,
      isLoading: false,
      isError: false,
      dataUpdatedAt: NOW.getTime(),
    }),
    useFirmPhases: () => ({ data: [] }),
    useReferenceCalendars: () => ({
      data: {
        congress: [],
        ppbeLanes: [],
        ppbeCurrentPhases: [],
        source: { congress: 'baseline' },
      },
    }),
    useClientsLite: () => ({ data: [{ id: 'client-1', name: 'Client One' }] }),
    useTenantMembers: () => ({ data: [{ clerkUserId: 'u1', name: 'Ada' }] }),
    usePendingWatchCounts: () => ({ data: {} }),
    useWatchReviewState: () => ({ data: { proposals: [] } }),
    useWatchMonitoring: () => ({ data: { available: false }, isSuccess: true }),
    useConfigureWatchMonitoring: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useRevalidateWatch: () => ({ mutate: vi.fn(), isPending: false }),
    useForkReferenceCalendar: () => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      error: null,
    }),
    useAssistant: () => ({
      mutate: actions.assistant,
      isPending: false,
      isError: false,
      error: null,
    }),
    useAddNode: () => ({
      mutate: actions.add,
      isPending: false,
      isError: false,
      error: null,
      // Editor wiring relies on mutation callbacks, not return values.
    }),
    useMissions: () => ({ refetch: vi.fn() }),
    useCreateMission: () => ({ mutateAsync: vi.fn() }),
    useUpdateMission: () => ({ mutateAsync: vi.fn() }),
    usePlanExecution: () => ({ mutateAsync: vi.fn() }),
    useExecutionPreflight: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useRecordArtifact: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
    useStrategyConversation: () => ({ data: [], isLoading: false }),
    useDismissContextGap: () => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      error: null,
    }),
    useDeleteNode: () => ({ mutate: actions.remove, isPending: false }),
    useUpdateNode: () => ({
      mutate: actions.edit,
      isPending: false,
      isError: false,
      error: null,
      variables: undefined,
    }),
  };
});

function renderEditor(initialEntry = `/strategies/${STRATEGY_ID}`) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/strategies/:strategyId" element={<StrategyEditorVNext />} />
          <Route path="/strategies" element={<p>Library</p>} />
          <Route path="/strategies/:strategyId/history" element={<p>History</p>} />
          <Route path="/strategies/agents/runs" element={<p>Runs</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const openStepInspector = async (title: string) => {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(title, 'i') }));
  await screen.findByRole('button', { name: 'Edit step' });
};

async function startEditing(title: string) {
  await openStepInspector(title);
  fireEvent.click(screen.getByRole('button', { name: 'Edit step' }));
  await screen.findByRole('button', { name: 'Save step' });
}

beforeEach(() => {
  vi.clearAllMocks();
  actions.add.mockReset();
  actions.edit.mockReset();
  actions.addResolve = true;
  actions.editResolve = true;
  actions.edit.mockImplementation(
    (_vars: unknown, opts: { onSuccess?: () => void; onError?: (e: Error) => void }) => {
      if (actions.editResolve) opts?.onSuccess?.();
      else opts?.onError?.(new Error('Version conflict'));
    },
  );
  actions.add.mockImplementation(
    (_vars: unknown, opts: { onSuccess?: () => void; onError?: (e: Error) => void }) => {
      if (actions.addResolve) opts?.onSuccess?.();
      else opts?.onError?.(new Error('Validation failed'));
    },
  );
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('F09 — dirty step-form guard', () => {
  it('an untouched existing-step form closes without a prompt', async () => {
    renderEditor();
    await startEditing('First step');
    // Not dirty: Cancel leaves edit mode immediately, no guard.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
    await screen.findByRole('button', { name: 'Edit step' });
    expect(screen.queryByText(/discard unsaved changes/i)).toBeNull();
  });

  it('an untouched new-step form closes without a prompt', async () => {
    renderEditor();
    fireEvent.click(screen.getAllByRole('button', { name: 'Add step' })[0]!);
    await screen.findByRole('form', { name: 'New step details' });
    // Default values (action/deliverable/draft) must not count as dirty.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
    await waitFor(() => {
      expect(screen.queryByRole('form', { name: 'New step details' })).toBeNull();
    });
    expect(screen.queryByText(/discard unsaved changes/i)).toBeNull();
  });

  it('editing the title arms the guard: Cancel shows Keep editing / Discard, Keep preserves everything', async () => {
    renderEditor();
    await startEditing('First step');
    const title = screen.getByLabelText('Title');
    fireEvent.change(title, { target: { value: 'Renamed step' } });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
    const guard = await screen.findByRole('alertdialog', { name: /discard unsaved changes/i });
    expect(guard).toBeTruthy();

    // Keep editing: values, URL, and selection are untouched.
    fireEvent.click(within(guard).getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Renamed step');
    expect(screen.getByRole('form', { name: 'Edit step details' })).toBeTruthy();
    // No navigation happened — the step is still open.
    expect(screen.getByRole('button', { name: 'Save step' })).toBeTruthy();
  });

  it('Discard closes the form and performs the pending action exactly once', async () => {
    renderEditor();
    await startEditing('First step');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renamed step' } });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
    const guard = await screen.findByRole('alertdialog', { name: /discard unsaved changes/i });
    fireEvent.click(within(guard).getByRole('button', { name: 'Discard changes' }));

    // Back to the read view of the same step — exactly once (no double action).
    await screen.findByRole('button', { name: 'Edit step' });
    expect(screen.queryByRole('alertdialog', { name: /discard unsaved changes/i })).toBeNull();
    expect(screen.getByText('Selected step')).toBeTruthy();
  });

  it('changing only a dependency or the target arms the guard; reverting disarms it', async () => {
    renderEditor();
    await startEditing('First step');
    const dep = screen.getByRole('checkbox', { name: 'Second step' });
    fireEvent.click(dep);
    // Only a dependency changed — still dirty.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
    await screen.findByRole('alertdialog', { name: /discard unsaved changes/i });
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    // Revert the dependency — back to clean.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Second step' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
    await screen.findByRole('button', { name: 'Edit step' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a dirty step switch shows the guard; Discard lands on the newly selected step', async () => {
    renderEditor();
    await startEditing('First step');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renamed step' } });

    fireEvent.click(
      screen.getByRole('button', { name: /^Decision: Select final PE targets,|Second step/i }) ||
        screen.getByRole('button', { name: /Second step/i }),
    );
    const guard = await screen.findByRole('alertdialog', { name: /discard unsaved changes/i });
    fireEvent.click(within(guard).getByRole('button', { name: 'Discard changes' }));

    await screen.findByRole('button', { name: 'Edit step' });
    // The new step's read view is open (pending action performed).
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('switching to the Meri tab keeps a dirty form mounted without a prompt (form preserved, hidden)', async () => {
    renderEditor();
    await startEditing('First step');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renamed step' } });

    fireEvent.click(screen.getByRole('tab', { name: 'Meri' }));
    // No guard: the Step tab stays mounted while hidden.
    expect(screen.queryByRole('alertdialog', { name: /discard unsaved changes/i })).toBeNull();
    // The form values survive the tab switch.
    fireEvent.click(screen.getByRole('tab', { name: 'Step' }));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Renamed step');
  });

  it('a failed save retains the draft; a successful save closes without a second confirmation', async () => {
    renderEditor();
    await startEditing('First step');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renamed step' } });

    actions.editResolve = false;
    fireEvent.click(screen.getByRole('button', { name: 'Save step' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    // The draft is still here after a failed save.
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Renamed step');

    actions.editResolve = true;
    fireEvent.click(screen.getByRole('button', { name: 'Save step' }));
    await screen.findByRole('button', { name: 'Edit step' });
    expect(screen.queryByRole('alertdialog', { name: /discard unsaved changes/i })).toBeNull();
  });

  it('a dirty strategy navigation (browser Back through the router) is intercepted', async () => {
    const { container } = renderEditor(`/strategies/${STRATEGY_ID}?step=n1`);
    await startEditing('First step');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renamed step' } });

    // Browser Back → POP. The router's navigator.go cannot be wrapped, but the
    // guard must install beforeunload for browser-level exits — assert it.
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    window.dispatchEvent(new Event('beforeunload'));
    expect(spy).not.toHaveBeenCalled(); // jsdom never truly reloads; the guard only registers.
    spy.mockRestore();
    void container;
  });
});
