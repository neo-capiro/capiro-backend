/**
 * Workspace Editor vNext — the main three-pane Document Agent editor.
 *
 * LEFT: Document Agent conversation panel
 * CENTER: Document canvas (scaffold, generated content, generation run, selection revision)
 * RIGHT: Inspector (Brief · Context · Outline · Design · Quality)
 *
 * Key invariants:
 * - GET /drafts/:draftId/agent is workflow truth — never shadow with local state
 * - Every agent mutation carries expectedRevision from cached state immediately before the call
 * - On 409 DOCUMENT_AGENT_REVISION_CONFLICT: refetch and reconcile, NEVER silently retry
 * - Proposals are never auto-applied — only explicit Accept
 * - On 409 PROPOSAL_STALE: show stale proposal state, request new proposal
 * - No chain-of-thought is ever rendered
 * - Both side panes collapse to 56px rails without changing document state, phase, or scroll
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../styles/workspace.css';
import { api } from '../api/client.js';
import type {
  AgentState,
  AgentMessage,
  AgentProposal,
  QualityResponse,
  GenerationStatusResponse,
  DraftDocument,
  ContextItem,
  EditLock,
  SendMessageScope,
  AgentPhase,
  GenerationMode,
  OutlineSection,
} from '../types/agent.js';

// ── Phase spine stops ──────────────────────────────────────────────────────

const SPINE_STOPS: Array<{ phase: AgentPhase; label: string }> = [
  { phase: 'brief', label: 'Brief' },
  { phase: 'context', label: 'Context' },
  { phase: 'outline', label: 'Outline' },
  { phase: 'draft', label: 'Draft' },
  { phase: 'quality', label: 'Quality' },
];

const PHASE_ORDER: AgentPhase[] = [
  'type', 'blueprint', 'design', 'goal', 'brief', 'context',
  'outline', 'generate', 'draft', 'quality', 'complete',
];

const BACKWARD_TARGETS = new Set<AgentPhase>([
  'type', 'blueprint', 'design', 'goal', 'brief', 'context', 'outline',
]);

const GENERATION_STAGES = [
  'preflight', 'evidence_plan', 'narrative_plan', 'drafting',
  'editorial_pass', 'assurance', 'snapshot', 'complete',
] as const;

// ── Responsive ─────────────────────────────────────────────────────────────

/**
 * The canonical tablet boundary (foundations/responsive.css). Mirrored in JS
 * because a media query cannot set React state — keep it pinned to 1179.
 *
 * Below it, an EXPANDED side pane renders as a full-screen sheet
 * (styles/workspace.css). Two stacked sheets over the document is not a
 * sensible first paint, so both panes start collapsed to their 56px rails in
 * that band and the user opens whichever one they want. Nothing about the
 * document, phase or scroll changes — collapsing is presentation only.
 */
const WS_TABLET_QUERY = '(max-width: 1179px)';

function prefersCollapsedPanes(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(WS_TABLET_QUERY).matches;
}

// ── Utility ────────────────────────────────────────────────────────────────

function genIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isPhaseReachable(from: AgentPhase, to: AgentPhase): boolean {
  if (from === to) return true;
  if (BACKWARD_TARGETS.has(to)) return true;
  // Forward transitions only via endpoints — clicking is not a transition
  return false;
}

function phaseToSpineIndex(phase: AgentPhase): number {
  const map: Record<string, number> = {
    brief: 0, context: 1, outline: 2, generate: 3, draft: 3, quality: 4, complete: 4,
  };
  return map[phase] ?? 0;
}

// ── Main component ─────────────────────────────────────────────────────────

export function WorkspaceEditorVNext({ draftId, isRunView }: { draftId: string; isRunView?: boolean }) {
  const navigate = useNavigate();

  // Agent state — the workflow truth
  const [agentState, setAgentState] = useState<AgentState | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentLoading, setAgentLoading] = useState(true);

  // Messages
  const [messages, setMessages] = useState<AgentMessage[]>([]);

  // Proposals
  const [proposals, setProposals] = useState<AgentProposal[]>([]);
  const [activeProposal, setActiveProposal] = useState<AgentProposal | null>(null);
  const [proposalStale, setProposalStale] = useState(false);

  // Quality
  const [quality, setQuality] = useState<QualityResponse | null>(null);

  // Generation
  const [generation, setGeneration] = useState<GenerationStatusResponse | null>(null);
  const [polling, setPolling] = useState(false);

  // Documents (packet tabs)
  const [documents, setDocuments] = useState<DraftDocument[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);

  // Context items
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);

  // Edit lock
  const [lock, setLock] = useState<EditLock | null>(null);

  // UI state
  const [agentCollapsed, setAgentCollapsed] = useState(prefersCollapsedPanes);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(prefersCollapsedPanes);
  const [activeTab, setActiveTab] = useState<string>('brief');
  const [composerText, setComposerText] = useState('');
  const [composerScope, setComposerScope] = useState<SendMessageScope>({ kind: 'whole_document' });
  const [selection, setSelection] = useState<{ quote: string; start: number; end: number; sectionId?: string } | null>(null);
  const [banner, setBanner] = useState<{ variant: 'red' | 'amber'; text: string; action?: { label: string; onClick: () => void } } | null>(null);
  const [overlay, setOverlay] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [preflightResult, setPreflightResult] = useState<{ requiresApproval: boolean; isStale: boolean } | null>(null);

  // Refs for heartbeat and polling
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const agentStateRef = useRef<AgentState | null>(null);

  // Keep ref in sync
  useEffect(() => {
    agentStateRef.current = agentState;
  }, [agentState]);

  // Crossing INTO the tablet band mid-session collapses both panes, for the
  // same reason they start collapsed there. Deliberately one-way: widening back
  // out must not undo a collapse the user chose on desktop.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(WS_TABLET_QUERY);
    const onChange = (e: MediaQueryListEvent) => {
      if (!e.matches) return;
      setAgentCollapsed(true);
      setInspectorCollapsed(true);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // ── Fetch agent state ──────────────────────────────────────────────────────

  const fetchAgentState = useCallback(async () => {
    try {
      const res = await api.getAgentState(draftId);
      setAgentState(res.state);
      setAgentError(null);
      // Set default tab based on phase
      const phaseToTab: Record<string, string> = {
        brief: 'brief', context: 'context', outline: 'outline',
        generate: 'outline', draft: 'quality', quality: 'quality', complete: 'quality',
      };
      if (res.state.phase && phaseToTab[res.state.phase]) {
        setActiveTab(phaseToTab[res.state.phase] as string);
      }
      return res.state;
    } catch (err: unknown) {
      const e = err as { statusCode?: number; code?: string; message?: string };
      if (e?.statusCode === 404) {
        // Draft has no agent state — not initialized. Show coherent state.
        setAgentError('not_initialized');
      } else {
        setAgentError(e?.message || 'Failed to load agent state');
      }
      return null;
    } finally {
      setAgentLoading(false);
    }
  }, [draftId]);

  const fetchMessages = useCallback(async () => {
    try {
      const res = await api.getMessages(draftId);
      setMessages(res.messages || []);
    } catch {
      // Silent — messages are secondary to state
    }
  }, [draftId]);

  const fetchProposals = useCallback(async () => {
    try {
      const res = await api.getProposals(draftId);
      setProposals(res.proposals || []);
    } catch {
      // Silent
    }
  }, [draftId]);

  const fetchDocuments = useCallback(async () => {
    try {
      const res = await api.getDocuments(draftId);
      setDocuments(res.documents || []);
      if (res.documents?.length && !activeDocId && res.documents[0]) {
        setActiveDocId(res.documents[0].id);
      }
    } catch {
      // Silent
    }
  }, [draftId, activeDocId]);

  const fetchContext = useCallback(async () => {
    try {
      const res = await api.getContext(draftId);
      setContextItems(res.items || []);
    } catch {
      // Silent
    }
  }, [draftId]);

  const fetchLock = useCallback(async () => {
    try {
      const res = await api.getLock(draftId);
      setLock(res);
    } catch {
      // Silent
    }
  }, [draftId]);

  const fetchQuality = useCallback(async () => {
    try {
      const res = await api.getQuality(draftId);
      setQuality(res);
    } catch {
      // Silent — quality may not be available yet
    }
  }, [draftId]);

  // ── Initial load ───────────────────────────────────────────────────────────

  useEffect(() => {
    fetchAgentState().then((state) => {
      if (state) {
        fetchMessages();
        fetchProposals();
        fetchDocuments();
        if (state.phase === 'context' || state.phase === 'outline') {
          fetchContext();
        }
        if (state.phase === 'draft' || state.phase === 'quality' || state.phase === 'complete') {
          fetchQuality();
        }
      }
    });
    fetchLock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  // ── Tab focus refetch (after 60s) ────────────────────────────────────────────

  useEffect(() => {
    let lastVisible = Date.now();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (Date.now() - lastVisible > 60_000) {
          fetchAgentState();
          fetchMessages();
        }
        lastVisible = Date.now();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [fetchAgentState, fetchMessages]);

  // ── Generation polling ────────────────────────────────────────────────────────

  useEffect(() => {
    if (agentState?.phase !== 'generate' && agentState?.status !== 'generating' && !polling) return;

    const poll = async () => {
      try {
        const res = await api.getGeneration(draftId);
        setGeneration(res);
        if (res.status === 'active') {
          // Keep polling
        } else {
          // Terminal status — stop polling, refetch state
          setPolling(false);
          if (pollRef.current) clearInterval(pollRef.current);
          fetchAgentState();
          fetchQuality();
        }
      } catch {
        setPolling(false);
        if (pollRef.current) clearInterval(pollRef.current);
      }
    };

    setPolling(true);
    poll();
    pollRef.current = setInterval(poll, 2500);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentState?.phase, agentState?.status, draftId]);

  // ── Lock heartbeat ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (lock?.heldBy && lock.heldBy !== 'me') return; // someone else holds lock

    heartbeatRef.current = setInterval(() => {
      api.heartbeat(draftId).catch(() => {});
    }, 30_000);

    const onUnload = () => {
      api.releaseLock(draftId).catch(() => {});
    };
    window.addEventListener('pagehide', onUnload);

    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      window.removeEventListener('pagehide', onUnload);
      api.releaseLock(draftId).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, lock?.heldBy]);

  // ── Banner computation ─────────────────────────────────────────────────────────

  useEffect(() => {
    // Priority: revision conflict → reasoning unavailable → preflight failed →
    // proposal stale → generation partial → edit lock held → approval stale
    if (!agentState) {
      setBanner(null);
      return;
    }

    // Check for generation partial/failed
    if (agentState.status === 'partial' || agentState.status === 'failed') {
      setBanner({
        variant: 'amber',
        text: agentState.status === 'partial'
          ? 'Generation incomplete — some sections were not generated.'
          : 'Generation failed — some sections could not be generated.',
        action: {
          label: 'Retry failed sections',
          onClick: () => handleRetryGeneration(),
        },
      });
      return;
    }

    // Check for lock held by someone else
    if (lock?.heldBy && lock.heldBy !== 'me') {
      const age = lock.acquiredAt ? Date.now() - new Date(lock.acquiredAt).getTime() : 0;
      const ageMin = Math.floor(age / 60000);
      setBanner({
        variant: 'amber',
        text: `Edit lock held by ${lock.heldByName || 'another user'} for ${ageMin}m`,
        action: {
          label: 'Request access',
          onClick: () => api.requestLock(draftId).catch(() => {}),
        },
      });
      return;
    }

    // Check for stale approval
    if (preflightResult?.isStale) {
      setBanner({
        variant: 'amber',
        text: 'Document changed since last approval. Request new approval.',
        action: {
          label: 'Request approval',
          onClick: () => handleRequestApproval(),
        },
      });
      return;
    }

    setBanner(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentState, lock, preflightResult]);

  // ── Mutation helpers ───────────────────────────────────────────────────────────

  const getRevision = (): number => {
    const state = agentStateRef.current;
    if (!state) throw new Error('No agent state');
    return state.revision;
  };

  const handleMutationError = useCallback((err: unknown) => {
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e?.code === 'DOCUMENT_AGENT_REVISION_CONFLICT') {
      // Refetch and reconcile — NEVER silently retry
      fetchAgentState();
      setBanner({
        variant: 'red',
        text: 'Agent state was modified by another session. Refetching.',
        action: { label: 'Refetch agent state', onClick: () => fetchAgentState() },
      });
    } else if (e?.code === 'PROPOSAL_STALE') {
      setProposalStale(true);
      setBanner({
        variant: 'red',
        text: 'Proposal is stale — the document changed since it was created.',
        action: { label: 'Request new proposal', onClick: () => setOverlay('proposal') },
      });
    } else if (e?.code === 'REASONING_UNAVAILABLE') {
      setBanner({
        variant: 'red',
        text: 'Reasoning service unavailable. Please retry.',
        action: { label: 'Retry', onClick: () => fetchAgentState() },
      });
    } else if (e?.code === 'PREFLIGHT_FAILED') {
      setBanner({
        variant: 'red',
        text: 'Delivery preflight failed. Resolve blockers before sharing.',
        action: { label: 'Open quality', onClick: () => setActiveTab('quality') },
      });
    }
  }, [fetchAgentState]);

  const updateState = useCallback((res: { state?: AgentState }) => {
    if (res.state) {
      setAgentState(res.state);
      agentStateRef.current = res.state;
    }
  }, []);

  // ── Agent actions ──────────────────────────────────────────────────────────────

  const handleSendMessage = useCallback(async () => {
    if (!composerText.trim() || sending) return;
    setSending(true);
    try {
      const revision = getRevision();
      const res = await api.sendMessage(draftId, {
        text: composerText.trim(),
        phase: agentStateRef.current?.phase || 'brief',
        expectedRevision: revision,
        idempotencyKey: genIdempotencyKey(),
        scope: composerScope,
      });
      // Append user message and agent response
      setMessages(prev => [...prev,
        { id: `user-${Date.now()}`, role: 'user', text: composerText.trim(), createdAt: new Date().toISOString() },
        { id: `agent-${Date.now()}`, role: 'agent', text: res.message, createdAt: new Date().toISOString(), questions: res.questions, proposalId: res.proposal?.proposalId, allowedActions: res.allowedActions },
      ]);
      // Update state if returned
      if (res.stateSummary) {
        // Partial state update
        setAgentState(prev => prev ? { ...prev, ...res.stateSummary! as Partial<AgentState> } : prev);
      }
      if (res.proposal) {
        fetchProposals();
        setOverlay('proposal');
      }
      setComposerText('');
      setComposerScope({ kind: 'whole_document' });
      setSelection(null);
    } catch (err) {
      handleMutationError(err);
      // Preserve composer text on error
    } finally {
      setSending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerText, sending, draftId, composerScope]);

  const handleBriefAction = useCallback(async (action: 'synthesize' | 'approve' | 'reopen', fields?: Record<string, unknown>) => {
    try {
      const revision = getRevision();
      let res: { state?: AgentState };
      if (action === 'synthesize') {
        res = await api.synthesizeBrief(draftId, revision);
      } else if (action === 'approve') {
        res = await api.approveBrief(draftId, revision);
      } else {
        res = await api.reopenBrief(draftId, revision);
      }
      updateState(res);
      fetchMessages();
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, updateState, handleMutationError, fetchMessages]);

  const handleBriefFieldEdit = useCallback(async (fields: Record<string, unknown>) => {
    try {
      const revision = getRevision();
      const res = await api.updateBrief(draftId, revision, fields);
      updateState(res);
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, updateState, handleMutationError]);

  const handleContextAction = useCallback(async (action: 'recommend' | 'analyze' | 'approve') => {
    try {
      const revision = getRevision();
      let res: { state?: AgentState };
      if (action === 'recommend') {
        res = await api.recommendContext(draftId, revision);
      } else if (action === 'analyze') {
        res = await api.analyzeContext(draftId, revision);
      } else {
        // Check for unresolved conflicts before approving
        const state = agentStateRef.current;
        const unresolved = state?.contextPlan?.conflicts?.some(c => !c.resolved);
        if (unresolved) {
          setBanner({
            variant: 'red',
            text: 'Cannot approve context with unresolved conflicts.',
            action: undefined,
          });
          return;
        }
        res = await api.approveContext(draftId, revision);
      }
      updateState(res);
      fetchContext();
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, updateState, handleMutationError, fetchContext]);

  const handleOutlineGenerate = useCallback(async () => {
    try {
      const revision = getRevision();
      const res = await api.generateOutline(draftId, revision);
      updateState(res);
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, updateState, handleMutationError]);

  const handleOutlineUpdate = useCallback(async (sections: OutlineSection[]) => {
    try {
      const revision = getRevision();
      const res = await api.updateOutline(draftId, revision, sections);
      updateState(res);
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, updateState, handleMutationError]);

  const handleOutlineRevise = useCallback(async (instruction: string) => {
    try {
      const revision = getRevision();
      await api.reviseOutline(draftId, revision, instruction);
      fetchProposals();
      setOverlay('proposal');
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, fetchProposals, handleMutationError]);

  const handleOutlineApprove = useCallback(async () => {
    try {
      const revision = getRevision();
      const res = await api.approveOutline(draftId, revision);
      updateState(res);
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, updateState, handleMutationError]);

  const handleAcceptProposal = useCallback(async (proposalId: string) => {
    try {
      const revision = getRevision();
      const res = await api.acceptProposal(draftId, proposalId, revision);
      updateState(res);
      setActiveProposal(null);
      setProposalStale(false);
      fetchProposals();
      fetchMessages();
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, updateState, handleMutationError, fetchProposals, fetchMessages]);

  const handleRejectProposal = useCallback(async (proposalId: string, note?: string) => {
    try {
      const revision = getRevision();
      const res = await api.rejectProposal(draftId, proposalId, revision, note);
      updateState(res);
      setActiveProposal(null);
      fetchProposals();
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, updateState, handleMutationError, fetchProposals]);

  const handleGenerate = useCallback(async (mode: GenerationMode) => {
    try {
      const revision = getRevision();
      const res = await api.generate(draftId, revision, mode, genIdempotencyKey());
      updateState(res);
      // Start polling
      setPolling(true);
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, updateState, handleMutationError]);

  const handleRetryGeneration = useCallback(async () => {
    try {
      const revision = getRevision();
      const res = await api.retryGeneration(draftId, revision);
      updateState(res);
      setPolling(true);
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, updateState, handleMutationError]);

  const handleCancelGeneration = useCallback(async () => {
    try {
      const revision = getRevision();
      const res = await api.cancelGeneration(draftId, revision);
      updateState(res);
      setPolling(false);
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, updateState, handleMutationError]);

  const handleFixIssue = useCallback(async (issueId: string, instruction?: string) => {
    try {
      const revision = getRevision();
      await api.fixIssue(draftId, issueId, revision, instruction);
      fetchProposals();
      setOverlay('proposal');
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, fetchProposals, handleMutationError]);

  const handlePreflight = useCallback(async () => {
    try {
      const res = await api.preflight(draftId);
      setPreflightResult(res);
      setOverlay('delivery');
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, handleMutationError]);

  const handleRequestApproval = useCallback(async () => {
    try {
      await api.createApprovalRequest(draftId, { idempotencyKey: genIdempotencyKey() });
      setBanner(null);
    } catch (err) {
      handleMutationError(err);
    }
  }, [draftId, handleMutationError]);

  const handleModeChange = useCallback(async (mode: GenerationMode) => {
    try {
      const revision = getRevision();
      const res = await api.patchAgent(draftId, revision, { generation: { mode } });
      updateState(res);
    } catch {
      // Fallback: client-only mode change
      setAgentState(prev => prev ? { ...prev, generation: { ...prev.generation, mode } } : prev);
    }
  }, [draftId, updateState]);

  // ── Document autosave ────────────────────────────────────────────────────────

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleDocEdit = useCallback((docId: string, body: string) => {
    // Update local immediately
    setDocuments(prev => prev.map(d => d.id === docId ? { ...d, body } : d));
    // Debounced autosave (800ms)
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      api.patchDocument(draftId, docId, { body }).catch(() => {});
    }, 800);
  }, [draftId]);

  // ── Keyboard ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd/Ctrl+Enter sends the agent composer
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSendMessage();
      }
      // Escape closes top-most layer
      if (e.key === 'Escape') {
        if (overlay) {
          setOverlay(null);
        } else if (selection) {
          setSelection(null);
          setComposerScope({ kind: 'whole_document' });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSendMessage, overlay, selection]);

  // ── Selection ─────────────────────────────────────────────────────────────────

  const handleSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const text = sel.toString();
    if (text.length < 14) {
      setSelection(null);
      setComposerScope({ kind: 'whole_document' });
      return;
    }
    const range = sel.getRangeAt(0);
    const paperEl = document.querySelector('.ws-vnext-paper');
    if (!paperEl || !paperEl.contains(range.commonAncestorContainer)) return;
    const start = range.startOffset;
    const end = range.endOffset;
    setSelection({ quote: text, start, end });
    setComposerScope({ kind: 'selection', documentId: activeDocId || undefined, quote: text, start, end });
  }, [activeDocId]);

  // ── Loading state ─────────────────────────────────────────────────────────────

  if (agentLoading) {
    return (
      <div className="ws-vnext">
        <div className="ws-vnext-editor">
          <div className="ws-vnext-empty">
            <div className="ws-vnext-skeleton-row" style={{ width: '60%', height: 24 }} />
            <div className="ws-vnext-skeleton-row" style={{ width: '40%' }} />
            <div className="ws-vnext-skeleton-row" style={{ width: '80%' }} />
          </div>
        </div>
      </div>
    );
  }

  // ── Not initialized state (flag off or no agent state) ────────────────────────

  if (agentError === 'not_initialized' || (!agentState && !agentLoading)) {
    return (
      <div className="ws-vnext">
        <div className="ws-vnext-editor">
          <div className="ws-vnext-editor__header-row1">
            <button className="ws-vnext-editor__back-btn" onClick={() => navigate('/workspace')}>
              ← Workspace
            </button>
          </div>
          <div className="ws-vnext-empty">
            <div className="ws-vnext-empty__title">Document Agent not initialized</div>
            <div className="ws-vnext-empty__desc">
              This document doesn't have a Document Agent state yet. The workspace
              editor is available in the standard view.
            </div>
            <button className="ws-vnext-btn ws-vnext-btn--primary" onClick={() => navigate(`/workspace/${draftId}`)}>
              Open in standard editor
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!agentState) {
    return (
      <div className="ws-vnext">
        <div className="ws-vnext-empty">
          <div className="ws-vnext-empty__title">Unable to load document</div>
          <div className="ws-vnext-empty__desc">{agentError || 'An error occurred loading this document.'}</div>
          <button className="ws-vnext-btn" onClick={() => navigate('/workspace')}>Back to Workspace</button>
        </div>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const currentSpineIdx = phaseToSpineIndex(agentState.phase);
  const hasUnresolvedConflicts = (agentState.contextPlan?.conflicts || []).some(c => !c.resolved);
  const openAssumptions = (agentState.brief?.assumptions || []).filter(a => a.status === 'open');

  return (
    <div className="ws-vnext">
      <div className="ws-vnext-editor">
        {/* Header row 1 */}
        <div className="ws-vnext-editor__header-row1">
          <button className="ws-vnext-editor__back-btn" onClick={() => navigate('/workspace')}>
            ← Workspace
          </button>
          <div className="ws-vnext-editor__title-block">
            <div className="ws-vnext-editor__title">{agentState.goal?.text || 'Untitled document'}</div>
            <div className="ws-vnext-editor__title-meta">
              {agentState.documentType?.label || '—'} · v{agentState.blueprintPin?.version || 1}
              {agentState.goal?.client ? ` · ${agentState.goal.client}` : ''}
            </div>
          </div>
          <div className="ws-vnext-editor__header-actions">
            <button className="ws-vnext-btn ws-vnext-btn--sm ws-vnext-btn--ghost" onClick={() => setOverlay('more')}>
              ⋯
            </button>
            <button className="ws-vnext-btn ws-vnext-btn--sm" onClick={handlePreflight}>
              Deliver
            </button>
          </div>
        </div>

        {/* Phase spine */}
        <div className="ws-vnext-phase-spine">
          {SPINE_STOPS.map((stop, i) => {
            const state = i < currentSpineIdx ? 'done' : i === currentSpineIdx ? 'current' : 'upcoming';
            const issues =
              (stop.phase === 'context' && hasUnresolvedConflicts) ||
              (stop.phase === 'quality' && (quality?.blockers?.length || 0) > 0)
                ? (stop.phase === 'context' ? (hasUnresolvedConflicts ? 1 : 0) : (quality?.blockers?.length || 0))
                : 0;
            const reachable = isPhaseReachable(agentState.phase, stop.phase);
            return (
              <div key={stop.phase} style={{ display: 'inline-flex', alignItems: 'center' }}>
                <button
                  className="ws-vnext-phase-stop"
                  data-state={state}
                  disabled={!reachable}
                  title={reachable ? `Go to ${stop.label}` : `${stop.label} is not reachable from ${agentState.phase}`}
                  onClick={() => reachable && setActiveTab(stop.phase === 'draft' ? 'quality' : stop.phase)}
                >
                  <span className="ws-vnext-phase-stop__dot" />
                  {stop.label}
                  {issues > 0 && <span className="ws-vnext-phase-stop__badge">{issues}</span>}
                </button>
                {i < SPINE_STOPS.length - 1 && (
                  <div className="ws-vnext-phase-connector" data-active={i < currentSpineIdx} />
                )}
              </div>
            );
          })}
          {/* Delivery stop — not a phase, opens overlay, unreachable before draft */}
          <div style={{ display: 'inline-flex', alignItems: 'center' }}>
            <div className="ws-vnext-phase-connector" data-active={currentSpineIdx >= 3} />
            <button
              className="ws-vnext-phase-stop"
              data-state={currentSpineIdx >= 3 ? 'done' : 'upcoming'}
              disabled={currentSpineIdx < 3}
              title={currentSpineIdx < 3 ? 'Delivery is available after the draft phase' : 'Open delivery'}
              onClick={() => currentSpineIdx >= 3 && handlePreflight()}
            >
              <span className="ws-vnext-phase-stop__dot" />
              Delivery
            </button>
          </div>
        </div>

        {/* Banner slot */}
        {banner && (
          <div className="ws-vnext-banner-slot">
            <div className="ws-vnext-banner" data-variant={banner.variant}>
              <span className="ws-vnext-banner__text">{banner.text}</span>
              {banner.action && (
                <button className="ws-vnext-banner__action" onClick={banner.action.onClick}>
                  {banner.action.label}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Three panes */}
        <div
          className="ws-vnext-panes"
          data-agent-collapsed={agentCollapsed}
          data-inspector-collapsed={inspectorCollapsed}
        >
          {/* ── Agent panel ─────────────────────────────────────────────────── */}
          <div className="ws-vnext-pane ws-vnext-pane--agent">
            {agentCollapsed ? (
              <div className="ws-vnext-agent-collapsed-rail">
                <button className="ws-vnext-collapse-btn" onClick={() => setAgentCollapsed(false)} title="Expand agent">
                  ▶
                </button>
                <div className="ws-vnext-collapsed-m-mark">M</div>
                <div className="ws-vnext-collapsed-msg-count">{messages.length}</div>
                <div className="ws-vnext-collapsed-label">DOCUMENT AGENT</div>
              </div>
            ) : (
              <div className="ws-vnext-agent-panel">
                <div className="ws-vnext-agent-header">
                  <div className="ws-vnext-agent-header__label">DOCUMENT AGENT</div>
                  <div className="ws-vnext-agent-header__phase">
                    {agentState.phase?.charAt(0).toUpperCase() + agentState.phase?.slice(1)}
                  </div>
                  <button
                    className="ws-vnext-agent-mode-chip"
                    onClick={() => {
                      const modes: GenerationMode[] = ['quick', 'standard', 'max'];
                      const current = (agentState.generation?.mode || 'standard') as GenerationMode;
                      const next = modes[(modes.indexOf(current) + 1) % 3] as GenerationMode;
                      handleModeChange(next);
                    }}
                  >
                    {agentState.generation?.mode?.toUpperCase() || 'STANDARD'}
                  </button>
                  <button
                    className="ws-vnext-collapse-btn"
                    style={{ position: 'absolute', top: 10, right: 10 }}
                    onClick={() => setAgentCollapsed(true)}
                    title="Collapse agent"
                  >
                    ◀
                  </button>
                </div>

                <div className="ws-vnext-agent-thread">
                  {messages.length === 0 && (
                    <div style={{ color: 'var(--ws-faint)', fontSize: 12, textAlign: 'center', padding: 16 }}>
                      Start a conversation with the Document Agent.
                    </div>
                  )}
                  {messages.map((msg) => (
                    <div key={msg.id} className={`ws-vnext-msg ws-vnext-msg--${msg.role}`}>
                      {msg.role === 'agent' && <span className="ws-vnext-msg__m-mark">M</span>}
                      <span>{msg.text}</span>
                      {msg.status && (
                        <div className="ws-vnext-msg__status-chip" data-status={msg.status}>
                          {msg.status.replace('_', ' ').toUpperCase()}
                        </div>
                      )}
                      {msg.proposalId && (
                        <div
                          className="ws-vnext-proposal-card"
                          onClick={() => {
                            const p = proposals.find(p => p.id === msg.proposalId);
                            if (p) { setActiveProposal(p); setOverlay('proposal'); }
                          }}
                        >
                          <div className="ws-vnext-proposal-card__label">PROPOSAL</div>
                          <div className="ws-vnext-proposal-card__title">Review proposed changes</div>
                        </div>
                      )}
                      {msg.questions && msg.questions.length > 0 && (
                        <div className="ws-vnext-questions-block">
                          <div className="ws-vnext-questions-block__label">NEEDS YOUR ANSWER</div>
                          {msg.questions.map((q) => (
                            <div key={q.id} className="ws-vnext-questions-block__q">
                              {q.label} {q.required && <span style={{ color: 'var(--ws-amber)' }}>*</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {sending && (
                    <div className="ws-vnext-msg ws-vnext-msg--agent">
                      <span className="ws-vnext-msg__m-mark">M</span>
                      <span style={{ color: 'var(--ws-faint)' }}>Thinking…</span>
                    </div>
                  )}
                </div>

                {/* Quick revision chips — phase dependent */}
                {(agentState.phase === 'draft' || agentState.phase === 'quality') && (
                  <div className="ws-vnext-quick-revisions">
                    <button className="ws-vnext-quick-rev-chip" onClick={() => setComposerText('Shorten the selected text')}>
                      Shorten
                    </button>
                    <button className="ws-vnext-quick-rev-chip" onClick={() => setComposerText('Check the evidence in the selected text')}>
                      Check evidence
                    </button>
                    <button className="ws-vnext-quick-rev-chip" onClick={() => setComposerText('Improve the selected text')}>
                      Improve
                    </button>
                  </div>
                )}

                {/* Composer */}
                <div className="ws-vnext-agent-composer">
                  <textarea
                    className="ws-vnext-agent-composer__textarea"
                    placeholder="Ask Meri to help with this document…"
                    value={composerText}
                    onChange={(e) => setComposerText(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        handleSendMessage();
                      }
                    }}
                  />
                  <div className="ws-vnext-agent-composer__footer">
                    <span
                      className="ws-vnext-scope-chip"
                      onClick={() => {
                        setComposerScope({ kind: 'whole_document' });
                        setSelection(null);
                      }}
                      title={composerScope.kind === 'selection' ? 'Click to clear selection' : 'Whole document scope'}
                    >
                      {composerScope.kind === 'selection'
                        ? `Selection · ${composerScope.quote?.split(' ').length || 0} words`
                        : 'Whole document'}
                    </span>
                    <button
                      className="ws-vnext-btn ws-vnext-btn--primary ws-vnext-btn--sm"
                      onClick={handleSendMessage}
                      disabled={!composerText.trim() || sending}
                    >
                      Send
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Canvas ───────────────────────────────────────────────────────── */}
          <div className="ws-vnext-pane ws-vnext-pane--canvas">
            <div className="ws-vnext-canvas" onMouseUp={handleSelection}>
              {/* Packet tab strip */}
              <div className="ws-vnext-canvas__tab-strip">
                {documents.map((doc) => (
                  <button
                    key={doc.id}
                    className="ws-vnext-packet-tab"
                    data-active={doc.id === activeDocId}
                    onClick={() => setActiveDocId(doc.id)}
                  >
                    {doc.title}
                  </button>
                ))}
                <button
                  className="ws-vnext-packet-tab__add"
                  onClick={async () => {
                    const doc = await api.createDocument(draftId, { title: `Document ${documents.length + 1}` });
                    setDocuments(prev => [...prev, doc]);
                    setActiveDocId(doc.id);
                  }}
                >
                  ＋
                </button>
              </div>

              {/* Provenance strip */}
              <div className="ws-vnext-provenance-strip">
                {agentState.phase === 'generate' || agentState.phase === 'draft' || agentState.phase === 'quality' || agentState.phase === 'complete'
                  ? <>
                    <span>AS GENERATED</span>
                    {agentState.outline && <span> · OUTLINE V{agentState.outline.version}</span>}
                    {agentState.contextPlan?.coverage && <span> · {agentState.contextPlan.coverage.supportedClaims} SOURCES</span>}
                    {agentState.quality?.score != null && <span> · QUALITY {agentState.quality.score}%</span>}
                    <a onClick={() => api.getContextUsed(draftId)}>Context used</a>
                  </>
                  : <>
                    <span>NOT GENERATED</span>
                    {agentState.blueprintPin && <span> · BLUEPRINT v{agentState.blueprintPin.version}</span>}
                    {agentState.outline?.sections && <span> · {agentState.outline.sections.length} SECTIONS PLANNED</span>}
                  </>
                }
              </div>

              {/* Canvas content */}
              <div className="ws-vnext-paper-container">
                {agentState.phase === 'generate' || polling ? (
                  /* Generation run panel */
                  <div className="ws-vnext-gen-panel">
                    <div className="ws-vnext-gen-panel__header">
                      <div className="ws-vnext-gen-panel__title">
                        {agentState.generation?.mode?.toUpperCase() || 'Standard'} reasoning run
                      </div>
                      <div className="ws-vnext-gen-panel__meta">
                        {generation?.runId && `run ${generation.runId.slice(0, 6)}`}
                        {generation?.startedAt && ` · started ${new Date(generation.startedAt).toLocaleTimeString()}`}
                      </div>
                      <button
                        className="ws-vnext-btn ws-vnext-btn--sm"
                        onClick={handleCancelGeneration}
                        style={{ marginLeft: 'auto' }}
                      >
                        Cancel run
                      </button>
                    </div>
                    <div className="ws-vnext-gen-stages">
                      {GENERATION_STAGES.map((stageName) => {
                        const stage = generation?.stages?.find(s => s.name === stageName);
                        const status = stage?.status || 'pending';
                        return (
                          <div key={stageName} className="ws-vnext-gen-stage" data-status={status}>
                            <span className="ws-vnext-gen-stage__icon">
                              {status === 'done' ? '✓' : status === 'active' ? '◐' : status === 'failed' ? '✕' : '○'}
                            </span>
                            <div>
                              <div className="ws-vnext-gen-stage__name">{stageName}</div>
                              {stage?.detail && <div className="ws-vnext-gen-stage__detail">{stage.detail}</div>}
                            </div>
                            <span className="ws-vnext-gen-stage__status">{status}</span>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--ws-muted)', marginTop: 16 }}>
                      Cancelled runs are partial, not complete. Retry regenerates only failed sections.
                    </div>
                  </div>
                ) : agentState.phase === 'draft' || agentState.phase === 'quality' || agentState.phase === 'complete' ? (
                  /* Generated document */
                  <div className="ws-vnext-paper">
                    {activeDocId && documents.find(d => d.id === activeDocId) ? (
                      <EditablePaper
                        doc={documents.find(d => d.id === activeDocId)!}
                        onEdit={(body) => handleDocEdit(activeDocId, body)}
                        readOnly={!!(lock?.heldBy && lock.heldBy !== 'me')}
                      />
                    ) : (
                      <div className="ws-vnext-empty">
                        <div className="ws-vnext-empty__desc">No document selected.</div>
                      </div>
                    )}
                  </div>
                ) : (
                  /* Blueprint/outline scaffold */
                  <div className="ws-vnext-paper">
                    <div className="ws-vnext-paper__eyebrow">
                      {agentState.documentType?.label || 'DOCUMENT'} · BLUEPRINT {agentState.blueprintPin ? `v${agentState.blueprintPin.version}` : '—'}
                    </div>
                    <h1>{agentState.goal?.text || 'Untitled document'}</h1>
                    <hr className="ws-vnext-paper__rule" />
                    {agentState.outline?.sections?.length ? (
                      <div className="ws-vnext-scaffold">
                        {agentState.outline.sections.map((section) => (
                          <div key={section.id} className="ws-vnext-scaffold-section">
                            <div className="ws-vnext-scaffold-section__header">
                              <span className="ws-vnext-scaffold-section__title">{section.title}</span>
                              <div className="ws-vnext-scaffold-section__badges">
                                {section.required && <span className="ws-vnext-scaffold-section__badge" data-variant="required">Required</span>}
                                {section.locked && <span className="ws-vnext-scaffold-section__badge" data-variant="locked">Locked</span>}
                              </div>
                            </div>
                            <div className="ws-vnext-scaffold-section__purpose">{section.purpose}</div>
                            <div className="ws-vnext-scaffold-section__meta">
                              {section.targetWords.min}–{section.targetWords.max} words · {section.evidenceItemIds.length} evidence items
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ color: 'var(--ws-faint)', fontSize: 13 }}>
                        The outline will appear here once generated.
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Selection bar */}
              {selection && (
                <div className="ws-vnext-selection-bar">
                  <span className="ws-vnext-selection-bar__quote">"{selection.quote.slice(0, 60)}…"</span>
                  <button
                    className="ws-vnext-selection-bar__action"
                    onClick={() => { setComposerText('Shorten the selected text'); }}
                  >
                    Shorten
                  </button>
                  <button
                    className="ws-vnext-selection-bar__action"
                    onClick={() => { setComposerText('Check evidence in the selected text'); }}
                  >
                    Check evidence
                  </button>
                  <button
                    className="ws-vnext-selection-bar__action"
                    onClick={() => { setComposerText('Revise the selected text with Meri'); }}
                  >
                    Ask Meri
                  </button>
                  <button
                    className="ws-vnext-selection-bar__action"
                    onClick={() => { setSelection(null); setComposerScope({ kind: 'whole_document' }); }}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* ── Inspector ─────────────────────────────────────────────────────── */}
          <div className="ws-vnext-pane ws-vnext-pane--inspector">
            {inspectorCollapsed ? (
              <div className="ws-vnext-inspector-collapsed-rail">
                {/* ◀, not ▶: the inspector is the RIGHT pane, so expanding it
                    grows leftwards. It shared a glyph with the new collapse
                    button, which now means the opposite thing. */}
                <button
                  className="ws-vnext-collapse-btn"
                  onClick={() => setInspectorCollapsed(false)}
                  title="Expand inspector"
                  aria-label="Expand inspector"
                >
                  ◀
                </button>
                {['brief', 'context', 'outline', 'design', 'quality'].map((tab) => (
                  <div
                    key={tab}
                    className="ws-vnext-inspector-rail-icon"
                    data-active={activeTab === tab}
                    onClick={() => { setInspectorCollapsed(false); setActiveTab(tab); }}
                    title={tab}
                  >
                    {tab === 'brief' ? '📋' : tab === 'context' ? '🗄' : tab === 'outline' ? '≡' : tab === 'design' ? '◆' : '✓'}
                    {(tab === 'context' && hasUnresolvedConflicts) || (tab === 'quality' && (quality?.blockers?.length || 0) > 0) ? (
                      <span className="ws-vnext-inspector-rail-icon__dot" />
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="ws-vnext-inspector">
                <div className="ws-vnext-inspector__tabs">
                  {['brief', 'context', 'outline', 'design', 'quality'].map((tab) => (
                    <button
                      key={tab}
                      className="ws-vnext-inspector-tab"
                      data-active={activeTab === tab}
                      onClick={() => setActiveTab(tab)}
                    >
                      {tab}
                      {tab === 'context' && hasUnresolvedConflicts && (
                        <span className="ws-vnext-inspector-tab__badge">{agentState.contextPlan.conflicts.filter(c => !c.resolved).length}</span>
                      )}
                      {tab === 'quality' && (quality?.blockers?.length || 0) > 0 && (
                        <span className="ws-vnext-inspector-tab__badge" data-variant="red">{quality!.blockers!.length}</span>
                      )}
                    </button>
                  ))}
                  {/* The expanded inspector had no way back to the rail: every
                      handler here set inspectorCollapsed(false), never true. On
                      desktop that stranded the pane open; below 1180, where an
                      expanded pane is a full-screen sheet, it would have left an
                      undismissable sheet over the document. */}
                  <button
                    className="ws-vnext-collapse-btn ws-vnext-inspector__collapse"
                    onClick={() => setInspectorCollapsed(true)}
                    title="Collapse inspector"
                    aria-label="Collapse inspector"
                  >
                    ▶
                  </button>
                </div>

                <div className="ws-vnext-inspector__body">
                  {activeTab === 'brief' && (
                    <BriefTab
                      state={agentState}
                      onAction={handleBriefAction}
                      onFieldEdit={handleBriefFieldEdit}
                    />
                  )}
                  {activeTab === 'context' && (
                    <ContextTab
                      state={agentState}
                      items={contextItems}
                      onAction={handleContextAction}
                      onPatchItem={(itemId, payload) => api.patchContextItem(draftId, itemId, payload)}
                      onAddItem={(data) => api.addContextItem(draftId, data)}
                      onRemoveItem={(itemId) => api.removeContextItem(draftId, itemId)}
                    />
                  )}
                  {activeTab === 'outline' && (
                    <OutlineTab
                      state={agentState}
                      onGenerate={handleOutlineGenerate}
                      onUpdate={handleOutlineUpdate}
                      onRevise={handleOutlineRevise}
                      onApprove={handleOutlineApprove}
                    />
                  )}
                  {activeTab === 'design' && (
                    <DesignTab state={agentState} />
                  )}
                  {activeTab === 'quality' && (
                    <QualityTab
                      state={agentState}
                      quality={quality}
                      onFixIssue={handleFixIssue}
                      onPreflight={handlePreflight}
                    />
                  )}
                </div>

                {/* Inspector footer — phase primary action when not on phase's tab */}
                {(() => {
                  const phaseToTab: Record<string, string> = {
                    brief: 'brief', context: 'context', outline: 'outline',
                    generate: 'outline', draft: 'quality', quality: 'quality',
                  };
                  const phaseTab = phaseToTab[agentState.phase] || 'brief';
                  if (activeTab === phaseTab) return null;
                  const actions: Record<string, { label: string; onClick: () => void; reason: string }> = {
                    brief: { label: 'Approve brief', onClick: () => handleBriefAction('approve'), reason: 'The brief needs approval to advance' },
                    context: { label: 'Approve context', onClick: () => handleContextAction('approve'), reason: 'Context needs approval to advance' },
                    outline: { label: 'Approve outline', onClick: handleOutlineApprove, reason: 'The outline needs approval to start generation' },
                    draft: { label: 'Review quality', onClick: () => setActiveTab('quality'), reason: 'Review quality checks for this document' },
                    quality: { label: 'Run preflight', onClick: handlePreflight, reason: 'Run delivery preflight before sharing' },
                  };
                  const action = actions[agentState.phase];
                  if (!action) return null;
                  return (
                    <div className="ws-vnext-inspector__footer">
                      <button className="ws-vnext-inspector-footer__action" onClick={action.onClick}>
                        {action.label}
                      </button>
                      <div className="ws-vnext-inspector-footer__reason">{action.reason}</div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Overlays */}
      {overlay === 'proposal' && activeProposal && (
        <ProposalOverlay
          proposal={activeProposal}
          stale={proposalStale}
          onAccept={() => handleAcceptProposal(activeProposal.id)}
          onReject={(note) => handleRejectProposal(activeProposal.id, note)}
          onClose={() => { setOverlay(null); setActiveProposal(null); }}
        />
      )}
      {overlay === 'delivery' && (
        <DeliveryOverlay
          draftId={draftId}
          preflight={preflightResult}
          onPreflight={handlePreflight}
          onRequestApproval={handleRequestApproval}
          onClose={() => setOverlay(null)}
        />
      )}
    </div>
  );
}

// ── Editable paper ──────────────────────────────────────────────────────────

function EditablePaper({ doc, onEdit, readOnly }: { doc: DraftDocument; onEdit: (body: string) => void; readOnly?: boolean }) {
  return (
    <>
      <div className="ws-vnext-paper__eyebrow">{doc.title}</div>
      <h1>{doc.title}</h1>
      <hr className="ws-vnext-paper__rule" />
      <div
        contentEditable={!readOnly}
        suppressContentEditableWarning
        onBlur={(e) => onEdit(e.currentTarget.innerHTML)}
        dangerouslySetInnerHTML={{ __html: doc.body || '<p style="color: #98a2b3;">Start writing…</p>' }}
        style={{ minHeight: 300, outline: 'none' }}
      />
      <div className="ws-vnext-paper__footer">{doc.title} · Capiro</div>
    </>
  );
}

// ── Brief tab ──────────────────────────────────────────────────────────────────

function BriefTab({
  state,
  onAction,
  onFieldEdit,
}: {
  state: AgentState;
  onAction: (action: 'synthesize' | 'approve' | 'reopen') => void;
  onFieldEdit: (fields: Record<string, unknown>) => void;
}) {
  const brief = state.brief;
  const fields = ['objective', 'audience', 'desiredAction', 'subject', 'centralArgument', 'evidenceInstructions', 'tone', 'targetPages', 'deadline'];
  const isApproved = !!brief?.approvedAt;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <span className="ws-vnext-status-pill" data-status={isApproved ? 'complete' : 'needs_input'}>
          <span className="ws-vnext-status-pill__dot" />
          {isApproved ? 'APPROVED' : 'DRAFT'}
        </span>
      </div>

      {fields.map((field) => (
        <div key={field} className="ws-vnext-card">
          <div className="ws-vnext-card__label">{field.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())}</div>
          <div className="ws-vnext-card__value">
            <input
              type="text"
              value={(brief as unknown as Record<string, unknown>)?.[field] as string || ''}
              onChange={(e) => onFieldEdit({ [field]: e.target.value })}
              disabled={isApproved}
              style={{ width: '100%', border: '0', background: 'transparent', fontSize: 13, color: 'var(--ws-ink)', outline: 'none' }}
            />
          </div>
          {brief?.provenance?.[field] && (
            <span className="ws-vnext-card__provenance" data-pv={brief.provenance[field]}>
              {brief.provenance[field]}
            </span>
          )}
        </div>
      ))}

      {/* Assumptions */}
      {brief?.assumptions?.map((assumption) => (
        <div key={assumption.id} className="ws-vnext-assumption-card">
          <div className="ws-vnext-assumption-card__text">{assumption.text}</div>
          <div className="ws-vnext-assumption-card__actions">
            <button
              className="ws-vnext-assumption-card__btn"
              data-action="confirm"
              onClick={() => onFieldEdit({
                assumptions: brief.assumptions.map(a => a.id === assumption.id ? { ...a, status: 'confirmed' } : a),
              })}
              disabled={assumption.status !== 'open'}
            >
              {assumption.status === 'confirmed' ? '✓ Confirmed' : 'Confirm'}
            </button>
            <button
              className="ws-vnext-assumption-card__btn"
              data-action="reject"
              onClick={() => onFieldEdit({
                assumptions: brief.assumptions.map(a => a.id === assumption.id ? { ...a, status: 'rejected' } : a),
              })}
              disabled={assumption.status !== 'open'}
            >
              {assumption.status === 'rejected' ? '✕ Rejected' : 'Reject'}
            </button>
          </div>
        </div>
      ))}

      {/* Actions */}
      {!isApproved ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="ws-vnext-btn ws-vnext-btn--sm" onClick={() => onAction('synthesize')}>
            Synthesize from conversation
          </button>
          <button className="ws-vnext-btn ws-vnext-btn--sm ws-vnext-btn--primary" onClick={() => onAction('approve')}>
            Approve brief
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="ws-vnext-btn ws-vnext-btn--sm" onClick={() => onAction('reopen')}>
            Edit brief
          </button>
        </div>
      )}
    </div>
  );
}

// ── Context tab ──────────────────────────────────────────────────────────────────

function ContextTab({
  state,
  items,
  onAction,
  onPatchItem,
  onAddItem,
  onRemoveItem,
}: {
  state: AgentState;
  items: ContextItem[];
  onAction: (action: 'recommend' | 'analyze' | 'approve') => void;
  onPatchItem: (itemId: string, payload: Record<string, unknown>) => void;
  onAddItem: (data: Record<string, unknown>) => void;
  onRemoveItem: (itemId: string) => void;
}) {
  const plan = state.contextPlan;
  const coverage = plan?.coverage;
  const conflicts = plan?.conflicts || [];
  const hasUnresolved = conflicts.some(c => !c.resolved);

  return (
    <div>
      {/* Coverage */}
      {coverage && (
        <div className="ws-vnext-card">
          <div className="ws-vnext-card__label">Coverage</div>
          <div className="ws-vnext-card__value">
            {coverage.supportedClaims} of {coverage.plannedClaims} planned claims supported
          </div>
          {coverage.missingClaims?.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--ws-amber)', marginTop: 4 }}>
              {coverage.missingClaims.length} missing claims
            </div>
          )}
        </div>
      )}

      {/* Conflicts */}
      {conflicts.map((conflict) => (
        <div key={conflict.id} className="ws-vnext-card" style={{ borderColor: conflict.resolved ? 'var(--ws-line)' : 'var(--ws-red)', background: conflict.resolved ? 'var(--ws-page-bg)' : 'var(--ws-red-bg)' }}>
          <div className="ws-vnext-card__label">CONFLICT · {conflict.type}</div>
          <div className="ws-vnext-card__value">{conflict.description}</div>
          <div style={{ fontSize: 11, color: 'var(--ws-muted)', marginTop: 4 }}>
            Recommended: {conflict.recommendedResolution}
          </div>
          {!conflict.resolved && (
            <div style={{ fontSize: 11, color: 'var(--ws-red)', marginTop: 6, fontWeight: 500 }}>
              Resolution endpoint not available — contact your administrator.
            </div>
          )}
          {conflict.resolved && (
            <div style={{ fontSize: 11, color: 'var(--ws-green)', marginTop: 4 }}>✓ Resolved</div>
          )}
        </div>
      ))}

      {/* Items */}
      {items.map((item) => (
        <div key={item.id} className="ws-vnext-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={item.included}
              onChange={(e) => onPatchItem(item.id, { included: e.target.checked })}
            />
            <span className="ws-vnext-card__value">{item.label}</span>
          </div>
          {item.sourceType && <span style={{ fontSize: 9, fontFamily: 'var(--capiro-type-family-mono)', color: 'var(--ws-faint)' }}>{item.sourceType}</span>}
          {item.authority && <span style={{ fontSize: 9, fontFamily: 'var(--capiro-type-family-mono)', color: 'var(--ws-faint)' }}> · {item.authority}</span>}
          {item.freshness && <span style={{ fontSize: 9, fontFamily: 'var(--capiro-type-family-mono)', color: 'var(--ws-faint)' }}> · {item.freshness}</span>}
          {!item.included && item.exclusionReason && (
            <div style={{ fontSize: 11, color: 'var(--ws-amber)', marginTop: 4 }}>Excluded: {item.exclusionReason}</div>
          )}
        </div>
      ))}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="ws-vnext-btn ws-vnext-btn--sm" onClick={() => onAction('recommend')}>Recommend</button>
        <button className="ws-vnext-btn ws-vnext-btn--sm" onClick={() => onAction('analyze')}>Analyze</button>
        <button
          className="ws-vnext-btn ws-vnext-btn--sm ws-vnext-btn--primary"
          onClick={() => onAction('approve')}
          disabled={hasUnresolved}
          title={hasUnresolved ? 'Cannot approve with unresolved conflicts' : 'Approve context plan'}
        >
          Approve context
        </button>
      </div>
      {hasUnresolved && (
        <div style={{ fontSize: 11, color: 'var(--ws-red)', marginTop: 8 }}>
          Cannot approve — {conflicts.filter(c => !c.resolved).length} unresolved conflict(s).
        </div>
      )}
    </div>
  );
}

// ── Outline tab ────────────────────────────────────────────────────────────────

function OutlineTab({
  state,
  onGenerate,
  onUpdate,
  onRevise,
  onApprove,
}: {
  state: AgentState;
  onGenerate: () => void;
  onUpdate: (sections: OutlineSection[]) => void;
  onRevise: (instruction: string) => void;
  onApprove: () => void;
}) {
  const outline = state.outline;
  const [sections, setSections] = useState<OutlineSection[]>(outline?.sections || []);
  const [reviseText, setReviseText] = useState('');
  const isApproved = !!outline?.approvedAt;

  useEffect(() => {
    setSections(outline?.sections || []);
  }, [outline?.sections]);

  if (!outline?.sections?.length) {
    return (
      <div className="ws-vnext-empty">
        <div className="ws-vnext-empty__desc">No outline yet. Generate one from the blueprint.</div>
        <button className="ws-vnext-btn ws-vnext-btn--primary ws-vnext-btn--sm" onClick={onGenerate}>
          Generate outline
        </button>
      </div>
    );
  }

  return (
    <div>
      {sections.map((section, i) => (
        <div key={section.id} className="ws-vnext-card">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <span style={{ color: 'var(--ws-faint)', cursor: 'grab' }}>⋮⋮</span>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="text"
                  value={section.title}
                  onChange={(e) => {
                    const next = [...sections]; next[i] = { ...section, title: e.target.value }; setSections(next);
                  }}
                  onBlur={() => onUpdate(sections)}
                  disabled={isApproved}
                  style={{ border: '0', background: 'transparent', fontSize: 13, fontWeight: 500, color: 'var(--ws-ink)', outline: 'none', flex: 1 }}
                />
                {section.required && <span className="ws-vnext-scaffold-section__badge" data-variant="required">Required</span>}
                {section.locked && <span className="ws-vnext-scaffold-section__badge" data-variant="locked">Locked</span>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--ws-body)', marginTop: 4 }}>{section.purpose}</div>
              <div className="ws-vnext-scaffold-section__meta">
                {section.targetWords.min}–{section.targetWords.max} words · {section.evidenceItemIds.length} evidence
                {section.evidenceItemIds.length === 0 && <span style={{ color: 'var(--ws-amber)' }}> (no evidence assigned)</span>}
              </div>
            </div>
          </div>
        </div>
      ))}

      {/* Revise with Meri */}
      {!isApproved && (
        <>
          <div style={{ marginTop: 8 }}>
            <textarea
              className="ws-vnext-agent-composer__textarea"
              placeholder="Revise the outline with Meri…"
              value={reviseText}
              onChange={(e) => setReviseText(e.target.value)}
              style={{ minHeight: 40 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              className="ws-vnext-btn ws-vnext-btn--sm"
              onClick={() => onRevise(reviseText)}
              disabled={!reviseText.trim()}
            >
              Revise with Meri
            </button>
            <button
              className="ws-vnext-btn ws-vnext-btn--sm ws-vnext-btn--primary"
              onClick={onApprove}
            >
              Approve outline
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Design tab ─────────────────────────────────────────────────────────────────

function DesignTab({ state }: { state: AgentState }) {
  const pin = state.blueprintPin;
  const theme = state.theme;
  const [paperColor, setPaperColor] = useState(theme?.settings?.paperColor || '#FEFDFA');

  return (
    <div>
      {/* Blueprint pin */}
      <div className="ws-vnext-card">
        <div className="ws-vnext-card__label">BLUEPRINT PIN</div>
        <div className="ws-vnext-card__value">{pin ? `v${pin.version} · ${pin.definitionHash?.slice(0, 6) || '—'}` : '—'}</div>
        <div style={{ fontSize: 11, color: 'var(--ws-muted)', marginTop: 4 }}>
          Documents remain pinned to their original blueprint version forever.
        </div>
      </div>

      {/* Paper picker */}
      <div className="ws-vnext-card">
        <div className="ws-vnext-card__label">PAPER</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {[
            { name: 'Ivory', color: '#FEFDFA' },
            { name: 'Bright white', color: '#FFFFFF' },
            { name: 'Warm cream', color: '#FBF6EC' },
            { name: 'Cool grey', color: '#F7F8FA' },
          ].map((p) => (
            <button
              key={p.name}
              onClick={() => setPaperColor(p.color)}
              style={{
                width: 32, height: 32, borderRadius: 6,
                background: p.color,
                border: paperColor === p.color ? '2px solid var(--ws-navy)' : '1px solid var(--ws-line)',
                cursor: 'pointer',
              }}
              title={p.name}
            />
          ))}
        </div>
      </div>

      {/* Read-only note */}
      <div className="ws-vnext-card" style={{ background: 'var(--ws-amber-bg)', borderColor: 'var(--ws-amber-ring)' }}>
        <div style={{ fontSize: 12, color: 'var(--ws-amber)' }}>
          Theme CRUD endpoints are not available. The Design tab is read-only —
          paper color and letterhead settings are preview only and will not be
          saved. See GAPS.md §15–17.
        </div>
      </div>
    </div>
  );
}

// ── Quality tab ──────────────────────────────────────────────────────────────────

function QualityTab({
  state,
  quality,
  onFixIssue,
  onPreflight,
}: {
  state: AgentState;
  quality: QualityResponse | null;
  onFixIssue: (issueId: string, instruction?: string) => void;
  onPreflight: () => void;
}) {
  const score = quality?.score;
  const displayScore = score == null ? '—' : `${score}%`;

  return (
    <div>
      {/* Score */}
      <div className="ws-vnext-card" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 32, fontWeight: 600, color: score == null ? 'var(--ws-faint)' : 'var(--ws-ink)' }}>
          {displayScore}
        </div>
        <div className="ws-vnext-card__label" style={{ marginTop: 4 }}>QUALITY SCORE</div>
        {quality?.readiness && (
          <div style={{ fontSize: 12, color: 'var(--ws-muted)', marginTop: 4 }}>{quality.readiness.replace(/_/g, ' ')}</div>
        )}
      </div>

      {/* Blockers */}
      {(quality?.blockers?.length ?? 0) > 0 && quality && (
        <div className="ws-vnext-card" style={{ background: 'var(--ws-red-bg)', borderColor: 'var(--ws-red)' }}>
          <div className="ws-vnext-card__label" style={{ color: 'var(--ws-red)' }}>BLOCKERS</div>
          {quality.blockers!.map((b, i) => (
            <div key={i} style={{ fontSize: 12, color: 'var(--ws-red)', marginTop: 2 }}>• {b}</div>
          ))}
        </div>
      )}

      {/* Recommendations */}
      {(quality?.recommendations?.length ?? 0) > 0 && quality && (
        <div className="ws-vnext-card" style={{ background: 'var(--ws-amber-bg)', borderColor: 'var(--ws-amber-ring)' }}>
          <div className="ws-vnext-card__label" style={{ color: 'var(--ws-amber)' }}>RECOMMENDATIONS</div>
          {quality.recommendations!.map((r, i) => (
            <div key={i} style={{ fontSize: 12, color: 'var(--ws-amber)', marginTop: 2 }}>• {r}</div>
          ))}
        </div>
      )}

      {/* Checks */}
      {quality?.checks?.map((check) => (
        <div key={check.id} className="ws-vnext-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: check.status === 'success' ? 'var(--ws-green)' : check.status === 'error' ? 'var(--ws-red)' : 'var(--ws-amber)' }}>
              {check.status === 'success' ? '✓' : check.status === 'error' ? '✕' : '⚠'}
            </span>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{check.label}</span>
          </div>
          <div style={{ fontSize: 10, fontFamily: 'var(--capiro-type-family-mono)', color: 'var(--ws-faint)', marginTop: 2 }}>
            {check.id} · {check.detail}
          </div>
          {check.fixable && check.status !== 'success' && (
            <button
              className="ws-vnext-btn ws-vnext-btn--sm"
              style={{ marginTop: 6 }}
              onClick={() => onFixIssue(check.id)}
            >
              Fix with Meri
            </button>
          )}
        </div>
      ))}

      {/* Preflight */}
      <button className="ws-vnext-btn ws-vnext-btn--primary ws-vnext-btn--sm" style={{ width: '100%', marginTop: 12 }} onClick={onPreflight}>
        Run delivery preflight
      </button>
    </div>
  );
}

// ── Proposal overlay ────────────────────────────────────────────────────────────

function ProposalOverlay({
  proposal,
  stale,
  onAccept,
  onReject,
  onClose,
}: {
  proposal: AgentProposal;
  stale: boolean;
  onAccept: () => void;
  onReject: (note?: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="ws-vnext-overlay-scrim" onClick={onClose}>
      <div className="ws-vnext-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="ws-vnext-overlay__header" style={{ position: 'relative' }}>
          <div className="ws-vnext-overlay__kicker">PROPOSAL · {proposal.type.replace(/_/g, ' ')}</div>
          <div className="ws-vnext-overlay__title">Review proposed changes</div>
          <button className="ws-vnext-overlay__close" onClick={onClose}>✕</button>
        </div>
        <div className="ws-vnext-overlay__body">
          {stale && (
            <div className="ws-vnext-banner" data-variant="red" style={{ marginBottom: 12 }}>
              This proposal is stale — the document changed since it was created.
            </div>
          )}
          <div className="ws-vnext-diff">
            <div className="ws-vnext-diff__side" data-side="before">
              <div className="ws-vnext-diff__side-label">CURRENT</div>
              <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', margin: 0 }}>
                {JSON.stringify(proposal.payload?.before, null, 2)}
              </pre>
            </div>
            <div className="ws-vnext-diff__side" data-side="after">
              <div className="ws-vnext-diff__side-label">PROPOSED</div>
              <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', margin: 0 }}>
                {JSON.stringify(proposal.payload?.after, null, 2)}
              </pre>
            </div>
          </div>
          {proposal.payload?.affectedSections && (
            <div style={{ fontSize: 11, color: 'var(--ws-muted)', marginTop: 12 }}>
              Affected sections: {(proposal.payload.affectedSections as string[]).join(', ')}
            </div>
          )}
          {proposal.payload?.lockedSectionsTouched && (
            <div style={{ fontSize: 11, color: 'var(--ws-amber)', marginTop: 4 }}>
              ⚠ Locked sections touched: {(proposal.payload.lockedSectionsTouched as string[]).join(', ')}
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--ws-faint)', marginTop: 8 }}>
            Base revision: {proposal.baseRevision} · Hash: {proposal.baseHash?.slice(0, 8) || '—'}
          </div>
        </div>
        <div className="ws-vnext-overlay__footer">
          <div className="ws-vnext-overlay__note">
            A proposal is applied only after you accept.
          </div>
          <div className="ws-vnext-overlay__actions">
            <button className="ws-vnext-btn ws-vnext-btn--sm" onClick={() => onReject()}>Reject</button>
            <button
              className="ws-vnext-btn ws-vnext-btn--sm ws-vnext-btn--primary"
              onClick={onAccept}
              disabled={stale}
            >
              Accept proposal
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Delivery overlay ────────────────────────────────────────────────────────────

function DeliveryOverlay({
  draftId,
  preflight,
  onPreflight,
  onRequestApproval,
  onClose,
}: {
  draftId: string;
  preflight: { requiresApproval: boolean; isStale: boolean } | null;
  onPreflight: () => void;
  onRequestApproval: () => void;
  onClose: () => void;
}) {
  const [shareLinks, setShareLinks] = useState<Array<{ shareId: string; token: string; expiresAt: string | null }>>([]);
  const [shareError, setShareError] = useState<string | null>(null);

  return (
    <div className="ws-vnext-overlay-scrim" onClick={onClose}>
      <div className="ws-vnext-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="ws-vnext-overlay__header" style={{ position: 'relative' }}>
          <div className="ws-vnext-overlay__kicker">DELIVERY</div>
          <div className="ws-vnext-overlay__title">Deliver document</div>
          <button className="ws-vnext-overlay__close" onClick={onClose}>✕</button>
        </div>
        <div className="ws-vnext-overlay__body">
          {!preflight && (
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: 13, color: 'var(--ws-muted)' }}>Run preflight to check delivery readiness.</p>
              <button className="ws-vnext-btn ws-vnext-btn--primary" onClick={onPreflight}>Run preflight</button>
            </div>
          )}
          {preflight && (
            <>
              <div className="ws-vnext-card">
                <div className="ws-vnext-card__label">PREFLIGHT</div>
                <div className="ws-vnext-card__value">✓ Passed</div>
                {preflight.requiresApproval && (
                  <div style={{ fontSize: 12, color: 'var(--ws-amber)', marginTop: 4 }}>
                    Client-facing approval required.
                  </div>
                )}
                {preflight.isStale && (
                  <div style={{ fontSize: 12, color: 'var(--ws-amber)', marginTop: 4 }}>
                    Document changed since last approval.
                  </div>
                )}
              </div>

              {preflight.requiresApproval && (
                <button className="ws-vnext-btn ws-vnext-btn--sm" onClick={onRequestApproval} style={{ marginBottom: 12 }}>
                  Request approval
                </button>
              )}

              {/* Share links */}
              <div className="ws-vnext-card">
                <div className="ws-vnext-card__label">SHARE LINKS</div>
                <button
                  className="ws-vnext-btn ws-vnext-btn--sm ws-vnext-btn--primary"
                  style={{ marginTop: 8 }}
                  onClick={async () => {
                    try {
                      setShareError(null);
                      const res = await api.createShareLink(draftId, { idempotencyKey: `${Date.now()}` });
                      setShareLinks(prev => [...prev, res]);
                    } catch (err) {
                      setShareError((err as Error).message);
                    }
                  }}
                >
                  Create share link
                </button>
                {shareLinks.map((link) => (
                  <div key={link.shareId} style={{ marginTop: 8, fontSize: 12 }}>
                    <div style={{ fontFamily: 'var(--capiro-type-family-mono)', color: 'var(--ws-navy)' }}>
                      /share/{link.token.slice(0, 12)}…
                    </div>
                    {link.expiresAt && <div style={{ color: 'var(--ws-faint)' }}>Expires: {new Date(link.expiresAt).toLocaleDateString()}</div>}
                    <button
                      className="ws-vnext-btn ws-vnext-btn--sm"
                      style={{ marginTop: 4 }}
                      onClick={() => api.revokeShareLink(draftId, link.shareId)}
                    >
                      Revoke
                    </button>
                  </div>
                ))}
                {shareError && <div style={{ fontSize: 12, color: 'var(--ws-red)', marginTop: 4 }}>{shareError}</div>}
              </div>

              {/* Export */}
              <div className="ws-vnext-card">
                <div className="ws-vnext-card__label">EXPORT</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <a className="ws-vnext-btn ws-vnext-btn--sm" href={api.exportDocx(draftId)} target="_blank" rel="noopener">
                    Export DOCX
                  </a>
                  <a className="ws-vnext-btn ws-vnext-btn--sm" href={api.exportPdf(draftId)} target="_blank" rel="noopener">
                    Export PDF
                  </a>
                </div>
                <div style={{ fontSize: 11, color: 'var(--ws-faint)', marginTop: 4 }}>
                  Export uses the document's current content. Theme settings may not be reflected in the export.
                </div>
              </div>
            </>
          )}
        </div>
        <div className="ws-vnext-overlay__footer">
          <div className="ws-vnext-overlay__note">Preflight must pass before sharing or client-facing export.</div>
          <button className="ws-vnext-btn ws-vnext-btn--sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
