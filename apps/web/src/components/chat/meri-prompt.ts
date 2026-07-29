import {
  clearChatSession,
  setActiveConversation,
  setChatOpen,
} from './chat-store.js';
import { setGlobalClientFilter } from '../../state/client-filter.js';

export const MERI_CONTEXT_PROMPT_EVENT = 'capiro:meri-context-prompt';

export interface MeriContextPromptRequest {
  prompt: string;
  clientId?: string | null;
  newSession?: boolean;
}

/**
 * Open global Meri with a source-backed prompt from another product surface.
 *
 * Client scope and session reset happen before the event is dispatched. The
 * short timer lets AppShell and the chat controller observe the new client
 * filter before `sendMessage` creates the conversation, preventing a prompt
 * about client A from being attached to client B's prior session.
 */
export function requestMeriContextPrompt(request: MeriContextPromptRequest): void {
  const prompt = request.prompt.trim();
  if (!prompt) return;
  if (request.clientId !== undefined) setGlobalClientFilter(request.clientId ?? null);
  if (request.newSession !== false) {
    clearChatSession();
    setActiveConversation(null);
  }
  setChatOpen(true);
  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent<MeriContextPromptRequest>(MERI_CONTEXT_PROMPT_EVENT, {
        detail: { ...request, prompt },
      }),
    );
  }, 0);
}
