import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCapiroToast } from '../components/feedback/toast.js';
import type {
  MeriChatController,
  PendingApproval,
} from '../../components/chat/useMeriChatController.js';
import { MeriIcon } from './meri-icons.js';
import { MERI_LOGO_SRC, dayDividerLabel, localDayKey, threadKindIcon, threadScopeLabel } from './meri-presentation.js';
import { VNextMeriMessage } from './VNextMeriMessage.js';
import { VNextMeriComposer } from './VNextMeriComposer.js';
import { MeriActionConfirm, MeriBulkActionConfirm } from './MeriActionConfirm.js';
import { VNextMeriReasoningControl } from './VNextMeriReasoningControl.js';
import { MeriStartWork } from './MeriStartWork.js';

function greetingFor(name: string): string {
  const hour = new Date().getHours();
  const daypart = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${daypart}, ${name}.` : `${daypart}.`;
}

function proposalStatusLabel(status: string): string {
  return status.replace(/_/g, ' ').toUpperCase();
}

function proposalOutcome(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  for (const key of ['summary', 'message', 'detail']) {
    if (typeof raw[key] === 'string' && raw[key].trim()) return raw[key] as string;
  }
  return null;
}

interface VNextMeriConversationProps {
  controller: MeriChatController;
  greetingName: string;
  tenantName: string;
  onOpenIntegrations: () => void;
  /** Expands the rail's Memory section. */
  onOpenMemory: () => void;
  /** True when the thread rail is hidden — shows the header's rail toggle. */
  threadRailCollapsed: boolean;
  /** Re-shows the thread rail from the conversation header. */
  onExpandThreadRail: () => void;
  /** Opens the rail's Source Detail view for one of a turn's citations. */
  onOpenSourceDetail: (citations: import('../../components/chat/chat-store.js').MeriCitation[], index: number) => void;
}

export function VNextMeriConversation({
  controller,
  greetingName,
  tenantName,
  onOpenIntegrations,
  onOpenMemory,
  threadRailCollapsed,
  onExpandThreadRail,
  onOpenSourceDetail,
}: VNextMeriConversationProps) {
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [pendingTitle, setPendingTitle] = useState<string | null>(null);
  const toast = useCapiroToast();
  const { messages, isStreaming, clients } = controller;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Focus scope on the turn list (handoff: one focusable region, arrow-key
  // traversal between turns, not one tab stop per turn — a long thread makes
  // per-turn tab stops unusably slow). Roving tabindex, hand-rolled the same
  // way CapiroTabs (vnext/components/menus/index.tsx) does it: exactly one
  // turn carries tabIndex 0 at a time, arrow keys move it and call .focus()
  // directly, everything else stays -1 so a single Tab press skips the whole
  // transcript. Sticky by design — once the user arrows to a turn, it stays
  // the tab stop even as new messages stream in; only scroll auto-follows.
  const [focusedTurnId, setFocusedTurnId] = useState<string | null>(null);
  const rovingTurnId =
    focusedTurnId && messages.some((message) => message.id === focusedTurnId)
      ? focusedTurnId
      : (messages[messages.length - 1]?.id ?? null);

  const handleTurnKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const list = event.currentTarget.parentElement;
    if (!list) return;
    const turns = Array.from(list.querySelectorAll<HTMLElement>('[data-meri-turn]'));
    const currentIndex = turns.indexOf(event.currentTarget);
    if (currentIndex < 0 || turns.length === 0) return;

    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % turns.length;
    if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + turns.length) % turns.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = turns.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const next = turns[nextIndex]!;
    next.focus();
    const nextId = next.dataset.meriTurn;
    if (nextId) setFocusedTurnId(nextId);
  };

  const hasThread = messages.length > 0;
  const selectedClient =
    clients.find((client) => client.id === controller.selectedClientValue) ?? null;

  // Scroll anchoring: stick to the bottom only while the user is at the bottom.
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      stickToBottomRef.current = atBottom;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (text: string) => {
    if (!text.trim() || isStreaming) return;
    void controller.sendMessage(text);
  };

  const threadTitle = hasThread
    ? controller.sessionTitle.trim() || 'Untitled thread'
    : 'New thread';
  // Truthful scope badge: when the backend's retrieval plan is available
  // (from the last finished assistant turn), use its subjectScope to label
  // the thread. Falls back to the legacy client-context sub-line for turns
  // that didn't forward retrieval metadata. Returns null for general scope,
  // in which case we omit the badge entirely.
  const retrieval = controller.lastRetrieval;
  const threadSub =
    threadScopeLabel(
      selectedClient?.name ?? null,
      retrieval ? { subjectScope: retrieval.plan.subjectScope, targetHint: retrieval.plan.targetHint, recipeTool: retrieval.plan.recipeTool } : null,
    ) ?? '';
  const researching = Boolean(controller.isStreaming || controller.researchAwaitingAnswers);
  const approval = controller.pendingApprovals.length > 0 && !controller.isStreaming;
  const modeLabel = approval
    ? 'APPROVAL'
    : researching
      ? controller.researchAwaitingAnswers
        ? 'CLARIFYING'
        : 'RESEARCHING'
      : hasThread
        ? 'STANDARD'
        : 'NEW';
  const canvasMode = researching || approval ? 'busy' : hasThread ? 'standard' : 'empty';
  const kindIcon = threadKindIcon({
    isNew: !hasThread,
    isResearch: researching,
    hasArtifact: controller.messages.some((message) => (message.chartArtifacts?.length ?? 0) > 0),
  });
  const activeConversationId = controller.activeConversationId;

  useEffect(() => {
    if (!threadMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setThreadMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [threadMenuOpen]);

  useEffect(() => {
    if (pendingTitle === null || controller.isSavingMeta) return;
    if (controller.metaError) {
      toast.error('The thread could not be renamed.');
      setPendingTitle(null);
      return;
    }
    const notice = window.setTimeout(() => {
      toast.success('Thread renamed.');
      setPendingTitle(null);
    }, 0);
    return () => window.clearTimeout(notice);
  }, [controller.isSavingMeta, controller.metaError, pendingTitle, toast]);

  return (
    <>
      <main className="vnext-meri__main">
        {hasThread ? (
          <div className="vnext-meri__thread-header">
            {/* Rail toggle — handoff §3, present only while the rail is
                collapsed, at the left of the conversation header. */}
            {threadRailCollapsed ? (
              <button
                type="button"
                className="vnext-meri__rail-toggle"
                aria-label="Show thread rail"
                onClick={onExpandThreadRail}
              >
                <MeriIcon name="Menu02" size={16} color="#344054" />
              </button>
            ) : null}
            <span className="vnext-meri__thread-icon">
              <MeriIcon name={kindIcon} size={15} color="#101828" />
            </span>
            <div className="vnext-meri__thread-title-block">
              <span className="vnext-meri__thread-title">{threadTitle}</span>
              <span className="vnext-meri__thread-sub">{threadSub}</span>
            </div>
            <span className={`vnext-meri__mode-pill is-${modeLabel.toLowerCase()}`}>
              <span
                className={`vnext-meri__mode-pill-dot${
                  modeLabel === 'RESEARCHING' ? ' is-researching' : modeLabel === 'APPROVAL' ? ' is-approval' : ''
                }`}
              />
              <span className="vnext-meri__mode-pill-label">{modeLabel}</span>
            </span>
            {activeConversationId ? (
              <VNextMeriReasoningControl conversationId={activeConversationId} />
            ) : null}
            <button
              type="button"
              className="vnext-meri__thread-action"
              aria-label="Copy thread link"
              onClick={() => {
                const copy = async () => {
                  if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(window.location.href);
                    return;
                  }
                  const input = document.createElement('textarea');
                  input.value = window.location.href;
                  input.setAttribute('readonly', '');
                  input.style.position = 'fixed';
                  input.style.opacity = '0';
                  document.body.appendChild(input);
                  input.select();
                  const copied = document.execCommand('copy');
                  input.remove();
                  if (!copied) throw new Error('Copy is not supported');
                };
                void copy()
                  .then(() => toast.success('Thread link copied.'))
                  .catch(() => toast.error('The thread link could not be copied.'));
              }}
            >
              <MeriIcon name="Link03" size={16} color="#667085" />
            </button>
            <span className="vnext-meri__thread-overflow">
              <button
                type="button"
                className="vnext-meri__thread-action"
                aria-label="Thread actions"
                aria-haspopup="menu"
                aria-expanded={threadMenuOpen}
                onClick={() => setThreadMenuOpen((open) => !open)}
              >
                <MeriIcon name="DotsHorizontal" size={16} color="#667085" />
              </button>
              {threadMenuOpen ? (
                <div className="vnext-meri__row-menu" role="menu" aria-label="Thread actions">
                  <button
                    type="button"
                    role="menuitem"
                    className="vnext-meri__row-menu-item"
                    onClick={() => {
                      const title = window.prompt('Thread title', threadTitle)?.trim();
                      if (!title) return;
                      setPendingTitle(title);
                      controller.setSessionTitle(title);
                      void controller.saveConversationMeta();
                      setThreadMenuOpen(false);
                    }}
                  >
                    <MeriIcon name="Edit01" size={14} color="#344054" />
                    Rename thread
                  </button>
                  {selectedClient ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="vnext-meri__row-menu-item"
                      onClick={() => {
                        void controller.changeSessionClient('')
                          .then(() => {
                            setThreadMenuOpen(false);
                            toast.success('Thread moved to all-client scope.');
                          })
                          .catch(() => toast.error('The thread scope could not be updated.'));
                      }}
                    >
                      <MeriIcon name="Building01" size={14} color="#344054" />
                      Move to all clients
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    className="vnext-meri__row-menu-item"
                    onClick={() => {
                      controller.handleNewSession();
                      setThreadMenuOpen(false);
                      toast.success('Started a new draft. Context was not copied.');
                    }}
                  >
                    <MeriIcon name="Copy01" size={14} color="#344054" />
                    Start new draft
                  </button>
                </div>
              ) : null}
            </span>
          </div>
        ) : null}

        <div
          className={`vnext-meri__conversation-scroll is-${canvasMode}`}
          ref={scrollRef}
          role="log"
          aria-live="polite"
        >
          <div className="vnext-meri__conversation-column" data-meri-column>
            {controller.metaError ? (
              <div className="vnext-meri__error" role="alert">
                {controller.metaError}
              </div>
            ) : null}

            {controller.orchestratorConflict ? (
              <div className="vnext-meri__attachment-notice" role="alert">
                <strong>{controller.orchestratorConflict.title}</strong>
                <span style={{ display: 'block', marginTop: 4 }}>
                  {controller.orchestratorConflict.detail}
                </span>
              </div>
            ) : null}

            {!hasThread ? (
              <div className="vnext-meri__landing">
                {/* On home the conversation header is hidden (handoff §3), so
                    the rail toggle rides with the greeting row instead — the
                    rail must stay recoverable from every view. */}
                <div className="vnext-meri__landing-greeting-row">
                  {threadRailCollapsed ? (
                    <button
                      type="button"
                      className="vnext-meri__rail-toggle"
                      aria-label="Show thread rail"
                      onClick={onExpandThreadRail}
                    >
                      <MeriIcon name="Menu02" size={16} color="#344054" />
                    </button>
                  ) : null}
                  <span className="vnext-meri__assistant-mark">
                    <img src={MERI_LOGO_SRC} alt="" width={13} height={13} />
                  </span>
                  <span className="vnext-meri__landing-live">
                    <span className="vnext-meri__landing-live-dot" />
                    SESSION LIVE
                  </span>
                </div>
                <h2 className="vnext-meri__landing-greeting">{greetingFor(greetingName)}</h2>
                <p className="vnext-meri__landing-homesub">
                  Ask across every client you're scoped to, draft a document, or start research —
                  Meri cites what it used and asks before it writes anywhere.
                </p>
                <span className="vnext-meri__landing-sub">
                  {tenantName.toUpperCase()} · {clients.length} CLIENT{clients.length === 1 ? '' : 'S'} IN SCOPE
                </span>

                <div className="vnext-meri__landing-mode-row">
                  <div className="vnext-meri__landing-mode-copy">
                    <span className="vnext-meri__landing-mode-label">How should Meri think?</span>
                    <span className="vnext-meri__landing-mode-hint">
                      Pick a depth before you start. It sticks for this new thread.
                    </span>
                  </div>
                  <VNextMeriReasoningControl conversationId={activeConversationId} />
                </div>

                <MeriStartWork
                  controller={controller}
                  onFillIntent={(text) => {
                    // Fill the composer draft — the composer owns the send.
                    // We dispatch a custom event the composer listens to.
                    window.dispatchEvent(new CustomEvent('meri-fill-draft', { detail: text }));
                  }}
                />
              </div>
            ) : (
              <>
                {messages.map((message, index) => {
                  const isLastAssistant =
                    message.role === 'assistant' && index === messages.length - 1;
                  const previous = messages[index - 1];
                  const showDivider =
                    index === 0 || localDayKey(previous?.createdAt) !== localDayKey(message.createdAt);
                  return (
                    <div
                      key={message.id}
                      data-meri-turn={message.id}
                      tabIndex={message.id === rovingTurnId ? 0 : -1}
                      aria-label={message.role === 'user' ? 'Your message' : "Meri's response"}
                      onKeyDown={handleTurnKeyDown}
                    >
                      {showDivider ? (
                        <div className="vnext-meri__date-divider">
                          <span className="vnext-meri__date-divider-line" />
                          <span className="vnext-meri__date-divider-label">
                            {dayDividerLabel(message.createdAt)}
                          </span>
                          <span className="vnext-meri__date-divider-line" />
                        </div>
                      ) : null}
                      <VNextMeriMessage
                        message={message}
                        isLastAssistant={isLastAssistant}
                        isStreaming={isStreaming}
                        controller={controller}
                        onOpenMemory={onOpenMemory}
                        onOpenSourceDetail={onOpenSourceDetail}
                      />
                    </div>
                  );
                })}

                {controller.researchAwaitingAnswers && controller.researchQuestions.length > 0 ? (
                  <ResearchClarifyInline controller={controller} />
                ) : null}

                {controller.pendingApprovals.length > 0 && !isStreaming ? (
                  <PendingApprovalsInline controller={controller} />
                ) : null}
              </>
            )}
          </div>
        </div>

        <VNextMeriComposer
          controller={controller}
          variant="pinned"
          hasThread={hasThread}
          onOpenIntegrations={onOpenIntegrations}
        />
      </main>
    </>
  );
}

function ResearchClarifyInline({ controller }: { controller: MeriChatController }) {
  const [answers, setAnswers] = useState<Record<number, string>>({});

  return (
    <div className="vnext-meri__research-clarify">
      <div className="vnext-meri__research-clarify-head">
        <span className="vnext-meri__research-clarify-icon">
          <MeriIcon name="HelpCircle" size={13} color="#ffffff" />
        </span>
        <span className="vnext-meri__research-clarify-title">
          A few quick questions before I dig in
        </span>
      </div>
      <div className="vnext-meri__research-clarify-body">
        {controller.researchQuestions.map((question, i) => (
          <label key={question} className="vnext-meri__research-clarify-question">
            <span className="vnext-meri__research-clarify-question-label">{question}</span>
            <textarea
              value={answers[i] ?? ''}
              rows={1}
              placeholder="Optional"
              disabled={controller.isStreaming}
              onChange={(event) =>
                setAnswers((prev) => ({ ...prev, [i]: event.target.value }))
              }
              className="vnext-meri__research-clarify-textarea"
            />
          </label>
        ))}
      </div>
      <div className="vnext-meri__research-clarify-actions">
        <button
          type="button"
          className="vnext-meri__new-chat-btn"
          style={{ height: 38, padding: '0 16px' }}
          disabled={controller.isStreaming}
          onClick={() =>
            void controller.submitResearchAnswers(
              answers,
              Object.keys(answers).length === 0,
            )
          }
        >
          Run deep research
        </button>
        <button
          type="button"
          className="vnext-meri__protip-trigger"
          style={{ height: 38, padding: '0 14px' }}
          disabled={controller.isStreaming}
          onClick={() => void controller.submitResearchAnswers({}, true)}
        >
          Skip — use your best judgment
        </button>
      </div>
    </div>
  );
}

function PendingApprovalsInline({ controller }: { controller: MeriChatController }) {
  const proposedCount = controller.pendingApprovals.filter(
    (proposal) => proposal.status === 'proposed',
  ).length;
  const actionBusy = Boolean(controller.approvingProposalId);
  // Informed-consent gate: a governed write only leaves the tenant after the
  // operator confirms this exact payload in the dialog.
  const [confirmFor, setConfirmFor] = useState<PendingApproval | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const proposedApprovals = controller.pendingApprovals.filter(
    (proposal) => proposal.status === 'proposed',
  );

  // Drop a held dialog if the server retires the proposal underneath it.
  useEffect(() => {
    if (!confirmFor) return;
    const live = controller.pendingApprovals.find(
      (proposal) => proposal.proposalId === confirmFor.proposalId,
    );
    if (!live) setConfirmFor(null);
    else if (live !== confirmFor) setConfirmFor(live);
  }, [confirmFor, controller.pendingApprovals]);

  useEffect(() => {
    if (bulkOpen && proposedApprovals.length === 0) setBulkOpen(false);
  }, [bulkOpen, proposedApprovals.length]);

  return (
    <div className="vnext-meri__pending-approvals">
      <div className="vnext-meri__pending-approvals-banner">
        <span className="vnext-meri__pending-approvals-banner-icon">
          <MeriIcon name="Lock01" size={13} color="#ffffff" />
        </span>
        <span className="vnext-meri__pending-approvals-banner-body">
          <span className="vnext-meri__pending-approvals-banner-title">
            Your approval is required before Meri executes a governed action.
          </span>
          <span className="vnext-meri__pending-approvals-banner-caption">
            REVIEW THE ACTION, SCOPE, AND RISK. MERI WILL NOT EXECUTE A HELD WRITE WITHOUT YOUR
            EXPLICIT APPROVAL.
          </span>
        </span>
      </div>
      {controller.pendingApprovals.map((proposal) => {
        const canApprove = proposal.status === 'proposed' || proposal.status === 'failed_retryable';
        const canDismiss = proposal.status === 'proposed' || proposal.status === 'failed_retryable';
        const outcome = proposalOutcome(proposal.resultSummary) || proposal.error?.message || null;
        const active = controller.approvingProposalId === proposal.proposalId;
        return (
          <div key={proposal.proposalId} className="vnext-meri__pending-approval-card">
            <div className="vnext-meri__pending-approval-status">
              {proposalStatusLabel(proposal.status)} · {proposal.preview.label.toUpperCase()}
            </div>
            <div className="vnext-meri__pending-approval-reason">{proposal.reason}</div>
            {outcome ? (
              <div className="vnext-meri__attachment-notice" style={{ marginTop: 10 }}>
                {outcome}
              </div>
            ) : null}
            {canApprove || canDismiss ? (
              <div className="vnext-meri__pending-approval-actions">
                {canApprove ? (
                  <button
                    type="button"
                    className="vnext-meri__rail-action-btn"
                    style={{ marginTop: 0 }}
                    disabled={actionBusy}
                    onClick={() => setConfirmFor(proposal)}
                  >
                    {active
                      ? proposal.status === 'failed_retryable'
                        ? 'Retrying…'
                        : 'Approving…'
                      : proposal.status === 'failed_retryable'
                        ? 'Retry'
                        : 'Approve'}
                  </button>
                ) : null}
                {canDismiss ? (
                  <button
                    type="button"
                    className="vnext-meri__protip-trigger"
                    style={{ height: 34, padding: '0 13px' }}
                    disabled={actionBusy}
                    onClick={() => void controller.handleDismissPending(proposal.proposalId)}
                  >
                    Dismiss
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {proposedCount > 1 ? (
        <button
          type="button"
          className="vnext-meri__rail-action-btn"
          disabled={actionBusy}
          onClick={() => setBulkOpen(true)}
        >
          Approve all proposed actions
        </button>
      ) : null}

      <MeriActionConfirm
        proposal={confirmFor}
        busy={actionBusy}
        onCancel={() => setConfirmFor(null)}
        onConfirm={() => {
          const target = confirmFor;
          setConfirmFor(null);
          if (target) void controller.handleApprovePending(target.proposalId);
        }}
      />
      <MeriBulkActionConfirm
        proposals={proposedApprovals}
        open={bulkOpen}
        busy={actionBusy}
        onCancel={() => setBulkOpen(false)}
        onConfirm={() => {
          setBulkOpen(false);
          void controller.handleApproveAll();
        }}
      />
    </div>
  );
}
