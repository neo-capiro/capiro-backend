import { beforeEach, describe, expect, test } from 'vitest';
import {
  appendChatMessage,
  claimMeriIdentity,
  getChatStateSnapshot,
  replaceChatMessageId,
  resetChatStoreForTests,
  setActiveConversation,
  setAlerts,
  setChatMessageCitations,
  setChatMessageFeedback,
  setChatOpen,
  setChatSession,
  setConversations,
  setStreaming,
  setMeriMaximized,
  setMeriSideCollapsed,
  setMeriSurfaceMode,
  toggleChat,
} from './chat-store.js';

describe('Meri surface state transitions', () => {
  beforeEach(() => resetChatStoreForTests());

  test('preserves setChatOpen compatibility', () => {
    setChatOpen(true);
    expect(getChatStateSnapshot()).toMatchObject({ isOpen: true, surfaceMode: 'docked' });
    setChatOpen(false);
    expect(getChatStateSnapshot()).toMatchObject({ isOpen: false, surfaceMode: 'closed' });
  });

  test('toggle opens docked and closes either open surface', () => {
    toggleChat();
    expect(getChatStateSnapshot().surfaceMode).toBe('docked');
    setMeriSurfaceMode('undocked');
    toggleChat();
    expect(getChatStateSnapshot()).toMatchObject({ isOpen: false, surfaceMode: 'closed' });
  });

  test('redocking clears maximized but preserves sidebar preference', () => {
    setMeriSurfaceMode('undocked');
    setMeriMaximized(true);
    setMeriSideCollapsed(true);
    setMeriSurfaceMode('docked');
    expect(getChatStateSnapshot()).toMatchObject({
      surfaceMode: 'docked',
      maximized: false,
      sideCollapsed: true,
    });
  });

  test('clears the shared transcript, rail, and alerts on an effective identity switch', () => {
    claimMeriIdentity('tenant-a:user-a');
    setChatOpen(true);
    setChatSession('thread-a');
    setActiveConversation('thread-a');
    setConversations([
      {
        id: 'thread-a',
        title: 'Tenant A thread',
        clientId: null,
        client: null,
        latestMessage: null,
        updatedAt: '2026-08-17T00:00:00.000Z',
      },
    ]);
    appendChatMessage({
      id: 'message-a',
      role: 'assistant',
      content: 'Tenant A only',
      createdAt: new Date('2026-08-17T00:00:00.000Z'),
    });
    setAlerts([
      { id: 'alert-a', status: 'pending', title: 'Tenant A briefing', body: 'Tenant A only' },
    ] as unknown as Parameters<typeof setAlerts>[0]);
    setStreaming(true);

    expect(claimMeriIdentity('tenant-b:user-a')).toBe(true);
    expect(getChatStateSnapshot()).toMatchObject({
      isOpen: false,
      surfaceMode: 'closed',
      sessionId: null,
      activeConversationId: null,
      messages: [],
      conversations: [],
      alerts: [],
      isStreaming: false,
    });
  });

  test('the first claim on a cold store takes ownership without clearing', () => {
    // Only Meri surfaces write here and each claims before it writes, so an
    // unclaimed store holds nothing from another identity. Clearing would
    // instead destroy the session the claiming surface just seeded.
    setChatSession('thread-a');
    setActiveConversation('thread-a');

    expect(claimMeriIdentity('tenant-a:user-a')).toBe(false);
    expect(getChatStateSnapshot()).toMatchObject({
      sessionId: 'thread-a',
      activeConversationId: 'thread-a',
    });
  });

  test('re-claiming the same identity is a no-op that preserves live state', () => {
    claimMeriIdentity('tenant-a:user-a');
    setChatSession('thread-a');
    setActiveConversation('thread-a');
    appendChatMessage({
      id: 'message-a',
      role: 'assistant',
      content: 'Tenant A only',
      createdAt: new Date('2026-08-17T00:00:00.000Z'),
    });

    // A second Meri surface mounting under the same identity must not wipe the
    // transcript the first one is showing.
    expect(claimMeriIdentity('tenant-a:user-a')).toBe(false);
    expect(getChatStateSnapshot()).toMatchObject({
      sessionId: 'thread-a',
      activeConversationId: 'thread-a',
      messages: [expect.objectContaining({ id: 'message-a' })],
    });
  });
});

// Phase 27 post-launch P1: the SSE `done` frame reconciles a freshly-streamed
// assistant message's client-generated optimistic id with the real
// `clio_messages.id` the server persisted it under. replaceChatMessageId is
// the primitive that does that swap without losing anything else already
// attached to the message.
describe('replaceChatMessageId (Meri feedback identity reconciliation)', () => {
  beforeEach(() => resetChatStoreForTests());

  test('renames the message id in place, preserving every other field', () => {
    appendChatMessage({
      id: 'optimistic-abc123',
      role: 'assistant',
      content: 'The answer is 42.',
      createdAt: new Date('2026-08-22T00:00:00.000Z'),
    });
    setChatMessageCitations('optimistic-abc123', [
      { n: 1, type: 'bill', id: 'hr-1', title: 'H.R. 1', url: null, snippet: null, tool: 'bills' },
    ]);

    replaceChatMessageId('optimistic-abc123', 'server-msg-42');

    const { messages } = getChatStateSnapshot();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'server-msg-42',
      content: 'The answer is 42.',
      citations: [expect.objectContaining({ id: 'hr-1' })],
    });
  });

  test('is a no-op when old and new ids are identical', () => {
    appendChatMessage({
      id: 'server-msg-1',
      role: 'assistant',
      content: 'Already canonical.',
      createdAt: new Date('2026-08-22T00:00:00.000Z'),
    });
    const before = getChatStateSnapshot().messages;
    replaceChatMessageId('server-msg-1', 'server-msg-1');
    expect(getChatStateSnapshot().messages).toBe(before);
  });

  test('does not touch other messages, including ones that share no relation to the renamed id', () => {
    appendChatMessage({
      id: 'user-1',
      role: 'user',
      content: 'Question',
      createdAt: new Date('2026-08-22T00:00:00.000Z'),
    });
    appendChatMessage({
      id: 'optimistic-xyz',
      role: 'assistant',
      content: 'Answer',
      createdAt: new Date('2026-08-22T00:00:01.000Z'),
    });

    replaceChatMessageId('optimistic-xyz', 'server-msg-99');

    const { messages } = getChatStateSnapshot();
    expect(messages[0]).toMatchObject({ id: 'user-1', content: 'Question' });
    expect(messages[1]).toMatchObject({ id: 'server-msg-99', content: 'Answer' });
  });

  test('silently no-ops when the old id is not found (nothing to reconcile)', () => {
    appendChatMessage({
      id: 'server-msg-1',
      role: 'assistant',
      content: 'Unrelated.',
      createdAt: new Date('2026-08-22T00:00:00.000Z'),
    });
    replaceChatMessageId('never-existed', 'server-msg-2');
    expect(getChatStateSnapshot().messages).toMatchObject([{ id: 'server-msg-1' }]);
  });

  test('feedback already set before reconciliation survives the rename', () => {
    appendChatMessage({
      id: 'optimistic-1',
      role: 'assistant',
      content: 'Rated before reconciliation.',
      createdAt: new Date('2026-08-22T00:00:00.000Z'),
    });
    setChatMessageFeedback('optimistic-1', 'up');
    replaceChatMessageId('optimistic-1', 'server-msg-7');
    expect(getChatStateSnapshot().messages[0]).toMatchObject({
      id: 'server-msg-7',
      feedback: 'up',
    });
  });
});
