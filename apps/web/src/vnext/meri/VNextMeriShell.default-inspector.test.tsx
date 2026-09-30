import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../components/chat/chat-store.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import type { MeriTurnInspectorData, MeriTurnInspectorTab } from './MeriTurnInspector.js';
import type { ActiveTurnInspector } from './VNextMeriContextRail.js';

const api = {};
vi.mock('../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('../../lib/me.js', () => ({ useMe: () => ({ data: null }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../../components/chat/managed-mcp-apps.js', () => ({
  ManagedMcpAppsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./useMeriSourceSelection.js', () => ({
  useMeriSourceSelection: () => ({
    active: null,
    open: vi.fn(),
    close: vi.fn(),
    changeIndex: vi.fn(),
  }),
}));
vi.mock('./meri-vnext-api.js', () => ({
  getMeriVNextPreferences: async () => ({
    windowChrome: 'undocked',
    railCollapsed: false,
    openSection: null,
  }),
  saveMeriVNextPreferences: async () => undefined,
}));
vi.mock('./VNextMeriTopBar.js', () => ({ VNextMeriTopBar: () => null }));
vi.mock('./VNextMeriThreadRail.js', () => ({ VNextMeriThreadRail: () => null }));
vi.mock('./MeriContextSheet.js', () => ({ MeriContextSheet: () => null }));
vi.mock('./MeriCommandPalette.js', () => ({ MeriCommandPalette: () => null }));

// Capture the latest ContextRail props so we can drive the rail directly.
let railProps: {
  activeTurnInspector: ActiveTurnInspector | null;
  onChangeTurnInspectorTab?: (t: MeriTurnInspectorTab) => void;
  onShowInspector?: () => void;
  onExpandSection?: (s: string) => void;
} | null = null;
vi.mock('./VNextMeriContextRail.js', () => ({
  VNextMeriContextRail: (props: NonNullable<typeof railProps>) => {
    railProps = props;
    const inspector = props.activeTurnInspector;
    return inspector ? (
      <div aria-label="rail-inspector">
        <span data-testid="turn">{inspector.data.turnId}</span>
        <span data-testid="tab">{inspector.activeTab}</span>
        <span data-testid="plan">{inspector.data.thinking.plan}</span>
      </div>
    ) : (
      <div aria-label="rail-context">context</div>
    );
  },
}));

// A conversation with a clickable "Show work" pin for a historical turn.
let lastPin: { data: MeriTurnInspectorData; tab: MeriTurnInspectorTab } | null = null;
vi.mock('./VNextMeriConversation.js', () => ({
  VNextMeriConversation: ({
    onOpenTurnInspector,
  }: {
    onOpenTurnInspector: (d: MeriTurnInspectorData, t: MeriTurnInspectorTab) => void;
  }) => (
    <button
      onClick={() =>
        onOpenTurnInspector(
          {
            turnId: 'historical-turn',
            turnScope: {
              kind: 'client',
              clientId: 'l3',
              clientName: 'L3 Harris',
              targetHint: null,
            },
            contextPacketId: 'historical-packet',
            thinking: { plan: 'Historical plan', steps: [], intent: null, tier: null },
            evidence: {
              sources: [],
              verifyStats: [],
              claims: [],
              groundingCaveat: null,
              retrieval: null,
            },
            approvals: [],
          },
          'evidence',
        )
      }
    >
      Show work
    </button>
  ),
}));

import { VNextMeriShell } from './VNextMeriShell.js';

function approval(status: 'proposed' | 'succeeded' = 'proposed') {
  return { proposalId: 'p1', status } as unknown as MeriChatController['pendingApprovals'][number];
}
function assistantMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'a1', role: 'assistant', content: 'Answer', createdAt: new Date(), ...overrides };
}
function makeController(overrides: Record<string, unknown> = {}) {
  return {
    activeConversationId: 'conv-1',
    messages: [
      assistantMsg({ id: 'a1', planSteps: ['Latest plan'], orchestratorIntent: 'draft_document' }),
    ],
    pendingApprovals: [],
    isStreaming: false,
    planSteps: [],
    trustSteps: [],
    orchestratorIntent: null,
    orchestratorTier: null,
    selectedClientValue: 'l3',
    clients: [{ id: 'l3', name: 'L3 Harris' }],
    ...overrides,
  } as unknown as MeriChatController;
}
function shellProps(controller: MeriChatController) {
  return {
    controller,
    historyError: null,
    onRetryHistory: vi.fn(),
    onArchiveThread: vi.fn(),
    onRenameThread: vi.fn(),
    onRestoreThread: vi.fn(),
  };
}

describe('VNextMeriShell default turn inspector', () => {
  it('shows the latest assistant turn inspector by default (Thinking when no approvals pending)', async () => {
    render(<VNextMeriShell {...shellProps(makeController())} />);
    await act(async () => {});
    expect(screen.getByLabelText('rail-inspector')).toBeTruthy();
    expect(screen.getByTestId('turn').textContent).toBe('a1');
    expect(screen.getByTestId('plan').textContent).toBe('Latest plan');
    expect(screen.getByTestId('tab').textContent).toBe('thinking');
  });

  it('defaults to Approvals when a conversation-level approval is awaiting a decision', async () => {
    render(
      <VNextMeriShell
        {...shellProps(makeController({ pendingApprovals: [approval('proposed')] }))}
      />,
    );
    await act(async () => {});
    expect(screen.getByTestId('tab').textContent).toBe('approvals');
  });

  it('keeps uncertain recovery out of the actionable default and wires read-only status refresh', async () => {
    const handleApprovePending = vi.fn();
    const uncertain = {
      ...approval('proposed'),
      approvalRecovery: { state: 'unavailable' as const, message: 'Outcome unconfirmed.' },
    };
    render(
      <VNextMeriShell
        {...shellProps(makeController({ pendingApprovals: [uncertain], handleApprovePending }))}
      />,
    );
    await act(async () => {});
    expect(screen.getByTestId('tab').textContent).toBe('thinking');

    act(() => railProps?.activeTurnInspector?.onRefreshApprovalStatus('p1'));
    expect(handleApprovePending).toHaveBeenCalledWith('p1');
  });

  it('a new conversation resets to the default inspector without the prior thread stale turn', async () => {
    const first = makeController({
      activeConversationId: 'conv-1',
      messages: [assistantMsg({ id: 'a1', planSteps: ['First plan'] })],
    });
    const view = render(<VNextMeriShell {...shellProps(first)} />);
    await act(async () => {});
    expect(screen.getByTestId('turn').textContent).toBe('a1');
    // Switch to a different conversation with its own latest turn.
    const second = makeController({
      activeConversationId: 'conv-2',
      messages: [assistantMsg({ id: 'b9', planSteps: ['Second plan'] })],
    });
    view.rerender(<VNextMeriShell {...shellProps(second)} />);
    await act(async () => {});
    expect(screen.getByTestId('turn').textContent).toBe('b9');
    expect(screen.getByTestId('plan').textContent).toBe('Second plan');
  });

  it('a manual "Show work" pin overrides the default with the historical turn until the conversation changes', async () => {
    lastPin = null;
    render(<VNextMeriShell {...shellProps(makeController())} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }));
    await act(async () => {});
    expect(screen.getByTestId('turn').textContent).toBe('historical-turn');
    expect(screen.getByTestId('plan').textContent).toBe('Historical plan');
    // The pin set the tab to what the caller requested (evidence).
    expect(screen.getByTestId('tab').textContent).toBe('evidence');
  });

  it('Context/Memory is reachable and returns to the inspector', async () => {
    render(<VNextMeriShell {...shellProps(makeController())} />);
    await act(async () => {});
    expect(screen.getByLabelText('rail-inspector')).toBeTruthy();
    // Open Context via the rail's Context/Memory control path.
    act(() => railProps?.onExpandSection?.('context'));
    expect(screen.getByLabelText('rail-context')).toBeTruthy();
    expect(screen.queryByLabelText('rail-inspector')).toBeNull();
    // Return to the inspector.
    act(() => railProps?.onShowInspector?.());
    expect(screen.getByLabelText('rail-inspector')).toBeTruthy();
    expect(screen.getByTestId('turn').textContent).toBe('a1');
  });

  it('preserves a user-selected tab against incoming data after initialization', async () => {
    const controller = makeController({ pendingApprovals: [approval('proposed')] });
    const view = render(<VNextMeriShell {...shellProps(controller)} />);
    await act(async () => {});
    // Default chose approvals (pending). User switches to evidence.
    expect(screen.getByTestId('tab').textContent).toBe('approvals');
    act(() => railProps?.onChangeTurnInspectorTab?.('evidence'));
    expect(screen.getByTestId('tab').textContent).toBe('evidence');
    // New data arrives (approval resolved) — must NOT yank the user back.
    const updated = makeController({ pendingApprovals: [approval('succeeded')] });
    view.rerender(<VNextMeriShell {...shellProps(updated)} />);
    await act(async () => {});
    expect(screen.getByTestId('tab').textContent).toBe('evidence');
  });
});
