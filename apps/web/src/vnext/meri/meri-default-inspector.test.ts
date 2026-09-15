import { describe, expect, test, vi } from 'vitest';
import type { ChatMessage } from '../../components/chat/chat-store.js';
import type { PendingApproval } from '../../components/chat/useMeriChatController.js';
import {
  buildDefaultTurnInspector,
  latestAssistantMessage,
  type MeriDefaultInspectorSource,
} from './meri-default-inspector.js';

function assistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'a1', role: 'assistant', content: 'Answer', createdAt: new Date(), ...overrides };
}
function user(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'u1', role: 'user', content: 'Question', createdAt: new Date(), ...overrides };
}
function approval(status: PendingApproval['status'] = 'proposed'): PendingApproval {
  return { proposalId: 'p1', status } as unknown as PendingApproval;
}
function source(overrides: Partial<MeriDefaultInspectorSource> = {}): MeriDefaultInspectorSource {
  return {
    messages: [],
    isStreaming: false,
    planSteps: [],
    trustSteps: [],
    orchestratorIntent: null,
    orchestratorTier: null,
    pendingApprovals: [],
    ...overrides,
  };
}

describe('latestAssistantMessage', () => {
  test('returns the last assistant turn, skipping trailing user turns', () => {
    const messages = [assistant({ id: 'a1' }), user({ id: 'u2' }), assistant({ id: 'a3' }), user({ id: 'u4' })];
    expect(latestAssistantMessage(messages)?.id).toBe('a3');
  });
  test('returns null when there is no assistant turn', () => {
    expect(latestAssistantMessage([user()])).toBeNull();
    expect(latestAssistantMessage([])).toBeNull();
  });
});

describe('buildDefaultTurnInspector', () => {
  test('uses the latest assistant turn saved thinking/evidence (real data)', () => {
    const turn = assistant({
      id: 'saved',
      planSteps: ['Verify the figure.', 'Draft the memo.'],
      trustSteps: [{ tool: 'read_client_documents', label: 'Read 5 compiled context items', status: 'done' } as never],
      orchestratorIntent: 'draft_document',
      orchestratorTier: 'deep',
      citations: [{ n: 1, id: 'd1', title: 'HAC-D report', type: 'document', tool: 'read_client_documents', url: null, snippet: 'excerpt' }],
      verification: { claims: [{ claim: 'Marked at $210.2M', supported: true, sourceIds: [1] }], totalCount: 1, unsupportedCount: 0, unsupportedRatio: 0, lowConfidence: false },
      contextPacketId: 'packet-1',
      turnScope: { kind: 'client', clientId: 'l3', clientName: 'L3 Harris', targetHint: null },
    });
    const result = buildDefaultTurnInspector(source({ messages: [user(), turn] }));
    expect(result.turnId).toBe('saved');
    expect(result.thinking.plan).toBe('Verify the figure. Draft the memo.');
    expect(result.thinking.steps).toHaveLength(1);
    expect(result.thinking.intent).toBe('draft_document');
    expect(result.thinking.tier).toBe('deep');
    expect(result.evidence.sources).toHaveLength(1);
    expect(result.evidence.sources[0]!.title).toBe('HAC-D report');
    expect(result.evidence.verifyStats[0]!.label).toBe('CLAIMS CHECKED · 1');
    expect(result.contextPacketId).toBe('packet-1');
    expect(result.turnScope?.kind).toBe('client');
  });

  test('streaming latest turn reads controller transient state, not stale saved fields', () => {
    const streaming = assistant({ id: 'live', planSteps: ['OLD SAVED'], orchestratorIntent: 'old' });
    const result = buildDefaultTurnInspector(source({
      messages: [user(), streaming],
      isStreaming: true,
      planSteps: ['Live plan step'],
      trustSteps: [{ tool: 'search', label: 'Searching', status: 'running' } as never],
      orchestratorIntent: 'research',
      orchestratorTier: 'fast',
    }));
    expect(result.turnId).toBe('live');
    expect(result.thinking.plan).toBe('Live plan step');
    expect(result.thinking.intent).toBe('research');
    expect(result.thinking.tier).toBe('fast');
    expect(result.thinking.steps[0]!.status).toBe('running');
  });

  test('does NOT pin transient new-turn work onto the previous assistant when the last message is a user turn', () => {
    const completed = assistant({ id: 'done', planSteps: ['Saved plan'], orchestratorIntent: 'saved_intent' });
    // User just asked a fresh question; its assistant row has not streamed yet.
    const result = buildDefaultTurnInspector(source({
      messages: [completed, user({ id: 'u-new' })],
      isStreaming: true, // controller is mid-flight for the NEW turn
      planSteps: ['NEW transient plan'],
      orchestratorIntent: 'new_intent',
    }));
    // Shows the completed turn's saved data, not the in-flight new turn's.
    expect(result.turnId).toBe('done');
    expect(result.thinking.plan).toBe('Saved plan');
    expect(result.thinking.intent).toBe('saved_intent');
  });

  test('empty/new thread still returns an inspector with honest empty tabs and conversation approvals', () => {
    const approvals = [approval('proposed')];
    const result = buildDefaultTurnInspector(source({ messages: [], pendingApprovals: approvals }));
    expect(result.turnId).toBe('conversation-default');
    expect(result.thinking.plan).toBe('');
    expect(result.thinking.steps).toEqual([]);
    expect(result.evidence.sources).toEqual([]);
    // Approvals are conversation-level and still surface (not turn-associated).
    expect(result.approvals).toBe(approvals);
  });

  test('default source opens the source UI with the turn scope and citation index', () => {
    const open = vi.fn();
    const turn = assistant({
      id: 'src',
      citations: [
        { n: 1, id: 'd1', title: 'First', type: 'document', tool: 'read_client_documents', url: null, snippet: null },
        { n: 2, id: 'd2', title: 'Second', type: 'document', tool: 'read_client_documents', url: null, snippet: null },
      ],
      turnScope: { kind: 'client', clientId: 'l3', clientName: 'L3 Harris', targetHint: null },
    });
    const result = buildDefaultTurnInspector(source({ messages: [turn] }), open);
    result.evidence.onOpenSource?.(result.evidence.sources[1]!, 1);
    expect(open).toHaveBeenCalledTimes(1);
    const [citations, index, message] = open.mock.calls[0]!;
    expect(citations).toHaveLength(2);
    expect(index).toBe(1);
    expect(message.id).toBe('src');
  });
});
