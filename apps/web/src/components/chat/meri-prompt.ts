import { clearChatSession, setActiveConversation, setChatOpen } from './chat-store.js';
import { setGlobalClientFilter } from '../../state/client-filter.js';

export const MERI_CONTEXT_PROMPT_EVENT = 'capiro:meri-context-prompt';

export interface MeriContextPromptRequest {
  prompt: string;
  clientId?: string | null;
  /**
   * Phase 4 prospect-scoped launch. When set, the Meri controller creates
   * the fresh durable conversation with { prospectId, title } — never a
   * client scope — before sending the prompt. Only the prospect id travels
   * from the browser; every other prospect scope field is server-resolved.
   */
  prospectId?: string;
  newSession?: boolean;
}

// Phase 4 prospect launches must not inherit an arbitrary global client
// filter: the server resolves/authorizes any confirmed linked client from
// the prospectId alone. A client-scoped request keeps its current meaning.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fixed, generic title — never a firm/prospect/provider fact from the browser. */
export const MERI_PROSPECT_LAUNCH_TITLE = 'Opportunity brief';

/** Validate and normalize a client-supplied prospect scope id; else null. */
export function normalizeMeriProspectId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
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
  const prospectWasRequested = request.prospectId !== undefined;
  const prospectId = normalizeMeriProspectId(request.prospectId);
  // A prospect launch carries only a bare UUID. A malformed explicit scope
  // fails closed before opening Meri or dispatching a prompt into an ordinary
  // conversation.
  if (prospectWasRequested && !prospectId) return;
  if (prospectId) {
    // Prospect launch: fresh, durable, prospect-scoped session. Clear the
    // global client filter so the session never inherits an arbitrary client
    // scope — the server resolves/authorizes any confirmed linked client.
    setGlobalClientFilter(null);
    // Prospect launches are always fresh even if a caller tries to opt out,
    // and their event is dispatched synchronously while the JS stack still
    // owns the reset. This lets the already-mounted controller bind its
    // one-shot prospect ref before React's create-on-open effect can run.
    clearChatSession();
    setActiveConversation(null);
    setChatOpen(true);
    window.dispatchEvent(
      new CustomEvent<MeriContextPromptRequest>(MERI_CONTEXT_PROMPT_EVENT, {
        detail: { prompt, prospectId },
      }),
    );
    return;
  }

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
