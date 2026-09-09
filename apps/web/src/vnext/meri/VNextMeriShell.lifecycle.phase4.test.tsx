import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../components/chat/chat-store.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { meriRuntimeStatus } from '../../components/chat/meri-runtime-status.js';
import type { MeriTurnInspectorData } from './MeriTurnInspector.js';

const api = {};
vi.mock('../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('../../lib/me.js', () => ({ useMe: () => ({ data: null }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../../components/chat/managed-mcp-apps.js', () => ({ ManagedMcpAppsProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('./useMeriSourceSelection.js', () => ({ useMeriSourceSelection: () => ({ active: null }) }));
vi.mock('./meri-vnext-api.js', () => ({
  getMeriVNextPreferences: async () => ({ windowChrome: 'undocked', railCollapsed: false, openSection: null }),
  saveMeriVNextPreferences: async () => undefined,
}));
vi.mock('./VNextMeriTopBar.js', () => ({ VNextMeriTopBar: () => null }));
vi.mock('./VNextMeriThreadRail.js', () => ({ VNextMeriThreadRail: () => null }));
vi.mock('./MeriContextSheet.js', () => ({ MeriContextSheet: () => null }));
vi.mock('./MeriCommandPalette.js', () => ({ MeriCommandPalette: () => null }));
vi.mock('./VNextMeriConversation.js', () => ({
  VNextMeriConversation: ({ onOpenTurnInspector }: { onOpenTurnInspector: (data: MeriTurnInspectorData, tab: 'thinking') => void }) => (
    <button onClick={() => onOpenTurnInspector({
      turnId: 'saved-turn',
      turnScope: { kind: 'client', clientId: 'l3', clientName: 'L3 Harris', targetHint: null },
      contextPacketId: 'original-packet',
      thinking: { plan: '', steps: [], intent: null, tier: null },
      evidence: { sources: [], verifyStats: [], claims: [], groundingCaveat: null, retrieval: null }, approvals: [],
    }, 'thinking')}>Open saved work</button>
  ),
}));
vi.mock('./VNextMeriContextRail.js', () => ({
  VNextMeriContextRail: ({ activeTurnInspector }: { activeTurnInspector: { data: MeriTurnInspectorData } | null }) => activeTurnInspector ? (
    <div aria-label="Pinned inspector">
      <span>{activeTurnInspector.data.thinking.runtimeStatus?.lifecycle ?? 'unknown'}</span>
      <span>{activeTurnInspector.data.turnScope?.kind === 'client' ? activeTurnInspector.data.turnScope.clientName : 'unknown scope'}</span>
      <span>{activeTurnInspector.data.contextPacketId}</span>
    </div>
  ) : null,
}));

import { VNextMeriShell } from './VNextMeriShell.js';

describe('pinned inspector rehydration', () => {
  it('reconciles the exact saved turn outcome without borrowing the current turn or client picker', async () => {
    const messages: ChatMessage[] = [{ id: 'saved-turn', role: 'assistant', content: 'Saved answer', createdAt: new Date() }];
    const base = {
      controller: { activeConversationId: 'conversation', messages, pendingApprovals: [], selectedClientValue: 'anduril' } as unknown as MeriChatController,
      historyError: null, onRetryHistory: vi.fn(), onArchiveThread: vi.fn(), onRenameThread: vi.fn(), onRestoreThread: vi.fn(),
    };
    const view = render(<VNextMeriShell {...base} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Open saved work' }));
    expect(screen.getByLabelText('Pinned inspector')).toHaveTextContent('unknown');
    for (const [finishReason, label] of [['stop', 'completed'], ['aborted', 'stopped'], ['error', 'failed']]) {
      view.rerender(<VNextMeriShell {...base} controller={{ ...base.controller, messages: [
        { ...messages[0]!, runtimeStatus: meriRuntimeStatus({ finishReason }) },
        { id: 'other-turn', role: 'assistant', content: '', createdAt: new Date(), runtimeStatus: meriRuntimeStatus({ type: 'start' }) },
      ] }} />);
      expect(screen.getByLabelText('Pinned inspector')).toHaveTextContent(label!);
      expect(screen.getByLabelText('Pinned inspector')).toHaveTextContent('L3 Harris');
      expect(screen.getByLabelText('Pinned inspector')).toHaveTextContent('original-packet');
      expect(screen.getByLabelText('Pinned inspector')).not.toHaveTextContent('running');
    }
  });
});
