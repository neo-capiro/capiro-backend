import { useEffect, useState } from 'react';
import type { MeriRect } from './meri-geometry.js';
import type { TrustStep } from './WorkPerformed.js';

export type MeriSurfaceMode = 'closed' | 'docked' | 'undocked';

export interface MeriCitation {
  n: number;
  type: string;
  id: string;
  title: string;
  url: string | null;
  snippet: string | null;
  tool: string;
}

export interface VerifiedClaim {
  claim: string;
  supported: boolean;
  sourceIds: number[];
}

export interface MeriVerification {
  claims: VerifiedClaim[];
  totalCount: number;
  unsupportedCount: number;
  unsupportedRatio: number;
  lowConfidence: boolean;
  confidence?: { level: 'high' | 'medium' | 'low' | 'unknown'; label: string };
}

/**
 * Chat enforce-gate (non-blocking): the post-hoc grounding auditor flagged
 * HIGH/CRITICAL issues in a reply that was already streamed (chat can't withhold
 * per ADR-2), so the user sees this caveat instead of the reply being held.
 */
export interface GroundingCaveat {
  topSeverity: string | null;
  findings: Array<{ check: string; severity: string; detail: string }>;
}

/** File chip attached to a (user) message — mirrors message metadata.attachments. */
export interface ChatMessageAttachment {
  id: string;
  filename: string;
  kind: string;
  status: string;
  /**
   * The upload endpoint already returns these; carried through so the v4
   * attachment chip can show real page/character counts instead of only the
   * status. Optional because they weren't tracked on this type before.
   */
  pages?: number | null;
  chars?: number;
}

/**
 * Inline analysis chart (F4) attached to an assistant message. The PNG body
 * is fetched lazily from GET /api/clio/artifacts/:id/image by the card.
 */
export interface ChatMessageChartArtifact {
  id: string;
  title: string;
}

/**
 * Retrieval plan metadata attached to a finished assistant message by the
 * SSE `done` frame. Only the fields the scope label and coverage indicator
 * need are stored here — the full frame (domains, timeWindow, toolsInvoked,
 * …) is typed on the SseEvent side and stays optional end-to-end so legacy
 * turns without retrieval still render.
 */
export interface ChatMessageRetrieval {
  plan: {
    subjectScope: string;
    targetHint: string | null;
    recipeTool: string | null;
    queryClass: string;
    /**
     * These three were already sent by the server's RetrievalFrame and simply
     * discarded here until the v4 coverage warning needed them. Optional
     * because legacy turns (and the older narrow shape this type used to
     * declare) may not carry them.
     */
    requireCompleteCoverage?: boolean;
    requiredDomains?: string[];
    timeWindow?: { expression: string; withinDays: number } | null;
  };
  coverage: {
    complete: boolean;
    stopReason: string;
    /** Same as above — real fields from RetrievalFrame, previously untyped. */
    searchedDomains?: string[];
    missingDomains?: string[];
    partialDomains?: string[];
    toolsInvoked?: string[];
  };
}

export interface ChatMessage {
  runtimeStatus?: import('./meri-runtime-status.js').MeriRuntimeStatus;
  /** Persisted Deep Research report; keeps export actions available on reload. */
  researchSessionId?: string;
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  citations?: MeriCitation[];
  verification?: MeriVerification;
  groundingCaveat?: GroundingCaveat;
  suggestions?: string[];
  feedback?: 'up' | 'down' | null;
  attachments?: ChatMessageAttachment[];
  chartArtifacts?: ChatMessageChartArtifact[];
  /** Server-computed grounding posture for this assistant turn. */
  groundingStatement?: string;
  /** Immutable server context packet that grounded this specific assistant turn. */
  contextPacketId?: string;
  /** Backend retrieval plan for this assistant turn (absent on legacy turns). */
  retrieval?: ChatMessageRetrieval;
  /**
   * "Work performed" data (Meri v6 thinking-persistence piece 1): the
   * orchestrator's classified intent/tier and the bounded plan/tool-use log
   * for this turn, persisted server-side (metadata.intent/tier/plan/trustSteps)
   * so it survives history replay instead of only living for the newest
   * message. Undefined on turns persisted before this shipped — treat as "no
   * Thinking data for this older turn", not an error. Never raw extended
   * thinking/chain-of-thought text — that is deliberately kept out of browser
   * state entirely (see useMeriChatController.ts).
   */
  orchestratorIntent?: string | null;
  orchestratorTier?: 'fast' | 'deep' | null;
  planSteps?: string[];
  trustSteps?: TrustStep[];
}

export interface ActiveDraftContext {
  engagementId: string;
  recipientId?: string;
  subject: string;
  body: string;
}

export interface MeriAlert {
  id: string;
  alertType: string;
  title: string;
  body: string;
  priority: string;
  status: string;
  clientId: string | null;
  createdAt: string;
}

export interface MeriConversation {
  id: string;
  title: string;
  clientId: string | null;
  client: { id: string; name: string } | null;
  latestMessage: { body: string; createdAt: string } | null;
  updatedAt: string;
  workspaceId?: string | null;
  workspace?: { id: string; name: string; clientId: string | null } | null;
}

export interface MeriSourceAttribution {
  tool: string;
  count?: number;
  summary: string;
  confidence?: 'high' | 'medium' | 'low';
}

interface ChatState {
  isOpen: boolean;
  surfaceMode: MeriSurfaceMode;
  maximized: boolean;
  sideCollapsed: boolean;
  undockedRect: MeriRect | null;
  dragging: boolean;
  resizing: boolean;
  zOrder: number;
  messages: ChatMessage[];
  sessionId: string | null;
  isStreaming: boolean;
  conversations: MeriConversation[];
  activeConversationId: string | null;
  sessionRailOpen: boolean;
  alerts: MeriAlert[];
  alertsBadge: number;
}

const initialState: ChatState = {
  isOpen: false,
  surfaceMode: 'closed',
  maximized: false,
  sideCollapsed: false,
  undockedRect: null,
  dragging: false,
  resizing: false,
  zOrder: 1200,
  messages: [],
  sessionId: null,
  isStreaming: false,
  conversations: [],
  activeConversationId: null,
  sessionRailOpen: false,
  alerts: [],
  alertsBadge: 0,
};

let state: ChatState = { ...initialState };

let activeDraft: ActiveDraftContext | null = null;
let activeMeriIdentityKey: string | null = null;
let listeners: Array<() => void> = [];

function notify(): void {
  for (const l of listeners) l();
}

export function setChatOpen(open: boolean): void {
  state = {
    ...state,
    isOpen: open,
    surfaceMode: open ? 'docked' : 'closed',
    ...(open ? {} : { maximized: false, dragging: false, resizing: false }),
  };
  notify();
}

export function toggleChat(): void {
  const open = state.surfaceMode === 'closed';
  state = {
    ...state,
    isOpen: open,
    surfaceMode: open ? 'docked' : 'closed',
    ...(open ? {} : { maximized: false, dragging: false, resizing: false }),
  };
  notify();
}

export function setMeriSurfaceMode(surfaceMode: MeriSurfaceMode): void {
  state = {
    ...state,
    surfaceMode,
    isOpen: surfaceMode !== 'closed',
    ...(surfaceMode === 'docked' ? { maximized: false, dragging: false, resizing: false } : {}),
    ...(surfaceMode === 'closed' ? { maximized: false, dragging: false, resizing: false } : {}),
  };
  notify();
}

export function setMeriMaximized(maximized: boolean): void {
  state = { ...state, maximized, dragging: false, resizing: false };
  notify();
}

export function setMeriSideCollapsed(sideCollapsed: boolean): void {
  state = { ...state, sideCollapsed };
  notify();
}

export function setMeriUndockedRect(undockedRect: MeriRect): void {
  state = { ...state, undockedRect };
  notify();
}

export function setMeriPointerState(pointer: { dragging?: boolean; resizing?: boolean }): void {
  state = { ...state, ...pointer };
  notify();
}

export function raiseMeriSurface(): void {
  state = { ...state, zOrder: state.zOrder + 1 };
  notify();
}

export function setChatSession(sessionId: string | null): void {
  state = { ...state, sessionId };
  notify();
}

export function appendChatMessage(message: ChatMessage): void {
  state = { ...state, messages: [...state.messages, message] };
  notify();
}

export function updateChatMessage(id: string, content: string): void {
  const messages = state.messages.map((m) => (m.id === id ? { ...m, content } : m));
  state = { ...state, messages };
  notify();
}

export function setChatMessageCitations(id: string, citations: MeriCitation[]): void {
  const messages = state.messages.map((m) => (m.id === id ? { ...m, citations } : m));
  state = { ...state, messages };
  notify();
}

export function setChatMessageRuntimeStatus(id: string, runtimeStatus: import('./meri-runtime-status.js').MeriRuntimeStatus): void {
  state = { ...state, messages: state.messages.map((message) => message.id === id ? { ...message, runtimeStatus } : message) };
  notify();
}

export function setChatMessageVerification(id: string, verification: MeriVerification): void {
  const messages = state.messages.map((m) => (m.id === id ? { ...m, verification } : m));
  state = { ...state, messages };
  notify();
}

/**
 * Attach this turn's "work performed" data (Meri v6 thinking-persistence
 * piece 1) once the stream finishes — orchestrator intent/tier + the plan and
 * trust-step logs accumulated over the turn. Called from the controller's
 * `finally` block so it fires on every exit path (done, silent close, thrown
 * error, abort).
 */
export function setChatMessageThinking(
  id: string,
  thinking: Pick<ChatMessage, 'orchestratorIntent' | 'orchestratorTier' | 'planSteps' | 'trustSteps'>,
): void {
  const messages = state.messages.map((m) => (m.id === id ? { ...m, ...thinking } : m));
  state = { ...state, messages };
  notify();
}

export function setChatMessageGroundingCaveat(id: string, groundingCaveat: GroundingCaveat): void {
  const messages = state.messages.map((m) => (m.id === id ? { ...m, groundingCaveat } : m));
  state = { ...state, messages };
  notify();
}

export function setChatMessageGroundingStatement(id: string, groundingStatement: string): void {
  const messages = state.messages.map((m) => (m.id === id ? { ...m, groundingStatement } : m));
  state = { ...state, messages };
  notify();
}

/** Attach the immutable context packet identifier that grounded this assistant turn. */
export function setChatMessageContextPacketId(id: string, contextPacketId: string): void {
  const messages = state.messages.map((m) => (m.id === id ? { ...m, contextPacketId } : m));
  state = { ...state, messages };
  notify();
}

/**
 * Attach the backend retrieval plan (from the SSE `done` frame) to a finished
 * assistant message. Absent on legacy turns that don't forward retrieval
 * metadata, so callers must treat `message.retrieval` as optional.
 */
export function setChatMessageRetrieval(
  id: string,
  retrieval: ChatMessageRetrieval,
): void {
  const messages = state.messages.map((m) => (m.id === id ? { ...m, retrieval } : m));
  state = { ...state, messages };
  notify();
}

export function setChatMessageSuggestions(id: string, suggestions: string[]): void {
  const messages = state.messages.map((m) => (m.id === id ? { ...m, suggestions } : m));
  state = { ...state, messages };
  notify();
}

/**
 * Reconciles a streamed assistant message's client-generated optimistic id
 * with the real `clio_messages.id` the server persisted it under (from the
 * SSE `done` frame's `messageId`). Every other field on the message is kept
 * as-is — citations/verification/contextPacketId etc. are already stored ON
 * the message object, not in a side table keyed by id, so this rename is the
 * only reconciliation step needed for them. Callers that separately key
 * external state by the message id (e.g. useMeriChatController's
 * `researchOffers`) must migrate that key themselves.
 */
export function replaceChatMessageId(oldId: string, newId: string): void {
  if (oldId === newId) return;
  const messages = state.messages.map((m) => (m.id === oldId ? { ...m, id: newId } : m));
  state = { ...state, messages };
  notify();
}

export function setChatMessageFeedback(id: string, feedback: 'up' | 'down' | null): void {
  const messages = state.messages.map((m) => (m.id === id ? { ...m, feedback } : m));
  state = { ...state, messages };
  notify();
}

/** Append one analysis chart (F4) to a message — used as artifact SSE events stream in. */
export function addChatMessageChartArtifact(id: string, chart: ChatMessageChartArtifact): void {
  const messages = state.messages.map((m) =>
    m.id === id ? { ...m, chartArtifacts: [...(m.chartArtifacts ?? []), chart] } : m,
  );
  state = { ...state, messages };
  notify();
}

/** Drop every message after the one with `id` (used by regenerate / edit-and-resend). */
export function truncateMessagesAfter(id: string): void {
  const idx = state.messages.findIndex((m) => m.id === id);
  if (idx < 0) return;
  state = { ...state, messages: state.messages.slice(0, idx + 1) };
  notify();
}

export function setStreaming(streaming: boolean): void {
  state = { ...state, isStreaming: streaming };
  notify();
}

export function clearChatSession(): void {
  state = { ...state, messages: [], sessionId: null, isStreaming: false };
  notify();
}

/** Clears every tenant/user-owned value from the shared Meri store. */
function clearMeriIdentityState(): void {
  state = {
    ...state,
    isOpen: false,
    surfaceMode: 'closed',
    maximized: false,
    dragging: false,
    resizing: false,
    messages: [],
    sessionId: null,
    isStreaming: false,
    conversations: [],
    activeConversationId: null,
    alerts: [],
    alertsBadge: 0,
  };
  activeDraft = null;
  notify();
}

/**
 * The identity that currently owns the shared store, or null before any claim.
 *
 * Read this during render — claims happen in layout effects, so a render-time
 * read sees the owner as it stood before this commit's claims, whichever
 * surface's effect happens to run first.
 */
export function meriIdentityOwner(): string | null {
  return activeMeriIdentityKey;
}

/**
 * Claims the shared Meri store for the effective tenant/user identity, clearing
 * every tenant-private value when the claim displaces a DIFFERENT identity.
 * Returns true exactly when that clearing happened.
 *
 * The first claim on a cold store does not clear. Only Meri surfaces write
 * conversation state here and each one claims before it can write, so an
 * unclaimed store holds nothing belonging to another identity — while clearing
 * it would discard the state the mounting surface itself just seeded.
 */
export function claimMeriIdentity(identityKey: string): boolean {
  if (activeMeriIdentityKey === identityKey) return false;
  const displacedIdentityKey = activeMeriIdentityKey;
  activeMeriIdentityKey = identityKey;
  if (displacedIdentityKey === null) return false;
  clearMeriIdentityState();
  return true;
}

/**
 * Atomically clear messages AND set the new session id in a single store
 * update. This prevents a render where sessionId is null while isOpen is
 * true, which would trigger the controller's auto-create-session effect
 * and race with hydration (clearing the loaded messages).
 */
export function replaceChatSession(sessionId: string | null): void {
  state = { ...state, messages: [], sessionId, isStreaming: false };
  notify();
}

export function setActiveDraft(draft: ActiveDraftContext | null): void {
  activeDraft = draft;
}

export function getActiveDraft(): ActiveDraftContext | null {
  return activeDraft;
}

export function setConversations(conversations: MeriConversation[]): void {
  state = { ...state, conversations };
  notify();
}

export function upsertConversation(conversation: MeriConversation): void {
  const existing = state.conversations.find((c) => c.id === conversation.id);
  const conversations = existing
    ? state.conversations.map((c) => (c.id === conversation.id ? conversation : c))
    : [conversation, ...state.conversations];
  state = { ...state, conversations };
  notify();
}

export function removeConversation(conversationId: string): void {
  const conversations = state.conversations.filter((c) => c.id !== conversationId);
  const activeConversationId =
    state.activeConversationId === conversationId ? null : state.activeConversationId;
  const sessionId = state.sessionId === conversationId ? null : state.sessionId;
  const messages = state.activeConversationId === conversationId ? [] : state.messages;
  state = { ...state, conversations, activeConversationId, sessionId, messages };
  notify();
}

export function setActiveConversation(id: string | null): void {
  state = { ...state, activeConversationId: id };
  notify();
}

export function toggleSessionRail(): void {
  state = { ...state, sessionRailOpen: !state.sessionRailOpen };
  notify();
}

export function setAlerts(alerts: MeriAlert[]): void {
  state = { ...state, alerts, alertsBadge: alerts.filter((a) => a.status === 'pending').length };
  notify();
}

export function dismissAlert(id: string): void {
  // Remove the dismissed alert from the list outright so it disappears
  // immediately (the previous version only relabeled status to 'read', which
  // left it rendered until a full refetch). Badge tracks remaining pending.
  const remaining = state.alerts.filter((a) => a.id !== id);
  state = {
    ...state,
    alerts: remaining,
    alertsBadge: remaining.filter((a) => a.status === 'pending').length,
  };
  notify();
}

export function getChatStateSnapshot(): Readonly<ChatState> {
  return state;
}

/** Test-only reset kept explicit so production callers cannot accidentally reset a live turn. */
export function resetChatStoreForTests(): void {
  state = {
    ...initialState,
    messages: [],
    conversations: [],
    alerts: [],
  };
  activeDraft = null;
  activeMeriIdentityKey = null;
  notify();
}

export function useChatStore(): ChatState {
  const [s, setS] = useState<ChatState>(state);
  useEffect(() => {
    const l = () => setS({ ...state });
    listeners.push(l);
    return () => {
      listeners = listeners.filter((x) => x !== l);
    };
  }, []);
  return s;
}
