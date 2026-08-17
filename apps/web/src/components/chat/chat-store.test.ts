import { beforeEach, describe, expect, test } from 'vitest';
import {
  appendChatMessage,
  claimMeriIdentity,
  getChatStateSnapshot,
  resetChatStoreForTests,
  setActiveConversation,
  setAlerts,
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
