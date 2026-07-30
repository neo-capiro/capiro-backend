import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import axios from 'axios';
import { config } from '../../env.js';
import { detectApprovalIntent } from './meri-approval-intent.js';
import {
  describeApprovalOutcome,
  outstandingApprovals,
  upsertProposal,
} from './meri-pending-approvals.js';
import { useApi } from '../../lib/use-api.js';
import { useClientFilter } from '../../state/client-filter.js';
import { useImpersonation } from '../../state/impersonation.js';
import {
  addChatMessageChartArtifact,
  appendChatMessage,
  clearChatSession,
  MeriSourceAttribution,
  type MeriCitation,
  type MeriVerification,
  getActiveDraft,
  removeConversation,
  setAlerts,
  dismissAlert,
  setActiveConversation,
  setChatOpen,
  setChatSession,
  setChatMessageCitations,
  setChatMessageVerification,
  setChatMessageGroundingCaveat,
  setChatMessageSuggestions,
  setChatMessageFeedback,
  setStreaming,
  truncateMessagesAfter,
  updateChatMessage,
  upsertConversation,
  useChatStore,
} from './chat-store.js';
import { MERI_CONTEXT_PROMPT_EVENT, type MeriContextPromptRequest } from './meri-prompt.js';
import { isUsableAttachment, type StagedAttachment } from './ChatInput.js';
import type { TrustStep } from './WorkPerformed.js';
import type { CanvasArtifact } from './MeriCanvas.js';
import type { MessageFeedbackPayload } from './MessageFeedback.js';
import type { MeriLearnedMemory } from './MeriMemoryPanel.js';

type SseEvent =
  | { type: 'start'; intent: string; tier?: 'fast' | 'deep' }
  | {
      type: 'trace';
      trace?: Array<{ tool: string; action: 'selected' | 'skipped'; reason: string }>;
      policy?: { tier?: 'fast' | 'deep' };
    }
  | { type: 'plan'; steps?: string[] }
  | { type: 'suggestions'; suggestions?: string[] }
  | {
      type: 'artifact';
      artifact?: { id?: string; title?: string; kind?: string; bodyText?: string };
    }
  | { type: 'tool_call'; tool: string; label?: string; input?: Record<string, unknown> }
  | { type: 'template'; template?: { heading: string; sections: string[] } }
  | { type: 'conflict'; conflict?: { title: string; detail: string } }
  | { type: 'sources'; sources?: Array<MeriSourceAttribution & { label?: string }> }
  | { type: 'citations'; citations?: MeriCitation[] }
  | {
      type: 'verification';
      title?: string;
      verification?: MeriVerification;
      confidence?: { level: 'high' | 'medium' | 'low' | 'unknown'; label: string };
    }
  // Chat enforce-gate (non-blocking): the grounding auditor flagged HIGH/CRITICAL
  // issues in an already-streamed reply. Older clients ignore this unknown type.
  | {
      type: 'grounding_caveat';
      topSeverity: string | null;
      findings: Array<{ check: string; severity: string; detail: string }>;
    }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  // MeriV2 full chat (meriv2.fullChat): a write the compliance gate held for
  // human approval. Rendered as an approve card; approving POSTs only the
  // opaque proposalId to /api/clio/action-proposals/:id/approve — never a
  // tool name, payload, or fingerprint. Legacy turns never emit this (unknown
  // event types are ignored by older clients).
  | {
      type: 'pending_approval';
      tool: string;
      label?: string;
      proposalId: string;
      status: MeriActionProposalStatus;
      reason: string;
      expiresAt: string;
      riskTier: string | null;
      policyCode: string | null;
      /** Policy rule behind the hold, rendered in the card's expandable details. */
      ruleId: string | null;
      preview: MeriActionPreview;
    }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | {
      type: 'draft_updated';
      engagementId: string;
      recipientId?: string;
      subject: string;
      body: string;
    }
  | { type: 'workflow_updated'; instanceId: string; fieldKey: string; updatedValue: string }
  | {
      type: 'page_write';
      target: 'outreach_draft';
      engagementId?: string;
      recipientId?: string;
      subject?: string;
      body?: string;
      note?: string;
    }
  // Server detected a report-shaped ask and short-circuited the chat loop with a
  // one-click offer to run it through the enforced Deep Research pipeline instead.
  // Legacy clients ignore unknown event types, so this is backward-compatible.
  | { type: 'research_offer'; topic: string; reason?: string };

// Deep Research SSE events (from /api/clio/research/:id/plan|stream).
type ResearchSseEvent =
  | { type: 'phase'; phase: 'plan' | 'clarify' | 'gather' | 'synthesize' | 'done' | 'error' }
  | { type: 'title'; title: string }
  | { type: 'plan'; plan: string[] }
  | { type: 'clarify'; questions: string[] }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'step'; tool: string; label?: string }
  | {
      type: 'source';
      source: {
        tool: string;
        label: string;
        count?: number | null;
        summary: string;
        confidence: 'low' | 'high';
      };
    }
  | { type: 'report'; artifactId?: string; body?: string }
  // Liveness heartbeat. A research run takes minutes and, on a workspace with
  // grounding enforcement on, streams no report text at all until the audit
  // clears it — so this is what tells the reader the run is alive, and what lets
  // the stall watchdog below distinguish "slow" from "dead".
  | { type: 'progress'; note: string; elapsedMs?: number; budgetMs?: number }
  // One-shot explanation of why the body will arrive all at once.
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

// No `progress` heartbeat (server cadence is 5s) for this long means the stream
// is dead, not slow: surface a real error instead of spinning on "Working…"
// forever. Generous enough to survive a paused laptop or a slow first byte.
const RESEARCH_STALL_MS = 120_000;

/** "1m 20s" / "45s" — elapsed time for the progress line. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// ── Chat attachments (F1) ────────────────────────────────────────────────
// Server limits (also enforced here with a friendly message before upload).
const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_ATTACHMENTS = 4;

/** Response shape of POST /api/clio/attachments. id === null ⇒ unusable. */
interface AttachmentUploadResponse {
  id: string | null;
  filename: string;
  kind: 'pdf' | 'docx' | 'image' | 'text' | 'unsupported';
  status: 'parsed' | 'truncated' | 'scanned' | 'image_ready' | 'unsupported';
  pages: number | null;
  truncated: boolean;
  reason: string | null;
  chars: number;
}

/** Best-effort kind guess for the uploading chip; the server response wins. */
function guessAttachmentKind(file: File): StagedAttachment['kind'] {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx')) return 'docx';
  if (file.type.startsWith('image/')) return 'image';
  if (
    file.type.startsWith('text/') ||
    name.endsWith('.txt') ||
    name.endsWith('.md') ||
    name.endsWith('.csv')
  ) {
    return 'text';
  }
  return 'unsupported';
}

function contextLabelFor(pathname: string): string {
  const draft = getActiveDraft();
  if (pathname.startsWith('/engagement') && draft) {
    const name = draft.subject ? `"${draft.subject}"` : 'outreach draft';
    return `Editing: ${name}`;
  }
  if (pathname.startsWith('/engagement')) return 'Engagement Manager';
  if (pathname.startsWith('/intelligence')) return 'Intelligence Center';
  if (pathname.startsWith('/workspace')) return 'Workspace';
  if (pathname.startsWith('/directory')) return 'Directory';
  if (pathname.startsWith('/clients')) return 'Portfolio';
  if (pathname.startsWith('/settings')) return 'Settings';
  return 'Capiro';
}

interface ClientOption {
  id: string;
  name: string;
}

export interface ChatDrawerProps {
  selectedClientName?: string | null;
}

/**
 * Server-authoritative lifecycle of a MeriV2 action proposal (Phase 0). Every
 * value here is exactly what apps/api's MeriActionProposalService returns —
 * the browser never computes or infers a status client-side.
 *
 * `proposed` is the only re-approvable "outstanding" state that counts toward
 * the header badge and "Approve all"; `failed_retryable` is separately
 * offered a Retry action (still server-reverified on click, same as a fresh
 * approval). Every other state is terminal display-only: `succeeded`,
 * `failed_terminal`, `outcome_unknown`, `blocked`, `expired`, `dismissed`.
 * `approved` is a legacy compatibility label the UI must never treat as
 * synonymous with `succeeded`.
 */
export type MeriActionProposalStatus =
  | 'proposed'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'outcome_unknown'
  | 'blocked'
  | 'dismissed'
  | 'expired';

/** Display-only informed-consent summary — never fed back into execution. */
export interface MeriActionPreview {
  label: string;
  riskTier: string | null;
  leavesFirm: boolean;
  reversible: boolean;
  client?: { id: string; name?: string };
  fields: Record<string, string | number | boolean>;
  counts: Record<string, number>;
  reason: string;
}

/** Mirrors apps/api's PublicMeriActionProposal exactly. */
export interface PendingApproval {
  proposalId: string;
  status: MeriActionProposalStatus;
  tool: string;
  preview: MeriActionPreview;
  expiresAt: string;
  reason: string;
  riskTier: string | null;
  policyCode: string | null;
  ruleId?: string | null;
  approvedAt?: string | null;
  approvedBy?: string | null;
  attemptCount: number;
  resultSummary: unknown;
  error?: { code: string | null; message: string | null };
  createdAt: string;
  updatedAt: string;
}

export function useMeriChatController({ selectedClientName }: ChatDrawerProps) {
  const {
    isOpen,
    messages,
    sessionId,
    isStreaming,
    alertsBadge,
    alerts,
    conversations,
    activeConversationId,
  } = useChatStore();
  // Only undismissed briefings are ever rendered. dismissAlert removes items from
  // the store outright, so this also makes them vanish on click without a refetch.
  const pendingAlerts = alerts.filter((a) => a.status === 'pending');
  const { getToken } = useAuth();
  const api = useApi();
  const { actAsTenantSlug } = useImpersonation();
  const { selectedClientId } = useClientFilter();
  const location = useLocation();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [clients, setClients] = useState<ClientOption[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [sessionTitle, setSessionTitle] = useState('');
  const [sessionClientId, setSessionClientId] = useState('');
  const [orchestratorTier, setOrchestratorTier] = useState<'fast' | 'deep' | null>(null);
  const [orchestratorIntent, setOrchestratorIntent] = useState<string | null>(null);
  const [trustSteps, setTrustSteps] = useState<TrustStep[]>([]);
  const [planSteps, setPlanSteps] = useState<string[]>([]);
  // Files staged in the composer (F1). Lives here because sendMessage needs it.
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [activeArtifact, setActiveArtifact] = useState<CanvasArtifact | null>(null);
  const [orchestratorConflict, setOrchestratorConflict] = useState<{
    title: string;
    detail: string;
  } | null>(null);
  // MeriV2 gate-held writes (meriv2.fullChat). UNLIKE trustSteps these SURVIVE
  // the next send: they used to be cleared by the `start` handler, so typing
  // anything — including "I approve" — silently destroyed every card the user
  // was about to approve. They now persist until explicitly approved or
  // dismissed, and resolved rows stay visible carrying their outcome.
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  // Mirror for reading the live set inside sequential loops (Approve all) and
  // async callbacks without tripping over a stale closure.
  const pendingApprovalsRef = useRef<PendingApproval[]>([]);
  pendingApprovalsRef.current = pendingApprovals;
  // sendMessage needs to run an approval, but the approval helpers are declared
  // below it and finishApprovalRound → sendMessage closes the cycle. Naming
  // them in sendMessage's dependency array would evaluate them in the temporal
  // dead zone and throw on first render, so the call goes through these
  // (stable) refs, assigned once the real implementations exist.
  const runApprovalRef = useRef<((proposalId: string) => Promise<void>) | null>(null);
  const finishApprovalRoundRef = useRef<(() => void) | null>(null);
  const [approvingProposalId, setApprovingProposalId] = useState<string | null>(null);
  const [orchestratorTemplate, setOrchestratorTemplate] = useState<{
    heading: string;
    sections: string[];
  } | null>(null);
  const [isSavingMeta, setIsSavingMeta] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [writeMode, setWriteMode] = useState(false);
  // Deep Research mode lives inside the chat: first message = topic (Meri plans +
  // asks clarifying questions), next message = answers (Meri runs the agentic
  // research and streams a cited report into the conversation).
  const [researchMode, setResearchMode] = useState(false);
  const researchSessionRef = useRef<string | null>(null);
  const [researchAwaitingAnswers, setResearchAwaitingAnswers] = useState(false);
  // Clarifying questions Meri asked, rendered as an inline answer form (Claude-style).
  const [researchQuestions, setResearchQuestions] = useState<string[]>([]);
  // Map of assistant message id -> completed research session id, so a finished
  // report can show Download Word / Open as page actions.
  const [researchReports, setResearchReports] = useState<Record<string, string>>({});
  // Map of assistant message id -> a server-emitted "run this as Deep Research"
  // offer (the chat loop was short-circuited because the ask was report-shaped).
  // Rendered as a one-click "Run as Deep Research" button on that message.
  const [researchOffers, setResearchOffers] = useState<
    Record<string, { topic: string; reason?: string }>
  >({});
  const [learnedMemories, setLearnedMemories] = useState<MeriLearnedMemory[]>([]);
  const [forgottenMemories, setForgottenMemories] = useState<MeriLearnedMemory[]>([]);
  const forgetTimersRef = useRef(new Map<string, number>());
  // Learned-memory panel is collapsed by default so it doesn't dominate the
  // drawer; the user can expand to review/acknowledge what Meri remembers.
  const [learnedExpanded, setLearnedExpanded] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const resizingRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [drawerWidth, setDrawerWidth] = useState(420);

  const contextLabel =
    selectedClientName && !location.pathname.startsWith('/clients')
      ? `${contextLabelFor(location.pathname)} · ${selectedClientName}`
      : contextLabelFor(location.pathname);

  // The workspace draft editor embeds its own document-scoped Meri panel whose
  // composer is docked to the bottom-right rail — exactly where this global
  // launcher floats, so the FAB covers its input. Suppress the (redundant) FAB
  // on that route; the drawer, if already open, still renders.
  const hideMeriFab = location.pathname.startsWith('/workspace/draft/');

  const selectedClientValue = useMemo(() => {
    if (!sessionClientId) return '';
    const found = clients.find((client) => client.id === sessionClientId);
    return found ? found.id : '';
  }, [clients, sessionClientId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Create session on first open
  useEffect(() => {
    if (!isOpen || sessionId) return;
    void doCreateSession();
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = await getToken({ template: 'capiro' });
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(actAsTenantSlug ? { 'x-capiro-impersonate-tenant': actAsTenantSlug } : {}),
    };
  }, [getToken, actAsTenantSlug]);

  // Load alerts on mount so the closed launcher can show its pending badge;
  // recheck when Meri opens in case a scheduled briefing arrived meanwhile.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${config.apiBaseUrl}/api/clio/alerts`, {
          headers: await authHeaders(),
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) setAlerts(data);
        }
      } catch {
        /* ignore */
      }
    })();
  }, [isOpen, authHeaders]);

  // Dismiss (mark read) a delivered alert — optimistic store update + persist.
  const handleDismissAlert = useCallback(
    async (id: string) => {
      dismissAlert(id);
      try {
        await fetch(`${config.apiBaseUrl}/api/clio/alerts/${id}/dismiss`, {
          method: 'POST',
          headers: await authHeaders(),
        });
      } catch {
        /* optimistic; ignore network error */
      }
    },
    [authHeaders],
  );

  // Dismiss every currently-visible briefing in one click.
  const handleClearAllAlerts = useCallback(async () => {
    const toClear = alerts.filter((a) => a.status === 'pending').map((a) => a.id);
    for (const id of toClear) dismissAlert(id);
    const headers = await authHeaders();
    await Promise.allSettled(
      toClear.map((id) =>
        fetch(`${config.apiBaseUrl}/api/clio/alerts/${id}/dismiss`, { method: 'POST', headers }),
      ),
    );
  }, [alerts, authHeaders]);

  useEffect(() => {
    if (!isOpen) return;
    void (async () => {
      try {
        const res = await fetch(`${config.apiBaseUrl}/api/clients`, {
          headers: await authHeaders(),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data)) {
          const options = data
            .map((client) => ({ id: String(client.id ?? ''), name: String(client.name ?? '') }))
            .filter((client) => Boolean(client.id && client.name));
          setClients(options);
        }
      } catch {
        // ignore
      }
    })();
  }, [isOpen, authHeaders]);

  useEffect(() => {
    const active =
      conversations.find((conversation) => conversation.id === activeConversationId) ?? null;
    setSessionTitle(active?.title ?? '');
    // ONLY the conversation's own assignment. This used to fall back to the
    // global client filter, so the scope selector could display a client the
    // server had never been told about — the session then answered from the
    // whole firm's data while looking client-scoped (reported 2026-07-29).
    setSessionClientId(active?.clientId ?? '');
    setMetaError(null);
  }, [conversations, activeConversationId]);

  useEffect(() => {
    if (!messages.length) {
      setTrustSteps([]);
      setOrchestratorIntent(null);
      setOrchestratorTier(null);
      setOrchestratorConflict(null);
      setOrchestratorTemplate(null);
    }
  }, [messages.length]);

  const saveConversationMeta = useCallback(async () => {
    if (!activeConversationId || isSavingMeta) return;
    setIsSavingMeta(true);
    setMetaError(null);
    try {
      const payload: Record<string, unknown> = {};
      const trimmedTitle = sessionTitle.trim();
      if (trimmedTitle) payload.title = trimmedTitle;
      payload.clientId = selectedClientValue || null;

      const res = await fetch(
        `${config.apiBaseUrl}/api/clio/conversations/${activeConversationId}`,
        {
          method: 'PATCH',
          headers: await authHeaders(),
          body: JSON.stringify(payload),
        },
      );

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }

      const updated = await res.json();
      if (updated && typeof updated.id === 'string') {
        upsertConversation({
          id: updated.id,
          title: updated.title,
          clientId: updated.clientId ?? null,
          client: updated.client ?? null,
          latestMessage:
            updated.latestMessage && typeof updated.latestMessage.body === 'string'
              ? { body: updated.latestMessage.body, createdAt: updated.latestMessage.createdAt }
              : null,
          updatedAt: updated.updatedAt,
        });
      }
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : 'Failed to save conversation settings');
    } finally {
      setIsSavingMeta(false);
    }
  }, [activeConversationId, authHeaders, isSavingMeta, selectedClientValue, sessionTitle]);

  /**
   * Assign the session's client and PERSIST it immediately.
   *
   * The scope selector used to be local state that only reached the server if
   * the user ALSO clicked the save button, and a conversation-list refresh
   * silently reverted an unsaved pick. Every turn reads
   * clio_conversations.client_id, so an unsaved pick meant a session that looked
   * scoped while every tool ran across the whole firm. Writing on change is what
   * makes the displayed scope the scope the model is actually held to; on
   * failure the selector snaps back rather than showing a scope the server
   * doesn't have.
   */
  const changeSessionClient = useCallback(
    async (clientId: string) => {
      const previous = sessionClientId;
      if (clientId === previous) return;
      // No conversation yet (the session is still being created): refuse the
      // pick outright rather than showing a scope nothing can be written to.
      if (!activeConversationId) {
        setMetaError('The session is still starting — set the client scope again in a moment.');
        return;
      }
      setSessionClientId(clientId);
      setMetaError(null);
      setIsSavingMeta(true);
      try {
        const res = await fetch(
          `${config.apiBaseUrl}/api/clio/conversations/${activeConversationId}`,
          {
            method: 'PATCH',
            headers: await authHeaders(),
            body: JSON.stringify({ clientId: clientId || null }),
          },
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(text || `HTTP ${res.status}`);
        }
        const updated = await res.json();
        if (updated && typeof updated.id === 'string') {
          upsertConversation({
            id: updated.id,
            title: updated.title,
            clientId: updated.clientId ?? null,
            client: updated.client ?? null,
            latestMessage:
              updated.latestMessage && typeof updated.latestMessage.body === 'string'
                ? { body: updated.latestMessage.body, createdAt: updated.latestMessage.createdAt }
                : null,
            updatedAt: updated.updatedAt,
          });
        }
      } catch (err) {
        setSessionClientId(previous);
        setMetaError(
          err instanceof Error
            ? `Could not change the client scope: ${err.message}`
            : 'Could not change the client scope',
        );
      } finally {
        setIsSavingMeta(false);
      }
    },
    [activeConversationId, authHeaders, sessionClientId],
  );

  const archiveConversation = useCallback(async () => {
    if (!activeConversationId) return;
    try {
      const res = await fetch(
        `${config.apiBaseUrl}/api/clio/conversations/${activeConversationId}/archive`,
        {
          method: 'PATCH',
          headers: await authHeaders(),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }
      removeConversation(activeConversationId);
      clearChatSession();
      setTrustSteps([]);
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : 'Failed to archive conversation');
    }
  }, [activeConversationId, authHeaders]);

  const doCreateSession = useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch(`${config.apiBaseUrl}/api/clio/conversations`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          clientId: selectedClientId || undefined,
          title: 'Chat session',
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          id: string;
          title?: string;
          clientId?: string | null;
          updatedAt?: string;
        };
        // Register the row so the header's scope selector reads the session's
        // REAL assignment. Previously nothing was stored, so the selector fell
        // back to the global client filter and could name a client the
        // conversation did not have — the display that made the leak invisible.
        // The POST response carries no `client` relation; resolve the name from
        // the loaded roster so the history rail groups it correctly too.
        const createdClientId = data.clientId ?? null;
        const createdClient = createdClientId
          ? (clients.find((client) => client.id === createdClientId) ?? null)
          : null;
        upsertConversation({
          id: data.id,
          title: typeof data.title === 'string' ? data.title : 'Chat session',
          clientId: createdClientId,
          client: createdClient,
          latestMessage: null,
          updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
        });
        setChatSession(data.id);
        setActiveConversation(data.id);
        return data.id;
      }
    } catch {
      // fallback
    }
    return null;
  }, [authHeaders, selectedClientId, clients]);

  const handleNewSession = useCallback(async () => {
    abortRef.current?.abort();
    clearChatSession();
    setTrustSteps([]);
    setOrchestratorIntent(null);
    setOrchestratorTier(null);
    setOrchestratorConflict(null);
    setOrchestratorTemplate(null);
    setStagedAttachments([]);
    setAttachmentNotice(null);
    await doCreateSession();
  }, [doCreateSession]);

  // ── Chat attachments (F1) ──────────────────────────────────────────────
  // Upload one file immediately; the chip starts as "uploading" and resolves
  // to the server's verdict (parsed/truncated/image_ready, or unusable).
  const uploadAttachment = useCallback(
    async (file: File) => {
      const localId = generateId();
      setStagedAttachments((prev) => [
        ...prev,
        {
          localId,
          id: null,
          filename: file.name,
          kind: guessAttachmentKind(file),
          status: 'uploading',
          reason: null,
        },
      ]);
      try {
        const form = new FormData();
        form.append('file', file);
        // Axios sets the multipart boundary itself; generous timeout for big PDFs.
        const { data } = await api.post<AttachmentUploadResponse>('/api/clio/attachments', form, {
          timeout: 120_000,
        });
        setStagedAttachments((prev) =>
          prev.map((att) =>
            att.localId === localId
              ? {
                  ...att,
                  id: data.id,
                  filename: data.filename || att.filename,
                  kind: data.kind,
                  status: data.status,
                  reason: data.reason,
                }
              : att,
          ),
        );
      } catch (err) {
        const serverMessage = axios.isAxiosError(err)
          ? (err.response?.data as { message?: string } | undefined)?.message
          : undefined;
        setStagedAttachments((prev) =>
          prev.map((att) =>
            att.localId === localId
              ? { ...att, status: 'error', reason: serverMessage || 'Upload failed — try again.' }
              : att,
          ),
        );
      }
    },
    [api],
  );

  // Stage newly picked files, enforcing the 8-file / 4-image caps client-side
  // (failed chips don't count — they'll never be sent).
  const handleAttachFiles = useCallback(
    (files: FileList) => {
      setAttachmentNotice(null);
      const active = stagedAttachments.filter(
        (att) => att.status === 'uploading' || isUsableAttachment(att),
      );
      let total = active.length;
      let images = active.filter((att) => att.kind === 'image').length;
      let notice: string | null = null;
      for (const file of Array.from(files)) {
        if (total >= MAX_ATTACHMENTS) {
          notice = `You can attach up to ${MAX_ATTACHMENTS} files per message — the rest were skipped.`;
          break;
        }
        const isImage = file.type.startsWith('image/');
        if (isImage && images >= MAX_IMAGE_ATTACHMENTS) {
          notice = `Up to ${MAX_IMAGE_ATTACHMENTS} images per message — “${file.name}” was skipped.`;
          continue;
        }
        total += 1;
        if (isImage) images += 1;
        void uploadAttachment(file);
      }
      if (notice) setAttachmentNotice(notice);
    },
    [stagedAttachments, uploadAttachment],
  );

  const removeStagedAttachment = useCallback((localId: string) => {
    setStagedAttachments((prev) => prev.filter((att) => att.localId !== localId));
    setAttachmentNotice(null);
  }, []);

  // ── Deep Research (in-chat) ────────────────────────────────────────────
  // Reads an SSE stream from a research endpoint, dispatching each event.
  const consumeResearchStream = useCallback(
    async (path: string, controller: AbortController, onEvent: (e: ResearchSseEvent) => void) => {
      const res = await fetch(`${config.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: await authHeaders(),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      outer: while (true) {
        // Watchdog: race each read against the stall window. The server sends a
        // `progress` heartbeat every few seconds, so silence past
        // RESEARCH_STALL_MS means the connection died (proxy drop, container
        // restart) — without this the reader awaits a chunk that never comes and
        // the drawer sits on "Working…" indefinitely.
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          ({ done, value } = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              stallTimer = setTimeout(() => {
                // Release the socket instead of leaving a read pending forever.
                // A user-initiated Stop tears the stream down via the
                // AbortController, so this path is only ever a real stall.
                void reader.cancel().catch(() => {});
                reject(
                  new Error(
                    `No update from the server for ${Math.round(
                      RESEARCH_STALL_MS / 1000,
                    )}s — the connection dropped.`,
                  ),
                );
              }, RESEARCH_STALL_MS);
            }),
          ]));
        } finally {
          if (stallTimer) clearTimeout(stallTimer);
        }
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;
          let event: ResearchSseEvent;
          try {
            event = JSON.parse(jsonStr) as ResearchSseEvent;
          } catch {
            continue;
          }
          onEvent(event);
          if (event.type === 'done') break outer;
        }
      }
    },
    [authHeaders],
  );

  const runResearch = useCallback(
    async (content: string) => {
      // Echo the user's message into the conversation.
      appendChatMessage({ id: generateId(), role: 'user', content, createdAt: new Date() });
      const assistantId = generateId();
      appendChatMessage({ id: assistantId, role: 'assistant', content: '', createdAt: new Date() });
      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        if (!researchSessionRef.current) {
          // ── Phase 1: topic → plan + clarifying questions ──
          setTrustSteps([]);
          setOrchestratorIntent('deep_research');
          setOrchestratorTier('deep');
          const created = await fetch(`${config.apiBaseUrl}/api/clio/research`, {
            method: 'POST',
            headers: await authHeaders(),
            body: JSON.stringify({ topic: content, clientId: selectedClientId || undefined }),
          });
          if (!created.ok) throw new Error(`Could not start research (HTTP ${created.status})`);
          const { id } = (await created.json()) as { id: string };
          researchSessionRef.current = id;

          let planText = '';
          let questions: string[] = [];
          await consumeResearchStream(`/api/clio/research/${id}/plan/stream`, controller, (e) => {
            if (e.type === 'progress') {
              // Only until the plan itself starts arriving.
              if (!planText) {
                const elapsed =
                  typeof e.elapsedMs === 'number' ? ` · ${formatElapsed(e.elapsedMs)} elapsed` : '';
                updateChatMessage(assistantId, `_${e.note}${elapsed}_`);
              }
            } else if (e.type === 'title') {
              planText = `**Research plan — ${e.title}**\n\n`;
              updateChatMessage(assistantId, planText);
            } else if (e.type === 'plan') {
              planText += e.plan.map((p, idx) => `${idx + 1}. ${p}`).join('\n');
              updateChatMessage(assistantId, planText);
            } else if (e.type === 'clarify') {
              questions = e.questions;
            } else if (e.type === 'thinking') {
              // Raw research reasoning is discarded rather than buffered; the
              // visible trace is built from step and source events instead.
            } else if (e.type === 'error') {
              updateChatMessage(assistantId, `Error: ${e.message}`);
            }
          });
          // Render clarifying questions as an inline answer form (Claude-style),
          // not as text the user has to reply to free-form.
          setResearchQuestions(questions);
          setResearchAwaitingAnswers(questions.length > 0);
          if (questions.length === 0) {
            // No questions — go straight to the run.
            await executeResearchRun(controller);
          }
          return;
        }

        // ── Phase 2 (free-text fallback): a typed reply during awaiting state ──
        // The inline form is the primary path; this handles a user who just types.
        const id = researchSessionRef.current;
        await fetch(`${config.apiBaseUrl}/api/clio/research/${id}/clarify`, {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({ answers: { '0': content } }),
        });
        setResearchAwaitingAnswers(false);
        setResearchQuestions([]);
        await executeResearchRun(controller, assistantId);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        updateChatMessage(
          assistantId,
          `Research failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
        researchSessionRef.current = null;
        setResearchAwaitingAnswers(false);
        setResearchQuestions([]);
      } finally {
        setStreaming(false);
      }
    },
    // executeResearchRun is stable via useCallback below; deps kept minimal.
    [authHeaders, consumeResearchStream, selectedClientId], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Accept a server-emitted "Run as Deep Research" offer: clear the offer card,
  // start a fresh research session (null the ref so runResearch enters Phase 1),
  // and run the exact same Deep Research flow the toggle uses.
  const handleRunResearchOffer = useCallback(
    (messageId: string, topic: string) => {
      if (isStreaming) return;
      setResearchOffers((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      researchSessionRef.current = null;
      void runResearch(topic);
    },
    [isStreaming, runResearch],
  );

  // Streams the gather+synthesize phase into the given (or a new) assistant
  // message, threading tool steps into the trust timeline and the report text
  // into the message body. Records the finished session id for export actions.
  const executeResearchRun = useCallback(
    async (controller: AbortController, existingAssistantId?: string) => {
      const id = researchSessionRef.current;
      if (!id) return;
      const assistantId = existingAssistantId ?? generateId();
      if (!existingAssistantId) {
        appendChatMessage({
          id: assistantId,
          role: 'assistant',
          content: '',
          createdAt: new Date(),
        });
      }
      setTrustSteps([]);
      let report = '';
      // Live status shown in the message body until the first report text lands.
      // On a grounding-enforced workspace that's the whole run, so without it the
      // bubble would read "Working…" for minutes with nothing else to go on.
      let progressNote = '';
      let deliveryNotice = '';
      const renderProgress = () => {
        if (report) return; // real content always wins
        const parts = [progressNote, deliveryNotice].filter(Boolean);
        if (parts.length > 0) updateChatMessage(assistantId, parts.join('\n\n'));
      };
      try {
        await consumeResearchStream(`/api/clio/research/${id}/stream`, controller, (e) => {
          if (e.type === 'step') {
            const label = e.label || e.tool;
            setTrustSteps((prev) => [...prev, { tool: e.tool, label, status: 'running' as const }]);
          } else if (e.type === 'source') {
            const s = e.source;
            setTrustSteps((prev) => {
              const next = [...prev];
              for (let i = next.length - 1; i >= 0; i -= 1) {
                if (next[i]!.status === 'running' && next[i]!.tool === s.tool) {
                  next[i] = {
                    ...next[i]!,
                    label: s.label || next[i]!.label,
                    detail: s.summary,
                    count: typeof s.count === 'number' ? s.count : next[i]!.count,
                    confidence: s.confidence,
                    status: s.confidence === 'low' ? 'error' : 'done',
                  };
                  return next;
                }
              }
              return next;
            });
          } else if (e.type === 'progress') {
            const elapsed =
              typeof e.elapsedMs === 'number' ? ` · ${formatElapsed(e.elapsedMs)} elapsed` : '';
            progressNote = `_${e.note}${elapsed}_`;
            renderProgress();
          } else if (e.type === 'notice') {
            deliveryNotice = `_${e.message}_`;
            renderProgress();
          } else if (e.type === 'thinking') {
            // Raw research reasoning is discarded rather than buffered.
          } else if (e.type === 'text') {
            report += e.text;
            updateChatMessage(assistantId, report);
          } else if (e.type === 'report' && typeof e.body === 'string') {
            report = e.body;
            updateChatMessage(assistantId, report);
          } else if (e.type === 'error') {
            updateChatMessage(assistantId, `${report}\n\n_Error: ${e.message}_`);
          }
        });
      } catch (err) {
        // A stalled or dropped stream must end as a readable failure, not as a
        // message stuck on the last progress line. A user-initiated Stop keeps
        // whatever streamed so far and is not an error.
        if (err instanceof Error && err.name === 'AbortError') {
          if (!report) updateChatMessage(assistantId, '_Research stopped._');
          researchSessionRef.current = null;
          return;
        }
        const message = err instanceof Error ? err.message : 'unknown error';
        updateChatMessage(
          assistantId,
          report
            ? `${report}\n\n_Research interrupted: ${message}_`
            : `_Research failed: ${message}_`,
        );
        researchSessionRef.current = null;
        return;
      }
      // Mark this message as a finished report so export actions render.
      const finishedId = researchSessionRef.current;
      if (finishedId) setResearchReports((prev) => ({ ...prev, [assistantId]: finishedId }));
      // Reset for the next research request in this conversation.
      researchSessionRef.current = null;
    },
    [consumeResearchStream],
  );

  // Submit per-question answers from the inline clarify form, then run research.
  const submitResearchAnswers = useCallback(
    async (answers: Record<string, string>, skipped: boolean) => {
      const id = researchSessionRef.current;
      if (!id || isStreaming) return;
      setResearchAwaitingAnswers(false);
      setResearchQuestions([]);
      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await fetch(`${config.apiBaseUrl}/api/clio/research/${id}/clarify`, {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({ answers: skipped ? {} : answers }),
        });
        await executeResearchRun(controller);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        researchSessionRef.current = null;
      } finally {
        setStreaming(false);
      }
    },
    [authHeaders, executeResearchRun, isStreaming],
  );

  const sendMessage = useCallback(
    async (content: string, opts?: { mode?: 'regenerate' | 'resend' }) => {
      if (isStreaming) return;

      const mode = opts?.mode;

      // Typed approval of held writes. The user saying "I approve" in the box
      // used to start a normal turn, which wiped the very cards it meant to
      // approve; the model then re-proposed under a new identity and the loop
      // never terminated. Intercept BEFORE anything else so the message never
      // reaches the model as a fresh instruction.
      //
      // Only cards the user can currently see are eligible, and the opaque
      // proposalId remains the unit of approval — nothing is re-derived, so
      // this can never approve something they have not read.
      if (!mode) {
        const outstanding = outstandingApprovals(pendingApprovalsRef.current);
        if (outstanding.length > 0 && detectApprovalIntent(content).approved) {
          appendChatMessage({ id: generateId(), role: 'user', content, createdAt: new Date() });
          const card = outstanding.length === 1 ? outstanding[0] : undefined;
          if (card) {
            appendChatMessage({
              id: generateId(),
              role: 'assistant',
              content: `Approving **${card.preview.label}** and running it now.`,
              createdAt: new Date(),
            });
            await runApprovalRef.current?.(card.proposalId);
            finishApprovalRoundRef.current?.();
          } else {
            // Several actions are held. A typed "approve" does not say WHICH,
            // and guessing "all of them" would run writes off an ambiguous
            // word. Name them and let the user commit deliberately.
            const list = outstanding.map((p) => `- ${p.preview.label}`).join('\n');
            appendChatMessage({
              id: generateId(),
              role: 'assistant',
              content:
                `There ${outstanding.length === 1 ? 'is' : 'are'} ${outstanding.length} actions ` +
                `waiting on you:\n\n${list}\n\nUse **Approve all** to run every one, or approve them ` +
                `individually — I have left the cards in place.`,
              createdAt: new Date(),
            });
          }
          return;
        }
      }

      // Deep Research mode is handled by a dedicated multi-phase flow (new turns only).
      if (researchMode && !mode) {
        await runResearch(content);
        return;
      }

      const writePrefix = 'write on this page:';
      const outgoing = mode ? content : writeMode ? `${writePrefix} ${content}` : content;

      // Ensure we have a session ID (create one if missing)
      let sid = sessionId;
      if (!sid) {
        sid = await doCreateSession();
      }
      if (!sid) return;

      // Staged attachments ride along on new turns only (regenerate/resend re-run
      // the already-persisted user turn server-side). Unusable chips (id === null)
      // are never sent.
      const turnAttachments = mode ? [] : stagedAttachments.filter(isUsableAttachment);
      const attachmentIds = turnAttachments
        .map((att) => att.id)
        .filter((id): id is string => Boolean(id));

      // A new turn appends the user message. For regenerate/edit-and-resend the
      // caller has already trimmed (and for resend, edited) the local messages,
      // and the server re-runs the last user turn (P0-4).
      if (!mode) {
        appendChatMessage({
          id: generateId(),
          role: 'user',
          content,
          createdAt: new Date(),
          ...(turnAttachments.length > 0
            ? {
                attachments: turnAttachments.map((att) => ({
                  id: att.id as string,
                  filename: att.filename,
                  kind: att.kind,
                  status: att.status,
                })),
              }
            : {}),
        });
        // Clear the staging row (including any failed chips) as the send starts.
        setStagedAttachments([]);
        setAttachmentNotice(null);
      }

      const assistantId = generateId();
      appendChatMessage({ id: assistantId, role: 'assistant', content: '', createdAt: new Date() });

      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const streamPayload: Record<string, unknown> = mode
          ? { body: outgoing, mode }
          : { body: outgoing };
        if (!mode && attachmentIds.length > 0) streamPayload.attachmentIds = attachmentIds;
        const res = await fetch(`${config.apiBaseUrl}/api/clio/conversations/${sid}/stream`, {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify(streamPayload),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          updateChatMessage(assistantId, `Error ${res.status}: ${text || res.statusText}`);
          return;
        }

        if (!res.body) {
          updateChatMessage(assistantId, 'No response body received.');
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';

        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;
            let event: SseEvent;
            try {
              event = JSON.parse(jsonStr) as SseEvent;
            } catch {
              continue;
            }

            if (event.type === 'start') {
              setOrchestratorTier(event.tier ?? null);
              setOrchestratorIntent(event.intent ?? null);
              setTrustSteps([]);
              setPlanSteps([]);
              // NOTE: pendingApprovals is deliberately NOT cleared here. Clearing
              // it on every turn is what made "I approve" a no-op — the new turn
              // wiped the cards, the model re-proposed under a fresh fingerprint,
              // and nothing was ever written. Cards clear on approve, on dismiss,
              // or on a session switch, and nowhere else.
            } else if (event.type === 'pending_approval') {
              // MeriV2 gate-held write — the server already created the durable
              // proposal; this just renders the card the id identifies.
              setPendingApprovals((prev) =>
                upsertProposal(prev, {
                  proposalId: event.proposalId,
                  status: event.status,
                  tool: event.tool,
                  preview: event.preview,
                  expiresAt: event.expiresAt,
                  reason: event.reason,
                  riskTier: event.riskTier,
                  policyCode: event.policyCode,
                  ruleId: event.ruleId,
                  // A newly proposed action is never approved yet. Approval
                  // attribution arrives from the server on the approve response
                  // and the recovery list fetch — never inferred here.
                  approvedAt: null,
                  approvedBy: null,
                  attemptCount: 0,
                  resultSummary: null,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                }),
              );
            } else if (event.type === 'trace') {
              if (event.policy?.tier) setOrchestratorTier(event.policy.tier);
            } else if (event.type === 'plan') {
              setPlanSteps(Array.isArray(event.steps) ? event.steps : []);
            } else if (event.type === 'tool_call') {
              // Live agentic tool call — push a "running" step into the trust
              // timeline; the matching `sources` event flips it to done/error.
              const label = event.label || event.tool;
              setTrustSteps((prev) => [
                ...prev,
                { tool: event.tool, label, status: 'running' as const },
              ]);
            } else if (event.type === 'template') {
              setOrchestratorTemplate(event.template ?? null);
            } else if (event.type === 'conflict') {
              setOrchestratorConflict(event.conflict ?? null);
            } else if (event.type === 'text') {
              accumulated += event.text;
              updateChatMessage(assistantId, accumulated);
            } else if (event.type === 'thinking') {
              // Deliberately discarded. Extended thinking may remain enabled
              // server-side for answer quality, but raw chain-of-thought is never
              // retained in browser state — holding it here would leave it one
              // render away from disclosure. The bounded work log is built from
              // tool and source events instead.
            } else if (event.type === 'sources') {
              const sources = Array.isArray(event.sources) ? event.sources : [];
              // Resolve the most recent running step (the tool that just finished)
              // with the real result detail/count/confidence.
              const src = sources[0];
              if (src) {
                setTrustSteps((prev) => {
                  const next = [...prev];
                  for (let i = next.length - 1; i >= 0; i -= 1) {
                    if (next[i]!.status === 'running' && next[i]!.tool === src.tool) {
                      next[i] = {
                        ...next[i]!,
                        label: src.label || next[i]!.label,
                        detail: src.summary,
                        count: typeof src.count === 'number' ? src.count : next[i]!.count,
                        confidence: src.confidence,
                        status: src.confidence === 'low' ? 'error' : 'done',
                      };
                      return next;
                    }
                  }
                  return next;
                });
              }
            } else if (event.type === 'citations') {
              setChatMessageCitations(
                assistantId,
                Array.isArray(event.citations) ? event.citations : [],
              );
            } else if (event.type === 'verification') {
              if (event.verification)
                setChatMessageVerification(assistantId, {
                  ...event.verification,
                  confidence: event.confidence,
                });
            } else if (event.type === 'grounding_caveat') {
              if (Array.isArray(event.findings) && event.findings.length > 0)
                setChatMessageGroundingCaveat(assistantId, {
                  topSeverity: event.topSeverity ?? null,
                  findings: event.findings,
                });
            } else if (event.type === 'suggestions') {
              setChatMessageSuggestions(
                assistantId,
                Array.isArray(event.suggestions) ? event.suggestions : [],
              );
            } else if (event.type === 'artifact') {
              if (event.artifact?.kind === 'analysis_chart') {
                // F4 analysis charts stream with an empty bodyText and render
                // inline under the assistant turn; the card lazy-fetches the
                // PNG from /api/clio/artifacts/:id/image.
                if (event.artifact.id) {
                  addChatMessageChartArtifact(assistantId, {
                    id: event.artifact.id,
                    title: event.artifact.title?.trim() || 'Analysis chart',
                  });
                }
              } else if (event.artifact?.bodyText) {
                setActiveArtifact(event.artifact);
              }
            } else if (event.type === 'research_offer') {
              // Server short-circuited a report-shaped ask; attach a one-click
              // "Run as Deep Research" offer to this assistant message.
              setResearchOffers((prev) => ({
                ...prev,
                [assistantId]: { topic: event.topic, reason: event.reason },
              }));
            } else if (event.type === 'done') {
              break outer;
            } else if (event.type === 'error') {
              updateChatMessage(assistantId, `Error: ${event.message}`);
              break outer;
            } else if (event.type === 'draft_updated') {
              window.dispatchEvent(
                new CustomEvent('capiro:draft-updated', {
                  detail: {
                    engagementId: event.engagementId,
                    recipientId: event.recipientId,
                    subject: event.subject,
                    body: event.body,
                  },
                }),
              );
            } else if (event.type === 'workflow_updated') {
              window.dispatchEvent(
                new CustomEvent('capiro:workflow-field-updated', {
                  detail: {
                    instanceId: event.instanceId,
                    fieldKey: event.fieldKey,
                    updatedValue: event.updatedValue,
                  },
                }),
              );
            } else if (event.type === 'page_write') {
              window.dispatchEvent(
                new CustomEvent('capiro:page-write', {
                  detail: {
                    target: event.target,
                    engagementId: event.engagementId,
                    recipientId: event.recipientId,
                    subject: event.subject,
                    body: event.body,
                    note: event.note,
                  },
                }),
              );
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        updateChatMessage(assistantId, 'Failed to get a response. Please try again.');
      } finally {
        setStreaming(false);
      }
    },
    [
      isStreaming,
      sessionId,
      doCreateSession,
      authHeaders,
      selectedClientId,
      selectedClientName,
      location.pathname,
      researchMode,
      writeMode,
      stagedAttachments,
    ],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  // Product surfaces can open Meri with a source-backed, client-scoped prompt.
  // A ref keeps the single window listener stable while still calling the latest
  // sendMessage closure after the client filter/session context has re-rendered.
  const contextualPromptSenderRef = useRef(sendMessage);
  useEffect(() => {
    contextualPromptSenderRef.current = sendMessage;
  }, [sendMessage]);
  useEffect(() => {
    const onContextPrompt = (event: Event) => {
      const detail = (event as CustomEvent<MeriContextPromptRequest>).detail;
      const prompt = detail?.prompt?.trim();
      if (!prompt) return;
      setChatOpen(true);
      void contextualPromptSenderRef.current(prompt);
    };
    window.addEventListener(MERI_CONTEXT_PROMPT_EVENT, onContextPrompt);
    return () => window.removeEventListener(MERI_CONTEXT_PROMPT_EVENT, onContextPrompt);
  }, []);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
    setChatOpen(false);
  }, []);

  // Stop: abort the in-flight stream. The server-side handler cancels the model
  // call on disconnect (P0-4); the partial answer streamed so far is kept.
  const submitFeedback = useCallback(
    async (messageId: string, feedback: MessageFeedbackPayload) => {
      const previous = messages.find((message) => message.id === messageId)?.feedback ?? null;
      setChatMessageFeedback(messageId, feedback.rating);
      try {
        const response = await fetch(
          `${config.apiBaseUrl}/api/clio/messages/${messageId}/feedback`,
          {
            method: 'POST',
            headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
            body: JSON.stringify(feedback),
          },
        );
        if (!response.ok) throw new Error(`Feedback save failed (${response.status})`);
      } catch {
        setChatMessageFeedback(messageId, previous);
        throw new Error('Feedback could not be saved. Please try again.');
      }
    },
    [authHeaders, messages],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  // Regenerate the last assistant answer, or edit-and-resend the last user
  // message (P0-4). Both trim the local thread, then re-run via sendMessage.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  const handleRegenerate = useCallback(() => {
    if (isStreaming) return;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    truncateMessagesAfter(lastUser.id);
    void sendMessage(lastUser.content, { mode: 'regenerate' });
  }, [isStreaming, messages, sendMessage]);

  // Approve a MeriV2 gate-held write (Phase 0): POST the opaque proposalId
  // only. The server revalidates the stored payload, recomputes the
  // fingerprint, rechecks the current policy, atomically claims the proposal,
  // and executes the EXACT stored input — there is no second model call and
  // nothing for the browser to replay or drift. The response is the complete,
  // authoritative updated proposal; the card just renders whatever status
  // comes back. Per Phase 0, approval NEVER automatically regenerates the
  // model turn — a result is shown on the card and the user decides what (if
  // anything) to say next.
  const executedThisRoundRef = useRef<PendingApproval[]>([]);

  const finishApprovalRound = useCallback(() => {
    const executed = executedThisRoundRef.current;
    executedThisRoundRef.current = [];
    if (executed.length === 0) return;
    // Include each action's own outcome. For create_client a succeeded result
    // carries "Name (id …)" in its summary, which the model needs in history
    // to propose the matching update_client_profile — otherwise it invents a
    // clientId from the display name and the follow-up write 404s.
    const names = executed
      .map((p) => `${p.preview.label} — ${describeApprovalOutcome(p)}`)
      .join('; ');
    appendChatMessage({
      id: generateId(),
      role: 'assistant',
      content: `${names}.`,
      createdAt: new Date(),
    });
  }, []);

  /**
   * Approve (or retry) ONE held write and record the outcome on its card.
   * Shared by the per-card button, "Approve all", and the typed-approval path
   * so all three behave identically — the proposalId is always the unit of
   * approval and the server is always the sole source of the result.
   *
   * Does not itself finish the round; callers decide when the round is over
   * (Approve all finishes once, not once per card).
   */
  const runApproval = useCallback(
    async (proposalId: string) => {
      setApprovingProposalId(proposalId);
      try {
        const res = await fetch(
          `${config.apiBaseUrl}/api/clio/action-proposals/${proposalId}/approve`,
          {
            method: 'POST',
            headers: await authHeaders(),
            body: JSON.stringify({}),
          },
        );
        if (!res.ok) {
          // A network/HTTP failure talking to the approve endpoint itself — the
          // server never even claimed the row. Leave the card in its last known
          // state; the user can just click again.
          return;
        }
        const proposal = (await res.json()) as PendingApproval;
        setPendingApprovals((prev) => upsertProposal(prev, proposal));
        if (proposal.status !== 'proposed' && proposal.status !== 'executing') {
          executedThisRoundRef.current = [...executedThisRoundRef.current, proposal];
        }
      } finally {
        setApprovingProposalId(null);
      }
    },
    [authHeaders],
  );

  runApprovalRef.current = runApproval;
  finishApprovalRoundRef.current = finishApprovalRound;

  const handleApprovePending = useCallback(
    async (proposalId: string) => {
      if (isStreaming || approvingProposalId) return;
      await runApproval(proposalId);
      finishApprovalRound();
    },
    [isStreaming, approvingProposalId, runApproval, finishApprovalRound],
  );

  /**
   * Approve every outstanding card, in the order they were proposed.
   *
   * Sequential on purpose: the approve endpoint executes each action for
   * real, and a create→update pair proposed in the same round must run in
   * order (the update needs the row the create makes). One failure does not
   * abort the rest — each card carries its own outcome.
   */
  const handleApproveAll = useCallback(async () => {
    if (isStreaming || approvingProposalId) return;
    const outstanding = outstandingApprovals(pendingApprovalsRef.current);
    for (const card of outstanding) {
      await runApproval(card.proposalId);
    }
    finishApprovalRound();
  }, [isStreaming, approvingProposalId, runApproval, finishApprovalRound]);

  /**
   * Dismiss is a durable server-side lifecycle transition, not a local hide —
   * removed from view optimistically (the server call is best-effort from the
   * UI's perspective; a resolved/expired proposal can never execute even if
   * this request is lost).
   */
  const handleDismissPending = useCallback(
    async (proposalId: string) => {
      setPendingApprovals((prev) => prev.filter((p) => p.proposalId !== proposalId));
      try {
        await fetch(`${config.apiBaseUrl}/api/clio/action-proposals/${proposalId}/dismiss`, {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({}),
        });
      } catch {
        /* optimistic; the card is already gone locally and server-side expiry/
           dismissal state does not depend on this request succeeding */
      }
    },
    [authHeaders],
  );

  // Recover outstanding/recent proposals from the server whenever the active
  // conversation changes (including on first load of a persisted session) —
  // cards must survive a page reload, not just live in memory for one tab.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${config.apiBaseUrl}/api/clio/action-proposals?conversationId=${encodeURIComponent(sessionId)}`,
          { headers: await authHeaders() },
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as PendingApproval[];
        if (!cancelled && Array.isArray(data)) setPendingApprovals(data);
      } catch {
        /* best-effort recovery; live SSE pending_approval events still work */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, authHeaders]);

  // Held-approval cards belong to ONE conversation — switching sessions must
  // not carry them over (approving would re-run the WRONG conversation's
  // turn). The recovery effect above re-populates them for the new session.
  useEffect(() => {
    setPendingApprovals([]);
    setResearchOffers({});
    executedThisRoundRef.current = [];
  }, [sessionId]);

  const handleEditResend = useCallback(() => {
    const text = editingText.trim();
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!text || !lastUser || isStreaming) return;
    updateChatMessage(lastUser.id, text);
    truncateMessagesAfter(lastUser.id);
    setEditingMessageId(null);
    void sendMessage(text, { mode: 'resend' });
  }, [editingText, isStreaming, messages, sendMessage]);

  const lastUserMessageId = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'user')?.id ?? null,
    [messages],
  );

  const fetchLearnedMemories = useCallback(async () => {
    try {
      const res = await fetch(`${config.apiBaseUrl}/api/clio/memory/recent?limit=5`, {
        headers: await authHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        setLearnedMemories(
          data
            .filter((m) => m && typeof m.id === 'string')
            .map((m) => ({
              id: String(m.id),
              key: String(m.key ?? ''),
              value: String(m.value ?? ''),
              scope: String(m.scope ?? ''),
              // Provenance/governance metadata is passed through verbatim. It used
              // to be dropped here, which is why the panel could only ever say
              // "Meri learned" regardless of scope, review state, or authority.
              clientId: typeof m.clientId === 'string' ? m.clientId : null,
              clientName: typeof m.clientName === 'string' ? m.clientName : null,
              source: typeof m.source === 'string' ? m.source : null,
              state: typeof m.state === 'string' ? m.state : null,
              confidence: typeof m.confidence === 'number' ? m.confidence : null,
              learnedAt: typeof m.learnedAt === 'string' ? m.learnedAt : null,
              confirmedAt: typeof m.confirmedAt === 'string' ? m.confirmedAt : null,
              expiresAt: typeof m.expiresAt === 'string' ? m.expiresAt : null,
              // Fail closed: only an explicit server `true` unlocks mutation.
              canMutate: m.canMutate === true,
            })),
        );
      }
    } catch {
      /* ignore */
    }
  }, [authHeaders]);

  /**
   * Propose a correction to memory this user cannot edit. The server creates a
   * PENDING candidate for admin review, so nothing is applied locally — showing
   * the new value as if it had taken effect would be exactly the client-inferred
   * success this phase forbids.
   */
  const suggestMemoryCorrection = useCallback(
    async (id: string, value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      try {
        const res = await fetch(
          `${config.apiBaseUrl}/api/clio/memory/${encodeURIComponent(id)}/suggest-correction`,
          {
            method: 'POST',
            headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: trimmed }),
          },
        );
        if (!res.ok) {
          setMetaError('The correction could not be sent for review. Nothing was changed.');
          return;
        }
        setMetaError('Correction sent for review. An administrator decides whether it applies.');
      } catch {
        setMetaError('The correction could not be sent for review. Nothing was changed.');
      }
    },
    [authHeaders],
  );

  const saveMemoryEdit = useCallback(
    async (id: string, value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setLearnedMemories((prev) => prev.map((m) => (m.id === id ? { ...m, value: trimmed } : m)));
      try {
        await fetch(`${config.apiBaseUrl}/api/clio/memory/${id}`, {
          method: 'PATCH',
          headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: trimmed }),
        });
      } catch {
        void fetchLearnedMemories();
      }
    },
    [authHeaders, fetchLearnedMemories],
  );

  const submitMemoryEdit = useCallback(
    async (id: string, currentValue: string) => {
      const next = window.prompt('Edit what Meri remembers:', currentValue);
      if (next == null || next.trim() === currentValue) return;
      await saveMemoryEdit(id, next);
    },
    [saveMemoryEdit],
  );

  const forgetMemory = useCallback(
    (id: string) => {
      const memory = learnedMemories.find((item) => item.id === id);
      if (!memory || forgetTimersRef.current.has(id)) return;
      setLearnedMemories((prev) => prev.filter((item) => item.id !== id));
      setForgottenMemories((prev) => [...prev.filter((item) => item.id !== id), memory]);
      const timer = window.setTimeout(() => {
        forgetTimersRef.current.delete(id);
        setForgottenMemories((prev) => prev.filter((item) => item.id !== id));
        void (async () => {
          try {
            await fetch(`${config.apiBaseUrl}/api/clio/memory/${id}`, {
              method: 'DELETE',
              headers: await authHeaders(),
            });
          } catch {
            setLearnedMemories((prev) =>
              prev.some((item) => item.id === id) ? prev : [...prev, memory],
            );
          }
        })();
      }, 6000);
      forgetTimersRef.current.set(id, timer);
    },
    [authHeaders, learnedMemories],
  );

  const undoForgetMemory = useCallback(
    (id: string) => {
      const memory = forgottenMemories.find((item) => item.id === id);
      if (!memory) return;
      const timer = forgetTimersRef.current.get(id);
      if (timer != null) window.clearTimeout(timer);
      forgetTimersRef.current.delete(id);
      setForgottenMemories((prev) => prev.filter((item) => item.id !== id));
      setLearnedMemories((prev) =>
        prev.some((item) => item.id === id) ? prev : [...prev, memory],
      );
    },
    [forgottenMemories],
  );

  // Fetch an authenticated research export (Word .doc or printable HTML) and
  // either download it or open it in a new browser tab via a blob URL.
  const fetchResearchExport = useCallback(
    async (researchId: string, kind: 'word' | 'html') => {
      try {
        const token = await getToken({ template: 'capiro' });
        const res = await fetch(
          `${config.apiBaseUrl}/api/clio/research/${researchId}/export/${kind}`,
          {
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(actAsTenantSlug ? { 'x-capiro-impersonate-tenant': actAsTenantSlug } : {}),
            },
          },
        );
        if (!res.ok) throw new Error(`Export failed (HTTP ${res.status})`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        if (kind === 'html') {
          window.open(url, '_blank', 'noopener,noreferrer');
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } else {
          const a = document.createElement('a');
          a.href = url;
          a.download = 'research-report.doc';
          a.click();
          URL.revokeObjectURL(url);
        }
      } catch {
        /* surfaced as a no-op; report text is still in the chat */
      }
    },
    [getToken, actAsTenantSlug],
  );

  const handleResizePointerMove = useCallback((event: PointerEvent) => {
    const state = resizingRef.current;
    if (!state) return;
    const deltaX = state.startX - event.clientX;
    const viewportWidth = window.innerWidth;
    const min = 360;
    const max = Math.max(min, Math.floor(viewportWidth * 0.9));
    const next = Math.max(min, Math.min(max, state.startWidth + deltaX));
    setDrawerWidth(next);
  }, []);

  const stopResize = useCallback(() => {
    const handle = drawerRef.current?.querySelector('.chat-resize-handle') as HTMLElement | null;
    if (handle) handle.classList.remove('is-dragging');
    resizingRef.current = null;
    window.removeEventListener('pointermove', handleResizePointerMove);
    window.removeEventListener('pointerup', stopResize);
    window.removeEventListener('pointercancel', stopResize);
  }, [handleResizePointerMove]);

  useEffect(() => () => stopResize(), [stopResize]);

  // After a streamed turn finishes, refresh the "Meri learned" chips. The
  // backend extracts memories fire-and-forget post-stream, so delay slightly.
  useEffect(() => {
    if (isStreaming || !sessionId) return;
    const t = setTimeout(() => {
      void fetchLearnedMemories();
    }, 1500);
    return () => clearTimeout(t);
  }, [isStreaming, sessionId, fetchLearnedMemories]);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const currentWidth = drawerRef.current?.getBoundingClientRect().width ?? drawerWidth;
      resizingRef.current = { startX: event.clientX, startWidth: currentWidth };
      event.currentTarget.classList.add('is-dragging');
      event.currentTarget.setPointerCapture(event.pointerId);
      window.addEventListener('pointermove', handleResizePointerMove);
      window.addEventListener('pointerup', stopResize);
      window.addEventListener('pointercancel', stopResize);
    },
    [drawerWidth, handleResizePointerMove, stopResize],
  );
  const showTypingIndicator =
    isStreaming &&
    messages.length > 0 &&
    messages[messages.length - 1]?.role === 'assistant' &&
    messages[messages.length - 1]?.content === '';

  return {
    isOpen,
    messages,
    sessionId,
    isStreaming,
    alertsBadge,
    pendingAlerts,
    alertsOpen,
    setAlertsOpen,
    sessionTitle,
    setSessionTitle,
    clients,
    selectedClientValue,
    // NOTE: the raw setSessionClientId setter is deliberately NOT exposed.
    // A scope that changes without being written to the conversation is the
    // 2026-07-29 cross-client leak — changeSessionClient is the only way in.
    changeSessionClient,
    activeConversationId,
    isSavingMeta,
    metaError,
    learnedMemories,
    forgottenMemories,
    learnedExpanded,
    setLearnedExpanded,
    orchestratorConflict,
    pendingApprovals,
    approvingProposalId,
    orchestratorTemplate,
    contextLabel,
    hideMeriFab,
    activeArtifact,
    setActiveArtifact,
    stagedAttachments,
    attachmentNotice,
    writeMode,
    researchMode,
    researchAwaitingAnswers,
    researchQuestions,
    researchReports,
    researchOffers,
    handleRunResearchOffer,
    lastUserMessageId,
    editingMessageId,
    setEditingMessageId,
    editingText,
    setEditingText,
    showTypingIndicator,
    messagesEndRef,
    orchestratorIntent,
    orchestratorTier,
    trustSteps,
    planSteps,
    drawerRef,
    drawerWidth,
    startResize,
    authHeaders,
    handleClose,
    handleNewSession,
    saveConversationMeta,
    archiveConversation,
    submitMemoryEdit,
    saveMemoryEdit,
    suggestMemoryCorrection,
    forgetMemory,
    undoForgetMemory,
    handleApprovePending,
    handleApproveAll,
    handleDismissPending,
    handleClearAllAlerts,
    handleDismissAlert,
    sendMessage,
    submitFeedback,
    handleRegenerate,
    handleEditResend,
    fetchResearchExport,
    submitResearchAnswers,
    handleStop,
    handleAttachFiles,
    removeStagedAttachment,
    setWriteMode,
    setResearchMode,
    setResearchAwaitingAnswers,
    setResearchQuestions,
    researchSessionRef,
  };
}

export type MeriChatController = ReturnType<typeof useMeriChatController>;
