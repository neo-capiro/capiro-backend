import { beforeEach, describe, expect, test } from 'vitest';
import {
  getChatStateSnapshot,
  resetChatStoreForTests,
  setChatOpen,
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
});
