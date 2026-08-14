import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../../components/actions/index.js';
import { api } from '../api/client.js';
import type {
  AgentMessage,
  AgentPhase,
  AgentProposal,
  AgentState,
  AgentStateResponse,
  ContextItem,
  GenerationMode,
  GenerationStatusResponse,
  OutlineSection,
  QualityResponse,
  SendMessageScope,
  ShareLinkResponse,
} from '../types/agent.js';
import {
  useAddDocument,
  useCollaborators,
  useComments,
  useCreateComment,
  useCreateVersion,
  useDeleteDocument,
  useDraft,
  useExportDocx,
  useExportPdf,
  useInviteCollaborator,
  useRemoveCollaborator,
  useRestoreVersion,
  useSuggestCommentEdit,
  useTenantMembers,
  useUpdateCollaboratorRole,
  useUpdateComment,
  useUpdateDocument,
  useUpdateDraft,
  useVersions,
} from '../../../../pages/workspace/api.js';
import { useEditLock } from '../../../../pages/workspace/editor/useEditLock.js';
import { LockBanner } from '../../../../pages/workspace/editor/LockBanner.js';
import { Icon } from '../../../../pages/workspace/kit.js';
import {
  applyEditToSectionHtml,
  getSelectionAnchor,
  type CommentAnchor,
  type SelectionAnchor,
} from '../../../../pages/workspace/editor/anchors.js';
import { sanitizeWorkspaceBody } from '../../../../pages/workspace/editor/workspace-richtext.js';
import type {
  WsAssignableRole,
  WsComment,
  WsConfig,
  WsDocVersion,
  WsDocument,
} from '../../../../pages/workspace/types.js';
import { useMe } from '../../../../lib/me.js';
import {
  SPINE_STOPS,
  canOpenSpineStop,
  documentBodyToHtml,
  errorCode,
  errorMessage,
  formatTimestamp,
  hasGeneratedContent,
  htmlToDocumentBody,
  mainSectionContent,
  normalizeGenerationStages,
  phaseToSpineIndex,
  phaseToTab,
  primaryDocument,
  unresolvedConflictCount,
  type InspectorTab,
  type SpineStop,
} from './editor-model.js';
import '../styles/workspace.css';
import '../styles/workspace-audit.css';

const AUTOSAVE_MS = 800;
const MODE_ORDER: GenerationMode[] = ['quick', 'standard', 'max'];
const MAIN_TAB = 'main';

type SaveState = 'saved' | 'saving' | 'error';
type Overlay = 'proposal' | 'delivery' | 'versions' | 'collaborators' | null;

type BannerState = {
  tone: 'red' | 'amber' | 'blue';
  message: string;
  actionLabel?: string;
  action?: () => void;
} | null;

function requestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function plainText(html: string): string {
  if (!html) return '';
  if (typeof document === 'undefined') return html.replace(/<[^>]+>/g, '');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return parsed.body.textContent ?? '';
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts.at(-1)?.[0] ?? ''}`.toUpperCase();
}

function roleLabel(role: string): string {
  return role.replace(/_/g, ' ').replace(/^./, (value) => value.toUpperCase());
}

function EditableHtml({
  value,
  section,
  readOnly,
  placeholder,
  onChange,
}: {
  value: string;
  section: string;
  readOnly: boolean;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current && ref.current && ref.current.innerHTML !== value) {
      ref.current.innerHTML = value;
    }
  }, [value]);

  return (
    <div
      ref={ref}
      className="ws-audit-editable-section"
      data-empty={!plainText(value).trim()}
      data-ws-section={section}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      role="textbox"
      aria-label={`${section} body`}
      aria-readonly={readOnly}
      data-placeholder={placeholder}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={(event) => {
        focused.current = false;
        if (!readOnly) onChange(sanitizeWorkspaceBody(event.currentTarget.innerHTML));
      }}
      onInput={(event) => {
        if (!readOnly) onChange(event.currentTarget.innerHTML);
      }}
      dangerouslySetInnerHTML={{ __html: value }}
    />
  );
}

function ModalShell({
  kicker,
  title,
  onClose,
  children,
  footer,
}: {
  kicker: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="ws-audit-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section className="ws-audit-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <div>
            <div className="ws-audit-eyebrow">{kicker}</div>
            <h2>{title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            <Icon name="X" size={18} />
          </button>
        </header>
        <div className="ws-audit-modal__body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </section>
    </div>
  );
}

function PhaseSpine({
  state,
  onOpen,
}: {
  state: AgentState;
  onOpen: (stop: SpineStop) => void;
}) {
  const current = phaseToSpineIndex(state.phase);
  const contextIssues = unresolvedConflictCount(state);
  const qualityIssues =
    (state.quality?.blockers?.length ?? 0) +
    (state.quality?.recommendations?.length ?? 0);

  return (
    <nav className="ws-audit-phase-spine" aria-label="Document phase">
      {SPINE_STOPS.map((stop, index) => {
        const issues =
          stop.id === 'context'
            ? contextIssues
            : stop.id === 'quality'
              ? qualityIssues
              : 0;
        const reachable = canOpenSpineStop(state.phase, stop.id);
        const phaseState =
          index < current
            ? 'done'
            : index === current
              ? issues
                ? 'issues'
                : 'current'
              : issues
                ? 'issues'
                : 'upcoming';
        return (
          <button
            type="button"
            key={stop.id}
            data-state={phaseState}
            disabled={!reachable}
            title={reachable ? `Open ${stop.label}` : `${stop.label} is not available yet`}
            onClick={() => reachable && onOpen(stop.id)}
          >
            <span className="ws-audit-phase-spine__mark">
              {phaseState === 'done' ? '✓' : issues || ''}
            </span>
            <span>{stop.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function GenerationPanel({
  state,
  run,
  busy,
  onStart,
  onRetry,
}: {
  state: AgentState;
  run: GenerationStatusResponse | null | undefined;
  busy: boolean;
  onStart: () => void;
  onRetry: () => void;
}) {
  const stages = normalizeGenerationStages(run);
  const canStart = state.status === 'ready' && !run;
  const retryable = run?.status === 'partial' || run?.status === 'failed';

  return (
    <div className="ws-audit-generation-panel">
      <div className="ws-audit-generation-panel__header">
        <div>
          <div className="ws-audit-eyebrow">GENERATION RUN</div>
          <h2>{state.generation.mode.toUpperCase()} reasoning</h2>
          <p>
            {run
              ? `Run ${run.runId.slice(0, 8)} · ${run.status.replace(/_/g, ' ')}`
              : 'The approved brief, context, and outline are ready.'}
          </p>
        </div>
        {canStart ? (
          <CapiroButton variant="primary" loading={busy} onClick={onStart}>
            Generate document
          </CapiroButton>
        ) : retryable ? (
          <CapiroButton variant="primary" loading={busy} onClick={onRetry}>
            Retry failed sections
          </CapiroButton>
        ) : null}
      </div>

      {run ? (
        <div className="ws-audit-generation-stages">
          {stages.length ? (
            stages.map((stage) => (
              <div key={stage.name} data-status={stage.status}>
                <span className="ws-audit-generation-stages__mark" />
                <div>
                  <strong>{stage.name.replace(/_/g, ' ')}</strong>
                  <p>{stage.detail || 'No additional detail.'}</p>
                </div>
                <span>{stage.status}</span>
              </div>
            ))
          ) : (
            <div className="ws-vnext-callout">
              The server reported the run status but did not emit stage telemetry.
              Workspace will not invent progress or time remaining.
            </div>
          )}
        </div>
      ) : null}

      {run?.sectionResults ? (
        <div className="ws-audit-section-results">
          {Object.entries(run.sectionResults).map(([section, status]) => (
            <span key={section} data-status={status}>
              {section} · {status}
            </span>
          ))}
        </div>
      ) : null}

      <div className="ws-audit-generation-panel__note">
        Cancellation is unavailable because the current provider request is not
        cooperatively abortable. Closing the page does not mark the run complete.
      </div>
    </div>
  );
}

function ProposalReview({
  proposal,
  busy,
  onAccept,
  onReject,
}: {
  proposal: AgentProposal;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const payload = proposal.payload ?? {};
  const before = payload.before ?? payload.outlineSnapshot ?? null;
  const after = payload.after ?? payload.proposedOutline ?? payload.revisedContent ?? null;
  const canApply = after != null;
  return (
    <div className="ws-audit-proposal-review">
      <div className="ws-audit-proposal-grid">
        <div>
          <div className="ws-audit-eyebrow">CURRENT</div>
          <pre>{before == null ? 'Current content is not included in this proposal.' : JSON.stringify(before, null, 2)}</pre>
        </div>
        <div>
          <div className="ws-audit-eyebrow">PROPOSED</div>
          <pre>{after == null ? 'The backend did not return proposed content. This proposal cannot be applied honestly.' : JSON.stringify(after, null, 2)}</pre>
        </div>
      </div>
      <dl className="ws-audit-proposal-meta">
        <div><dt>Base revision</dt><dd>{proposal.baseRevision}</dd></div>
        <div><dt>Base hash</dt><dd>{proposal.baseHash.slice(0, 12)}</dd></div>
        <div><dt>Status</dt><dd>{proposal.status}</dd></div>
      </dl>
      <div className="ws-audit-actions">
        <CapiroButton variant="secondary" disabled={busy} onClick={onReject}>Reject</CapiroButton>
        <CapiroButton variant="primary" disabled={!canApply || busy} loading={busy} onClick={onAccept}>Accept proposal</CapiroButton>
      </div>
    </div>
  );
}

export interface WorkspaceEditorStabilizedProps {
  draftId: string;
  isRunView?: boolean;
}

export function WorkspaceEditorStabilized({ draftId, isRunView = false }: WorkspaceEditorStabilizedProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const draftQuery = useDraft(draftId);
  const updateDraft = useUpdateDraft(draftId);
  const updateDocument = useUpdateDocument(draftId);
  const addDocument = useAddDocument(draftId);
  const deleteDocument = useDeleteDocument(draftId);
  const createVersion = useCreateVersion(draftId);
  const restoreVersion = useRestoreVersion(draftId);
  const versionsQuery = useVersions(draftId);
  const collaboratorsQuery = useCollaborators(draftId);
  const tenantMembersQuery = useTenantMembers();
  const inviteCollaborator = useInviteCollaborator(draftId);
  const updateCollaborator = useUpdateCollaboratorRole(draftId);
  const removeCollaborator = useRemoveCollaborator(draftId);
  const exportDocx = useExportDocx(draftId);
  const exportPdf = useExportPdf(draftId);

  const selfName =
    `${me?.user.firstName ?? ''} ${me?.user.lastName ?? ''}`.trim() ||
    me?.user.email ||
    'You';
  const editLock = useEditLock(draftId, selfName);
  const viewOnly = editLock.lock.held && !editLock.lock.heldByMe;

  const agentKey = useMemo(() => ['ws', 'agent', draftId] as const, [draftId]);
  const agentQuery = useQuery({
    queryKey: agentKey,
    queryFn: () => api.getAgentState(draftId),
    retry: false,
  });
  const state = agentQuery.data?.state ?? null;

  const messagesQuery = useQuery({
    queryKey: ['ws', 'agent', 'messages', draftId],
    queryFn: () => api.getMessages(draftId),
    enabled: Boolean(state),
    retry: false,
  });
  const contextQuery = useQuery({
    queryKey: ['ws', 'context', draftId],
    queryFn: () => api.getContext(draftId),
    enabled: Boolean(state),
  });
  const qualityQuery = useQuery({
    queryKey: ['ws', 'agent', 'quality', draftId],
    queryFn: () => api.getQuality(draftId),
    enabled: Boolean(state) && ['draft', 'quality', 'complete'].includes(state?.phase ?? ''),
    retry: false,
  });
  const proposalsQuery = useQuery({
    queryKey: ['ws', 'agent', 'proposals', draftId],
    queryFn: () => api.getProposals(draftId),
    enabled: Boolean(state),
  });
  const generationQuery = useQuery({
    queryKey: ['ws', 'agent', 'generation', draftId],
    queryFn: () => api.getGeneration(draftId),
    enabled:
      Boolean(state) &&
      (state?.phase === 'generate' ||
        state?.status === 'generating' ||
        Boolean(state?.generation.activeRunId)),
    refetchInterval: (query) =>
      query.state.data?.status === 'active' ? 2_500 : false,
    retry: false,
  });

  const draft = draftQuery.data ?? null;
  const [cfg, setCfg] = useState<WsConfig | null>(null);
  const [docTitle, setDocTitle] = useState('');
  const [packetBodies, setPacketBodies] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState(MAIN_TAB);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('brief');
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [selection, setSelection] = useState<SelectionAnchor | null>(null);
  const [composer, setComposer] = useState('');
  const [messageScope, setMessageScope] = useState<SendMessageScope>({ kind: 'whole_document' });
  const [sending, setSending] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [banner, setBanner] = useState<BannerState>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null);
  const [localMode, setLocalMode] = useState<GenerationMode>('standard');
  const [commentText, setCommentText] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [suggestions, setSuggestions] = useState<Record<string, { before?: string; after: string }>>({});
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WsAssignableRole>('viewer');
  const [shareResult, setShareResult] = useState<ShareLinkResponse | null>(null);
  const [preflight, setPreflight] = useState<Awaited<ReturnType<typeof api.preflight>> | null>(null);

  const dirtyMain = useRef(false);
  const dirtyPackets = useRef<Set<string>>(new Set());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<() => Promise<{ ok: boolean }>>(async () => ({ ok: true }));

  useEffect(() => {
    if (!draft || dirtyMain.current || dirtyPackets.current.size) return;
    setCfg(draft.config);
    setDocTitle(draft.docTitle);
    setPacketBodies(
      Object.fromEntries(draft.documents.map((document) => [document.id, documentBodyToHtml(document)])),
    );
  }, [draft]);

  useEffect(() => {
    if (!state) return;
    setInspectorTab(phaseToTab(state.phase));
    setLocalMode(state.generation.mode);
  }, [state?.phase, state?.generation.mode]);

  const activeDocument = useMemo(
    () => draft?.documents.find((document) => document.id === activeTab) ?? null,
    [activeTab, draft?.documents],
  );
  const primary = useMemo(
    () => (draft ? primaryDocument(draft.documents) : null),
    [draft],
  );
  const activeDocumentId = activeTab === MAIN_TAB ? primary?.id ?? null : activeDocument?.id ?? null;
  const commentsQuery = useComments(activeDocumentId);
  const createComment = useCreateComment(activeDocumentId ?? '');
  const updateComment = useUpdateComment(activeDocumentId ?? '');
  const suggestComment = useSuggestCommentEdit(activeDocumentId ?? '');

  const getRevision = useCallback(() => {
    const cached = queryClient.getQueryData<AgentStateResponse>(agentKey);
    return cached?.state.revision ?? state?.revision ?? 0;
  }, [agentKey, queryClient, state?.revision]);

  const storeAgent = useCallback(
    (next: AgentStateResponse | AgentState) => {
      const response = 'state' in next ? next : { state: next };
      queryClient.setQueryData(agentKey, response);
      void queryClient.invalidateQueries({ queryKey: ['ws', 'drafts'] });
    },
    [agentKey, queryClient],
  );

  const refreshAgent = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: agentKey });
  }, [agentKey, queryClient]);

  const handleAgentError = useCallback(
    (error: unknown, fallback: string) => {
      const code = errorCode(error);
      if (code === 'DOCUMENT_AGENT_REVISION_CONFLICT') {
        setBanner({ tone: 'red', message: 'This document changed in another session. Refetch the Agent state before continuing.', actionLabel: 'Refetch agent state', action: () => void refreshAgent() });
      } else if (code === 'PROPOSAL_STALE') {
        setBanner({ tone: 'red', message: 'This proposal is stale because the document changed. Request a new proposal.', actionLabel: 'Refresh proposals', action: () => void proposalsQuery.refetch() });
      } else if (code === 'REASONING_UNAVAILABLE' || code === '503') {
        setBanner({ tone: 'red', message: 'Meri reasoning is temporarily unavailable. Your document and unsent text were preserved.', actionLabel: 'Retry', action: () => setBanner(null) });
      } else {
        setBanner({ tone: 'red', message: errorMessage(error, fallback) });
      }
    },
    [proposalsQuery, refreshAgent],
  );

  const flush = useCallback(async (): Promise<{ ok: boolean }> => {
    if (!draft || !cfg) return { ok: true };
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    setSaveState('saving');
    try {
      if (dirtyMain.current) {
        await updateDraft.mutateAsync({
          docTitle,
          config: {
            sectionContent: cfg.sectionContent,
            sectionMeta: cfg.sectionMeta,
          },
        });
        dirtyMain.current = false;
      }
      for (const documentId of [...dirtyPackets.current]) {
        const html = packetBodies[documentId] ?? '';
        await updateDocument.mutateAsync({
          docId: documentId,
          body: { body: htmlToDocumentBody(sanitizeWorkspaceBody(html)) },
        });
        dirtyPackets.current.delete(documentId);
      }
      setSaveState('saved');
      return { ok: true };
    } catch (error) {
      setSaveState('error');
      setBanner({ tone: 'red', message: errorMessage(error, 'Could not save document changes.') });
      return { ok: false };
    }
  }, [cfg, docTitle, draft, packetBodies, updateDocument, updateDraft]);
  flushRef.current = flush;

  const scheduleSave = useCallback(() => {
    setSaveState('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flushRef.current(), AUTOSAVE_MS);
  }, []);

  useEffect(() => {
    const pageHide = () => {
      if (dirtyMain.current || dirtyPackets.current.size) void flushRef.current();
    };
    window.addEventListener('pagehide', pageHide);
    return () => {
      window.removeEventListener('pagehide', pageHide);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  useEffect(() => {
    if (generationQuery.data && generationQuery.data.status !== 'active') {
      void queryClient.invalidateQueries({ queryKey: ['ws', 'draft', draftId] });
      void refreshAgent();
      void queryClient.invalidateQueries({ queryKey: ['ws', 'agent', 'quality', draftId] });
    }
  }, [draftId, generationQuery.data?.status, queryClient, refreshAgent]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        const target = event.target as HTMLElement | null;
        if (target?.closest('.ws-audit-agent-composer')) {
          event.preventDefault();
          void sendMessage();
        }
      }
      if (event.key === 'Escape') {
        if (overlay) setOverlay(null);
        else if (selection) clearSelection();
      }
    };
    document.addEventListener('keydown', onShortcut);
    return () => document.removeEventListener('keydown', onShortcut);
  });

  const setMainSection = (section: string, html: string) => {
    if (!cfg || viewOnly) return;
    setCfg((previous) =>
      previous
        ? {
            ...previous,
            sectionContent: {
              ...mainSectionContent(previous),
              [section]: html,
            },
          }
        : previous,
    );
    dirtyMain.current = true;
    scheduleSave();
  };

  const setPacketBody = (documentId: string, html: string) => {
    if (viewOnly) return;
    setPacketBodies((previous) => ({ ...previous, [documentId]: html }));
    dirtyPackets.current.add(documentId);
    scheduleSave();
  };

  const captureSelection = () => {
    const next = getSelectionAnchor();
    if (!next || next.quote.trim().length < 14) return;
    setSelection(next);
    setMessageScope({
      kind: 'selection',
      documentId: activeDocumentId ?? undefined,
      sectionId: next.section,
      quote: next.quote,
      start: next.start,
      end: next.end,
    });
  };

  const clearSelection = () => {
    setSelection(null);
    setMessageScope({ kind: 'whole_document' });
    window.getSelection()?.removeAllRanges();
  };

  const sendMessage = async (override?: string) => {
    if (!state || sending) return;
    const text = (override ?? composer).trim();
    if (!text) return;
    setSending(true);
    setBanner(null);
    try {
      const response = await api.sendMessage(draftId, {
        text,
        phase: state.phase,
        expectedRevision: getRevision(),
        idempotencyKey: requestId(),
        scope: messageScope,
      });
      if (response.stateSummary) storeAgent(response.stateSummary as AgentState);
      else await refreshAgent();
      await queryClient.invalidateQueries({ queryKey: ['ws', 'agent', 'messages', draftId] });
      if (response.proposal?.proposalId) {
        setActiveProposalId(response.proposal.proposalId);
        await proposalsQuery.refetch();
        setOverlay('proposal');
      }
      setComposer('');
      clearSelection();
    } catch (error) {
      handleAgentError(error, 'Meri could not process that request.');
    } finally {
      setSending(false);
    }
  };

  const mutateAgent = async (
    key: string,
    operation: (revision: number) => Promise<AgentStateResponse>,
    after?: () => Promise<void> | void,
  ) => {
    if (!state || busyAction) return;
    setBusyAction(key);
    setBanner(null);
    try {
      const response = await operation(getRevision());
      storeAgent(response);
      await after?.();
    } catch (error) {
      handleAgentError(error, 'Workspace could not complete that action.');
    } finally {
      setBusyAction(null);
    }
  };

  const cycleMode = () => {
    if (!state) return;
    const current = MODE_ORDER.indexOf(localMode);
    const next = MODE_ORDER[(current + 1) % MODE_ORDER.length] ?? 'standard';
    void mutateAgent('mode', (revision) => api.patchAgent(draftId, revision, { generation: { mode: next } })).then(() => {
      const cached = queryClient.getQueryData<AgentStateResponse>(agentKey);
      if (cached?.state.generation.mode === next) setLocalMode(next);
    });
  };

  const openProposal = async (proposalId: string) => {
    setActiveProposalId(proposalId);
    await proposalsQuery.refetch();
    setOverlay('proposal');
  };

  const activeProposal =
    proposalsQuery.data?.proposals.find((proposal) => proposal.id === activeProposalId) ?? null;

  const reviseOutline = async () => {
    if (!state) return;
    const instruction = window.prompt('How should Meri revise this outline?')?.trim();
    if (!instruction) return;
    setBusyAction('outline-revise');
    try {
      const response = await api.reviseOutline(draftId, getRevision(), instruction);
      await openProposal(response.proposalId);
    } catch (error) {
      handleAgentError(error, 'Could not create an outline proposal.');
    } finally {
      setBusyAction(null);
    }
  };

  const startGeneration = async () => {
    if (!state) return;
    setBusyAction('generate');
    try {
      const response = await api.generate(draftId, getRevision(), localMode, requestId());
      storeAgent(response);
      await generationQuery.refetch();
      await queryClient.invalidateQueries({ queryKey: ['ws', 'draft', draftId] });
    } catch (error) {
      handleAgentError(error, 'Could not start generation.');
    } finally {
      setBusyAction(null);
    }
  };

  const retryGeneration = async () => {
    await mutateAgent('retry-generation', (revision) => api.retryGeneration(draftId, revision), async () => {
      await generationQuery.refetch();
      await queryClient.invalidateQueries({ queryKey: ['ws', 'draft', draftId] });
    });
  };

  const addPacketDocument = async () => {
    const name = window.prompt('Document name')?.trim();
    if (!name) return;
    try {
      const created = await addDocument.mutateAsync({
        name,
        ordinal: (draft?.documents.length ?? 0) + 1,
      });
      setActiveTab(created.id);
    } catch (error) {
      setBanner({ tone: 'red', message: errorMessage(error, 'Could not add the packet document.') });
    }
  };

  const renamePacketDocument = async (document: WsDocument) => {
    const name = window.prompt('Rename document', document.name)?.trim();
    if (!name || name === document.name) return;
    await updateDocument.mutateAsync({ docId: document.id, body: { name } });
  };

  const removePacketDocument = async (document: WsDocument) => {
    if (!window.confirm(`Remove “${document.name}” from this packet?`)) return;
    await deleteDocument.mutateAsync(document.id);
    if (activeTab === document.id) setActiveTab(MAIN_TAB);
  };

  const submitComment = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeDocumentId || !commentText.trim()) return;
    const body = commentText.trim();
    try {
      await createComment.mutateAsync({
        body,
        quote: selection?.quote,
        anchor: selection
          ? { section: selection.section, quote: selection.quote, start: selection.start, end: selection.end }
          : undefined,
      });
      setCommentText('');
      clearSelection();
    } catch (error) {
      setBanner({ tone: 'red', message: errorMessage(error, 'Could not add the comment.') });
    }
  };

  const submitReply = async (commentId: string) => {
    if (!replyText.trim()) return;
    await createComment.mutateAsync({ body: replyText.trim(), parentId: commentId });
    setReplyText('');
    setReplyTo(null);
  };

  const draftCommentEdit = async (comment: WsComment) => {
    try {
      const result = await suggestComment.mutateAsync(comment.id);
      setSuggestions((previous) => ({ ...previous, [comment.id]: result }));
    } catch (error) {
      setBanner({ tone: 'red', message: errorMessage(error, 'Meri could not draft an edit.') });
    }
  };

  const applyCommentEdit = async (comment: WsComment) => {
    const suggestion = suggestions[comment.id];
    const anchor = comment.anchor as CommentAnchor | null;
    if (!suggestion || !anchor || !cfg) return;
    const current = mainSectionContent(cfg)[anchor.section] ?? '';
    setMainSection(anchor.section, applyEditToSectionHtml(current, anchor, suggestion.after));
    await updateComment.mutateAsync({ commentId: comment.id, body: { resolved: true } });
    setSuggestions((previous) => {
      const next = { ...previous };
      delete next[comment.id];
      return next;
    });
  };

  if (draftQuery.isLoading || agentQuery.isLoading) {
    return <div className="ws-vnext ws-audit-editor-loading" role="status" aria-busy="true"><div className="ws-vnext-skeleton-row" /><div className="ws-vnext-skeleton-row" /><div className="ws-vnext-skeleton-row" /></div>;
  }

  if (draftQuery.isError || !draft) {
    return <div className="ws-vnext-empty"><div className="ws-vnext-empty__title">Couldn’t open this document</div><div className="ws-vnext-empty__desc">Workspace could not load the draft or you no longer have access.</div><CapiroButton variant="secondary" onClick={() => navigate('/workspace')}>Back to documents</CapiroButton></div>;
  }

  if (agentQuery.isError || !state || !cfg) {
    return (
      <div className="ws-vnext ws-audit-agent-unavailable">
        <div className="ws-vnext-empty">
          <div className="ws-audit-eyebrow">DOCUMENT AGENT NOT INITIALIZED</div>
          <div className="ws-vnext-empty__title">{draft.docTitle}</div>
          <div className="ws-vnext-empty__desc">This draft belongs to the standard Workspace editor. Nothing is wrong with the document.</div>
          <div className="ws-audit-actions">
            <CapiroButton variant="primary" onClick={() => navigate(`/workspace/draft/${draftId}`)}>Open standard editor</CapiroButton>
            <CapiroButton variant="secondary" onClick={() => navigate('/workspace/new')}>Create an Agent document</CapiroButton>
          </div>
        </div>
      </div>
    );
  }

  const generated = hasGeneratedContent(cfg);
  const sectionContent = mainSectionContent(cfg);
  const sectionNames = cfg.sections?.length
    ? cfg.sections
    : state.outline.sections.map((section) => section.title);
  const latestQuestions = [...(messagesQuery.data?.messages ?? [])]
    .reverse()
    .find((message) => message.questions?.length)?.questions ?? [];
  const comments = commentsQuery.data ?? [];
  const messages: AgentMessage[] = messagesQuery.data?.messages ?? [];
  const quality: QualityResponse | undefined = qualityQuery.data;
  const contextItems: ContextItem[] = contextQuery.data?.items ?? [];
  const run = generationQuery.data;
  const currentSpine = phaseToSpineIndex(state.phase);

  const openSpine = (stop: SpineStop) => {
    if (stop === 'delivery') {
      setOverlay('delivery');
      return;
    }
    setInspectorTab(stop === 'draft' ? 'quality' : (stop as InspectorTab));
    setInspectorCollapsed(false);
  };

  const tabs = [
    { id: MAIN_TAB, label: state.documentType?.label || draft.product || 'Main document' },
    ...draft.documents.map((document) => ({ id: document.id, label: document.name })),
  ];

  return (
    <div className="ws-vnext ws-audit-editor" data-agent-collapsed={agentCollapsed} data-inspector-collapsed={inspectorCollapsed}>
      <header className="ws-audit-editor__header">
        <div className="ws-audit-editor__title-row">
          <button type="button" onClick={() => navigate('/workspace')} aria-label="Back to documents"><Icon name="ArrowLeft" size={18} /></button>
          <div className="ws-audit-editor__title"><h1>{draft.docTitle}</h1><span>{state.documentType?.label || draft.product || 'Document'} · VERSION {state.outline.version || 1} · {saveState.toUpperCase()}</span></div>
          <div className="ws-audit-editor__header-actions">
            <CapiroButton variant="secondary" size="compact" onClick={() => window.open(`/workspace/preview/${draftId}`, '_blank', 'noopener,noreferrer')}>Preview as client</CapiroButton>
            <CapiroButton variant="primary" size="compact" disabled={currentSpine < 3} onClick={() => setOverlay('delivery')}>Deliver</CapiroButton>
            <button type="button" className="ws-audit-icon-button" onClick={() => setOverlay('versions')} aria-label="More document actions"><Icon name="MoreHorizontal" size={18} /></button>
          </div>
        </div>
        <PhaseSpine state={state} onOpen={openSpine} />
      </header>

      {banner ? <div className="ws-vnext-banner" data-variant={banner.tone}><span className="ws-vnext-banner__text">{banner.message}</span>{banner.actionLabel ? <button className="ws-vnext-banner__action" type="button" onClick={banner.action}>{banner.actionLabel}</button> : <button className="ws-vnext-banner__action" type="button" onClick={() => setBanner(null)}>Dismiss</button>}</div> : null}
      <LockBanner lock={editLock.lock} requestPending={editLock.requestPending} requestBusy={editLock.requestBusy} takeOverBusy={editLock.takeOverBusy} releasing={editLock.releasing} onRequest={editLock.request} onTakeOver={editLock.takeOver} onSaveAndRelease={() => void editLock.saveAndRelease(flush)} onKeepEditing={editLock.keepEditing} />

      <div className="ws-audit-editor__grid">
        <aside className="ws-audit-agent-panel">
          {agentCollapsed ? (
            <button type="button" className="ws-audit-collapsed-rail" onClick={() => setAgentCollapsed(false)}><Icon name="ChevronRight" size={16} /><span className="ws-audit-m-mark">M</span><b>{messages.length}</b><em>DOCUMENT AGENT</em></button>
          ) : (
            <>
              <header className="ws-audit-panel-header"><div><div className="ws-audit-eyebrow">DOCUMENT AGENT</div><strong>{roleLabel(state.phase)}</strong></div><div className="ws-audit-panel-header__actions"><button type="button" className="ws-audit-mode-chip" disabled={busyAction === 'mode'} onClick={cycleMode}>{localMode.toUpperCase()}</button><button type="button" onClick={() => setAgentCollapsed(true)} aria-label="Collapse Agent"><Icon name="PanelLeftClose" size={16} /></button></div></header>
              <div className="ws-audit-agent-thread">
                {messages.length ? messages.map((message) => <div key={message.id} className="ws-audit-agent-message" data-role={message.role}><span>{message.role === 'agent' ? 'M' : initials(selfName)}</span><div><p>{message.text}</p>{message.proposalId ? <button type="button" onClick={() => void openProposal(message.proposalId!)}>Review proposal</button> : null}</div></div>) : <div className="ws-vnext-callout">Tell the Document Agent what this paper needs to accomplish or answer the questions below.</div>}
                {latestQuestions.length ? <div className="ws-audit-agent-questions"><div className="ws-audit-eyebrow">NEEDS YOUR ANSWER</div>{latestQuestions.map((question) => <button type="button" key={question.id} onClick={() => setComposer(question.label)}>{question.required ? 'Required · ' : ''}{question.label}</button>)}</div> : null}
                {sending ? <div className="ws-audit-thinking"><span />Meri is working…</div> : null}
              </div>
              <div className="ws-audit-quick-revisions"><div className="ws-audit-eyebrow">QUICK REVISIONS</div><button type="button" onClick={() => setComposer('Make this more concise without losing evidence.')}>Shorten</button><button type="button" onClick={() => setComposer('Check every material claim against the approved evidence.')}>Check evidence</button><button type="button" onClick={() => setComposer('Make the requested action clearer for the intended audience.')}>Clarify ask</button></div>
              <div className="ws-audit-agent-composer"><textarea value={composer} onChange={(event) => setComposer(event.target.value)} placeholder="Ask for a revision or answer a question…" disabled={sending} /><div><button type="button" className="ws-audit-scope-chip" onClick={clearSelection}>{messageScope.kind === 'selection' ? `Selection · ${messageScope.quote?.split(/\s+/).length ?? 0} words` : 'Whole document'}</button><CapiroButton variant="primary" size="compact" loading={sending} disabled={!composer.trim()} onClick={() => void sendMessage()}>Send</CapiroButton></div></div>
            </>
          )}
        </aside>

        <main className="ws-audit-canvas">
          <div className="ws-audit-packet-tabs"><div className="ws-audit-packet-tabs__scroll">{tabs.map((tab) => <button type="button" key={tab.id} data-active={activeTab === tab.id} onClick={() => setActiveTab(tab.id)} onDoubleClick={() => { const document = draft.documents.find((item) => item.id === tab.id); if (document) void renamePacketDocument(document); }}>{tab.label}{tab.id !== MAIN_TAB ? <span onClick={(event) => { event.stopPropagation(); const document = draft.documents.find((item) => item.id === tab.id); if (document) void removePacketDocument(document); }}>×</span> : null}</button>)}</div><button type="button" onClick={() => void addPacketDocument()} aria-label="Add packet document"><Icon name="Plus" size={15} /></button><button type="button" data-active={commentsOpen} onClick={() => setCommentsOpen((open) => !open)}><Icon name="MessageSquare" size={15} />{comments.filter((comment) => !comment.resolved).length}</button></div>
          <div className="ws-audit-provenance-strip">{generated ? `AS GENERATED · OUTLINE V${state.outline.version} · ${state.contextPlan.includedItemIds.length} SOURCES · QUALITY ${quality?.score == null ? '—' : `${quality.score}%`}` : `NOT GENERATED · BLUEPRINT V${state.blueprintPin?.version ?? '—'} · ${state.outline.sections.length} SECTIONS PLANNED`}<button type="button" onClick={() => setInspectorTab('context')}>Context used</button></div>

          {state.phase === 'generate' || isRunView ? (
            <GenerationPanel state={state} run={run} busy={busyAction === 'generate' || busyAction === 'retry-generation'} onStart={() => void startGeneration()} onRetry={() => void retryGeneration()} />
          ) : (
            <div className="ws-audit-canvas__body" onMouseUp={captureSelection}>
              {activeTab === MAIN_TAB ? (
                <article className="ws-audit-paper" style={{ background: String(state.theme?.settings?.paperColor ?? '#FEFDFA') }}>
                  <div className="ws-audit-paper__rule" />
                  <div className="ws-audit-eyebrow">{state.documentType?.label || draft.product || 'DOCUMENT'}</div>
                  <h1>{docTitle}</h1>
                  {!generated ? <div className="ws-audit-paper__scaffold-note">This is the approved document plan. It will become editable prose after generation.</div> : null}
                  {sectionNames.map((sectionName) => {
                    const outlineSection = state.outline.sections.find((section) => section.title === sectionName || section.id === sectionName);
                    const content = sectionContent[sectionName] ?? '';
                    return <section key={sectionName} className="ws-audit-paper-section" data-scaffold={!generated}><div className="ws-audit-paper-section__heading"><h2>{sectionName}</h2>{!generated ? <span>{outlineSection?.required ? 'required · ' : ''}{outlineSection?.locked ? 'locked · ' : ''}{outlineSection ? `${outlineSection.targetWords.min}–${outlineSection.targetWords.max} words · ${outlineSection.evidenceItemIds.length} evidence items` : 'planned section'}</span> : null}</div>{generated ? <EditableHtml value={content} section={sectionName} readOnly={viewOnly} placeholder="Write this section…" onChange={(html) => setMainSection(sectionName, html)} /> : <p>{outlineSection?.purpose || 'This section will be drafted from the approved brief, context, and blueprint.'}</p>}</section>;
                  })}
                  <footer>CONFIDENTIAL · DRAFT · {saveState.toUpperCase()}</footer>
                </article>
              ) : activeDocument ? (
                <article className="ws-audit-paper"><div className="ws-audit-paper__rule" /><div className="ws-audit-eyebrow">PACKET DOCUMENT</div><h1>{activeDocument.name}</h1><EditableHtml value={packetBodies[activeDocument.id] ?? ''} section={`packet:${activeDocument.id}`} readOnly={viewOnly} placeholder="Write this packet document…" onChange={(html) => setPacketBody(activeDocument.id, html)} /><footer>CONFIDENTIAL · DRAFT · {saveState.toUpperCase()}</footer></article>
              ) : null}
              {selection ? <div className="ws-audit-selection-bar"><q>{selection.quote.slice(0, 96)}{selection.quote.length > 96 ? '…' : ''}</q><button type="button" onClick={() => { setComposer('Shorten this selection without losing any supported claim.'); }}>Shorten</button><button type="button" onClick={() => setComposer('Check the evidence supporting this selection.')}>Check evidence</button><button type="button" onClick={() => setComposer('Revise this selection: ')}>Ask Meri</button><button type="button" onClick={clearSelection} aria-label="Clear selection"><Icon name="X" size={14} /></button></div> : null}
            </div>
          )}
        </main>

        {commentsOpen ? <aside className="ws-audit-comments-drawer"><header><div><div className="ws-audit-eyebrow">COMMENTS</div><strong>{comments.filter((comment) => !comment.resolved).length} open</strong></div><button type="button" onClick={() => setCommentsOpen(false)} aria-label="Close comments"><Icon name="X" size={16} /></button></header>{activeDocumentId ? <><form onSubmit={submitComment}><textarea value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder={selection ? `Comment on “${selection.quote.slice(0, 45)}…”` : 'Add a comment…'} /><CapiroButton variant="primary" size="compact" disabled={!commentText.trim()} loading={createComment.isPending}>Comment</CapiroButton></form><div className="ws-audit-comments-list">{comments.map((comment) => { const member = tenantMembersQuery.data?.find((item) => item.clerkUserId === comment.authorId); const author = comment.authorId.startsWith('guest:') ? 'Guest reviewer' : member?.name || 'Teammate'; const suggestion = suggestions[comment.id]; return <article key={comment.id} data-resolved={comment.resolved}><div className="ws-audit-comment-author"><span>{initials(author)}</span><div><strong>{author}</strong><em>{formatTimestamp(comment.createdAt)}</em></div></div>{comment.quote ? <blockquote>{comment.quote}</blockquote> : null}<p>{comment.body}</p>{suggestion ? <div className="ws-audit-comment-suggestion"><div className="ws-audit-eyebrow">MERI SUGGESTS</div>{suggestion.before ? <del>{suggestion.before}</del> : null}<p>{suggestion.after}</p><div><button type="button" onClick={() => void applyCommentEdit(comment)}>Approve</button><button type="button" onClick={() => setSuggestions((previous) => { const next = { ...previous }; delete next[comment.id]; return next; })}>Reject</button></div></div> : null}<div className="ws-audit-comment-actions"><button type="button" disabled={!comment.anchor || suggestComment.isPending} onClick={() => void draftCommentEdit(comment)}>Let Meri draft an edit</button><button type="button" onClick={() => setReplyTo(comment.id)}>Reply</button>{!comment.resolved ? <button type="button" onClick={() => void updateComment.mutateAsync({ commentId: comment.id, body: { resolved: true } })}>Resolve</button> : null}</div>{replyTo === comment.id ? <div className="ws-audit-reply"><input value={replyText} onChange={(event) => setReplyText(event.target.value)} placeholder="Reply…" /><button type="button" onClick={() => void submitReply(comment.id)}>Send</button></div> : null}{comment.replies?.map((reply) => <div key={reply.id} className="ws-audit-comment-reply"><strong>{reply.authorId.startsWith('guest:') ? 'Guest reviewer' : tenantMembersQuery.data?.find((item) => item.clerkUserId === reply.authorId)?.name || 'Teammate'}</strong><p>{reply.body}</p></div>)}</article>; })}</div></> : <div className="ws-vnext-callout">Comments become available after the draft has a document row.</div>}</aside> : null}

        <aside className="ws-audit-inspector">
          {inspectorCollapsed ? <div className="ws-audit-collapsed-inspector"><button type="button" onClick={() => setInspectorCollapsed(false)} aria-label="Expand inspector"><Icon name="ChevronLeft" size={16} /></button>{(['brief','context','outline','design','quality'] as InspectorTab[]).map((tab) => <button type="button" key={tab} data-active={inspectorTab === tab} onClick={() => { setInspectorTab(tab); setInspectorCollapsed(false); }} aria-label={roleLabel(tab)}><Icon name={tab === 'brief' ? 'ClipboardCheck' : tab === 'context' ? 'Database' : tab === 'outline' ? 'List' : tab === 'design' ? 'Diamond' : 'ShieldCheck'} size={16} /></button>)}</div> : <><header className="ws-audit-panel-header"><div className="ws-audit-inspector-tabs">{(['brief','context','outline','design','quality'] as InspectorTab[]).map((tab) => <button type="button" key={tab} data-active={inspectorTab === tab} onClick={() => setInspectorTab(tab)}>{roleLabel(tab)}{tab === 'context' && unresolvedConflictCount(state) ? <span>{unresolvedConflictCount(state)}</span> : null}{tab === 'quality' && quality?.blockers.length ? <span>{quality.blockers.length}</span> : null}</button>)}</div><button type="button" onClick={() => setInspectorCollapsed(true)} aria-label="Collapse inspector"><Icon name="PanelRightClose" size={16} /></button></header><div className="ws-audit-inspector__body">
            {inspectorTab === 'brief' ? <BriefInspector state={state} busy={busyAction} onMutate={mutateAgent} /> : null}
            {inspectorTab === 'context' ? <ContextInspector state={state} items={contextItems} busy={busyAction} onMutate={mutateAgent} onItemsChanged={() => void contextQuery.refetch()} /> : null}
            {inspectorTab === 'outline' ? <OutlineInspector state={state} busy={busyAction} onMutate={mutateAgent} onRevise={() => void reviseOutline()} /> : null}
            {inspectorTab === 'design' ? <DesignInspector state={state} /> : null}
            {inspectorTab === 'quality' ? <QualityInspector state={state} quality={quality} busy={busyAction} onRefresh={() => void qualityQuery.refetch()} onFix={async (issueId) => { setBusyAction(`fix-${issueId}`); try { const response = await api.fixIssue(draftId, issueId, getRevision()); await openProposal(response.proposalId); } catch (error) { handleAgentError(error, 'Could not create a quality-fix proposal.'); } finally { setBusyAction(null); } }} onPreflight={() => setOverlay('delivery')} /> : null}
          </div></>}
        </aside>
      </div>

      {overlay === 'proposal' && activeProposal ? <ModalShell kicker="AGENT PROPOSAL" title="Review proposed change" onClose={() => setOverlay(null)}><ProposalReview proposal={activeProposal} busy={busyAction === 'proposal'} onReject={() => void mutateAgent('proposal', (revision) => api.rejectProposal(draftId, activeProposal.id, revision), async () => { setOverlay(null); await proposalsQuery.refetch(); })} onAccept={() => void mutateAgent('proposal', (revision) => api.acceptProposal(draftId, activeProposal.id, revision), async () => { setOverlay(null); await proposalsQuery.refetch(); await queryClient.invalidateQueries({ queryKey: ['ws', 'draft', draftId] }); })} /></ModalShell> : null}
      {overlay === 'versions' ? <VersionsOverlay versions={versionsQuery.data ?? []} busy={createVersion.isPending || restoreVersion.isPending} onClose={() => setOverlay(null)} onCreate={() => void createVersion.mutateAsync({ label: 'Manual checkpoint', authorKind: 'person' })} onRestore={(versionId) => { if (window.confirm('Restore this version as the live draft?')) void restoreVersion.mutateAsync(versionId); }} onCollaborators={() => setOverlay('collaborators')} /> : null}
      {overlay === 'collaborators' ? <CollaboratorsOverlay collaborators={collaboratorsQuery.data ?? []} members={tenantMembersQuery.data ?? []} email={inviteEmail} role={inviteRole} busy={inviteCollaborator.isPending || updateCollaborator.isPending || removeCollaborator.isPending} onEmail={setInviteEmail} onRole={setInviteRole} onInvite={async () => { if (!inviteEmail.trim()) return; await inviteCollaborator.mutateAsync({ email: inviteEmail.trim(), name: inviteEmail.trim(), role: inviteRole, inviterName: selfName }); setInviteEmail(''); }} onUpdate={(id, role) => void updateCollaborator.mutateAsync({ id, role })} onRemove={(id) => void removeCollaborator.mutateAsync(id)} onClose={() => setOverlay(null)} /> : null}
      {overlay === 'delivery' ? <DeliveryOverlay state={state} preflight={preflight} shareResult={shareResult} busy={Boolean(busyAction) || createVersion.isPending || exportDocx.isPending || exportPdf.isPending} onClose={() => setOverlay(null)} onPreflight={async () => { setBusyAction('preflight'); try { const result = await api.preflight(draftId); setPreflight(result); } catch (error) { handleAgentError(error, 'Delivery preflight failed.'); } finally { setBusyAction(null); } }} onRequestApproval={async () => { setBusyAction('approval'); try { await api.createApprovalRequest(draftId, { idempotencyKey: requestId() }); setBanner({ tone: 'blue', message: 'Approval requested.' }); } catch (error) { handleAgentError(error, 'Could not request approval.'); } finally { setBusyAction(null); } }} onCreateShare={async () => { setBusyAction('share'); try { const version = await createVersion.mutateAsync({ label: 'Client share snapshot', authorKind: 'person' }); const result = await api.createShareLink(draftId, { versionId: version.id, expiresInDays: 7, idempotencyKey: requestId() }); setShareResult(result); } catch (error) { handleAgentError(error, 'Could not create the share link.'); } finally { setBusyAction(null); } }} onDocx={() => void exportDocx.mutateAsync({ filenameHint: draft.docTitle, part: 'all' })} onPdf={() => void exportPdf.mutateAsync({ filenameHint: draft.docTitle, part: 'all' })} /> : null}
    </div>
  );
}

function BriefInspector({ state, busy, onMutate }: { state: AgentState; busy: string | null; onMutate: (key: string, operation: (revision: number) => Promise<AgentStateResponse>) => Promise<void> }) {
  const fields: Array<[keyof AgentState['brief'], string]> = [['objective','Objective'],['audience','Audience'],['desiredAction','Desired action'],['subject','Subject'],['centralArgument','Central argument'],['evidenceInstructions','Evidence instructions'],['tone','Tone'],['deadline','Deadline']];
  return <div className="ws-audit-inspector-stack"><div className="ws-audit-inspector-title"><div className="ws-audit-eyebrow">WORKING BRIEF</div><span className="ws-vnext-status-pill" data-status={state.brief.approvedAt ? 'complete' : 'needs_input'}><span className="ws-vnext-status-pill__dot" />{state.brief.approvedAt ? 'Approved' : 'Needs review'}</span></div>{fields.map(([key,label]) => <label className="ws-audit-field-card" key={key}><span>{label}<em>{state.brief.provenance?.[key] ?? '—'}</em></span><textarea defaultValue={String(state.brief[key] ?? '')} disabled={Boolean(state.brief.approvedAt) || Boolean(busy)} onBlur={(event) => { const value = event.target.value; if (value !== String(state.brief[key] ?? '')) void onMutate(`brief-${key}`, (revision) => api.updateBrief((window.location.pathname.match(/[0-9a-f-]{36}/i)?.[0] ?? ''), revision, { [key]: value })); }} /></label>)}{state.brief.assumptions.map((assumption) => <div className="ws-audit-assumption" key={assumption.id}><div><strong>{assumption.text}</strong><span>{assumption.status}</span></div>{assumption.status === 'open' ? <div><button type="button" onClick={() => void onMutate(`assumption-${assumption.id}`, (revision) => api.updateBrief((window.location.pathname.match(/[0-9a-f-]{36}/i)?.[0] ?? ''), revision, { assumptions: state.brief.assumptions.map((item) => item.id === assumption.id ? { ...item, status: 'confirmed' } : item) }))}>Confirm</button><button type="button" onClick={() => void onMutate(`assumption-${assumption.id}`, (revision) => api.updateBrief((window.location.pathname.match(/[0-9a-f-]{36}/i)?.[0] ?? ''), revision, { assumptions: state.brief.assumptions.map((item) => item.id === assumption.id ? { ...item, status: 'rejected' } : item) }))}>Reject</button></div> : null}</div>)}<div className="ws-audit-actions">{state.brief.approvedAt ? <CapiroButton variant="secondary" loading={busy === 'brief-reopen'} onClick={() => void onMutate('brief-reopen', (revision) => api.reopenBrief((window.location.pathname.match(/[0-9a-f-]{36}/i)?.[0] ?? ''), revision))}>Edit brief</CapiroButton> : <><CapiroButton variant="secondary" loading={busy === 'brief-synthesize'} onClick={() => void onMutate('brief-synthesize', (revision) => api.synthesizeBrief((window.location.pathname.match(/[0-9a-f-]{36}/i)?.[0] ?? ''), revision))}>Synthesize from conversation</CapiroButton><CapiroButton variant="primary" loading={busy === 'brief-approve'} onClick={() => void onMutate('brief-approve', (revision) => api.approveBrief((window.location.pathname.match(/[0-9a-f-]{36}/i)?.[0] ?? ''), revision))}>Approve brief</CapiroButton></>}</div></div>;
}

function ContextInspector({ state, items, busy, onMutate, onItemsChanged }: { state: AgentState; items: ContextItem[]; busy: string | null; onMutate: (key: string, operation: (revision: number) => Promise<AgentStateResponse>) => Promise<void>; onItemsChanged: () => void }) {
  const unresolved = state.contextPlan.conflicts.filter((conflict) => !conflict.resolved);
  const coverage = state.contextPlan.coverage;
  const draftId = window.location.pathname.match(/[0-9a-f-]{36}/i)?.[0] ?? '';
  return <div className="ws-audit-inspector-stack"><div className="ws-audit-coverage"><div className="ws-audit-eyebrow">EVIDENCE COVERAGE</div><strong>{coverage.supportedClaims} of {coverage.plannedClaims || '—'} planned claims supported</strong>{coverage.plannedClaims > 0 ? <progress value={coverage.supportedClaims} max={coverage.plannedClaims} /> : null}{coverage.missingClaims.map((claim) => <p key={claim.claimId}>{claim.description} · {claim.recommendedSourceTypes.join(', ')}</p>)}</div>{unresolved.map((conflict) => <div className="ws-audit-conflict" key={conflict.id}><div className="ws-audit-eyebrow">{conflict.type} conflict</div><strong>{conflict.description}</strong><p>{conflict.recommendedResolution}</p><button type="button" disabled title="A semantic conflict-resolution endpoint is not available yet.">Resolution unavailable</button></div>)}<div className="ws-audit-context-items">{items.map((item) => <label key={item.id}><input type="checkbox" checked={item.included} onChange={async () => { await api.patchContextItem(draftId, item.id, { included: !item.included, exclusionReason: item.included ? 'Excluded by user' : undefined }); onItemsChanged(); }} /><span><strong>{item.label}</strong><em>{[item.sourceType,item.authority,item.freshness].filter(Boolean).join(' · ') || '—'}</em>{item.exclusionReason ? <small>{item.exclusionReason}</small> : null}</span></label>)}</div><div className="ws-audit-actions"><CapiroButton variant="secondary" loading={busy === 'context-recommend'} onClick={() => void onMutate('context-recommend', (revision) => api.recommendContext(draftId, revision))}>Recommend</CapiroButton><CapiroButton variant="secondary" loading={busy === 'context-analyze'} onClick={() => void onMutate('context-analyze', (revision) => api.analyzeContext(draftId, revision))}>Analyze</CapiroButton><CapiroButton variant="primary" disabled={unresolved.length > 0} loading={busy === 'context-approve'} onClick={() => void onMutate('context-approve', (revision) => api.approveContext(draftId, revision))}>Approve context</CapiroButton></div></div>;
}

function OutlineInspector({ state, busy, onMutate, onRevise }: { state: AgentState; busy: string | null; onMutate: (key: string, operation: (revision: number) => Promise<AgentStateResponse>) => Promise<void>; onRevise: () => void }) {
  const draftId = window.location.pathname.match(/[0-9a-f-]{36}/i)?.[0] ?? '';
  const saveSections = (sections: OutlineSection[]) => onMutate('outline-update', (revision) => api.updateOutline(draftId, revision, sections));
  return <div className="ws-audit-inspector-stack">{state.outline.sections.length ? state.outline.sections.map((section,index) => <div className="ws-audit-outline-card" key={section.id}><div><span>{String(index + 1).padStart(2,'0')}</span><input defaultValue={section.title} onBlur={(event) => { if (event.target.value !== section.title) void saveSections(state.outline.sections.map((item) => item.id === section.id ? { ...item, title: event.target.value } : item)); }} /></div><textarea defaultValue={section.purpose} onBlur={(event) => { if (event.target.value !== section.purpose) void saveSections(state.outline.sections.map((item) => item.id === section.id ? { ...item, purpose: event.target.value } : item)); }} /><footer><span>{section.targetWords.min}–{section.targetWords.max} words</span><span data-warning={!section.evidenceItemIds.length}>{section.evidenceItemIds.length} evidence items</span><label><input type="checkbox" checked={section.locked} onChange={() => void saveSections(state.outline.sections.map((item) => item.id === section.id ? { ...item, locked: !item.locked } : item))} />Locked</label><button type="button" disabled={section.required} title={section.required ? 'Required sections cannot be removed.' : 'Remove section'} onClick={() => void saveSections(state.outline.sections.filter((item) => item.id !== section.id))}>Remove</button></footer></div>) : <div className="ws-vnext-empty"><div className="ws-vnext-empty__title">No outline yet</div></div>}<div className="ws-audit-actions">{!state.outline.sections.length ? <CapiroButton variant="primary" loading={busy === 'outline-generate'} onClick={() => void onMutate('outline-generate', (revision) => api.generateOutline(draftId, revision))}>Generate outline</CapiroButton> : <><CapiroButton variant="secondary" loading={busy === 'outline-revise'} onClick={onRevise}>Revise with Meri</CapiroButton><CapiroButton variant="primary" loading={busy === 'outline-approve'} onClick={() => void onMutate('outline-approve', (revision) => api.approveOutline(draftId, revision))}>Approve outline</CapiroButton></>}</div></div>;
}

function DesignInspector({ state }: { state: AgentState }) {
  return <div className="ws-audit-inspector-stack"><div className="ws-audit-pin-card"><div className="ws-audit-eyebrow">BLUEPRINT PIN</div><strong>Version {state.blueprintPin?.version ?? '—'}</strong><code>{state.blueprintPin?.definitionHash?.slice(0, 16) || 'No hash'}</code><p>This document remains pinned to this blueprint version even when a newer version is published.</p></div><div className="ws-audit-field-card"><span>Theme</span><strong>{state.theme?.name || 'Default theme'}</strong></div><div className="ws-vnext-callout">Theme editing remains read-only because Workspace does not yet expose versioned theme CRUD and export parity routes.</div></div>;
}

function QualityInspector({ state, quality, busy, onRefresh, onFix, onPreflight }: { state: AgentState; quality: QualityResponse | undefined; busy: string | null; onRefresh: () => void; onFix: (issueId: string) => Promise<void>; onPreflight: () => void }) {
  if (!quality) return <div className="ws-audit-inspector-stack"><div className="ws-vnext-callout">Quality becomes available after generation.</div><CapiroButton variant="secondary" onClick={onRefresh}>Load quality</CapiroButton></div>;
  return <div className="ws-audit-inspector-stack"><div className="ws-audit-quality-score"><strong>{quality.score == null ? '—' : quality.score}</strong><span>{quality.readiness}</span></div>{quality.blockers.map((blocker) => <div className="ws-audit-quality-item" data-status="error" key={blocker}><strong>Blocker</strong><p>{blocker}</p></div>)}{quality.recommendations.map((recommendation) => <div className="ws-audit-quality-item" data-status="warning" key={recommendation}><strong>Recommendation</strong><p>{recommendation}</p></div>)}{quality.checks.map((check) => <div className="ws-audit-quality-item" data-status={check.status} key={check.id}><div><strong>{check.label}</strong><span>{check.status}</span></div><code>{check.id}</code><p>{check.detail}</p>{check.fixable ? <button type="button" disabled={busy === `fix-${check.id}`} onClick={() => void onFix(check.id)}>Fix with Meri</button> : null}</div>)}<CapiroButton variant="primary" disabled={state.phase === 'generate'} onClick={onPreflight}>Run delivery preflight</CapiroButton></div>;
}

function VersionsOverlay({ versions, busy, onClose, onCreate, onRestore, onCollaborators }: { versions: WsDocVersion[]; busy: boolean; onClose: () => void; onCreate: () => void; onRestore: (id: string) => void; onCollaborators: () => void }) {
  return <ModalShell kicker="VERSION HISTORY" title="Document versions" onClose={onClose} footer={<><CapiroButton variant="secondary" onClick={onCollaborators}>Collaborators</CapiroButton><CapiroButton variant="primary" loading={busy} onClick={onCreate}>Create version</CapiroButton></>}><div className="ws-audit-version-list">{versions.length ? versions.map((version) => <div key={version.id}><div><strong>{version.label || 'Saved version'}</strong><span>{formatTimestamp(version.createdAt)} · {version.authorKind}</span></div><button type="button" disabled={busy} onClick={() => onRestore(version.id)}>Restore</button></div>) : <div className="ws-vnext-empty__desc">No saved versions yet.</div>}</div></ModalShell>;
}

function CollaboratorsOverlay({ collaborators, members, email, role, busy, onEmail, onRole, onInvite, onUpdate, onRemove, onClose }: { collaborators: NonNullable<ReturnType<typeof useCollaborators>['data']>; members: NonNullable<ReturnType<typeof useTenantMembers>['data']>; email: string; role: WsAssignableRole; busy: boolean; onEmail: (value: string) => void; onRole: (value: WsAssignableRole) => void; onInvite: () => Promise<void>; onUpdate: (id: string, role: WsAssignableRole) => void; onRemove: (id: string) => void; onClose: () => void }) {
  return <ModalShell kicker="COLLABORATION" title="People with access" onClose={onClose}><form className="ws-audit-invite-form" onSubmit={(event) => { event.preventDefault(); void onInvite(); }}><input list="workspace-members" value={email} onChange={(event) => onEmail(event.target.value)} placeholder="Email or teammate" /><datalist id="workspace-members">{members.map((member) => <option key={member.id} value={member.email}>{member.name}</option>)}</datalist><select value={role} onChange={(event) => onRole(event.target.value as WsAssignableRole)}><option value="editor">Editor</option><option value="reviewer">Reviewer</option><option value="commenter">Commenter</option><option value="viewer">Viewer</option></select><CapiroButton variant="primary" size="compact" loading={busy} disabled={!email.trim()}>Invite</CapiroButton></form><div className="ws-audit-collaborator-list">{collaborators.map((collaborator) => <div key={collaborator.id}><span>{initials(collaborator.name || collaborator.email || 'Owner')}</span><div><strong>{collaborator.name || collaborator.email || 'Owner'}</strong><em>{collaborator.status}</em></div>{collaborator.isOwner ? <b>Owner</b> : <><select value={collaborator.role} disabled={busy} onChange={(event) => onUpdate(collaborator.id, event.target.value as WsAssignableRole)}><option value="editor">Editor</option><option value="reviewer">Reviewer</option><option value="commenter">Commenter</option><option value="viewer">Viewer</option></select><button type="button" onClick={() => onRemove(collaborator.id)} aria-label="Remove collaborator"><Icon name="Trash2" size={15} /></button></>}</div>)}</div></ModalShell>;
}

function DeliveryOverlay({ state, preflight, shareResult, busy, onClose, onPreflight, onRequestApproval, onCreateShare, onDocx, onPdf }: { state: AgentState; preflight: Awaited<ReturnType<typeof api.preflight>> | null; shareResult: ShareLinkResponse | null; busy: boolean; onClose: () => void; onPreflight: () => Promise<void>; onRequestApproval: () => Promise<void>; onCreateShare: () => Promise<void>; onDocx: () => void; onPdf: () => void }) {
  const canShare = Boolean(preflight && !preflight.isStale && (!preflight.requiresApproval || !preflight.approvalPolicy.clientFacingApprovalRequired));
  const publicUrl = shareResult ? `${window.location.origin}/share/${shareResult.token}` : '';
  return <ModalShell kicker="DELIVERY" title="Prepare client delivery" onClose={onClose}><div className="ws-audit-delivery"><div className="ws-audit-delivery__status"><strong>{preflight ? preflight.isStale ? 'Approval is stale' : preflight.requiresApproval ? 'Approval required' : 'Preflight passed' : 'Run preflight before client delivery'}</strong><p>Client-facing sharing is gated. Internal DOCX and PDF exports remain available.</p></div><div className="ws-audit-actions"><CapiroButton variant="secondary" loading={busy} onClick={() => void onPreflight()}>Run preflight</CapiroButton>{preflight?.requiresApproval ? <CapiroButton variant="secondary" loading={busy} onClick={() => void onRequestApproval()}>Request approval</CapiroButton> : null}</div><hr /><div className="ws-audit-eyebrow">INTERNAL EXPORT</div><div className="ws-audit-actions"><CapiroButton variant="secondary" loading={busy} onClick={onDocx}>Download DOCX</CapiroButton><CapiroButton variant="secondary" loading={busy} onClick={onPdf}>Download PDF</CapiroButton></div><hr /><div className="ws-audit-eyebrow">CLIENT SHARE</div>{shareResult ? <div className="ws-audit-share-result"><input readOnly value={publicUrl} /><button type="button" onClick={() => void navigator.clipboard.writeText(publicUrl)}>Copy</button><span>Expires {formatTimestamp(shareResult.expiresAt)}</span></div> : <CapiroButton variant="primary" disabled={!canShare || state.phase === 'generate'} loading={busy} onClick={() => void onCreateShare()}>Create frozen share link</CapiroButton>}</div></ModalShell>;
}

export default WorkspaceEditorStabilized;
