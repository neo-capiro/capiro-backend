/*
 * Phase 6 §4 (Web) — accessibility and keyboard access for the surfaces this
 * rollout introduced or rebuilt: the compact header, the Meri panel (strategy
 * and step contexts), the Watch proposal card, the chat composer, and the
 * inline `needs context` marker.
 *
 * Two kinds of check, deliberately:
 *  · a real `vitest-axe` pass, filtered to serious/critical impact and with
 *    color-contrast excluded — jsdom does not render, so a contrast verdict
 *    either way would be a false assurance (same rule the tracker a11y suite
 *    established);
 *  · explicit keyboard/state assertions axe cannot make: Enter vs Shift+Enter,
 *    reaching the created step from the reply without a mouse, and the fact
 *    that a control disabled mid-recheck is still EXPLAINED (a disabled button
 *    is not focusable, so the explanation has to reach assistive tech another
 *    way).
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { App } from 'antd';
import { axe } from 'vitest-axe';
import type { StrategyChatMessage, StrategyNode, WatchProposalCard, WatchReviewState } from './types.js';

const idle = { isLoading: false, isError: false, isSuccess: true, error: null };

// ---- mocked data layer --------------------------------------------------------

const threads: Record<string, StrategyChatMessage[]> = {};
const assistantMutate = vi.fn();
let watchState: WatchReviewState | null = null;
let revalidating = false;
const revalidateMutate = vi.fn();

vi.mock('./api.js', () => ({
  useUpdateNode: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteNode: () => ({ mutate: vi.fn(), isPending: false }),
  useAssistant: () => ({ mutate: assistantMutate, isPending: false }),
  useUploadAttachment: () => ({ mutateAsync: vi.fn() }),
  useStrategyConversation: (_s: string | null, nodeId: string | null) => ({
    ...idle,
    data: threads[nodeId ?? 'strategy'] ?? [],
  }),
  useWatchReviewState: () => ({ ...idle, isLoading: false, data: watchState }),
  useRevalidateWatch: () => ({ mutate: revalidateMutate, isPending: revalidating }),
  useAcceptWatchProposal: () => ({ mutate: vi.fn(), isPending: false }),
  useDismissWatchProposal: () => ({ mutate: vi.fn(), isPending: false }),
  useAcceptAllWatchProposals: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateMission: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateMission: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('./client-targets-lite.js', () => ({
  useClientTargetsLite: () => ({ ...idle, data: [] }),
  targetDisplayLabel: () => 'Target',
}));
vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) };
});

import { StrategyMeriPanel } from './NodeRail.js';
import { StrategyHeader } from './StrategyHeader.js';
import { StrategyTimeline } from './StrategyTimeline.js';
import { buildCalendar } from './fiscal.js';

const calendar = buildCalendar(new Date('2026-07-27T12:00:00Z'));

const chat = (over: Partial<StrategyChatMessage> & { id: string }): StrategyChatMessage => ({
  strategyId: 'strat-1',
  nodeId: null,
  role: 'meri',
  kind: 'message',
  body: 'A tight FY27 push.',
  attachments: [],
  action: null,
  state: 'active',
  createdByUserId: null,
  createdAt: '2026-07-27T00:00:00.000Z',
  ...over,
});

const stepNode = (over: Partial<StrategyNode> & { id: string } = { id: 'n1' }): StrategyNode =>
  ({
    strategyId: 'strat-1',
    kind: 'action',
    subject: 'deliverable',
    title: 'Coalition sign-on letter',
    note: null,
    ownerUserId: null,
    status: 'draft',
    startsOn: '2027-02-01',
    endsOn: '2027-02-20',
    openEnded: false,
    dependsOnIds: [],
    provenance: null,
    targetRef: null,
    meriAuthored: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  }) as StrategyNode;

const proposal = (over: Partial<WatchProposalCard> = {}): WatchProposalCard => ({
  id: 'cs-1',
  watchKey: 'k1',
  strategyVersionId: 'v7',
  sourceLabel: 'Dependency check',
  sourceDate: '2026-07-20',
  badges: ['out_of_order'],
  title: 'Markup defense memo starts before the letter lands',
  proposal: 'Retime to 2027-04-01 – 2027-04-15',
  impact: 'moves one later step',
  why: 'This step starts before the step it depends on finishes.',
  risk: 'medium',
  recheckStatus: null,
  ...over,
});

const reviewState = (over: Partial<WatchReviewState> = {}): WatchReviewState => ({
  strategyId: 'strat-1',
  headVersionId: 'v7',
  mission: { id: 'm1', state: 'active', cadence: 'weekly', lastRunAt: '2026-07-20T00:00:00.000Z', nextRunAt: null },
  pendingCount: 1,
  proposals: [proposal()],
  lastRecheck: null,
  ...over,
});

function renderPanel(props: Partial<Parameters<typeof StrategyMeriPanel>[0]> = {}) {
  return render(
    <MemoryRouter>
      <App>
        <div className="sp-root">
          <StrategyMeriPanel
            strategyId="strat-1"
            clientId="client-1"
            node={null}
            calendar={calendar}
            members={[]}
            meriEnabled
            watcherEnabled
            draftedByMeri
            meriSummary={null}
            currentUserId="user-1"
            nodeArtifacts={[]}
            applied={null}
            onFlash={vi.fn()}
            onSelectNode={vi.fn()}
            onOpenArtifact={vi.fn()}
            onClose={vi.fn()}
            onDeselect={vi.fn()}
            {...props}
          />
        </div>
      </App>
    </MemoryRouter>,
  );
}

function renderHeader(props: Partial<Parameters<typeof StrategyHeader>[0]> = {}) {
  return render(
    <div className="sp-root">
      <StrategyHeader
        onBack={vi.fn()}
        clientLabel="Brightdefense"
        typeLabel="Appropriations"
        title="FY27 plus-up"
        goal="Secure the FY27 plus-up."
        layers={{ ppbe: true, congress: true }}
        onToggleLayer={vi.fn()}
        watch={{ on: true, pending: 2 }}
        onOpenWatch={vi.fn()}
        onExport={vi.fn()}
        onHistory={vi.fn()}
        onAskMeri={vi.fn()}
        meriPanelOpen={false}
        meriEnabled
        {...props}
      />
    </div>,
  );
}

/** Serious/critical only; color-contrast is not meaningfully checkable in jsdom. */
function seriousViolations(results: Awaited<ReturnType<typeof axe>>) {
  return (results.violations ?? [])
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .filter((v) => v.id !== 'color-contrast')
    .map((v) => `${v.id}: ${v.help} :: ${v.nodes.map((n) => n.html).join(' | ').slice(0, 240)}`);
}

beforeEach(() => {
  for (const k of Object.keys(threads)) delete threads[k];
  Element.prototype.scrollIntoView = vi.fn();
  watchState = reviewState();
  revalidating = false;
  assistantMutate.mockReset();
  revalidateMutate.mockReset();
});

// ── axe ────────────────────────────────────────────────────────────────────────

describe('axe — no serious or critical violations', () => {
  test('the compact header, with the Watch chip alerting', async () => {
    const { container } = renderHeader();
    expect(seriousViolations(await axe(container))).toEqual([]);
  });

  test('the header in its Meri-off fallback shape', async () => {
    const { container } = renderHeader({ meriEnabled: false, onAddStep: vi.fn(), watch: null });
    expect(seriousViolations(await axe(container))).toEqual([]);
  });

  test('the panel at strategy scope — Watch panel, thread and composer together', async () => {
    threads.strategy = [
      chat({ id: 'u1', role: 'user', body: 'Add a coalition letter' }),
      chat({
        id: 'm1',
        body: 'Added it.',
        action: { type: 'open_node', nodeId: 'n9', title: 'Coalition sign-on letter' },
      }),
      chat({ id: 'g1', kind: 'context_gap', body: 'I drafted this without the strategy brief.' }),
    ];
    const { container } = renderPanel();
    expect(seriousViolations(await axe(container))).toEqual([]);
  });

  test('the panel at step scope — the field editor and node actions', async () => {
    threads.n1 = [chat({ id: 'm1', nodeId: 'n1', body: 'This step moves to April.' })];
    const { container } = renderPanel({ node: stepNode({ id: 'n1' }), agenticEnabled: true });
    expect(seriousViolations(await axe(container))).toEqual([]);
  });

  test('the Watch proposal card with its Why expanded', async () => {
    const { container } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Why?' }));
    expect(seriousViolations(await axe(container))).toEqual([]);
  });

  test('the Watch panel in its empty (nothing to review) state', async () => {
    watchState = reviewState({ pendingCount: 0, proposals: [] });
    const { container } = renderPanel();
    expect(seriousViolations(await axe(container))).toEqual([]);
  });

  test('the timeline with an inline needs-context marker', async () => {
    const { container } = render(
      <StrategyTimeline
        strategyId="strat-1"
        calendar={calendar}
        nodes={[
          stepNode({
            id: 'n1',
            title: 'File the funding request memo',
            provenance: { contextNeeds: [{ code: 'strategy_brief', label: 'the strategy brief' }] } as never,
          }),
        ]}
        congress={[]}
        ppbeLanes={[]}
        ppbeCurrentPhases={[]}
        firmPhases={[]}
        layers={{ ppbe: true, congress: true }}
        selectedId={null}
        onSelectNode={vi.fn()}
      />,
    );
    expect(seriousViolations(await axe(container))).toEqual([]);
  });
});

// ── named controls ─────────────────────────────────────────────────────────────

describe('every control has an accessible name', () => {
  test('the panel’s icon-only controls are named, in both contexts', () => {
    const { unmount } = renderPanel();
    expect(screen.getByRole('button', { name: 'Close the panel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    unmount();

    renderPanel({ node: stepNode({ id: 'n1' }) });
    expect(screen.getByRole('button', { name: 'Back to the strategy' })).toBeTruthy();
  });

  test('no button anywhere in the header or panel is announced as just “button”', () => {
    renderHeader();
    renderPanel();
    const unnamed = Array.from(document.querySelectorAll('button')).filter(
      (b) => !(b.getAttribute('aria-label') ?? b.textContent ?? '').trim(),
    );
    expect(unnamed.map((b) => b.outerHTML.slice(0, 120))).toEqual([]);
  });

  test('the Watch chip announces its state and its pending count', () => {
    renderHeader();
    expect(
      screen.getByRole('button', { name: 'Watching. 2 proposed changes awaiting review.' }),
    ).toBeTruthy();
  });
});

// ── keyboard ───────────────────────────────────────────────────────────────────

describe('keyboard access', () => {
  test('Enter sends and Shift+Enter inserts a newline instead', () => {
    renderPanel();
    const input = screen.getByPlaceholderText('Ask Meri to change anything…');
    fireEvent.change(input, { target: { value: 'Add a risk' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(assistantMutate).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(assistantMutate).toHaveBeenCalledTimes(1);
  });

  test('an IME composition’s Enter never sends', () => {
    renderPanel();
    const input = screen.getByPlaceholderText('Ask Meri to change anything…');
    fireEvent.change(input, { target: { value: '連合' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(assistantMutate).not.toHaveBeenCalled();
  });

  test('the reply’s Open action is a real button, reachable and activatable from the keyboard', () => {
    const onSelectNode = vi.fn();
    threads.strategy = [
      chat({
        id: 'm1',
        body: 'Added it.',
        action: { type: 'open_node', nodeId: 'n9', title: 'Coalition sign-on letter' },
      }),
    ];
    renderPanel({ onSelectNode });
    const open = screen.getByRole('button', { name: /Open “Coalition sign-on letter”/ });
    open.focus();
    expect(document.activeElement).toBe(open);
    fireEvent.keyDown(open, { key: 'Enter' });
    fireEvent.click(open); // Enter on a native button fires click in a real browser.
    expect(onSelectNode).toHaveBeenCalledWith('n9');
  });

  test('the Watch panel’s Why toggle and its actions are all native buttons', () => {
    renderPanel();
    const panel = screen.getByTestId('sp-watch-panel');
    for (const name of ['Accept', 'Dismiss', 'Why?', 'Accept all 1', 'Pause for this strategy']) {
      const el = within(panel).getByRole('button', { name });
      expect(el.tagName).toBe('BUTTON');
    }
  });

  test('mid-recheck the disabled actions are still EXPLAINED — visibly and to assistive tech', () => {
    revalidating = true;
    renderPanel();
    const panel = screen.getByTestId('sp-watch-panel');
    expect(panel).toHaveAttribute('aria-busy', 'true');
    expect(panel).toHaveTextContent('Re-checking…');
    expect(within(panel).getByRole('button', { name: 'Accept' })).toBeDisabled();
  });

  test('a dropped-proposal notice is announced as a status, and its control is named apart from a proposal’s Dismiss', () => {
    // The header chip's focus request revalidates; that response is what
    // carries the dropped list.
    revalidateMutate.mockImplementation((_v: unknown, opts?: { onSuccess?: (s: WatchReviewState) => void }) =>
      opts?.onSuccess?.(
        reviewState({
          lastRecheck: {
            state: 'complete',
            elapsedMs: 10,
            unchanged: [],
            updated: [],
            dropped: [
              { watchKey: 'k9', reason: 'The step this was about is no longer in the plan.', targetDeleted: true },
            ],
          },
        }),
      ),
    );
    renderPanel({ focusWatch: true });

    const notice = screen.getByText('The step this was about is no longer in the plan.').closest('[role="status"]');
    expect(notice).toBeTruthy();
    expect(within(notice as HTMLElement).getByRole('button', { name: 'Dismiss this notice' })).toBeTruthy();
    // ...and the proposal's own Dismiss is still a separate, distinctly named
    // control, so a screen-reader user can tell the two apart.
    expect(within(screen.getByTestId('sp-watch-scroller')).getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });
});
