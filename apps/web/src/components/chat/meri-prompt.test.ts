import { beforeEach, describe, expect, test, vi } from 'vitest';

const { clearChatSession, setActiveConversation, setChatOpen, setGlobalClientFilter } = vi.hoisted(() => ({
  clearChatSession: vi.fn(),
  setActiveConversation: vi.fn(),
  setChatOpen: vi.fn(),
  setGlobalClientFilter: vi.fn(),
}));

vi.mock('./chat-store.js', () => ({
  clearChatSession,
  setActiveConversation,
  setChatOpen,
}));
vi.mock('../../state/client-filter.js', () => ({ setGlobalClientFilter }));

import { MERI_CONTEXT_PROMPT_EVENT, requestMeriContextPrompt } from './meri-prompt.js';

describe('requestMeriContextPrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  test('scopes the client, starts a fresh session, opens Meri and dispatches the prompt', () => {
    const received: string[] = [];
    const listener = (event: Event) => {
      received.push((event as CustomEvent<{ prompt: string }>).detail.prompt);
    };
    window.addEventListener(MERI_CONTEXT_PROMPT_EVENT, listener);

    requestMeriContextPrompt({ clientId: 'client-1', prompt: '  Review this opportunity.  ' });
    expect(setGlobalClientFilter).toHaveBeenCalledWith('client-1');
    expect(clearChatSession).toHaveBeenCalledTimes(1);
    expect(setActiveConversation).toHaveBeenCalledWith(null);
    expect(setChatOpen).toHaveBeenCalledWith(true);
    expect(received).toEqual([]);

    vi.runAllTimers();
    expect(received).toEqual(['Review this opportunity.']);
    window.removeEventListener(MERI_CONTEXT_PROMPT_EVENT, listener);
  });
});
