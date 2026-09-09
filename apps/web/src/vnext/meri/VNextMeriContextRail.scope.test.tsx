import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { mapPersistedTurnScope } from './meri-route-state.js';
import type { MeriContextPacket } from './meri-vnext-api.js';
import type { ActiveTurnInspector } from './VNextMeriContextRail.js';

const mocks = vi.hoisted(() => ({ api: {}, latest: vi.fn(), byId: vi.fn() }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
vi.mock('./meri-vnext-api.js', () => ({
  fetchLatestMeriContextPacket: mocks.latest, fetchMeriContextPacket: mocks.byId,
}));
vi.mock('./MeriMemoryTab.js', () => ({
  MeriMemoryTab: () => null, useMeriGovernedMemoryQueues: () => ({ reviewCount: 0, pendingProposalCount: 0 }),
}));
vi.mock('./MeriArtifactCanvas.js', () => ({ MeriArtifactCanvas: () => null }));
vi.mock('./MeriTurnInspector.js', () => ({ MeriTurnInspector: () => <div>Turn contents</div> }));
vi.mock('./meri-icons.js', () => ({ MeriIcon: () => null }));

import { VNextMeriContextRail } from './VNextMeriContextRail.js';

const clients = [{ id: 'l3', name: 'L3 Harris' }, { id: 'anduril', name: 'Anduril' }];
const citations = [
  { n: 1, id: 'doc-a', title: 'First evidence', type: 'document', tool: 'read_client_documents', url: null, snippet: 'First excerpt' },
  { n: 2, id: 'doc-b', title: 'Second evidence', type: 'document', tool: 'read_client_documents', url: null, snippet: 'Second excerpt' },
];
const packet: MeriContextPacket = {
  packetId: 'packet-l3', clientId: 'l3', persisted: true, persistenceErrorCode: null,
  surface: 'chat', items: [], exclusions: [], unauthorizedCount: 0, degraded: false,
};
function props(selectedClientValue = 'l3') {
  return {
    controller: { selectedClientValue, clients, activeConversationId: 'thread', stagedAttachments: [], messages: [], isStreaming: false } as unknown as MeriChatController,
    collapsed: false, openSection: 'context' as const, onToggle: vi.fn(), onExpandSection: vi.fn(), onOpenContext: vi.fn(),
    activeSourceDetail: null, onCloseSourceDetail: vi.fn(), activeArtifact: null, onCloseArtifact: vi.fn(),
  };
}
beforeEach(() => {
  mocks.latest.mockReset().mockResolvedValue(packet);
  mocks.byId.mockReset().mockResolvedValue(packet);
});

describe('historical Meri source, inspector and packet scope', () => {
  test.each(['l3', 'anduril'])('pins a reloaded %s turn while picker cycles clients and portfolio', async (clientId) => {
    // This is the same legacy metadata shape returned by the history endpoint.
    const turnScope = mapPersistedTurnScope(JSON.parse(JSON.stringify({ clientId, metadata: {
      retrieval: { plan: { subjectScope: 'client' } }, contextPacket: { clientId },
    } })));
    const detail = { citations, index: 0, turnScope };
    const { rerender } = render(<VNextMeriContextRail {...props(clientId)} activeSourceDetail={detail} />);
    const expected = clients.find((client) => client.id === clientId)!.name;
    for (const selected of ['l3', 'anduril', '', 'l3']) {
      rerender(<VNextMeriContextRail {...props(selected)} activeSourceDetail={detail} />);
      expect(screen.getByText('TURN SCOPE')).toBeInTheDocument();
      expect(screen.getByText(expected)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Next source' }));
    expect(screen.getByText('Second evidence')).toBeInTheDocument();
    expect(screen.getByText(expected)).toBeInTheDocument();
    rerender(<VNextMeriContextRail {...props('anduril')} activeSourceDetail={null} />);
    rerender(<VNextMeriContextRail {...props('anduril')} activeSourceDetail={detail} />);
    expect(screen.getByText('First evidence')).toBeInTheDocument();
    expect(screen.getByText(expected)).toBeInTheDocument();
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled());
  });

  test('keeps old unknown sources unknown instead of adopting the picker', async () => {
    const { rerender } = render(<VNextMeriContextRail {...props('l3')} activeSourceDetail={{ citations, index: 0 }} />);
    expect(screen.getByText('Scope not recorded')).toBeInTheDocument();
    rerender(<VNextMeriContextRail {...props('anduril')} activeSourceDetail={{ citations, index: 0 }} />);
    expect(screen.getByText('Scope not recorded')).toBeInTheDocument();
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled());
  });

  test('opens the inspected turn’s persisted packet and preserves external scope under another picker', async () => {
    const turnPacket = { ...packet, packetId: 'older-packet', clientId: null };
    mocks.byId.mockResolvedValue(turnPacket);
    const inspector = { activeTab: 'thinking', data: {
      turnId: 'older-turn', contextPacketId: 'older-packet',
      turnScope: { kind: 'external_entity', targetHint: 'Anduril', clientId: null, clientName: null },
      evidence: { sources: [] }, approvals: [], thinking: {},
    }, approvingProposalId: null, onApprove: vi.fn(), onApproveAll: vi.fn(), onDismiss: vi.fn() } as unknown as ActiveTurnInspector;
    const base = props('l3');
    const { rerender } = render(<VNextMeriContextRail {...base} activeTurnInspector={inspector} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open this turn’s context packet' })).toBeEnabled());
    expect(mocks.byId).toHaveBeenCalledWith(mocks.api, 'older-packet');
    expect(screen.getByText('EXTERNAL SUBJECT · ANDURIL')).toBeInTheDocument();
    rerender(<VNextMeriContextRail {...base} controller={{ ...base.controller, selectedClientValue: '' }} activeTurnInspector={inspector} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open this turn’s context packet' }));
    expect(base.onOpenContext).toHaveBeenCalledWith(turnPacket, false, false);
    expect(screen.getByText('EXTERNAL SUBJECT · ANDURIL')).toBeInTheDocument();
    rerender(<VNextMeriContextRail {...base} activeTurnInspector={{ ...inspector, data: { ...inspector.data, contextPacketId: undefined, turnScope: undefined } }} />);
    expect(screen.getByRole('button', { name: 'Open this turn’s context packet' })).toBeDisabled();
    expect(screen.getByText('SCOPE NOT RECORDED')).toBeInTheDocument();
  });

  test('does not replace turn B with a late packet response for turn A', async () => {
    let resolveA!: (value: MeriContextPacket) => void;
    let resolveB!: (value: MeriContextPacket) => void;
    mocks.byId.mockImplementation((_api, id) => new Promise<MeriContextPacket>((resolve) => {
      if (id === 'packet-a') resolveA = resolve;
      else if (id === 'packet-b') resolveB = resolve;
    }));
    const makeInspector = (clientId: string, packetId: string) => ({ activeTab: 'thinking', data: {
      turnId: packetId, contextPacketId: packetId,
      turnScope: { kind: 'client', clientId, clientName: null, targetHint: null },
      evidence: { sources: [] }, approvals: [], thinking: {},
    }, approvingProposalId: null, onApprove: vi.fn(), onApproveAll: vi.fn(), onDismiss: vi.fn() } as unknown as ActiveTurnInspector);
    const base = props('l3');
    const { rerender } = render(<VNextMeriContextRail {...base} activeTurnInspector={makeInspector('l3', 'packet-a')} />);
    rerender(<VNextMeriContextRail {...base} activeTurnInspector={makeInspector('anduril', 'packet-b')} />);
    const packetB = { ...packet, packetId: 'packet-b', clientId: 'anduril' };
    await act(async () => resolveB(packetB));
    await act(async () => resolveA({ ...packet, packetId: 'packet-a' }));
    expect(screen.getByText('ANDURIL')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open this turn’s context packet' }));
    expect(base.onOpenContext).toHaveBeenCalledWith(packetB, false, false);
  });

  test('labels latest context from its packet and clears it while another conversation loads', async () => {
    const base = props('anduril');
    const { rerender } = render(<VNextMeriContextRail {...base} />);
    await waitFor(() => expect(screen.getByText('L3 HARRIS')).toBeInTheDocument());
    let resolveNext!: (value: MeriContextPacket) => void;
    mocks.latest.mockImplementationOnce(() => new Promise<MeriContextPacket>((resolve) => { resolveNext = resolve; }));
    rerender(<VNextMeriContextRail {...base} controller={{ ...base.controller, activeConversationId: 'new-thread' }} />);
    expect(screen.queryByText('L3 HARRIS')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open context packet' })).toBeDisabled();
    expect(base.onOpenContext).not.toHaveBeenCalled();
    await act(async () => resolveNext({ ...packet, packetId: 'anduril-packet', clientId: 'anduril' }));
    expect(screen.getByText('ANDURIL')).toBeInTheDocument();
  });
});
