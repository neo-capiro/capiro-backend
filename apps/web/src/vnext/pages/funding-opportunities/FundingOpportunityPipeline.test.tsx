import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FundingOpportunityPipeline } from './FundingOpportunityPipeline.js';
import { deadlineForCard, listBasis } from './funding-opportunities-v2-pursuit.js';
import { createReferencePursuitFixtureApi } from '../../testing/visual/funding-opportunities-v2-pursuit-fixtures.js';
import type { PipelineBoardView, PipelineCardView } from './funding-opportunities-domain.js';

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: getMock, post: postMock }) }));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => ({ ready: true, enabled: true }),
}));
vi.mock('./funding-opportunities-v2-icons.js', () => ({
  FundingOpportunityV2Icon: () => <span aria-hidden="true" />,
}));

const card = (overrides: Partial<PipelineCardView> = {}): PipelineCardView => ({
  rowId: 'row-1',
  source: 'sam_gov',
  sourceRecordId: 'notice-1',
  title: 'Vehicle sustainment notice',
  stage: 'reviewing',
  stageBasis: 'recorded',
  stageExplanation: 'Moved here by a person.',
  version: 3,
  allowedTransitions: ['qualified', 'passed'],
  responseDeadline: '2026-10-01',
  owner: null,
  nextAction: null,
  nextActionDueAt: null,
  ...overrides,
});

const board = (cards: PipelineCardView[] = [card()]): PipelineBoardView => ({
  clientId: 'client-1',
  counts: {
    stages: ['reviewing', 'qualified', 'pursuing', 'submitted', 'won', 'lost', 'passed'].map((stage) => ({
      stage: stage as PipelineBoardView['counts']['stages'][number]['stage'],
      count: cards.filter((entry) => entry.stage === stage).length,
    })),
    unstaged: { suggested: 0, expired: 0, other: 0 },
    total: cards.length,
    derivedFromWorkflowStatus: 0,
  },
  cards,
  cardsTruncated: false,
  summary: {
    inPipeline: cards.length,
    deadlinesInside30Days: 1,
    unassigned: 1,
    awaitingAward: 0,
    lastStageChange: '2026-09-01T12:00:00.000Z',
  },
});

function renderPipeline(clientId: string | null = 'client-1', callbacks: Partial<React.ComponentProps<typeof FundingOpportunityPipeline>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <FundingOpportunityPipeline clientId={clientId} clientName="Test client" {...callbacks} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.clearAllMocks());

beforeEach(() => {
  getMock.mockResolvedValue({ data: board() });
  postMock.mockResolvedValue({ data: { rowId: 'row-1', to: 'qualified', version: 4 } });
});

describe('FundingOpportunityPipeline v2 pursuit board', () => {
  test('renders no-client state and sends the client picker event', () => {
    const onChooseClient = vi.fn();
    renderPipeline(null, { onChooseClient });
    expect(screen.getByRole('heading', { name: 'A pursuit pipeline belongs to one client' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a client' }));
    expect(onChooseClient).toHaveBeenCalledWith({ clientId: null, clientName: null });
    expect(getMock).not.toHaveBeenCalled();
  });

  test('computes summary from the board response and opens the clicked title with source identity', async () => {
    const onOpenTitle = vi.fn();
    renderPipeline('client-1', { onOpenTitle });
    expect(await screen.findByText('Deadlines inside 30 days')).toBeInTheDocument();
    expect(within(screen.getByText('Deadlines inside 30 days').parentElement!).getByText('1', { selector: 'strong' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Vehicle sustainment notice' }));
    expect(onOpenTitle).toHaveBeenCalledWith({
      rowId: 'row-1', title: 'Vehicle sustainment notice', source: 'sam_gov', sourceRecordId: 'notice-1', sourceReference: undefined, clientId: 'client-1',
    });
  });

  test('posts a normal move with expected version and refetches only after success', async () => {
    let resolvePost!: (value: { data: { rowId: string; to: string; version: number } }) => void;
    postMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePost = resolve; }));
    renderPipeline();
    fireEvent.click(await screen.findByRole('button', { name: '→ Qualified' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      '/api/intelligence/clients/client-1/pipeline/row-1/stage',
      { toStage: 'qualified', expectedVersion: 3, reason: null },
    ));
    expect(getMock).toHaveBeenCalledTimes(1);
    resolvePost({ data: { rowId: 'row-1', to: 'qualified', version: 4 } });
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
  });

  test('requires the clicked card reason and preserves its id/title in the dialog', async () => {
    renderPipeline('client-1', {},);
    fireEvent.click(await screen.findByRole('button', { name: '→ Passed' }));
    const dialog = await screen.findByRole('dialog', { name: 'Not a fit — record a reason' });
    expect(within(dialog).getByText(/A reason is required\. Vehicle sustainment notice/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Record the decision' })).toBeDisabled();
    fireEvent.click(within(dialog).getByText('Economics do not work').closest('label')!);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record the decision' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      '/api/intelligence/clients/client-1/pipeline/row-1/stage',
      { toStage: 'passed', expectedVersion: 3, reason: 'Economics do not work' },
    ));
  });

  test('uses signal strength for list basis instead of score thresholds', async () => {
    getMock.mockResolvedValue({ data: board([card({ currentEvidence: {
      relevanceScore: 99,
      matchedSignals: [{ signal: 'genericTopical', strength: 'weak', matchedOn: 'defense' }],
      eligibility: { state: 'eligible', reason: 'Eligible' },
    } })]) });
    renderPipeline('client-1', { view: 'list' });
    const row = await screen.findByRole('row', { name: /Vehicle sustainment notice/ });
    expect(row).toHaveTextContent('Weak signal');
    expect(row).not.toHaveTextContent('Strong fit');
  });

  test('omits invented board facts for terminal cards and never falls back to internal ids', async () => {
    getMock.mockResolvedValue({ data: board([card({ rowId: 'won-1', stage: 'won', sourceReference: null, nextAction: null, value: { display: '$1', basis: 'source' }, allowedTransitions: [] })]) });
    renderPipeline();
    const rendered = await screen.findByTestId('fo-pursuit-card-won-1');
    expect(rendered).toHaveTextContent('Source reference not provided');
    expect(rendered).not.toHaveTextContent('notice-1');
    expect(rendered).not.toHaveTextContent('No next action recorded');
    expect(rendered).not.toHaveTextContent('$1');
  });

  test('terminal cards render immutable explanatory text without move controls', async () => {
    getMock.mockResolvedValue({ data: board([card({ rowId: 'won-1', stage: 'won', allowedTransitions: [] })]) });
    renderPipeline();
    expect(await screen.findByText('Nothing moves out of Won.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /→/ })).not.toBeInTheDocument();
  });

  test('refetch errors render an error and no stale rows', async () => {
    getMock.mockRejectedValue(new Error('network down'));
    renderPipeline();
    expect(await screen.findByRole('alert')).toHaveTextContent('The pursuit pipeline could not be loaded.');
    expect(screen.queryByText('Vehicle sustainment notice')).not.toBeInTheDocument();
  });

  test('invalid reason submission stays disabled and Cancel returns focus to the move control', async () => {
    renderPipeline();
    const move = await screen.findByRole('button', { name: '→ Passed' });
    move.focus();
    fireEvent.click(move);
    const dialog = await screen.findByRole('dialog', { name: 'Not a fit — record a reason' });
    const submit = within(dialog).getByRole('button', { name: 'Record the decision' });
    expect(submit).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Not a fit — record a reason' })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(move));
    expect(postMock).not.toHaveBeenCalled();
  });

  test('Escape closes the reason dialog', async () => {
    renderPipeline();
    fireEvent.click(await screen.findByRole('button', { name: '→ Passed' }));
    const dialog = await screen.findByRole('dialog', { name: 'Not a fit — record a reason' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Not a fit — record a reason' })).not.toBeInTheDocument();
  });
});

describe('pursuit reference contracts', () => {
  test('derives strict date semantics without browser-local shifting', () => {
    const now = new Date('2026-09-16T23:30:00Z');
    expect(deadlineForCard(card({ responseDeadline: '2026-09-24', lifecycle: 'active' }), now)).toMatchObject({ value: 'Sep 24, 2026', daysRemaining: 8, tone: 'warning' });
    expect(deadlineForCard(card({ responseDeadline: '2026-09-24T00:30:00-07:00' }), now).daysRemaining).toBe(8);
    expect(deadlineForCard(card({ responseDeadline: '2026-09-24T99:99:00+99:99' })).value).toBe('Not provided by source');
    expect(deadlineForCard(card({ responseDeadline: '2026-02-31' })).value).toBe('Not provided by source');
    expect(deadlineForCard(card({ responseDeadline: '2026-09-24', lifecycle: 'closed', stage: 'won' }), now).tone).toBe('success');
    expect(deadlineForCard(card({ responseDeadline: '2026-09-24', lifecycle: 'active', stage: 'lost' }), now).tone).toBe('error');
    expect(deadlineForCard(card({ responseDeadline: '2026-09-24', keyDate: { kind: 'response', date: '2026-09-24', displayLabel: 'Response deadline' } }), now)).toMatchObject({ label: 'Closes', value: 'Sep 24, 2026', daysRemaining: 8 });
    expect(deadlineForCard(card({ responseDeadline: '2026-09-24', keyDate: { kind: 'anticipated_award', date: null, displayLabel: 'Dec 2026' } }), now)).toMatchObject({ label: 'Award expected', value: 'Dec 2026', daysRemaining: null });
    expect(deadlineForCard(card({ responseDeadline: '2026-09-24', keyDate: { kind: 'anticipated_award', date: null, displayLabel: 'Dec 2026' } }), now).tone).toBe('plain');
  });

  test('uses the recorded transition reason, not stage derivation prose, for terminal list basis', () => {
    const lost = card({ stage: 'lost', stageExplanation: 'Moved here by a person.', stageReason: 'Teaming incomplete.' });
    expect(listBasis(lost)).toBe('Teaming incomplete.');
    expect(listBasis({ ...lost, stageReason: null })).toBe('Reason not provided by source');
    expect(listBasis(card({ stage: 'won', value: { display: '$48,000,000', basis: 'source_backed' } }))).toBe('Award amount not provided by source');
    expect(listBasis(card({ stage: 'won', value: { display: '$2,410,000', basis: 'awarded_amount' } }))).toBe('$2,410,000');
  });

  test('fixture transport enforces identity, version, reason, and refetch state', async () => {
    const api = createReferencePursuitFixtureApi();
    const initial = await api.get<PipelineBoardView>('/api/intelligence/clients/overland/pipeline');
    const first = initial.data.cards.find((entry) => entry.rowId === 'p1')!;
    expect(first.sourceReference).toBe('W911QY-26-R-0148');
    expect(first.sourceRecordId).toMatch(/^00000000-0000-4000-8000-000000000001$/);
    await expect(api.post('/api/intelligence/clients/overland/pipeline/p1/stage', { toStage: 'passed', expectedVersion: first.version, reason: null })).rejects.toMatchObject({ response: { status: 400 } });
    await api.post('/api/intelligence/clients/overland/pipeline/p1/stage', { toStage: 'qualified', expectedVersion: first.version, reason: null });
    const updated = await api.get<PipelineBoardView>('/api/intelligence/clients/overland/pipeline');
    expect(updated.data.cards.find((entry) => entry.rowId === 'p1')?.stage).toBe('qualified');
    expect(updated.data.cards.find((entry) => entry.rowId === 'p1')?.version).toBe(first.version + 1);
    await expect(api.post('/api/intelligence/clients/overland/pipeline/p1/stage', { toStage: 'pursuing', expectedVersion: first.version, reason: null })).rejects.toMatchObject({ response: { status: 409 } });
  });
});
