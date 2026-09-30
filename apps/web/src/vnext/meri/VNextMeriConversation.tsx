import type { MeriTurnScope } from '../../components/chat/meri-turn-scope.js';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCapiroToast } from '../components/feedback/toast.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { MeriIcon } from './meri-icons.js';
import {
  dayDividerLabel,
  localDayKey,
  threadKindIcon,
  threadScopeLabel,
} from './meri-presentation.js';
import { VNextMeriMessage } from './VNextMeriMessage.js';
import { VNextMeriComposer } from './VNextMeriComposer.js';
import { MeriApprovalNotice } from './MeriApprovalNotice.js';
import { VNextMeriReasoningControl } from './VNextMeriReasoningControl.js';
import { MeriStartWork } from './MeriStartWork.js';
import { MeriDurableResearchControls } from './MeriDurableResearchControls.js';
import type { MeriTurnInspectorData, MeriTurnInspectorTab } from './MeriTurnInspector.js';

function greetingFor(name: string): string {
  const hour = new Date().getHours();
  const daypart = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${daypart}, ${name}.` : `${daypart}.`;
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
  onOpenSourceDetail: (
    citations: import('../../components/chat/chat-store.js').MeriCitation[],
    index: number,
    scope: MeriTurnScope,
  ) => void;
  /** Opens the rail's v6 turn inspector, focused on one turn's data. */
  onOpenTurnInspector: (data: MeriTurnInspectorData, tab: MeriTurnInspectorTab) => void;
  /** Opens the turn inspector straight to Approvals (not turn-scoped — see MeriApprovalNotice). */
  onOpenApprovals: () => void;
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
  onOpenTurnInspector,
  onOpenApprovals,
}: VNextMeriConversationProps) {
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const renameRequestRef = useRef<object | null>(null);
  const currentConversationIdRef = useRef(controller.activeConversationId);
  currentConversationIdRef.current = controller.activeConversationId;
  const toast = useCapiroToast();
  const { messages, isStreaming, clients } = controller;
  const scrollRef = useRef<HTMLDivElement>(null);

  // v6 inline rename: focus the input as soon as rename mode opens.
  useEffect(() => {
    if (renaming) renameInputRef.current?.focus();
  }, [renaming]);

  const beginRename = () => {
    setRenameValue(threadTitle === 'Untitled thread' ? '' : threadTitle);
    setThreadMenuOpen(false);
    setRenaming(true);
  };

  const commitRename = async () => {
    const title = renameValue.trim();
    if (renameRequestRef.current) return;
    if (!title || title === threadTitle) {
      setRenaming(false);
      return;
    }
    const conversationId = controller.activeConversationId;
    const request = {};
    renameRequestRef.current = request;
    setIsRenaming(true);
    try {
      const saved = await controller.saveConversationMeta({ title });
      if (
        renameRequestRef.current !== request ||
        currentConversationIdRef.current !== conversationId
      )
        return;
      if (saved) {
        setRenaming(false);
        toast.success('Thread renamed.');
      } else {
        toast.error('The thread could not be renamed.');
      }
    } catch {
      if (
        renameRequestRef.current === request &&
        currentConversationIdRef.current === conversationId
      )
        toast.error('The thread could not be renamed.');
    } finally {
      if (renameRequestRef.current === request) {
        renameRequestRef.current = null;
        setIsRenaming(false);
      }
    }
  };

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
      retrieval
        ? {
            subjectScope: retrieval.plan.subjectScope,
            targetHint: retrieval.plan.targetHint,
            recipeTool: retrieval.plan.recipeTool,
          }
        : null,
    ) ?? '';
  const researching = Boolean(controller.isStreaming || controller.researchAwaitingAnswers);
  const approval = controller.pendingApprovals.length > 0 && !controller.isStreaming;
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
    setRenaming(false);
    setRenameValue('');
    setThreadMenuOpen(false);
    setIsRenaming(false);
    renameRequestRef.current = null;
    return () => {
      renameRequestRef.current = null;
    };
  }, [activeConversationId]);

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
              {renaming ? (
                <div className="capiro-vnext-meri-rename">
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    aria-label="Rename thread"
                    disabled={isRenaming}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void commitRename();
                      if (event.key === 'Escape') setRenaming(false);
                    }}
                  />
                  <button
                    type="button"
                    className="capiro-vnext-meri-rename-save"
                    onClick={() => void commitRename()}
                    disabled={isRenaming}
                  >
                    {isRenaming ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="capiro-vnext-meri-rename-cancel"
                    onClick={() => setRenaming(false)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <span className="vnext-meri__thread-title">{threadTitle}</span>
                  <span className="vnext-meri__thread-sub">{threadSub}</span>
                </>
              )}
            </div>
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
                <div className="vnext-meri__thread-menu" role="menu" aria-label="Thread actions">
                  <button
                    type="button"
                    role="menuitem"
                    className="vnext-meri__thread-menu-item"
                    onClick={beginRename}
                    disabled={isRenaming}
                  >
                    <MeriIcon name="Edit01" size={15} color="#667085" />
                    Rename
                  </button>
                  {selectedClient ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="vnext-meri__thread-menu-item"
                      onClick={() => {
                        void controller
                          .changeSessionClient('')
                          .then(() => {
                            setThreadMenuOpen(false);
                            toast.success('Thread moved to all-client scope.');
                          })
                          .catch(() => toast.error('The thread scope could not be updated.'));
                      }}
                    >
                      <MeriIcon name="Grid01" size={15} color="#667085" />
                      Move to all clients
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    className="vnext-meri__thread-menu-item"
                    onClick={() => {
                      controller.handleNewSession();
                      setThreadMenuOpen(false);
                      toast.success('Started a new draft. Context was not copied.');
                    }}
                  >
                    <MeriIcon name="FilePlus02" size={15} color="#667085" />
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
          <div
            className={`vnext-meri__conversation-column${!hasThread ? ' is-landing' : ''}`}
            data-meri-column
          >
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
                  <span className="vnext-meri__landing-badge">
                    <MeriIcon name="Stars02" size={16} color="#FFFFFF" />
                  </span>
                </div>
                <h2 className="vnext-meri__landing-greeting">{greetingFor(greetingName)}</h2>
                <p className="vnext-meri__landing-homesub">
                  Ask across every client you're scoped to, draft a document, or start research —
                  Meri cites what it used and asks before it writes anywhere.
                </p>
                <span className="vnext-meri__landing-sub">
                  {/* Reference: recorded tenant name verbatim, then the actual
                      selection — the selected client's name, or the real
                      client count when nothing is selected. */}
                  {tenantName} ·{' '}
                  {selectedClient
                    ? `${selectedClient.name.toUpperCase()} IN SCOPE`
                    : `${clients.length} CLIENT${clients.length === 1 ? '' : 'S'} IN SCOPE`}
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
                    // v6 reference: no leading date divider above the first
                    // turn — dividers only appear at day boundaries deeper in
                    // the transcript.
                    index > 0 &&
                    localDayKey(previous?.createdAt) !== localDayKey(message.createdAt);
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
                        onOpenTurnInspector={onOpenTurnInspector}
                      />
                    </div>
                  );
                })}

                <MeriDurableResearchControls
                  controller={controller}
                  researchId={
                    controller.researchSessionRef.current ?? controller.researchRecovery?.id ?? null
                  }
                />

                {controller.researchAwaitingAnswers && controller.researchQuestions.length > 0 ? (
                  <ResearchClarifyInline controller={controller} />
                ) : null}

                {/* v6 streaming indicator: the avatar + "Meri is responding" row
                    at the foot of the log while a turn streams. */}
                {isStreaming ? (
                  <div className="vnext-meri__responding" aria-live="polite">
                    <span className="vnext-meri__assistant-mark">
                      <MeriIcon name="Stars02" size={14} color="#FFFFFF" />
                    </span>
                    <span className="vnext-meri__responding-label">Meri is responding</span>
                  </div>
                ) : null}

                {/*
                  v6: the full inline approval card (status/reason/outcome/
                  Approve/Retry/Dismiss) moved to the rail's Approvals tab —
                  this is now just the one-sentence notice + a link that opens
                  it. Not turn-scoped (PendingApproval carries no turn id),
                  so — same as the card it replaces — this stays an aggregate,
                  once-per-conversation notice rather than something rendered
                  per message.
                */}
                {controller.pendingApprovals.length > 0 && !isStreaming ? (
                  <MeriApprovalNotice
                    approvals={controller.pendingApprovals}
                    onReview={onOpenApprovals}
                  />
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
              onChange={(event) => setAnswers((prev) => ({ ...prev, [i]: event.target.value }))}
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
            void controller.submitResearchAnswers(answers, Object.keys(answers).length === 0)
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

// PendingApprovalsInline (the full inline card + its own confirm-dialog
// state) moved to VNextMeriShell.tsx + MeriApprovalNotice/MeriApprovalsTab
// as part of the v6 turn-inspector panel — see the mount point above.
