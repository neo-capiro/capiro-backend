import { useEffect, useState } from 'react';
import type { MeriRect } from './meri-geometry.js';

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
}

/**
 * Inline analysis chart (F4) attached to an assistant message. The PNG body
 * is fetched lazily from GET /api/clio/artifacts/:id/image by the card.
 */
export interface ChatMessageChartArtifact {
  id: string;
  title: string;
}

export interface ChatMessage {
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

export function setChatMessageVerification(id: string, verification: MeriVerification): void {
  const messages = state.messages.map((m) => (m.id === id ? { ...m, verification } : m));
  state = { ...state, messages };
  notify();
}

export function setChatMessageGroundingCaveat(id: string, groundingCaveat: GroundingCaveat): void {
  const messages = state.messages.map((m) => (m.id === id ? { ...m, groundingCaveat } : m));
  state = { ...state, messages };
  notify();
}

export function setChatMessageSuggestions(id: string, suggestions: string[]): void {
  const messages = state.messages.map((m) => (m.id === id ? { ...m, suggestions } : m));
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
