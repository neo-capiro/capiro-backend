/**
 * Step inspector — cross-step state isolation (2026-08-30).
 *
 * Flagged during PR #1367 review as a suspected cross-step state-bleed bug,
 * confirmed here: `<StepInspector>` was rendered without a `key` in
 * StrategyEditorVNext, so clicking a different step card re-rendered the
 * SAME component instance with a new `step` prop instead of remounting it.
 * Local state that isn't itself keyed to the step — the "Ask Meri" composer
 * draft, the "Record evidence artifact" form — survived the switch and
 * leaked into the next step's inspector view. Fixed by keying
 * `<StepInspector key={openStepId}>` on the selected step id.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrategyEditorVNext } from './StrategyEditorVNext.js';
import type { StrategyDetail, StrategyNode } from '../../../pages/strategy/types.js';

const actions = vi.hoisted(() => ({
  assistant: vi.fn(), add: vi.fn(), missions: vi.fn(), create: vi.fn(), update: vi.fn(), plan: vi.fn(),
  assistantError: false, addError: false, empty: false, dueToday: false,
}));

const STRATEGY_ID = '11111111-2222-3333-4444-555555555555';

/** Fixed "now" so the axis and the fixtures agree — mirrors the timeline suite. */
const NOW = new Date('2026-08-19T12:00:00.000Z');

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
  node({ id: 'n1', title: 'Identify target program elements', startsOn: '2026-08-15', endsOn: '2026-09-30' }),
  node({ id: 'n2', kind: 'decision', title: 'Select final PE targets', startsOn: '2026-10-01', endsOn: null }),
];

const detail: StrategyDetail = {
  id: STRATEGY_ID,
  clientId: 'client-1',
  title: 'Secure a $10M plus-up',
  type: 'regulatory',
  goal: 'Secure a $10M plus-up',
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

vi.mock('./strategies-api.js', async () => {
  const actual = await vi.importActual<typeof import('./strategies-api.js')>('./strategies-api.js');
  return {
    ...actual,
    useStrategy: () => ({ data: actions.empty ? { ...detail, nodes: [] } : actions.dueToday ? { ...detail, nodes: [node({ id: 'today', title: 'Accepted work due today', startsOn: '2026-08-19', status: 'active', ownerUserId: 'u1' })] } : detail, isLoading: false, isError: false, dataUpdatedAt: NOW.getTime() }),
    useFirmPhases: () => ({ data: [] }),
    useReferenceCalendars: () => ({
      data: { congress: [], ppbeLanes: [], ppbeCurrentPhases: [], source: { congress: 'baseline' } },
    }),
    useClientsLite: () => ({ data: [{ id: 'client-1', name: 'RTX Corporation' }] }),
    useTenantMembers: () => ({ data: [] }),
    usePendingWatchCounts: () => ({ data: {} }),
    useWatchReviewState: () => ({ data: { proposals: [] } }),
    useRevalidateWatch: () => ({ mutate: vi.fn(), isPending: false }),
    useForkReferenceCalendar: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
    // Only StepInspector needs these — never resolving a real request here,
    // just enough shape for the inspector (and its "Ask Meri" composer and
    // evidence-artifact form) to render.
    useAssistant: () => ({ mutate: actions.assistant, isPending: false, isError: actions.assistantError, error: new Error('Service unavailable') }),
    useAddNode: () => ({ mutate: actions.add, isPending: false, isError: actions.addError, error: new Error('Validation failed') }),
    useMissions: () => ({ refetch: actions.missions }),
    useCreateMission: () => ({ mutateAsync: actions.create }),
    useUpdateMission: () => ({ mutateAsync: actions.update }),
    usePlanExecution: () => ({ mutateAsync: actions.plan }),
    useRecordArtifact: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
    useStrategyConversation: () => ({ data: [], isLoading: false }),
    useDismissContextGap: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
    useUpdateNode: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null, variables: undefined }),
  };
});

function renderEditor() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/strategies/${STRATEGY_ID}`]}>
        <Routes>
          <Route path="/strategies/:strategyId" element={<StrategyEditorVNext />} />
          <Route path="/strategies/agents/runs" element={<p>Execution review</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  actions.assistantError = false;
  actions.addError = false;
  actions.empty = false;
  actions.dueToday = false;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

describe('Step inspector — cross-step state isolation', () => {
  it('does not carry an unsent Ask Meri draft from one step into the next', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Identify target program elements/ }));

    const composer = screen.getByLabelText('Ask Meri') as HTMLInputElement;
    fireEvent.change(composer, { target: { value: 'Draft meant for step n1' } });
    expect(composer.value).toBe('Draft meant for step n1');

    fireEvent.click(screen.getByRole('button', { name: /Select final PE targets/ }));

    const composerAfterSwitch = screen.getByLabelText('Ask Meri') as HTMLInputElement;
    expect(composerAfterSwitch.value).toBe('');
  });

  it('does not carry a half-filled evidence-artifact form from one step into the next', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Identify target program elements/ }));

    const refInput = screen.getByPlaceholderText('Artifact reference id') as HTMLInputElement;
    fireEvent.change(refInput, { target: { value: 'outreach-123' } });
    expect(refInput.value).toBe('outreach-123');

    fireEvent.click(screen.getByRole('button', { name: /Select final PE targets/ }));

    const refInputAfterSwitch = screen.getByPlaceholderText('Artifact reference id') as HTMLInputElement;
    expect(refInputAfterSwitch.value).toBe('');
  });
});



afterEach(() => vi.useRealTimers());

describe('Strategy editor action persistence', () => {
  it('submits Add step through the existing node API when the visible button is clicked', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    const inspector = screen.getByRole('complementary', { name: 'Step inspector' });
    fireEvent.change(within(inspector).getByLabelText('Title'), { target: { value: 'Review budget request' } });
    fireEvent.change(within(inspector).getByLabelText('Start date'), { target: { value: '2026-09-06' } });
    fireEvent.click(within(inspector).getByRole('button', { name: 'Add step' }));
    expect(actions.add).toHaveBeenCalledWith(
      { kind: 'action', subject: 'deliverable', title: 'Review budget request', startsOn: '2026-09-06' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('shows an Add step failure and preserves the entered fields', () => {
    actions.addError = true;
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Retry this title' } });
    expect(screen.getByRole('alert')).toHaveTextContent('The step could not be added');
    expect(screen.getByLabelText('Title')).toHaveValue('Retry this title');
  });

  it('opens strategy-level Meri on an empty plan', () => {
    actions.empty = true;
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Ask Meri' }));
    expect(screen.getByRole('tab', { name: 'Meri' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(screen.getByLabelText('Ask Meri'), { target: { value: 'Draft an initial timeline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(actions.assistant).toHaveBeenCalledWith(expect.objectContaining({ scope: 'strategy', instruction: 'Draft an initial timeline' }), expect.any(Object));
  });

  it('header Ask Meri switches an already open step to Meri, including after a tab switch', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Identify target program elements/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask Meri' }));
    expect(screen.getByRole('tab', { name: 'Meri' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Step' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask Meri' }));
    expect(screen.getByRole('tab', { name: 'Meri' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps a failed Meri draft and suppresses duplicate Enter submissions', () => {
    actions.assistantError = true;
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Ask Meri' }));
    const composer = screen.getByLabelText('Ask Meri');
    fireEvent.change(composer, { target: { value: 'Keep my question' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(actions.assistant).toHaveBeenCalledTimes(1);
    expect(composer).toHaveValue('Keep my question');
    expect(screen.getByRole('alert')).toHaveTextContent('Meri could not respond');
  });

  it('plans the selected node before navigating to execution review, without executing it', async () => {
    actions.missions.mockResolvedValue({ data: [{ id: 'mission-1', strategyId: STRATEGY_ID, name: 'Execute this strategy', state: 'active' }], isError: false });
    actions.plan.mockResolvedValue({ id: 'run-1', state: 'waiting_for_input' });
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Identify target program elements/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Stage outreach' }));
    await waitFor(() => expect(actions.plan).toHaveBeenCalledWith({ missionId: 'mission-1', strategyId: STRATEGY_ID, nodeId: 'n1', kind: 'outreach' }));
    expect(actions.create).not.toHaveBeenCalled();
    expect(await screen.findByText('Execution review')).toBeInTheDocument();
  });

  it('does not create a duplicate execution mission when the mission lookup fails', async () => {
    actions.missions.mockResolvedValue({ data: undefined, isError: true, error: new Error('Mission lookup failed') });
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Identify target program elements/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare in Workspace' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Mission lookup failed'));
    expect(actions.create).not.toHaveBeenCalled();
    expect(actions.plan).not.toHaveBeenCalled();
  });
});


describe('Inspector tab draft preservation', () => {
  it('retains an unsaved new step while consulting Meri', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Unfinished step' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Meri' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Step' }));
    expect(screen.getByLabelText('Title')).toHaveValue('Unfinished step');
  });
});


it('shows accepted work due today in Next 30 days', () => {
  actions.dueToday = true;
  renderEditor();
  const upcoming = screen.getByText('Next 30 days').closest('section')!;
  expect(within(upcoming).getByText('Accepted work due today')).toBeInTheDocument();
  expect(within(upcoming).getByRole('button', { name: 'Open step' })).toBeInTheDocument();
});
