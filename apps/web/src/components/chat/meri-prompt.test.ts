import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { clearChatSession, setActiveConversation, setChatOpen, setGlobalClientFilter } = vi.hoisted(
  () => ({
    clearChatSession: vi.fn(),
    setActiveConversation: vi.fn(),
    setChatOpen: vi.fn(),
    setGlobalClientFilter: vi.fn(),
  }),
);

vi.mock('./chat-store.js', () => ({
  clearChatSession,
  setActiveConversation,
  setChatOpen,
}));
vi.mock('../../state/client-filter.js', () => ({ setGlobalClientFilter }));

import {
  MERI_CONTEXT_PROMPT_EVENT,
  normalizeMeriProspectId,
  requestMeriContextPrompt,
  type MeriContextPromptRequest,
} from './meri-prompt.js';

const PROSPECT_UUID = '11111111-1111-4111-8111-111111111111';

describe('requestMeriContextPrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  test('existing client-scoped contextual launch stays green: no prospect staging, prompt dispatched unchanged', () => {
    const details: MeriContextPromptRequest[] = [];
    const listener = (event: Event) => {
      details.push((event as CustomEvent<MeriContextPromptRequest>).detail);
    };
    window.addEventListener(MERI_CONTEXT_PROMPT_EVENT, listener);

    requestMeriContextPrompt({ clientId: 'client-1', prompt: 'Summarize the client plan.' });
    vi.runAllTimers();
    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({ prompt: 'Summarize the client plan.', clientId: 'client-1' });
    window.removeEventListener(MERI_CONTEXT_PROMPT_EVENT, listener);
  });

  test('a prospect launch resets the session, clears the client filter, and dispatches a sanitized scope', () => {
    const details: MeriContextPromptRequest[] = [];
    const listener = (event: Event) => {
      details.push((event as CustomEvent<MeriContextPromptRequest>).detail);
    };
    window.addEventListener(MERI_CONTEXT_PROMPT_EVENT, listener);

    requestMeriContextPrompt({
      prompt: 'Prepare the brief.',
      prospectId: PROSPECT_UUID,
      clientId: 'must-not-leak',
      newSession: false,
    });
    // Client filter is cleared BEFORE anything else, so the new session can
    // never inherit an arbitrary global client scope.
    expect(setGlobalClientFilter).toHaveBeenCalledWith(null);
    expect(clearChatSession).toHaveBeenCalledTimes(1);
    expect(setActiveConversation).toHaveBeenCalledWith(null);
    expect(setChatOpen).toHaveBeenCalledWith(true);

    expect(details).toHaveLength(1);
    expect(details[0]).toEqual({ prompt: 'Prepare the brief.', prospectId: PROSPECT_UUID });
    expect(setGlobalClientFilter).toHaveBeenCalledTimes(1);
    window.removeEventListener(MERI_CONTEXT_PROMPT_EVENT, listener);
  });

  test('a non-UUID prospectId fails closed without opening or dispatching', () => {
    const received: MeriContextPromptRequest[] = [];
    const listener = (event: Event) =>
      received.push((event as CustomEvent<MeriContextPromptRequest>).detail);
    window.addEventListener(MERI_CONTEXT_PROMPT_EVENT, listener);
    requestMeriContextPrompt({ prompt: 'Prepare the brief.', prospectId: 'not-a-uuid' });
    vi.runAllTimers();
    expect(received).toEqual([]);
    expect(setGlobalClientFilter).not.toHaveBeenCalled();
    expect(clearChatSession).not.toHaveBeenCalled();
    expect(setChatOpen).not.toHaveBeenCalled();
    window.removeEventListener(MERI_CONTEXT_PROMPT_EVENT, listener);
  });
});

describe('prospect launch validation', () => {
  test('normalizeMeriProspectId accepts bare UUIDs only', () => {
    expect(normalizeMeriProspectId(PROSPECT_UUID)).toBe(PROSPECT_UUID);
    expect(normalizeMeriProspectId(` ${PROSPECT_UUID} `)).toBe(PROSPECT_UUID);
    expect(normalizeMeriProspectId('nope')).toBeNull();
    expect(normalizeMeriProspectId(null)).toBeNull();
    expect(normalizeMeriProspectId(undefined)).toBeNull();
    expect(normalizeMeriProspectId(12345)).toBeNull();
  });
});
