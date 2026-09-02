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
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrategyEditorVNext } from './StrategyEditorVNext.js';
import type { StrategyDetail, StrategyNode } from '../../../pages/strategy/types.js';

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
    useStrategy: () => ({ data: detail, isLoading: false, isError: false, dataUpdatedAt: NOW.getTime() }),
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
    useAssistant: () => ({ mutate: vi.fn(), isPending: false }),
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
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
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
