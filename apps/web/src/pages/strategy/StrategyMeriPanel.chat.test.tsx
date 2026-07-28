/*
 * Phase 2 — the persistent contextual Meri chat.
 *
 * What these pin down, in the prototype's terms:
 *  · the drafted-plan note is standing provenance (exact copy, no close button);
 *  · user right / Meri left, with attachment chips inside the user bubble;
 *  · strategy and step threads are SEPARATE caches, and switching between them
 *    restores each one's own persisted history;
 *  · a created step is reachable only through the reply's explicit Open link —
 *    sending never navigates;
 *  · the composer lives OUTSIDE the scroll container, and a long thread grows
 *    the scroll height instead of squeezing the cards above it;
 *  · nothing user-visible says "rail".
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { App } from 'antd';
import type { StrategyChatMessage, StrategyNode } from './types.js';

const idle = { isLoading: false, isError: false, isSuccess: true, error: null };

/** Per-context conversation fixtures, keyed the way the real query keys are. */
const threads: Record<string, StrategyChatMessage[]> = {};
const assistantMutate = vi.fn();
const updateMutate = vi.fn();
let assistantPending = false;

const msg = (over: Partial<StrategyChatMessage> & { id: string }): StrategyChatMessage => ({
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

vi.mock('./api.js', () => ({
  useUpdateNode: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteNode: () => ({ mutate: vi.fn(), isPending: false }),
  useAssistant: () => ({ mutate: assistantMutate, isPending: assistantPending }),
  useUploadAttachment: () => ({ mutateAsync: vi.fn() }),
  useStrategyConversation: (_sid: string | null, nodeId: string | null, enabled: boolean) => ({
    ...idle,
    isSuccess: enabled,
    data: enabled ? (threads[nodeId ?? 'strategy'] ?? []) : undefined,
  }),
}));
vi.mock('./client-targets-lite.js', () => ({
  useClientTargetsLite: () => ({ ...idle, data: [] }),
  targetDisplayLabel: () => 'Target',
}));
vi.mock('./agents/WatchRail.js', () => ({ WatchRail: () => <div>watch</div> }));

import { StrategyMeriPanel, DRAFTED_NOTE } from './NodeRail.js';
import { buildCalendar } from './fiscal.js';

// A real calendar: the node editor derives its quarter labels from it, so a
// stub object silently blows up the moment a step is selected.
const calendar = buildCalendar(new Date('2026-07-27T00:00:00.000Z'));

const node = (over: Partial<StrategyNode> & { id: string }): StrategyNode => ({
  strategyId: 'strat-1',
  kind: 'action',
  subject: 'deliverable',
  title: 'Coalition sign-on letter',
  note: null,
  ownerUserId: null,
  status: 'draft',
  startsOn: '2027-05-01',
  endsOn: null,
  openEnded: false,
  dependsOnIds: [],
  provenance: null,
  targetRef: null,
  meriAuthored: true,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  ...over,
});

function renderPanel(props: Partial<Parameters<typeof StrategyMeriPanel>[0]> = {}) {
  const onSelectNode = vi.fn();
  const view = render(
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
            draftedByMeri
            meriSummary={null}
            currentUserId="user-1"
            nodeArtifacts={[]}
            applied={null}
            onFlash={vi.fn()}
            onSelectNode={onSelectNode}
            onOpenArtifact={vi.fn()}
            onClose={vi.fn()}
            onDeselect={vi.fn()}
            {...props}
          />
        </div>
      </App>
    </MemoryRouter>,
  );
  return { ...view, onSelectNode };
}

beforeEach(() => {
  for (const k of Object.keys(threads)) delete threads[k];
  assistantMutate.mockReset();
  updateMutate.mockReset();
  assistantPending = false;
});

describe('persistent drafted-plan note', () => {
  test('renders the exact prototype copy, with no dismiss control', () => {
    renderPanel();
    const note = screen.getByTestId('sp-drafted-note');
    expect(note).toHaveTextContent(DRAFTED_NOTE);
    expect(DRAFTED_NOTE).toBe(
      'Meri drafted this plan. Every step is editable — drag to re-time, click to open, or just ask here.',
    );
    // Standing provenance, not a notification: no close button anywhere in it.
    expect(within(note).queryByRole('button')).toBeNull();
  });

  test('matches the prototype presentation', () => {
    renderPanel();
    const note = screen.getByTestId('sp-drafted-note');
    expect(note).toHaveStyle({
      padding: '8px 14px',
      background: 'var(--accent-soft)',
      borderBottom: '1px solid #C6D4F4',
    });
    // The prototype sizes this with its own --text-2xs token (10px), not a
    // hardcoded 11px.
    const label = note.querySelector('span:last-of-type') as HTMLElement;
    expect(label).toHaveStyle({ fontSize: 'var(--text-2xs)', color: 'var(--accent-ink)' });
  });

  test('renders nothing for a manually created strategy', () => {
    renderPanel({ draftedByMeri: false });
    expect(screen.queryByTestId('sp-drafted-note')).toBeNull();
    // And no substitute wording that would claim Meri drafted it.
    expect(document.body.textContent).not.toMatch(/Meri drafted/i);
  });

  test('sits outside the scrolling body so it never scrolls away', () => {
    renderPanel();
    const body = screen.getByTestId('sp-panel-body');
    expect(body.contains(screen.getByTestId('sp-drafted-note'))).toBe(false);
  });
});

describe('message rendering', () => {
  test('user messages are right-aligned with their attachment chips inside', () => {
    threads.strategy = [
      msg({
        id: 'm1',
        role: 'user',
        body: 'Read this and add a step',
        attachments: [{ id: 'att-1', filename: 'FY27 markup memo.pdf', kind: 'pdf', status: 'ready' }],
      }),
    ];
    renderPanel();
    const bubble = screen.getByTestId('sp-chat-user');
    expect(bubble).toHaveStyle({ alignSelf: 'flex-end', maxWidth: '86%', background: 'var(--accent)' });
    expect(within(bubble).getByText('FY27 markup memo.pdf')).toBeTruthy();
  });

  test('Meri messages are left-aligned', () => {
    threads.strategy = [msg({ id: 'm1', body: 'Added the letter.' })];
    renderPanel();
    const bubble = screen.getByTestId('sp-chat-meri');
    expect(bubble).toHaveStyle({ alignSelf: 'flex-start', maxWidth: '92%' });
    expect(bubble).toHaveTextContent('Added the letter.');
  });

  test('a watch_applied message carries the Watch mode badge', () => {
    threads.strategy = [msg({ id: 'm1', kind: 'watch_applied', body: 'Applied 2 watch changes.' })];
    renderPanel();
    expect(screen.getByTestId('sp-chat-meri')).toHaveTextContent('Watch mode');
  });

  test('a dismissed context gap is not rendered', () => {
    threads.strategy = [
      msg({ id: 'm1', kind: 'context_gap', body: 'I drafted this without the strategy brief.', state: 'dismissed' }),
    ];
    renderPanel();
    expect(screen.queryByTestId('sp-chat-meri')).toBeNull();
  });

  test('a pre-Phase-2 strategy shows its stored summary as Meri’s opening line', () => {
    threads.strategy = [];
    renderPanel({ meriSummary: 'A tight FY27 push, front-loaded before markup.' });
    expect(screen.getByTestId('sp-chat-meri')).toHaveTextContent('front-loaded before markup');
  });
});

describe('the Open “<step>” action', () => {
  const withAction = () => {
    threads.strategy = [
      msg({
        id: 'm1',
        body: 'Added a coalition sign-on letter.',
        action: { type: 'open_node', nodeId: 'node-9', title: 'Coalition sign-on letter' },
      }),
    ];
  };

  test('renders the link but does NOT auto-select the created step', () => {
    withAction();
    const { onSelectNode } = renderPanel();
    expect(screen.getByRole('button', { name: /Open “Coalition sign-on letter”/ })).toBeTruthy();
    expect(onSelectNode).not.toHaveBeenCalled();
  });

  test('selects the step only when clicked', () => {
    withAction();
    const { onSelectNode } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Open “Coalition sign-on letter”/ }));
    expect(onSelectNode).toHaveBeenCalledWith('node-9');
  });
});

describe('separate contexts', () => {
  test('the strategy thread and a step thread render their own history', () => {
    threads.strategy = [msg({ id: 's1', body: 'Strategy-level answer.' })];
    threads['node-1'] = [msg({ id: 'n1', nodeId: 'node-1', body: 'Step-level answer.' })];

    const { rerender, unmount } = renderPanel();
    expect(screen.getByTestId('sp-chat-thread')).toHaveTextContent('Strategy-level answer.');
    expect(screen.getByTestId('sp-chat-thread')).not.toHaveTextContent('Step-level answer.');
    unmount();
    void rerender;

    renderPanel({ node: node({ id: 'node-1' }) });
    expect(screen.getByTestId('sp-chat-thread')).toHaveTextContent('Step-level answer.');
    expect(screen.getByTestId('sp-chat-thread')).not.toHaveTextContent('Strategy-level answer.');
  });

  test('switching away and back restores the original thread', () => {
    threads.strategy = [msg({ id: 's1', body: 'Strategy-level answer.' })];
    threads['node-1'] = [msg({ id: 'n1', nodeId: 'node-1', body: 'Step-level answer.' })];

    const first = renderPanel();
    expect(screen.getByTestId('sp-chat-thread')).toHaveTextContent('Strategy-level answer.');
    first.unmount();

    const second = renderPanel({ node: node({ id: 'node-1' }) });
    expect(screen.getByTestId('sp-chat-thread')).toHaveTextContent('Step-level answer.');
    second.unmount();

    renderPanel();
    expect(screen.getByTestId('sp-chat-thread')).toHaveTextContent('Strategy-level answer.');
  });
});

describe('the pinned composer', () => {
  test('lives outside the scrolling body', () => {
    renderPanel();
    const body = screen.getByTestId('sp-panel-body');
    const footer = screen.getByTestId('sp-panel-footer');
    expect(body.contains(footer)).toBe(false);
    expect(within(footer).getByPlaceholderText('Ask Meri to change anything…')).toBeTruthy();
  });

  test('send is disabled with no text and no attachment, and enabled once there is text', () => {
    renderPanel();
    const footer = screen.getByTestId('sp-panel-footer');
    const send = within(footer).getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    fireEvent.change(within(footer).getByPlaceholderText('Ask Meri to change anything…'), {
      target: { value: 'Add a risk' },
    });
    expect(send).not.toBeDisabled();
  });

  test('Enter sends and Shift+Enter does not', () => {
    renderPanel();
    const input = screen.getByPlaceholderText('Ask Meri to change anything…');
    fireEvent.change(input, { target: { value: 'Add a risk' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(assistantMutate).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(assistantMutate).toHaveBeenCalledTimes(1);
  });

  test('each send carries a fresh clientMessageId and never auto-navigates', () => {
    const { onSelectNode } = renderPanel();
    const input = screen.getByPlaceholderText('Ask Meri to change anything…');
    fireEvent.change(input, { target: { value: 'one' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'two' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const ids = assistantMutate.mock.calls.map((c) => (c[0] as { clientMessageId: string }).clientMessageId);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ids[0]).not.toBe(ids[1]);
    expect(onSelectNode).not.toHaveBeenCalled();
  });

  test('the in-flight user message shows immediately and is not removed', async () => {
    renderPanel();
    const input = screen.getByPlaceholderText('Ask Meri to change anything…');
    fireEvent.change(input, { target: { value: 'Add a coalition letter' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      const bubble = screen.getByTestId('sp-chat-user');
      expect(bubble).toHaveTextContent('Add a coalition letter');
      expect(bubble.dataset.pending).toBe('true');
    });
  });

  test('a strategy suggestion pill sends its own text through Meri', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Add a coalition sign-on letter' }));
    expect(assistantMutate.mock.calls[0]![0]).toMatchObject({
      scope: 'strategy',
      instruction: 'Add a coalition sign-on letter',
    });
  });

  test("the node pills are NOD-5's deterministic quick actions, and appear exactly once", () => {
    renderPanel({ node: node({ id: 'node-1' }) });
    // Relocated from the body to the footer — not duplicated across both.
    expect(screen.getAllByRole('button', { name: 'Push a quarter' })).toHaveLength(1);
    expect(screen.queryByText('Quick actions')).toBeNull();
    const footer = screen.getByTestId('sp-panel-footer');
    for (const label of ['Push a quarter', 'Reassign to me', 'Make it a gate']) {
      expect(within(footer).getByRole('button', { name: label })).toBeTruthy();
    }
    // Deterministic: a PATCH, never a model round-trip.
    fireEvent.click(within(footer).getByRole('button', { name: 'Push a quarter' }));
    expect(assistantMutate).not.toHaveBeenCalled();
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0]![0]).toMatchObject({
      nodeId: 'node-1',
      input: { changeNote: 'Pushed one quarter.' },
    });
  });
});

describe('scroll behaviour', () => {
  test('the body is the single scrolling block and its children do not shrink', () => {
    threads.strategy = [msg({ id: 'm1' })];
    renderPanel();
    const body = screen.getByTestId('sp-panel-body');
    expect(body).toHaveStyle({ flex: '1', minHeight: '0px', overflowY: 'auto' });
    // Every direct child holds its height, so a long thread lengthens the
    // scroll area instead of compressing the cards and fields above it.
    for (const child of Array.from(body.children) as HTMLElement[]) {
      expect(child.style.flexShrink).toBe('0');
    }
  });

  test('scrolls to newest when messages arrive', async () => {
    threads.strategy = [msg({ id: 'm1' })];
    renderPanel();
    const body = screen.getByTestId('sp-panel-body');
    // jsdom reports 0 for both, so drive scrollHeight and re-trigger the effect
    // by sending — the assertion is that the effect writes scrollHeight through.
    Object.defineProperty(body, 'scrollHeight', { value: 900, configurable: true });
    const input = screen.getByPlaceholderText('Ask Meri to change anything…');
    fireEvent.change(input, { target: { value: 'next' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(body.scrollTop).toBe(900));
  });
});

describe('vocabulary', () => {
  test('no user-visible copy or accessible name says “rail”', () => {
    threads.strategy = [
      msg({ id: 'm1', role: 'user', body: 'Add a risk' }),
      msg({ id: 'm2', body: 'Added it.', action: { type: 'open_node', nodeId: 'n9', title: 'Risk' } }),
    ];
    renderPanel({ node: null });
    expect(document.body.textContent ?? '').not.toMatch(/rail/i);
    for (const el of Array.from(document.querySelectorAll('[aria-label],[title],[placeholder],[alt]'))) {
      expect(
        `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''} ` +
          `${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('alt') ?? ''}`,
      ).not.toMatch(/rail/i);
    }
  });
});
