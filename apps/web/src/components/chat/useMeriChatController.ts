import { readMeriTurnScope, type MeriTurnScope } from './meri-turn-scope.js';
import { meriRetrievalMetadata } from './meri-retrieval-metadata.js';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  addChatMessageDocumentArtifact,
  appendChatMessage,
  completeChatMessage,
  claimMeriIdentity,
  clearChatSession,
  MeriSourceAttribution,
  type ChatMessageRetrieval,
  type MeriCitation,
  type MeriVerification,
  getActiveDraft,
  getChatStateSnapshot,
  removeConversation,
  setAlerts,
  dismissAlert,
  setActiveConversation,
  setChatOpen,
  setChatSession,
  setChatMessageCitations,
  setChatMessageRuntimeStatus,
  setChatMessageRetrieval,
  setChatMessageVerification,
  setChatMessageThinking,
  setChatMessageGroundingCaveat,
  setChatMessageGroundingStatement,
  setChatMessageContextPacketId,
  setChatMessageTurnScope,
  setChatMessageSuggestions,
  setChatMessageFeedback,
  replaceChatMessageId,
  setStreaming,
  truncateMessagesAfter,
  updateChatMessage,
  upsertConversation,
  useChatStore,
} from './chat-store.js';
import { readMeriSavedDocumentArtifact } from './meri-artifact-download.js';
import { MERI_CONTEXT_PROMPT_EVENT, type MeriContextPromptRequest } from './meri-prompt.js';
import {
  mayApplyApprovalResult,
  mayApplyIdentityResult,
  meriEffectiveIdentityKey,
  type ScopePersistStatus,
} from './meri-route-guards.js';
import { formatMeriHttpError } from './meri-http-error.js';
import { mergeMeriRuntimeStatus, meriRuntimeStatus, type MeriRuntimeStatus } from './meri-runtime-status.js';
import {
  readRecoveredResearch,
  readResearchReportEvidence,
  readResearchRun,
  mayResumeResearch,
  type MeriRecoveredResearch,
  type MeriResearchRun,
} from './meri-research-recovery.js';
// UI-free shared modules — NOT the antd components. This controller is
// mounted on the vNext surface (vnext/meri/**), so a value import of
// ChatInput/WorkPerformed here would drag antd + legacy CSS into the
// os.capiro.ai runtime module graph.
import { isUsableAttachment, type StagedAttachment } from './chat-attachments.js';
import type { TrustStep } from './work-performed-shared.js';
import type { CanvasArtifact } from './MeriCanvas.js';
import type { MessageFeedbackPayload } from './message-feedback-shared.js';
import type { MeriLearnedMemory } from './MeriMemoryPanel.js';

type SseEvent =
  | { type: 'runtime'; telemetry?: Record<string, unknown> }
  | { type: 'turn_accepted'; messageId?: string }
  | {
      type: 'progress';
      note: string;
      elapsedMs?: number;
      phase?: string;
      runId?: string;
      accepted?: false;
    }
  | { type: 'start'; intent: string; tier?: 'fast' | 'deep'; reasoningMode?: string }
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
  | { type: 'grounding_statement'; statement?: string }
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
      /** Durable pack-authority binding that held the write (mirrors PublicMeriActionProposal.policy). */
      policy: {
        source: string;
        mode: string;
        packKey: string;
        packVersion: string;
        binding: string;
        decisionHash: string;
        contextHash: string;
        decision: string;
        jurisdiction: string;
        channel: string;
        recipientType: string | null;
      };
      preview: MeriActionPreview;
    }
  // Retrieval plan forwarded by the orchestrator's `done` frame. Absent on
  // legacy turns (and on turns that don't run the retrieval assistant), so
  // `retrieval` stays optional and older clients keep working. The shape
  // mirrors the backend's RetrievalFrame (version: 1).
  | {
      type: 'done';
      telemetry?: Record<string, unknown>;
      partial?: boolean;
      finishReason?: string;
      // The real `clio_messages.id` this turn was persisted under — absent
      // only when nothing was persisted (e.g. an empty/aborted reply).
      // Reconciles the client-generated optimistic id the assistant
      // placeholder was created under so feedback rated immediately after
      // streaming completes (before any refetch) targets a real message
      // instead of 400ing on the optimistic id.
      messageId?: string;
      contextPacketId?: string;
      turnScope?: MeriTurnScope;
      retrieval?: ChatMessageRetrieval;
    }
  | { type: 'error'; message: string; accepted?: false }
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
  | { type: 'run'; run: MeriResearchRun }
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
  | {
      type: 'report';
      reportMetadata?: Record<string, unknown>;
      artifactId?: string;
      messageId?: string | null;
      conversationId?: string;
      body?: string;
    }
  // Liveness heartbeat. A research run takes minutes and, on a workspace with
  // grounding enforcement on, streams no report text at all until the audit
  // clears it — so this is what tells the reader the run is alive, and what lets
  // the stall watchdog below distinguish "slow" from "dead".
  | { type: 'progress'; note: string; elapsedMs?: number; budgetMs?: number }
  // One-shot explanation of why the body will arrive all at once.
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done'; messageId?: string };

// No `progress` heartbeat (server cadence is 5s) for this long means the stream
// is dead, not slow: surface a real error instead of spinning on "Working…"
// forever. Generous enough to survive a paused laptop or a slow first byte.
const RESEARCH_STALL_MS = 120_000;

/** "1m 20s" / "45s" — elapsed time for the progress line. */
export function formatElapsed(ms: number): string {
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
  if (pathname.startsWith('/engagement')) return 'Engagement';
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
  /**
   * Compatibility switch for legacy drawer surfaces. vNext Meri owns memory
   * through Institutional Memory governance and must disable this adapter.
   */
  legacyMemoryEnabled?: boolean;
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
  policy: {
    source: string;
    mode: string;
    packKey: string;
    packVersion: string;
    binding: string;
    decisionHash: string;
    contextHash: string;
    decision: string;
    jurisdiction: string;
    channel: string;
    recipientType: string | null;
  };
  approvedAt?: string | null;
  approvedBy?: string | null;
  attemptCount: number;
  resultSummary: unknown;
  error?: { code: string | null; message: string | null };
  createdAt: string;
  updatedAt: string;
}

export function useMeriChatController({
  selectedClientName,
  legacyMemoryEnabled = true,
}: ChatDrawerProps) {
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
  const { getToken, orgId, userId } = useAuth();
  const api = useApi();
  const { actAsTenantSlug } = useImpersonation();
  const identityKey = meriEffectiveIdentityKey(actAsTenantSlug, orgId, userId);
  const { selectedClientId } = useClientFilter();
  const location = useLocation();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Every route/session boundary invalidates the previous async stream. Abort
  // alone cannot prevent a read that had already resolved from dispatching one
  // last SSE event into a newly selected conversation.
  const streamEpochRef = useRef(0);
  // Approval requests are separately asynchronous HTTP mutations. A route
  // transition increments this epoch before any new thread hydrates so a late
  // completion cannot repopulate cards or append an old thread's outcome.
  const routeEpochRef = useRef(0);
  const currentSessionRef = useRef<string | null>(sessionId);
  currentSessionRef.current = sessionId;
  const previousIdentityKeyRef = useRef<string | null>(null);
  // Always points to the identity currently rendering; asynchronous responses
  // compare their captured request identity to this before writing UI state.
  const identityKeyRef = useRef(identityKey);
  identityKeyRef.current = identityKey;

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
  const runApprovalRef = useRef<
    ((proposalId: string, sessionId?: string | null, routeEpoch?: number) => Promise<void>) | null
  >(null);
  const finishApprovalRoundRef = useRef<
    ((sessionId?: string | null, routeEpoch?: number) => void) | null
  >(null);
  const [approvingProposalId, setApprovingProposalId] = useState<string | null>(null);
  const [orchestratorTemplate, setOrchestratorTemplate] = useState<{
    heading: string;
    sections: string[];
  } | null>(null);
  const [isSavingMeta, setIsSavingMeta] = useState(false);
  const metadataRequestRef = useRef<object | null>(null);
  const feedbackRequestsRef = useRef(new Map<string, Promise<void>>());
  const [metaError, setMetaError] = useState<string | null>(null);
  // Server-confirmed client scope. The send path must use persistedClientId,
  // NOT the optimistic sessionClientId, to decide whether a send is safe.
  // sessionClientId tracks the visual selection; persistedClientId tracks the
  // durable server PATCH. They diverge while scope persistence is pending.
  const [persistedClientId, setPersistedClientId] = useState<string | null>(null);
  const [scopePersistStatus, setScopePersistStatus] = useState<ScopePersistStatus>('idle');
  // Monotonically increasing scope intent. Each changeSessionClient captures
  // the current value; on resolution it must still match to prevent an
  // out-of-order A→B→C PATCH from overwriting C's state with B's result.
  const scopeIntentRef = useRef(0);
  const [writeMode, setWriteMode] = useState(false);
  // Deep Research mode lives inside the chat: first message = topic (Meri plans +
  // asks clarifying questions), next message = answers (Meri runs the agentic
  // research and streams a cited report into the conversation).
  const [researchMode, setResearchMode] = useState(false);
  const researchSessionRef = useRef<string | null>(null);
  const [researchRecovery, setResearchRecovery] = useState<MeriRecoveredResearch | null>(null);
  const [researchRecoveryError, setResearchRecoveryError] = useState<string | null>(null);
  useLayoutEffect(() => {
    setResearchRecovery(null);
    setResearchRecoveryError(null);
  }, [identityKey, sessionId]);
  const [researchRecoveryVersion, refreshResearchRecovery] = useState(0);
  const researchStoppedRef = useRef(false);
  const researchMessageRef = useRef<{
    sessionId: string;
    messageId: string;
    phase: 'plan' | 'research';
  } | null>(null);
  const researchStreamActiveRef = useRef(false);
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
  // True only while a deep-research SSE stream (plan or gather/synthesize) is
  // actively being consumed — distinct from `isStreaming`, which is also true
  // for an ordinary chat reply. Lets the UI show research-specific progress
  // instead of the generic agent-run card.
  const [isResearchStreaming, setIsResearchStreaming] = useState(false);
  researchStreamActiveRef.current = isResearchStreaming;
  // Preserve server heartbeat elapsed time and stage. A time budget is not a
  // completion estimate; the progress display stays indeterminate.
  const [researchProgress, setResearchProgress] = useState<{
    note: string;
    elapsedMs: number;
    budgetMs?: number;
  } | null>(null);
  // The last finished assistant turn's retrieval plan, forwarded by the
  // orchestrator's `done` frame. Drives the truthful thread scope label
  // (CLIENT / PORTFOLIO / EXTERNAL RESEARCH / general) instead of the legacy
  // "Scoped · <client>" placeholder. Reset to null when a new turn starts.
  const [lastRetrieval, setLastRetrieval] = useState<ChatMessageRetrieval | null>(null);
  const [turnProgress, setTurnProgress] = useState<{ note: string; elapsedMs: number } | null>(
    null,
  );
  const resetActiveTurnWork = useCallback(() => {
    // These fields describe the pending reply. Completed messages already own
    // their work receipts, so clear live state before awaiting this turn's start
    // frame (context compilation can take time before the first event arrives).
    setTrustSteps([]);
    setPlanSteps([]);
    setOrchestratorIntent(null);
    setOrchestratorTier(null);
    setOrchestratorConflict(null);
    setOrchestratorTemplate(null);
    setLastRetrieval(null);
    setTurnProgress(null);
  }, []);
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
  }, [getToken, actAsTenantSlug, identityKey]);

  // Load alerts on mount so the closed launcher can show its pending badge;
  // recheck when Meri opens in case a scheduled briefing arrived meanwhile.
  useEffect(() => {
    const requestIdentityKey = identityKey;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${config.apiBaseUrl}/api/clio/alerts`, {
          headers: await authHeaders(),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (
          !cancelled &&
          mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current) &&
          Array.isArray(data)
        ) {
          setAlerts(data);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, authHeaders, identityKey]);

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
        fetch(`${config.apiBaseUrl}/api/clio/alerts/${id}/dismiss`, {
          method: 'POST',
          headers,
        }),
      ),
    );
  }, [alerts, authHeaders]);

  useEffect(() => {
    if (!isOpen) return;
    const requestIdentityKey = identityKey;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${config.apiBaseUrl}/api/clients`, {
          headers: await authHeaders(),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (
          !cancelled &&
          mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current) &&
          Array.isArray(data)
        ) {
          const options = data
            .map((client) => ({ id: String(client.id ?? ''), name: String(client.name ?? '') }))
            .filter((client) => Boolean(client.id && client.name));
          setClients(options);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, authHeaders, identityKey]);

  const activeConversation =
    conversations.find((conversation) => conversation.id === activeConversationId) ?? null;
  const savedConversationTitle = activeConversation?.title ?? '';
  const savedConversationClientId = activeConversation?.clientId ?? '';

  useEffect(() => {
    setSessionTitle(savedConversationTitle);
  }, [activeConversationId, savedConversationTitle]);

  useLayoutEffect(() => {
    // A late metadata response must never settle a newly selected thread's UI.
    metadataRequestRef.current = null;
    scopeIntentRef.current += 1;
    setIsSavingMeta(false);
    setMetaError(null);
  }, [activeConversationId]);

  useEffect(() => {
    // ONLY the conversation's own assignment. This used to fall back to the
    // global client filter, so the scope selector could display a client the
    // server had never been told about — the session then answered from the
    // whole firm's data while looking client-scoped (reported 2026-07-29).
    const conversationClientId = savedConversationClientId;
    setSessionClientId(conversationClientId);
    // Sync persistedClientId with the server-confirmed scope. This is the
    // authoritative value the send path checks against scopePersistStatus.
    setPersistedClientId(conversationClientId || null);
    setScopePersistStatus('idle');
    setMetaError(null);
  }, [activeConversationId, savedConversationClientId]);

  useEffect(() => {
    if (!messages.length) {
      setTrustSteps([]);
      setOrchestratorIntent(null);
      setOrchestratorTier(null);
      setOrchestratorConflict(null);
      setOrchestratorTemplate(null);
    }
  }, [messages.length]);

  const saveConversationMeta = useCallback(
    async (changes?: { title: string }): Promise<boolean> => {
      const title = (changes?.title ?? sessionTitle).trim();
      if (!activeConversationId || !title || metadataRequestRef.current) return false;
      const conversationId = activeConversationId;
      const requestIdentityKey = identityKeyRef.current;
      const request = {};
      metadataRequestRef.current = request;
      const isCurrentRequest = () =>
        metadataRequestRef.current === request &&
        getChatStateSnapshot().activeConversationId === conversationId &&
        mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current);
      setIsSavingMeta(true);
      setMetaError(null);
      try {
        // PRE-DISPATCH: authHeaders() is async, so an identity switch can resolve
        // between capture and send. Without this the PATCH would carry the new
        // tenant's credentials to the previous tenant's conversation id.
        const headers = await authHeaders();
        if (!isCurrentRequest()) return false;

        const res = await fetch(`${config.apiBaseUrl}/api/clio/conversations/${conversationId}`, {
          method: 'PATCH',
          headers,
          // Scope is persisted separately by changeSessionClient. A title save
          // must never resend a captured client selection over a newer scope.
          body: JSON.stringify({ title }),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(text || `HTTP ${res.status}`);
        }

        const updated = await res.json();
        if (!isCurrentRequest()) return false;
        if (updated?.id !== conversationId || updated.title !== title) {
          throw new Error('The server did not confirm the renamed thread.');
        }
        const current = getChatStateSnapshot().conversations.find(
          (row) => row.id === conversationId,
        );
        if (!current) return false;
        // Merge only the field this request changed. The response's scope and
        // latest message can predate a concurrent scope change or streamed reply.
        upsertConversation({ ...current, title: updated.title });
        setSessionTitle(updated.title);
        return true;
      } catch (err) {
        if (isCurrentRequest()) {
          const current = getChatStateSnapshot().conversations.find(
            (row) => row.id === conversationId,
          );
          setSessionTitle(current?.title ?? '');
          setMetaError(err instanceof Error ? err.message : 'Failed to save conversation settings');
        }
        return false;
      } finally {
        if (isCurrentRequest()) {
          metadataRequestRef.current = null;
          setIsSavingMeta(false);
        }
      }
    },
    [activeConversationId, authHeaders, sessionTitle],
  );

  /**
   * Assign the session's client and PERSIST it immediately — transactional
   * scope transition.
   *
   * On scope change:
   * 1. clear staged attachments if client actually changes
   * 2. set pending visual state (sessionClientId = new, scopePersistStatus = saving)
   * 3. PATCH durable session scope
   * 4. on success: commit persistedClientId, clear pending state
   * 5. on failure: revert visual selection to persisted client, show error
   *
   * The send path MUST use only persistedClientId/server-confirmed scope.
   * While scopePersistStatus === 'saving', Send is disabled.
   *
   * Uses a monotonically increasing scope intent to prevent out-of-order
   * resolution: if A→B→C sends two PATCHes and B resolves after C starts,
   * B's completion must NOT overwrite C's state.
   */
  const changeSessionClient = useCallback(
    async (clientId: string) => {
      const requestIdentityKey = identityKeyRef.current;
      const previous = persistedClientId;
      const nextClientId = clientId || null;
      if (nextClientId === previous) return;
      // No conversation yet: refuse the pick rather than showing a scope
      // nothing can be written to.
      if (!activeConversationId) {
        setMetaError('The session is still starting — set the client scope again in a moment.');
        return;
      }
      // Capture the intent sequence. Only the newest scope intent may commit.
      const intent = ++scopeIntentRef.current;
      // Optimistic visual state.
      setSessionClientId(clientId);
      setScopePersistStatus('saving');
      setMetaError(null);
      try {
        // PRE-DISPATCH: never scope the previous tenant's conversation using
        // the identity that authenticated while authHeaders() was pending.
        const headers = await authHeaders();
        if (
          intent !== scopeIntentRef.current ||
          getChatStateSnapshot().activeConversationId !== activeConversationId ||
          !mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)
        )
          return;
        const res = await fetch(
          `${config.apiBaseUrl}/api/clio/conversations/${activeConversationId}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ clientId: clientId || null }),
          },
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          let message = text;
          try {
            const body = JSON.parse(text) as { message?: unknown };
            if (typeof body.message === 'string') message = body.message;
          } catch { /* Plain-text errors remain readable. */ }
          throw new Error(message || `HTTP ${res.status}`);
        }
        const updated = await res.json();
        // INTENT CHECK: if a newer scope change (C) started while this
        // PATCH (B) was in flight, B must NOT overwrite C's state. Do not
        // commit persistedClientId, do not clear the pending status, do
        // not upsert the conversation.
        if (
          intent !== scopeIntentRef.current ||
          getChatStateSnapshot().activeConversationId !== activeConversationId ||
          !mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)
        ) {
          return;
        }
        if (updated?.id !== activeConversationId || (updated.clientId ?? null) !== nextClientId) {
          throw new Error('The server did not confirm the client scope.');
        }
        const current = getChatStateSnapshot().conversations.find(
          (row) => row.id === activeConversationId,
        );
        if (!current) return;
        upsertConversation({
          ...current,
          clientId: nextClientId,
          client: updated.client ?? null,
        });
        setPersistedClientId(nextClientId);
        setScopePersistStatus('idle');
      } catch (err) {
        // INTENT CHECK: only the newest scope intent may revert UI on failure.
        if (
          intent !== scopeIntentRef.current ||
          getChatStateSnapshot().activeConversationId !== activeConversationId ||
          !mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)
        ) {
          return;
        }
        setSessionClientId(previous ?? '');
        setScopePersistStatus('error');
        setMetaError(
          err instanceof Error
            ? `Could not change the client scope: ${err.message}`
            : 'Could not change the client scope',
        );
      }
    },
    [activeConversationId, authHeaders, persistedClientId],
  );

  const archiveConversation = useCallback(async (): Promise<boolean> => {
    if (!activeConversationId) return false;
    const requestIdentityKey = identityKeyRef.current;
    const conversationId = activeConversationId;
    try {
      // PRE-DISPATCH: an archive is a durable server mutation. Do not issue the
      // previous tenant's archive under the identity that just authenticated.
      const headers = await authHeaders();
      if (!mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)) return false;
      const res = await fetch(
        `${config.apiBaseUrl}/api/clio/conversations/${conversationId}/archive`,
        {
          method: 'PATCH',
          headers,
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }
      // The server mutation belongs to the identity that issued it, but its
      // delayed completion must never clear a newly authenticated identity.
      if (!mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)) return false;
      removeConversation(conversationId);
      clearChatSession();
      setTrustSteps([]);
      return true;
    } catch (err) {
      if (mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)) {
        setMetaError(err instanceof Error ? err.message : 'Failed to archive conversation');
      }
      return false;
    }
  }, [activeConversationId, authHeaders]);

  const doCreateSession = useCallback(async (): Promise<string | null> => {
    const requestIdentityKey = identityKeyRef.current;
    // The body carries the globally selected client id. Capture it with the
    // identity so a switch during authHeaders() cannot post one tenant's client
    // scope into a conversation created for the next one.
    const requestClientId = selectedClientId || undefined;
    try {
      const headers = await authHeaders();
      if (!mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)) return null;
      const res = await fetch(`${config.apiBaseUrl}/api/clio/conversations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          clientId: requestClientId,
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
        if (!mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)) return null;
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
      // The axios request interceptor acquires the token, so the dispatch half
      // cannot be fenced from here. Both branches below are keyed to a localId
      // that the identity reset has already removed, but assert the identity
      // explicitly rather than relying on that.
      const requestIdentityKey = identityKeyRef.current;
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
        if (!mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)) return;
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
                  pages: data.pages,
                  chars: data.chars,
                }
              : att,
          ),
        );
      } catch (err) {
        const serverMessage = axios.isAxiosError(err)
          ? (err.response?.data as { message?: string } | undefined)?.message
          : undefined;
        if (!mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)) return;
        setStagedAttachments((prev) =>
          prev.map((att) =>
            att.localId === localId
              ? {
                  ...att,
                  status: 'error',
                  reason: serverMessage || 'Upload failed — try again.',
                }
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

  useEffect(() => {
    const stageWorkspaceImport = (event: Event) => {
      const detail = (event as CustomEvent<{ attachmentId?: unknown; filename?: unknown }>).detail;
      const attachmentId = typeof detail?.attachmentId === 'string' ? detail.attachmentId : '';
      if (!attachmentId) return;
      const filename =
        typeof detail.filename === 'string' && detail.filename.trim()
          ? detail.filename.trim()
          : 'workspace-document.txt';
      setStagedAttachments((previous) => {
        if (previous.some((attachment) => attachment.id === attachmentId)) return previous;
        const active = previous.filter(
          (attachment) => attachment.status === 'uploading' || isUsableAttachment(attachment),
        );
        if (active.length >= MAX_ATTACHMENTS) {
          setAttachmentNotice(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
          return previous;
        }
        return [
          ...previous,
          {
            localId: `workspace-import-${attachmentId}`,
            id: attachmentId,
            filename,
            kind: 'text',
            status: 'parsed',
            reason: null,
          },
        ];
      });
    };
    window.addEventListener('meri-stage-existing-attachment', stageWorkspaceImport);
    return () => window.removeEventListener('meri-stage-existing-attachment', stageWorkspaceImport);
  }, []);

  // ── Deep Research (in-chat) ────────────────────────────────────────────
  // Reads an SSE stream from a research endpoint, dispatching each event.
  const consumeResearchStream = useCallback(
    async (
      path: string,
      controller: AbortController,
      onEvent: (e: ResearchSseEvent) => void,
      streamEpoch = streamEpochRef.current,
      resumeRunId?: string,
    ) => {
      const requestIdentityKey = identityKeyRef.current;
      const headers = await authHeaders();
      // PRE-DISPATCH: an identity switch during authHeaders() would stream a
      // prior tenant's research under the new tenant's credentials.
      if (!mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)) return;
      const res = await fetch(`${config.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          ...headers,
          ...(resumeRunId ? { 'x-meri-research-resume-run': resumeRunId } : {}),
        },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
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
          if (streamEpoch !== streamEpochRef.current || controller.signal.aborted) break outer;
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
          if (event.type === 'done') {
            completed = true;
            break outer;
          }
        }
      }
      await reader.cancel().catch(() => {});
      if (streamEpoch !== streamEpochRef.current || controller.signal.aborted) {
        throw new DOMException('Meri route changed', 'AbortError');
      }
      if (!completed) throw new Error('The research connection ended before a completion receipt.');
    },
    [authHeaders],
  );

  const executeResearchPlan = useCallback(
    async (
      id: string,
      controller: AbortController,
      initialAssistantId: string,
      streamEpoch: number,
      resumeRunId?: string,
    ) => {
      let assistantId = initialAssistantId;
      researchMessageRef.current = { sessionId: id, messageId: assistantId, phase: 'plan' };
      let planText = '';
      let questions: string[] = [];
      let runAnnounced = false;
      let planError: string | null = null;
      setIsResearchStreaming(true);
      setResearchProgress(null);
      await consumeResearchStream(
        `/api/clio/research/${id}/plan/stream`,
        controller,
        (e) => {
          if (e.type === 'run') {
            runAnnounced = readResearchRun(e.run) !== null;
          } else if (e.type === 'progress') {
            // Only until the plan itself starts arriving.
            if (!planText) {
              const elapsed =
                typeof e.elapsedMs === 'number' ? ` · ${formatElapsed(e.elapsedMs)} elapsed` : '';
              updateChatMessage(assistantId, `_${e.note}${elapsed}_`);
              setResearchProgress({
                note: e.note,
                elapsedMs: e.elapsedMs ?? 0,
                budgetMs: e.budgetMs,
              });
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
          } else if (
            e.type === 'done' &&
            typeof e.messageId === 'string' &&
            e.messageId !== assistantId
          ) {
            replaceChatMessageId(assistantId, e.messageId);
            assistantId = e.messageId;
            researchMessageRef.current = { sessionId: id, messageId: assistantId, phase: 'plan' };
          } else if (e.type === 'error') {
            planError = e.message;
            updateChatMessage(assistantId, `Error: ${e.message}`);
          }
        },
        streamEpoch,
        resumeRunId,
      );
      setIsResearchStreaming(false);
      setResearchProgress(null);
      if (planError) throw new Error(planError);
      // Render clarifying questions as an inline answer form (Claude-style),
      // not as text the user has to reply to free-form.
      if (runAnnounced && !planText) {
        refreshResearchRecovery((version) => version + 1);
        return;
      }
      setResearchQuestions(questions);
      setResearchAwaitingAnswers(questions.length > 0);
      refreshResearchRecovery((version) => version + 1);
      if (questions.length === 0) {
        // No questions — go straight to the run.
        await executeResearchRun(controller, undefined, streamEpoch);
      }
    },
    [consumeResearchStream],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const runResearch = useCallback(
    async (content: string): Promise<boolean> => {
      if (researchSessionRef.current && !researchAwaitingAnswers) {
        // Resume keeps the saved request. A new topic after a terminal or
        // interrupted run is a separate, explicit request and may start fresh.
        const saved = researchRecovery;
        if (!saved || saved.id !== researchSessionRef.current || !mayResumeResearch(saved.run))
          return false;
        researchSessionRef.current = null;
        setResearchRecovery(null);
      }
      const requestIdentityKey = identityKeyRef.current;
      const existingConversationId = currentSessionRef.current;
      const conversationId = existingConversationId ?? (await doCreateSession());
      if (!conversationId || !mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current))
        return false;
      const turnAttachments = researchSessionRef.current
        ? []
        : stagedAttachments.filter(isUsableAttachment);
      resetActiveTurnWork();
      // Echo the user's message into the conversation.
      appendChatMessage({
        id: generateId(),
        role: 'user',
        content,
        createdAt: new Date(),
        ...(turnAttachments.length
          ? {
              attachments: turnAttachments.map((attachment) => ({
                id: attachment.id as string,
                filename: attachment.filename,
                kind: attachment.kind,
                status: attachment.status,
              })),
            }
          : {}),
      });
      let assistantId = generateId();
      appendChatMessage({
        id: assistantId,
        role: 'assistant',
        content: '',
        createdAt: new Date(),
      });
      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      const streamEpoch = ++streamEpochRef.current;
      let accepted = false;
      researchStoppedRef.current = false;
      setResearchRecoveryError(null);

      try {
        if (!researchSessionRef.current) {
          // ── Phase 1: topic → plan + clarifying questions ──
          setTrustSteps([]);
          setOrchestratorIntent('deep_research');
          setOrchestratorTier('deep');
          // Scope and persisted reasoning come from the server-owned conversation.
          // Only new threads need the draft preference which predates that row.
          const draftReasoningMode = existingConversationId
            ? undefined
            : (
                await import('../../vnext/meri/VNextMeriReasoningControl.js')
              ).readDraftReasoningMode(requestIdentityKey);
          const createHeaders = await authHeaders();
          if (
            !mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current) ||
            streamEpoch !== streamEpochRef.current
          )
            return accepted;
          const created = await fetch(`${config.apiBaseUrl}/api/clio/research`, {
            method: 'POST',
            headers: createHeaders,
            body: JSON.stringify({
              topic: content,
              conversationId,
              attachmentIds: turnAttachments.map((attachment) => attachment.id),
              ...(draftReasoningMode ? { reasoningMode: draftReasoningMode } : {}),
            }),
            signal: controller.signal,
          });
          if (!created.ok) throw new Error(`Could not start research (HTTP ${created.status})`);
          accepted = true;
          const { id } = (await created.json()) as { id: string };
          // A route change may happen while research creation is awaiting the
          // server. Do not start its plan stream or write a session id into the
          // destination thread once that request's epoch has been invalidated.
          if (streamEpoch !== streamEpochRef.current || controller.signal.aborted) return accepted;
          researchSessionRef.current = id;
          const consumedIds = new Set(turnAttachments.map((attachment) => attachment.localId));
          setStagedAttachments((previous) =>
            previous.filter((attachment) => !consumedIds.has(attachment.localId)),
          );

          await executeResearchPlan(id, controller, assistantId, streamEpoch);
          return accepted;
        }

        // ── Phase 2 (free-text fallback): a typed reply during awaiting state ──
        // The inline form is the primary path; this handles a user who just types.
        const id = researchSessionRef.current;
        const clarifyHeaders = await authHeaders();
        if (
          !mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current) ||
          streamEpoch !== streamEpochRef.current
        )
          return accepted;
        const clarified = await fetch(`${config.apiBaseUrl}/api/clio/research/${id}/clarify`, {
          method: 'POST',
          headers: clarifyHeaders,
          body: JSON.stringify({ answers: { '0': content } }),
          signal: controller.signal,
        });
        accepted = clarified.ok;
        if (streamEpoch !== streamEpochRef.current) return accepted;
        if (!clarified.ok)
          throw new Error(`Could not save clarification answers (HTTP ${clarified.status})`);
        accepted = true;
        setResearchAwaitingAnswers(false);
        setResearchQuestions([]);
        await executeResearchRun(controller, assistantId, streamEpoch);
      } catch (err) {
        if (streamEpoch !== streamEpochRef.current) return accepted;
        const stopped = researchStoppedRef.current;
        updateChatMessage(
          assistantId,
          stopped
            ? '_Research stopped._'
            : '_The research connection was interrupted. Checking the saved run…_',
        );
        refreshResearchRecovery((version) => version + 1);
        setResearchAwaitingAnswers(false);
        setResearchQuestions([]);
      } finally {
        if (streamEpoch === streamEpochRef.current) {
          setStreaming(false);
          setIsResearchStreaming(false);
          setResearchProgress(null);
        }
      }
      return accepted;
    },
    // executeResearchRun is stable via useCallback below; deps kept minimal.
    [
      authHeaders,
      executeResearchPlan,
      doCreateSession,
      stagedAttachments,
      researchAwaitingAnswers,
      researchRecovery,
      resetActiveTurnWork,
    ], // eslint-disable-line react-hooks/exhaustive-deps
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
    async (
      controller: AbortController,
      existingAssistantId?: string,
      streamEpoch = streamEpochRef.current,
      resumeRunId?: string,
    ) => {
      if (streamEpoch !== streamEpochRef.current) return;
      const id = researchSessionRef.current;
      if (!id) return;
      let assistantId = existingAssistantId ?? generateId();
      researchMessageRef.current = { sessionId: id, messageId: assistantId, phase: 'research' };
      if (!existingAssistantId) {
        appendChatMessage({
          id: assistantId,
          role: 'assistant',
          content: '',
          createdAt: new Date(),
        });
      }
      setTrustSteps([]);
      setIsResearchStreaming(true);
      setResearchProgress(null);
      let report = '';
      let completedReport = false;
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
        await consumeResearchStream(
          `/api/clio/research/${id}/stream`,
          controller,
          (e) => {
            if (e.type === 'run') {
              refreshResearchRecovery((version) => version + 1);
            } else if (e.type === 'step') {
              const label = e.label || e.tool;
              setTrustSteps((prev) => [
                ...prev,
                { tool: e.tool, label, status: 'running' as const },
              ]);
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
              setResearchProgress({
                note: e.note,
                elapsedMs: e.elapsedMs ?? 0,
                budgetMs: e.budgetMs,
              });
            } else if (e.type === 'notice') {
              deliveryNotice = `_${e.message}_`;
              renderProgress();
            } else if (e.type === 'thinking') {
              // Raw research reasoning is discarded rather than buffered.
            } else if (e.type === 'text') {
              report += e.text;
              updateChatMessage(assistantId, report);
            } else if (e.type === 'report' && typeof e.body === 'string') {
              completedReport = true;
              report = e.body;
              const canonicalId =
                typeof e.messageId === 'string' && e.messageId ? e.messageId : assistantId;
              completeChatMessage(assistantId, {
                id: canonicalId,
                content: report,
                ...(e.reportMetadata ? readResearchReportEvidence(e.reportMetadata) : {}),
              });
              assistantId = canonicalId;
              researchMessageRef.current = {
                sessionId: id,
                messageId: assistantId,
                phase: 'research',
              };
            } else if (e.type === 'error') {
              updateChatMessage(assistantId, `${report}\n\n_Error: ${e.message}_`);
            }
          },
          streamEpoch,
          resumeRunId,
        );
      } catch (err) {
        // A stalled or dropped stream must end as a readable failure, not as a
        // message stuck on the last progress line. A user-initiated Stop keeps
        // whatever streamed so far and is not an error.
        if (streamEpoch !== streamEpochRef.current) return;
        if (err instanceof Error && err.name === 'AbortError') {
          if (!report)
            updateChatMessage(
              assistantId,
              researchStoppedRef.current
                ? '_Research stopped._'
                : '_Research continues on the server. Checking its saved status…_',
            );
          refreshResearchRecovery((version) => version + 1);
          return;
        }
        const message = err instanceof Error ? err.message : 'unknown error';
        updateChatMessage(
          assistantId,
          report
            ? `${report}\n\n_Research interrupted: ${message}_`
            : `_Research failed: ${message}_`,
        );
        refreshResearchRecovery((version) => version + 1);
        return;
      } finally {
        if (streamEpoch === streamEpochRef.current) {
          setIsResearchStreaming(false);
          setResearchProgress(null);
        }
      }
      if (streamEpoch !== streamEpochRef.current) return;
      // Mark this message as a finished report so export actions render.
      const finishedId = researchSessionRef.current;
      if (finishedId && completedReport)
        setResearchReports((prev) => ({ ...prev, [assistantId]: finishedId }));
      // Reset for the next research request in this conversation.
      if (completedReport) researchSessionRef.current = null;
      refreshResearchRecovery((version) => version + 1);
    },
    [consumeResearchStream],
  );

  // Reopen only this identity's saved request. Reads never restart provider work.
  useEffect(() => {
    const conversationId = sessionId;
    if (!conversationId || !identityKey || isStreaming || isResearchStreaming) return;
    const requestIdentityKey = identityKey;
    const requestEpoch = streamEpochRef.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const current = () =>
      !cancelled &&
      !researchStreamActiveRef.current &&
      requestEpoch === streamEpochRef.current &&
      currentSessionRef.current === conversationId &&
      mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current);
    const restore = async () => {
      try {
        const headers = await authHeaders();
        if (!current()) return;
        const listed = await fetch(
          `${config.apiBaseUrl}/api/clio/research?conversationId=${encodeURIComponent(conversationId)}`,
          {
            headers,
            signal: controller.signal,
          },
        );
        if (!listed.ok) throw new Error('Saved research status is unavailable.');
        const rows: unknown = await listed.json();
        if (!current() || !Array.isArray(rows)) return;
        const latest = rows.map((row) => readRecoveredResearch(row, conversationId)).find(Boolean);
        if (!latest) return;
        const response = await fetch(
          `${config.apiBaseUrl}/api/clio/research/${encodeURIComponent(latest.id)}`,
          {
            headers,
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error('Saved research status is unavailable.');
        const recovered = readRecoveredResearch(await response.json(), conversationId);
        if (!current() || !recovered) return;
        setResearchRecoveryError((previous) =>
          previous?.startsWith('Stop was not confirmed') && recovered.run.status === 'running'
            ? previous
            : null,
        );
        setResearchRecovery(recovered);
        const finished = recovered.run.phase === 'research' && recovered.run.status === 'complete';
        researchSessionRef.current =
          finished || recovered.run.status === 'cancelled' ? null : recovered.id;
        const awaiting = recovered.run.status === 'awaiting_clarification';
        setResearchQuestions(awaiting ? recovered.questions : []);
        setResearchAwaitingAnswers(awaiting && recovered.questions.length > 0);
        const messagesNow = getChatStateSnapshot().messages;
        if (recovered.reportMessageId && recovered.report !== null) {
          const pendingId =
            researchMessageRef.current?.sessionId === recovered.id &&
            researchMessageRef.current.phase === 'research'
              ? researchMessageRef.current.messageId
              : `research-recovery-${recovered.id}`;
          completeChatMessage(pendingId, {
            id: recovered.reportMessageId,
            content: recovered.report,
            ...recovered.reportEvidence,
          });
          setResearchReports((previous) => ({
            ...previous,
            [recovered.reportMessageId!]: recovered.id,
          }));
        } else if (recovered.planMessageId && recovered.plan.length) {
          const planBody = `**Research plan — ${recovered.title}**\n\n${recovered.plan.map((step, index) => `${index + 1}. ${step}`).join('\n')}`;
          if (!messagesNow.some((message) => message.id === recovered.planMessageId)) {
            const pendingId =
              researchMessageRef.current?.sessionId === recovered.id &&
              researchMessageRef.current.phase === 'plan'
                ? researchMessageRef.current.messageId
                : null;
            if (pendingId && messagesNow.some((message) => message.id === pendingId))
              replaceChatMessageId(pendingId, recovered.planMessageId);
            else
              appendChatMessage({
                id: recovered.planMessageId,
                role: 'assistant',
                content: planBody,
                createdAt: new Date(),
              });
          }
          updateChatMessage(recovered.planMessageId, planBody);
        } else if (!messagesNow.some((message) => message.role === 'assistant')) {
          appendChatMessage({
            id: `research-recovery-${recovered.id}`,
            role: 'assistant',
            createdAt: new Date(),
            content: `**${recovered.title}**`,
          });
        }
        if (recovered.run.status === 'running') timer = setTimeout(() => void restore(), 5_000);
      } catch (error) {
        if (!current() || controller.signal.aborted) return;
        if (researchSessionRef.current)
          setResearchRecoveryError('Could not verify research status. Retrying…');
        timer = setTimeout(() => void restore(), 10_000);
      }
    };
    void restore();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [
    authHeaders,
    identityKey,
    isStreaming,
    isResearchStreaming,
    sessionId,
    researchRecoveryVersion,
  ]);

  const resumeResearch = useCallback(async () => {
    const saved = researchRecovery;
    if (
      !saved ||
      isStreaming ||
      currentSessionRef.current !== saved.conversationId ||
      (!mayResumeResearch(saved.run) &&
        !(saved.run.status === 'awaiting_clarification' && saved.questions.length === 0))
    )
      return;
    researchSessionRef.current = saved.id;
    researchStoppedRef.current = false;
    setResearchRecoveryError(null);
    setResearchRecovery(null);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const streamEpoch = ++streamEpochRef.current;
    const existing = getChatStateSnapshot().messages;
    const assistantId =
      saved.run.phase === 'plan'
        ? (saved.planMessageId ?? `research-recovery-${saved.id}`)
        : `research-recovery-${saved.id}`;
    if (!existing.some((message) => message.id === assistantId))
      appendChatMessage({
        id: assistantId,
        role: 'assistant',
        content: '',
        createdAt: new Date(),
      });
    try {
      if (
        saved.run.phase === 'plan' &&
        saved.run.status !== 'awaiting_clarification' &&
        saved.run.status !== 'complete'
      ) {
        await executeResearchPlan(saved.id, controller, assistantId, streamEpoch, saved.run.id);
      } else {
        await executeResearchRun(controller, assistantId, streamEpoch, saved.run.id);
      }
    } catch (error) {
      if (streamEpoch === streamEpochRef.current)
        updateChatMessage(
          assistantId,
          '_Research connection interrupted. Checking the saved run…_',
        );
    } finally {
      if (streamEpoch === streamEpochRef.current) {
        setStreaming(false);
        setIsResearchStreaming(false);
        refreshResearchRecovery((version) => version + 1);
      }
    }
  }, [executeResearchPlan, executeResearchRun, isStreaming, researchRecovery]);

  // Submit per-question answers from the inline clarify form, then run research.
  const submitResearchAnswers = useCallback(
    async (answers: Record<string, string>, skipped: boolean) => {
      const id = researchSessionRef.current;
      if (!id || isStreaming) return;
      researchStoppedRef.current = false;
      setResearchAwaitingAnswers(false);
      setResearchQuestions([]);
      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      const streamEpoch = ++streamEpochRef.current;
      const requestIdentityKey = identityKeyRef.current;
      try {
        const headers = await authHeaders();
        if (
          !mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current) ||
          streamEpoch !== streamEpochRef.current
        )
          return;
        const clarified = await fetch(`${config.apiBaseUrl}/api/clio/research/${id}/clarify`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ answers: skipped ? {} : answers }),
          signal: controller.signal,
        });
        if (streamEpoch !== streamEpochRef.current) return;
        if (!clarified.ok)
          throw new Error(`Could not save clarification answers (HTTP ${clarified.status})`);
        await executeResearchRun(controller, undefined, streamEpoch);
      } catch (err) {
        if (streamEpoch !== streamEpochRef.current) return;
        refreshResearchRecovery((version) => version + 1);
        if (!(err instanceof Error && err.name === 'AbortError'))
          appendChatMessage({
            id: generateId(),
            role: 'assistant',
            createdAt: new Date(),
            content: `Research failed: ${err instanceof Error ? err.message : 'unknown error'}`,
          });
      } finally {
        if (streamEpoch === streamEpochRef.current) setStreaming(false);
      }
    },
    [authHeaders, executeResearchRun, isStreaming],
  );

  const sendMessage = useCallback(
    async (content: string, opts?: { mode?: 'regenerate' | 'resend' }): Promise<boolean> => {
      if (isStreaming) return false;
      // Every server call this turn makes belongs to the identity that typed it.
      const requestIdentityKey = identityKeyRef.current;

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
            const approvalSessionId = currentSessionRef.current;
            const approvalRouteEpoch = routeEpochRef.current;
            appendChatMessage({
              id: generateId(),
              role: 'assistant',
              content: `Approving **${card.preview.label}** and running it now.`,
              createdAt: new Date(),
            });
            await runApprovalRef.current?.(card.proposalId, approvalSessionId, approvalRouteEpoch);
            finishApprovalRoundRef.current?.(approvalSessionId, approvalRouteEpoch);
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
          return true;
        }
      }

      // Deep Research mode is handled by a dedicated multi-phase flow (new turns only).
      if (researchMode && !mode) {
        return runResearch(content);
      }

      const writePrefix = 'write on this page:';
      const outgoing = mode ? content : writeMode ? `${writePrefix} ${content}` : content;

      // Ensure we have a session ID (create one if missing)
      let sid = sessionId;
      if (!sid) {
        sid = await doCreateSession();
      }
      if (!sid) return false;

      // Staged attachments ride along on new turns only (regenerate/resend re-run
      // the already-persisted user turn server-side). Unusable chips (id === null)
      // are never sent.
      const turnAttachments = mode ? [] : stagedAttachments.filter(isUsableAttachment);
      const attachmentIds = turnAttachments
        .map((att) => att.id)
        .filter((id): id is string => Boolean(id));

      resetActiveTurnWork();

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
                  pages: att.pages,
                  chars: att.chars,
                })),
              }
            : {}),
        });
        // Clear the staging row (including any failed chips) as the send starts.
        setStagedAttachments([]);
        setAttachmentNotice(null);
      }

      const assistantId = generateId();
      let canonicalAssistantId = assistantId;
      appendChatMessage({
        id: assistantId,
        role: 'assistant',
        content: '',
        createdAt: new Date(),
        runtimeStatus: meriRuntimeStatus({ type: 'start' }),
      });

      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      const streamEpoch = ++streamEpochRef.current;
      // This stream's callbacks own only this assistant placeholder. The epoch
      // rejects a replaced request; the signal also rejects a read that already
      // fulfilled when Stop was clicked, before another request starts.
      const isCurrentTurn = () =>
        streamEpoch === streamEpochRef.current &&
        !controller.signal.aborted &&
        mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current);

      // Meri v6 thinking-persistence piece 1: local (non-state) accumulators
      // mirroring every setOrchestratorTier/setOrchestratorIntent/setPlanSteps/
      // setTrustSteps call below. This closure's useCallback deps deliberately
      // don't include that React state (see the dependency array below), so
      // reading it directly at completion time would read a STALE value, not
      // what actually accumulated this turn — the same trap `accumulated`
      // below already avoids for the message text. Read only in `finally`.
      // Declared HERE, before `try`, not next to `accumulated` inside it: a
      // `let`/`const` scoped to a `try` block is NOT visible from its sibling
      // `finally` block (a real bug caught by tsc — TS2304 — during this
      // change's own verification), so these must live in the enclosing scope.
      let turnTrustSteps: TrustStep[] = [];
      let turnPlanSteps: string[] = [];
      let turnIntent: string | null = null;
      let turnTier: 'fast' | 'deep' | null = null;
      let turnRuntimeStatus: MeriRuntimeStatus | undefined;
      let turnCompletionReceived = false;
      let accepted = false;

      try {
        const streamPayload: Record<string, unknown> = mode
          ? { body: outgoing, mode }
          : { body: outgoing };
        if (!mode && attachmentIds.length > 0) streamPayload.attachmentIds = attachmentIds;
        const streamHeaders = await authHeaders();
        // PRE-DISPATCH: authHeaders() is async, so an identity switch can land
        // while it is pending. Never send this identity's request under the
        // credentials of the one that just authenticated.
        if (!isCurrentTurn()) return false;
        const res = await fetch(`${config.apiBaseUrl}/api/clio/conversations/${sid}/stream`, {
          method: 'POST',
          headers: streamHeaders,
          body: JSON.stringify(streamPayload),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (!isCurrentTurn()) return false;
          turnRuntimeStatus = meriRuntimeStatus({ type: 'error' });
          updateChatMessage(assistantId, formatMeriHttpError(res.status, text, res.statusText));
          return false;
        }

        if (!res.body) {
          if (!isCurrentTurn()) return false;
          turnRuntimeStatus = meriRuntimeStatus({ type: 'error' });
          updateChatMessage(assistantId, 'No response body received.');
          return false;
        }

        const reader = res.body.getReader();
        if (!isCurrentTurn()) {
          await reader.cancel().catch(() => {});
          return accepted;
        }
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
            // A route switch can race one final fulfilled reader.read(). Ignore
            // that stale event rather than letting the former thread mutate the
            // currently selected thread's shared controller state.
            if (!isCurrentTurn()) break outer;
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;
            let event: SseEvent;
            try {
              event = JSON.parse(jsonStr) as SseEvent;
            } catch {
              continue;
            }

            // HTTP headers alone can precede durable turn acceptance. Older
            // runtimes lack the explicit receipt, but their actual runtime
            // frames still establish acceptance; progress and an empty done do
            // not, and an explicit setup rejection must survive its done frame.
            if (event.type !== 'progress' && event.type !== 'done' && event.type !== 'error')
              accepted = true;

            if (event.type === 'turn_accepted') {
              // Persistence is acknowledged separately from starting the model.
              // Keep context/provider progress and work state untouched.
              accepted = true;
            } else if (event.type === 'progress') {
              // The API can open SSE while preparing context, before the user
              // turn is persisted. Stop in that window must restore the draft.
              if (event.accepted === false) accepted = false;
              if (typeof event.note === 'string' && event.note.trim())
                setTurnProgress({
                  note: event.note,
                  elapsedMs:
                    typeof event.elapsedMs === 'number' && Number.isFinite(event.elapsedMs)
                      ? Math.max(0, event.elapsedMs)
                      : 0,
                });
            } else if (event.type === 'start') {
              accepted = true;
              setTurnProgress(null);
              const status = meriRuntimeStatus(event);
              if (status) {
                turnRuntimeStatus = mergeMeriRuntimeStatus(turnRuntimeStatus, status);
                setChatMessageRuntimeStatus(assistantId, turnRuntimeStatus);
              }
              setOrchestratorTier(event.tier ?? null);
              setOrchestratorIntent(event.intent ?? null);
              setTrustSteps([]);
              setPlanSteps([]);
              turnTier = event.tier ?? null;
              turnIntent = event.intent ?? null;
              turnTrustSteps = [];
              turnPlanSteps = [];
              // NOTE: pendingApprovals is deliberately NOT cleared here. Clearing
              // it on every turn is what made "I approve" a no-op — the new turn
              // wiped the cards, the model re-proposed under a fresh fingerprint,
              // and nothing was ever written. Cards clear on approve, on dismiss,
              // or on a session switch, and nowhere else.
            } else if (event.type === 'runtime') {
              const status = meriRuntimeStatus(event);
              turnRuntimeStatus = status ? mergeMeriRuntimeStatus(turnRuntimeStatus, status) : turnRuntimeStatus;
              if (status) setChatMessageRuntimeStatus(assistantId, status);
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
                  policy: event.policy,
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
              if (event.policy?.tier) {
                setOrchestratorTier(event.policy.tier);
                turnTier = event.policy.tier;
              }
            } else if (event.type === 'plan') {
              setPlanSteps(Array.isArray(event.steps) ? event.steps : []);
              turnPlanSteps = Array.isArray(event.steps) ? event.steps : [];
            } else if (event.type === 'tool_call') {
              // Live agentic tool call — push a "running" step into the trust
              // timeline; the matching `sources` event flips it to done/error.
              const label = event.label || event.tool;
              setTrustSteps((prev) => [
                ...prev,
                { tool: event.tool, label, status: 'running' as const },
              ]);
              turnTrustSteps.push({ tool: event.tool, label, status: 'running' as const });
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
                for (let i = turnTrustSteps.length - 1; i >= 0; i -= 1) {
                  if (
                    turnTrustSteps[i]!.status === 'running' &&
                    turnTrustSteps[i]!.tool === src.tool
                  ) {
                    turnTrustSteps[i] = {
                      ...turnTrustSteps[i]!,
                      label: src.label || turnTrustSteps[i]!.label,
                      detail: src.summary,
                      count: typeof src.count === 'number' ? src.count : turnTrustSteps[i]!.count,
                      confidence: src.confidence,
                      status: src.confidence === 'low' ? 'error' : 'done',
                    };
                    break;
                  }
                }
              }
            } else if (event.type === 'citations') {
              setChatMessageCitations(
                assistantId,
                Array.isArray(event.citations) ? event.citations : [],
              );
            } else if (event.type === 'grounding_statement') {
              if (typeof event.statement === 'string' && event.statement.trim()) {
                setChatMessageGroundingStatement(assistantId, event.statement);
              }
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
                const savedDocument = readMeriSavedDocumentArtifact(event.artifact);
                if (savedDocument) addChatMessageDocumentArtifact(assistantId, savedDocument);
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
              if (event.messageId) accepted = true;
              const status = meriRuntimeStatus(
                turnRuntimeStatus?.lifecycle === 'failed' && !event.finishReason
                  ? { ...event, finishReason: 'error', partial: true }
                  : event,
              );
              turnCompletionReceived = true;
              turnRuntimeStatus = status ? mergeMeriRuntimeStatus(turnRuntimeStatus, status) : turnRuntimeStatus;
              if (status) setChatMessageRuntimeStatus(assistantId, status);
              // Evidence must resolve the immutable packet from this response,
              // never whichever packet happened to be compiled most recently.
              if (typeof event.contextPacketId === 'string' && event.contextPacketId) {
                setChatMessageContextPacketId(assistantId, event.contextPacketId);
              }
              const turnScope = readMeriTurnScope(event.turnScope);
              if (turnScope) setChatMessageTurnScope(assistantId, turnScope);
              // Capture the backend retrieval plan (subjectScope, coverage)
              // so the thread scope label reflects the actual retrieval scope
              // instead of always printing "Client context · <client>".
              const retrieval = meriRetrievalMetadata(event.retrieval);
              if (retrieval) {
                setChatMessageRetrieval(assistantId, retrieval);
                setLastRetrieval(retrieval);
              }
              // Reconcile the optimistic id LAST, after every mutation above
              // that still needs to match by the id this message was created
              // under. Without this, rating the message immediately after
              // the stream finishes (before any refetch re-hydrates real
              // ids) posts the optimistic id, which the server can't
              // resolve, and the feedback — plus the LearningSignal/telemetry
              // capture behind it — is silently lost.
              if (
                typeof event.messageId === 'string' &&
                event.messageId &&
                event.messageId !== assistantId
              ) {
                const canonicalId = event.messageId;
                canonicalAssistantId = canonicalId;
                replaceChatMessageId(assistantId, canonicalId);
                setResearchOffers((prev) => {
                  if (!(assistantId in prev)) return prev;
                  const { [assistantId]: offer, ...rest } = prev;
                  return { ...rest, [canonicalId]: offer! };
                });
              }
              break outer;
            } else if (event.type === 'error') {
              accepted = event.accepted !== false;
              const status = meriRuntimeStatus(event)!;
              turnRuntimeStatus = mergeMeriRuntimeStatus(turnRuntimeStatus, status);
              setChatMessageRuntimeStatus(assistantId, turnRuntimeStatus);
              updateChatMessage(assistantId, `Error: ${event.message}`);
              // Errors after a persisted user turn can still be followed by
              // done with the assistant id, work receipt and partial status.
              // Drain that frame so feedback/history target the durable row.
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
        if (!isCurrentTurn() || (err instanceof Error && err.name === 'AbortError'))
          return accepted;
        turnRuntimeStatus = mergeMeriRuntimeStatus(turnRuntimeStatus, meriRuntimeStatus({ type: 'error' })!);
        updateChatMessage(assistantId, 'Failed to get a response. Please try again.');
      } finally {
        // Meri v6 thinking-persistence piece 1: attach whatever plan/trust-step/
        // intent/tier data accumulated this turn (the LOCAL turnXxx variables,
        // never the React state — see the staleness note by `accumulated`
        // above) to this assistant message. `finally` guarantees this fires on
        // every exit path — done, silent stream close, thrown error, or abort —
        // so it deliberately runs unconditionally here, NOT gated by the
        // streamEpoch check below: a route-switch abort bumps streamEpoch
        // before this runs, and gating on it would silently drop a still-valid
        // historical message's data merely because a newer stream started
        // elsewhere.
        setChatMessageThinking(canonicalAssistantId, {
          orchestratorIntent: turnIntent,
          orchestratorTier: turnTier,
          planSteps: turnPlanSteps,
          trustSteps: turnTrustSteps,
        });
        if (!turnCompletionReceived)
          setChatMessageRuntimeStatus(canonicalAssistantId, {
            requestedEffort: null,
            effectiveEffort: null,
            adjusted: false,
            ...turnRuntimeStatus,
            lifecycle: controller.signal.aborted ? 'stopped' : turnRuntimeStatus?.lifecycle === 'failed' ? 'failed' : 'incomplete',
            partial: true,
            stopped: controller.signal.aborted,
          });
        // An older stream must never unlock a newly-selected thread or a newer
        // request that is now in progress.
        if (streamEpoch === streamEpochRef.current) {
          setStreaming(false);
          setTurnProgress(null);
        }
      }
      return accepted;
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
      resetActiveTurnWork,
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
      const requestIdentityKey = identityKeyRef.current;
      const requestSession = currentSessionRef.current;
      const requestEpoch = routeEpochRef.current;
      const key = `${requestIdentityKey}:${messageId}`;
      const stillOwnsMessage = () =>
        mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current) &&
        currentSessionRef.current === requestSession && routeEpochRef.current === requestEpoch;
      // Serialize changes to one message so network order matches user intent.
      // Read the rollback value from the live store after the prior save settles.
      const task = (feedbackRequestsRef.current.get(key) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          if (!stillOwnsMessage()) return;
          const message = getChatStateSnapshot().messages.find((entry) => entry.id === messageId);
          if (!message || message.role !== 'assistant') return;
          const previous = message.feedback ?? null;
          setChatMessageFeedback(messageId, feedback.rating);
          try {
            const headers = await authHeaders();
            if (!stillOwnsMessage()) return;
            const response = await fetch(
              `${config.apiBaseUrl}/api/clio/messages/${encodeURIComponent(messageId)}/feedback`,
              {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify(feedback),
              },
            );
            if (!response.ok) throw new Error(`Feedback save failed (${response.status})`);
          } catch {
            if (!stillOwnsMessage()) return;
            setChatMessageFeedback(messageId, previous);
            throw new Error('Feedback could not be saved. Please try again.');
          }
        });
      feedbackRequestsRef.current.set(key, task);
      try {
        await task;
      } finally {
        if (feedbackRequestsRef.current.get(key) === task) feedbackRequestsRef.current.delete(key);
      }
    },
    [authHeaders],
  );

  /**
   * Discard transient, per-turn state before the vNext router changes thread.
   *
   * Staged attachment ids belong to a single prospective user turn. Leaving
   * them in the shared controller while a route moves from one thread/client to
   * another could attach the prior thread's files to the next Send. Aborting
   * also stops an old SSE request before it can project transient execution
   * state (plans, trust steps, proposals, or an artifact) into the next thread.
   * Durable messages and conversations intentionally remain untouched.
   */
  const invalidateRouteStream = useCallback(() => {
    // Keep durable conversation-scoped UI (notably pending approvals and staged
    // draft attachments) intact when navigating to integrations and back. The
    // epoch is the authority that prevents the cancelled request from delivering
    // a late event afterward; transient execution state belongs to that request.
    streamEpochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setTrustSteps([]);
    setPlanSteps([]);
    setTurnProgress(null);
    setOrchestratorIntent(null);
    setOrchestratorTier(null);
    setOrchestratorConflict(null);
    setOrchestratorTemplate(null);
    setActiveArtifact(null);
    setResearchAwaitingAnswers(false);
    setResearchQuestions([]);
    setIsResearchStreaming(false);
    setResearchProgress(null);
    researchSessionRef.current = null;
    setResearchRecovery(null);
    setResearchRecoveryError(null);
    refreshResearchRecovery((version) => version + 1);
  }, []);

  const discardRouteState = useCallback(() => {
    // A different conversation is a hard ownership boundary. Unlike a detour to
    // integrations, nothing transient from the old session may cross this line.
    // Approval HTTP requests cannot be aborted, so invalidate their completions
    // only at an actual session ownership transition—not integrations navigation.
    routeEpochRef.current += 1;
    invalidateRouteStream();
    setStagedAttachments([]);
    setAttachmentNotice(null);
    setPendingApprovals([]);
    setApprovingProposalId(null);
    executedThisRoundRef.current = [];
    setResearchOffers({});
    setLastRetrieval(null);
  }, [invalidateRouteStream]);

  // The shared store is claimed at the controller boundary as well as the vNext
  // route. This covers any other Meri surface that mounts the same controller.
  // Route-level bootstrap will reload durable data after this synchronous clear.
  useLayoutEffect(() => {
    const previousIdentityKey = previousIdentityKeyRef.current;
    if (previousIdentityKey === identityKey) return;
    previousIdentityKeyRef.current = identityKey;
    claimMeriIdentity(identityKey);

    // Claiming the shared store is the whole job on a first mount: every value
    // reset below is controller-local `useState`, already fresh at mount, so
    // there is nothing of another identity's here to discard. Running the reset
    // anyway would abort a live stream and drop staged attachments belonging to
    // a surface that merely remounted under its own identity.
    if (previousIdentityKey === null) return;

    // Scope writes use a separate intent sequence; advance it here so an
    // old-identity PATCH completion cannot overwrite the freshly cleared scope.
    scopeIntentRef.current += 1;
    discardRouteState();
    setClients([]);
    setAlertsOpen(false);
    setSessionTitle('');
    setSessionClientId('');
    setPersistedClientId(null);
    setScopePersistStatus('idle');
    setIsSavingMeta(false);
    setMetaError(null);
    setWriteMode(false);
    setResearchMode(false);
    setResearchAwaitingAnswers(false);
    setResearchQuestions([]);
    researchSessionRef.current = null;
    setResearchReports({});
    for (const timer of forgetTimersRef.current.values()) window.clearTimeout(timer);
    forgetTimersRef.current.clear();
    setLearnedMemories([]);
    setForgottenMemories([]);
    setLearnedExpanded(false);
    setEditingMessageId(null);
    setEditingText('');
  }, [discardRouteState, identityKey]);

  const handleStop = useCallback(() => {
    const researchId =
      researchSessionRef.current ??
      (researchRecovery?.run.status === 'running' ? researchRecovery.id : null);
    const requestIdentityKey = identityKeyRef.current;
    const requestConversationId = currentSessionRef.current;
    researchStoppedRef.current = true;
    researchSessionRef.current = null;
    abortRef.current?.abort();
    if (!researchId && !isResearchStreaming) {
      const current = getChatStateSnapshot();
      const message = [...current.messages].reverse().find((entry) => entry.role === 'assistant');
      if (current.isStreaming && message && (!message.runtimeStatus?.lifecycle || message.runtimeStatus.lifecycle === 'running')) {
        // Stop is immediate even if an already-fulfilled stream read settles
        // later. Only this active ordinary turn gets the cancellation receipt.
        setChatMessageRuntimeStatus(message.id, meriRuntimeStatus({ finishReason: 'aborted', partial: true })!);
      }
    }
    setStreaming(false);
    setTurnProgress(null);
    setResearchAwaitingAnswers(false);
    setResearchQuestions([]);
    setIsResearchStreaming(false);
    setResearchProgress(null);
    if (!researchId) return;
    // Closing a browser stream detaches it. Stop is an explicit durable cancel.
    void (async () => {
      try {
        const headers = await authHeaders();
        if (!mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)) return;
        const response = await fetch(
          `${config.apiBaseUrl}/api/clio/research/${encodeURIComponent(researchId)}/cancel`,
          {
            method: 'POST',
            headers,
          },
        );
        if (!response.ok) throw new Error('Research cancellation was not confirmed.');
      } catch {
        if (
          mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current) &&
          requestConversationId === currentSessionRef.current
        )
          setResearchRecoveryError(
            'Stop was not confirmed. Research may still be running; try Stop again.',
          );
      } finally {
        if (
          mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current) &&
          requestConversationId === currentSessionRef.current
        )
          refreshResearchRecovery((version) => version + 1);
      }
    })();
  }, [authHeaders, researchRecovery, isResearchStreaming]);

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

  const finishApprovalRound = useCallback(
    (approvalSessionId = currentSessionRef.current, approvalRouteEpoch = routeEpochRef.current) => {
      // Check ownership BEFORE taking/clearing the shared round accumulator. A
      // late completion from the old thread must not discard an outcome that the
      // newly selected thread has accumulated in the meantime.
      if (
        !approvalSessionId ||
        !mayApplyApprovalResult(
          approvalSessionId,
          currentSessionRef.current,
          approvalRouteEpoch,
          routeEpochRef.current,
        )
      ) {
        return;
      }
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
    },
    [],
  );

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
    async (
      proposalId: string,
      approvalSessionId = currentSessionRef.current,
      approvalRouteEpoch = routeEpochRef.current,
    ) => {
      // PRE-AWAIT CHECK: verify ownership before acquiring auth headers.
      if (
        !approvalSessionId ||
        !mayApplyApprovalResult(
          approvalSessionId,
          currentSessionRef.current,
          approvalRouteEpoch,
          routeEpochRef.current,
        )
      ) {
        return;
      }
      setApprovingProposalId(proposalId);
      try {
        // authHeaders() is async — a route change can occur while it is pending.
        const headers = await authHeaders();

        // PRE-DISPATCH CHECK: re-verify ownership immediately before the
        // server-write fetch. Without this, a stale approval POST can still
        // execute after the user navigated away during header acquisition.
        if (
          !mayApplyApprovalResult(
            approvalSessionId,
            currentSessionRef.current,
            approvalRouteEpoch,
            routeEpochRef.current,
          )
        ) {
          return;
        }
        const res = await fetch(
          `${config.apiBaseUrl}/api/clio/action-proposals/${proposalId}/approve`,
          {
            method: 'POST',
            headers,
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
        // POST-RESPONSE CHECK: a prior conversation's approval may finish after
        // a route switch. The server-side mutation remains authoritative, but
        // its outcome must never repopulate the new thread's cards or append to
        // its transcript.
        if (
          !mayApplyApprovalResult(
            approvalSessionId,
            currentSessionRef.current,
            approvalRouteEpoch,
            routeEpochRef.current,
          )
        ) {
          return;
        }
        setPendingApprovals((prev) => upsertProposal(prev, proposal));
        if (proposal.status !== 'proposed' && proposal.status !== 'executing') {
          executedThisRoundRef.current = [...executedThisRoundRef.current, proposal];
        }
      } finally {
        // FINALLY CHECK: only clear the approving lock if this operation still
        // owns the current route/session. A stale approval must not unlock a
        // newer thread's controls.
        if (
          mayApplyApprovalResult(
            approvalSessionId,
            currentSessionRef.current,
            approvalRouteEpoch,
            routeEpochRef.current,
          )
        ) {
          setApprovingProposalId(null);
        }
      }
    },
    [authHeaders],
  );

  runApprovalRef.current = runApproval;
  finishApprovalRoundRef.current = finishApprovalRound;

  const handleApprovePending = useCallback(
    async (proposalId: string) => {
      if (isStreaming || approvingProposalId) return;
      const approvalSessionId = currentSessionRef.current;
      const approvalRouteEpoch = routeEpochRef.current;
      await runApproval(proposalId, approvalSessionId, approvalRouteEpoch);
      finishApprovalRound(approvalSessionId, approvalRouteEpoch);
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
    const approvalSessionId = currentSessionRef.current;
    const approvalRouteEpoch = routeEpochRef.current;
    if (!approvalSessionId) return;
    const outstanding = outstandingApprovals(pendingApprovalsRef.current);
    for (const card of outstanding) {
      // PRE-ITEM CHECK: verify ownership before starting this item's approval.
      if (
        !mayApplyApprovalResult(
          approvalSessionId,
          currentSessionRef.current,
          approvalRouteEpoch,
          routeEpochRef.current,
        )
      ) {
        // Route changed mid-loop: stop immediately, dispatch no further
        // approvals, do not clear the new route's state, and do not call
        // finishApprovalRound against another session.
        return;
      }
      // runApproval has its own pre-dispatch ownership check after
      // authHeaders() resolves. If the route changes during header
      // acquisition, the POST is never sent.
      await runApproval(card.proposalId, approvalSessionId, approvalRouteEpoch);

      // POST-ITEM CHECK: if ownership was lost during this item's approval,
      // stop the loop immediately. Do not start the next item, do not
      // finish the round against a different session.
      if (
        !mayApplyApprovalResult(
          approvalSessionId,
          currentSessionRef.current,
          approvalRouteEpoch,
          routeEpochRef.current,
        )
      ) {
        return;
      }
    }
    finishApprovalRound(approvalSessionId, approvalRouteEpoch);
  }, [isStreaming, approvingProposalId, runApproval, finishApprovalRound]);

  /**
   * Dismiss is a durable server-side lifecycle transition, not a local hide —
   * removed from view optimistically (the server call is best-effort from the
   * UI's perspective; a resolved/expired proposal can never execute even if
   * this request is lost).
   */
  const handleDismissPending = useCallback(
    async (proposalId: string) => {
      const requestIdentityKey = identityKeyRef.current;
      setPendingApprovals((prev) => prev.filter((p) => p.proposalId !== proposalId));
      try {
        const headers = await authHeaders();
        // A dismiss is a durable lifecycle transition on the previous tenant's
        // proposal; never issue it with the next tenant's credentials.
        if (!mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)) return;
        await fetch(`${config.apiBaseUrl}/api/clio/action-proposals/${proposalId}/dismiss`, {
          method: 'POST',
          headers,
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
    const requestIdentityKey = identityKey;
    let cancelled = false;
    void (async () => {
      try {
        // authHeaders() is async — an identity switch can land while it is
        // pending, which would send THIS tenant's conversation id under the
        // next tenant's credentials. Fence the dispatch, not just the commit.
        const headers = await authHeaders();
        if (cancelled || !mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current))
          return;
        const res = await fetch(
          `${config.apiBaseUrl}/api/clio/action-proposals?conversationId=${encodeURIComponent(sessionId)}`,
          { headers },
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as PendingApproval[];
        // Approval cards authorize real server-side actions. A prior identity's
        // recovery must never restore them under a newly authenticated one.
        if (
          !cancelled &&
          mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current) &&
          Array.isArray(data)
        ) {
          setPendingApprovals(data);
        }
      } catch {
        /* best-effort recovery; live SSE pending_approval events still work */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, authHeaders, identityKey]);

  // Held-approval cards belong to ONE conversation — switching sessions must
  // not carry them over (approving would re-run the WRONG conversation's
  // turn). The recovery effect above re-populates them for the new session.
  useEffect(() => {
    setPendingApprovals([]);
    setResearchOffers({});
    setLastRetrieval(null);
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
    if (!legacyMemoryEnabled) return;
    const requestIdentityKey = identityKeyRef.current;
    try {
      const res = await fetch(`${config.apiBaseUrl}/api/clio/memory/recent?limit=5`, {
        headers: await authHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (
        mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current) &&
        Array.isArray(data)
      ) {
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
  }, [authHeaders, legacyMemoryEnabled]);

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
      const requestIdentityKey = identityKeyRef.current;
      setLearnedMemories((prev) => prev.filter((item) => item.id !== id));
      setForgottenMemories((prev) => [...prev.filter((item) => item.id !== id), memory]);
      const timer = window.setTimeout(() => {
        forgetTimersRef.current.delete(id);
        if (!mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)) return;
        setForgottenMemories((prev) => prev.filter((item) => item.id !== id));
        void (async () => {
          try {
            await fetch(`${config.apiBaseUrl}/api/clio/memory/${id}`, {
              method: 'DELETE',
              headers: await authHeaders(),
            });
          } catch {
            if (mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)) {
              setLearnedMemories((prev) =>
                prev.some((item) => item.id === id) ? prev : [...prev, memory],
              );
            }
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
      const requestIdentityKey = identityKeyRef.current;
      try {
        const token = await getToken({ template: 'capiro' });
        // PRE-DISPATCH: this export is downloaded or opened in a tab. Requesting
        // the previous tenant's report with the next tenant's token would put
        // that document in front of the newly authenticated user.
        if (!mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)) return;
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
        // The download/open below is the point of no return: re-check after the
        // body has been read, not only before the request went out.
        if (!mayApplyIdentityResult(requestIdentityKey, identityKeyRef.current)) return;
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

  // Legacy drawer compatibility only. vNext Meri disables this adapter and
  // reads governed recall from the Context Packet instead.
  useEffect(() => {
    if (!legacyMemoryEnabled || isStreaming || !sessionId) return;
    const t = setTimeout(() => {
      void fetchLearnedMemories();
    }, 1500);
    return () => clearTimeout(t);
  }, [legacyMemoryEnabled, isStreaming, sessionId, fetchLearnedMemories]);

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
    scopePersistStatus,
    persistedClientId,
    activeConversationId,
    isSavingMeta: isSavingMeta || scopePersistStatus === 'saving',
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
    isResearchStreaming,
    researchProgress,
    turnProgress,
    researchRecovery,
    researchRecoveryError,
    resumeResearch,
    handleRunResearchOffer,
    lastRetrieval,
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
    invalidateRouteStream,
    discardRouteState,
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
