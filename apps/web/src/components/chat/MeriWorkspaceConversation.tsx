import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { AnalysisChartCard } from './AnalysisChartCard.js';
import { ActionProposalList } from './ActionProposalList.js';
import { ChatMessage } from './ChatMessage.js';
import {
  attachmentKindIcon,
  truncateFilenameMiddle,
  type StagedAttachment,
} from './ChatInput.js';
import { ManagedComposerPlus } from './ManagedComposerPlus.js';
import { MeriCanvas } from './MeriCanvas.js';
import { ResearchClarifyForm } from './ResearchClarifyForm.js';
import { WorkPerformed } from './WorkPerformed.js';
import { config } from '../../env.js';
import type { MeriChatController } from './useMeriChatController.js';

const ATTACH_ACCEPT = '.pdf,.docx,.txt,.md,.csv,image/png,image/jpeg,image/gif,image/webp';

const PROMPT_LIBRARY = [
  { text: 'What changed across my clients this week?', tag: 'PORTFOLIO · ALL CLIENTS' },
  { text: "Prep me for Thursday's appropriations markup", tag: 'HEARING · APPROPRIATIONS' },
  { text: 'Draft a client update on the highest-priority budget change', tag: 'DRAFT · CLIENT' },
  { text: 'Which FY27 exposures need attention first?', tag: 'ANALYSIS · FY27' },
  { text: 'Which of my asks survived from House mark to enacted last cycle, and why?', tag: 'PATTERN · PRIOR CYCLES' },
  { text: 'Who on committee staff has moved on this program before, and what did they ask for?', tag: 'RELATIONSHIPS · STAFF' },
  { text: 'Where do two sources disagree on a number I am about to send a client?', tag: 'CONFLICT CHECK' },
  { text: 'Watch the most important issue in this week’s hearings and tell me what moves', tag: 'WATCHLIST · LIVE' },
  { text: 'Compare the committee report language against what we actually requested, line by line', tag: 'LANGUAGE DIFF' },
  { text: 'What is the strongest evidence against our own position?', tag: 'RED TEAM' },
  { text: 'Turn the latest meeting debrief into follow-ups with owners and dates', tag: 'MEETING · DEBRIEF' },
  { text: 'Which grants is this client eligible for, and name the criteria met', tag: 'GRANTS · ELIGIBILITY' },
] as const;

function formatTime(value: Date | string | undefined): string {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function greetingFor(name: string): string {
  const hour = new Date().getHours();
  const daypart = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${daypart}, ${name}.` : `${daypart}.`;
}

function stagedAttachmentFailed(attachment: StagedAttachment): boolean {
  return (
    attachment.status === 'error' ||
    attachment.status === 'scanned' ||
    attachment.status === 'unsupported'
  );
}

export function MeriWorkspaceConversation({
  controller,
  userLabel,
  greetingName,
  tenantName,
}: {
  controller: MeriChatController;
  userLabel: string;
  greetingName: string;
  tenantName: string;
}) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [libraryPage, setLibraryPage] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const {
    messages,
    isStreaming,
    clients,
    selectedClientValue,
    changeSessionClient,
    stagedAttachments,
    attachmentNotice,
    handleAttachFiles,
    removeStagedAttachment,
    sendMessage,
    handleStop,
    pendingApprovals,
    approvingProposalId,
    handleApprovePending,
    handleApproveAll,
    handleDismissPending,
    activeArtifact,
    setActiveArtifact,
    authHeaders,
    orchestratorIntent,
    orchestratorTier,
    trustSteps,
    planSteps,
    researchAwaitingAnswers,
    researchQuestions,
    submitResearchAnswers,
    researchReports,
    researchOffers,
    handleRunResearchOffer,
    fetchResearchExport,
    orchestratorConflict,
    messagesEndRef,
  } = controller;

  const selectedClient = clients.find((client) => client.id === selectedClientValue) ?? null;
  // `handleNewSession` creates the durable server conversation immediately. The
  // prototype's "New thread" state is therefore keyed to whether the thread has
  // any messages, not whether an id already exists.
  const hasThread = messages.length > 0;
  const uploadsInFlight = stagedAttachments.some((attachment) => attachment.status === 'uploading');
  const canSend = draft.trim().length > 0 && !isStreaming && !uploadsInFlight;
  const scopeLabel = selectedClient ? selectedClient.name.toUpperCase() : 'THREAD';
  const contextLabel = selectedClient
    ? `${selectedClient.name.toUpperCase()} · CAPIRO CONTEXT`
    : 'CAPIRO SOURCES IN CONTEXT';

  useEffect(() => {
    if (!scopeOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!scopeRef.current?.contains(event.target as Node)) setScopeOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setScopeOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [scopeOpen]);

  useEffect(() => {
    if (!hasThread) textareaRef.current?.focus();
  }, [hasThread]);

  const submit = (forced?: string) => {
    const content = (forced ?? draft).trim();
    if (!content || isStreaming || uploadsInFlight) return;
    void sendMessage(content);
    setDraft('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const promptPages = Math.ceil(PROMPT_LIBRARY.length / 4);
  const prompts = useMemo(
    () => PROMPT_LIBRARY.slice(libraryPage * 4, libraryPage * 4 + 4),
    [libraryPage],
  );

  const composer = (
    <div className="meri-v3-composer-wrap">
      <div className={`meri-v3-composer${focused ? ' is-focused' : ''}`}>
        {stagedAttachments.length > 0 ? (
          <div className="meri-v3-attachments" aria-label="Attached files">
            {stagedAttachments.map((attachment) => {
              const failed = stagedAttachmentFailed(attachment);
              return (
                <span
                  key={attachment.localId}
                  className={`meri-v3-attachment${failed ? ' is-error' : ''}`}
                >
                  <span aria-hidden="true">{attachmentKindIcon(attachment.kind)}</span>
                  <span title={attachment.filename}>
                    {truncateFilenameMiddle(attachment.filename, 28)}
                  </span>
                  <span className="meri-v3-attachment-state">
                    {attachment.status === 'uploading'
                      ? 'UPLOADING'
                      : failed
                        ? 'UNAVAILABLE'
                        : attachment.status === 'truncated'
                          ? 'TRUNCATED'
                          : 'READY'}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeStagedAttachment(attachment.localId)}
                    aria-label={`Remove ${attachment.filename}`}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        ) : null}
        {attachmentNotice ? (
          <div className="meri-v3-attachment-notice" role="status">
            {attachmentNotice}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          disabled={isStreaming}
          placeholder={
            hasThread
              ? 'Ask about this thread, or draft an action…'
              : 'Ask across your clients, or start a piece of work…'
          }
          aria-label="Message Meri"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => setDraft(event.target.value)}
          onInput={(event) => {
            const element = event.currentTarget;
            element.style.height = 'auto';
            element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
          }}
          onKeyDown={onKeyDown}
        />
        <div className="meri-v3-composer-toolbar">
          <ManagedComposerPlus
            disabled={isStreaming}
            onUpload={() => fileInputRef.current?.click()}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ATTACH_ACCEPT}
            hidden
            onChange={(event) => {
              if (event.target.files?.length) handleAttachFiles(event.target.files);
              event.target.value = '';
            }}
          />

          <div className="meri-v3-scope-control" ref={scopeRef}>
            <button
              type="button"
              className="meri-v3-scope-trigger"
              onClick={() => setScopeOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={scopeOpen}
            >
              SCOPE: {scopeLabel} ▾
            </button>
            {scopeOpen ? (
              <div className="meri-v3-scope-menu" role="menu" aria-label="Conversation scope">
                <button type="button" role="menuitem" onClick={() => setScopeOpen(false)}>
                  <span>This thread</span>
                  <small>THREAD SOURCES</small>
                </button>
                {clients.map((client) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={client.id}
                    onClick={() => {
                      setScopeOpen(false);
                      void changeSessionClient(client.id);
                    }}
                  >
                    <span>{client.name}</span>
                    <small>CLIENT</small>
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setScopeOpen(false);
                    void changeSessionClient('');
                  }}
                >
                  <span>All clients</span>
                  <small>PORTFOLIO · {clients.length} CLIENTS</small>
                </button>
              </div>
            ) : null}
          </div>

          <span className="meri-v3-composer-context">{contextLabel}</span>
          <span className="meri-v3-composer-spacer" />
          <span className="meri-v3-send-hint">{isStreaming ? '■ STOP' : '⏎ SEND'}</span>
          <button
            type="button"
            className={`meri-v3-send${canSend ? ' is-ready' : ''}${isStreaming ? ' is-stop' : ''}`}
            disabled={!isStreaming && !canSend}
            onClick={() => (isStreaming ? handleStop() : submit())}
            aria-label={isStreaming ? 'Stop generating' : 'Send'}
          >
            {isStreaming ? '■' : '↑'}
          </button>
        </div>
      </div>
      <div className="meri-v3-composer-policy">
        MERI CITES SOURCES · NETWORK WRITES AND EXTERNAL SENDS REQUIRE YOUR APPROVAL
      </div>
    </div>
  );

  if (!hasThread) {
    return (
      <div className="meri-v3-new-thread-view">
        <div className="meri-v3-new-thread-inner">
          <h1>{greetingFor(greetingName)}</h1>
          <p>
            {tenantName} · {clients.length} client{clients.length === 1 ? '' : 's'} in scope
          </p>
          <div className="meri-v3-new-thread-composer">{composer}</div>
          <div className="meri-v3-library-heading">
            <span>PROMPT LIBRARY</span>
            <i />
            <small>
              {libraryPage + 1} / {promptPages}
            </small>
            <div className="meri-v3-library-nav">
              <button
                type="button"
                disabled={libraryPage === 0}
                onClick={() => setLibraryPage((page) => Math.max(0, page - 1))}
                aria-label="Previous prompts"
              >
                ←
              </button>
              <button
                type="button"
                disabled={libraryPage >= promptPages - 1}
                onClick={() => setLibraryPage((page) => Math.min(promptPages - 1, page + 1))}
                aria-label="More prompts"
              >
                →
              </button>
            </div>
          </div>
          <div className="meri-v3-prompt-grid">
            {prompts.map((prompt) => (
              <button type="button" key={prompt.text} onClick={() => submit(prompt.text)}>
                <span>{prompt.text}</span>
                <small>{prompt.tag}</small>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const firstMessageTime = messages[0]?.createdAt;

  return (
    <div className="meri-v3-conversation">
      <div className="meri-v3-conversation-scroll" role="log" aria-live="polite">
        <div className="meri-v3-conversation-column">
          {messages.length > 0 ? (
            <div className="meri-v3-date-divider">
              <span />
              <small>TODAY · {formatTime(firstMessageTime)}</small>
              <span />
            </div>
          ) : null}

          {messages.map((message, index) => {
            const isLastAssistant =
              message.role === 'assistant' && index === messages.length - 1;
            if (message.role === 'user') {
              return (
                <div className="meri-v3-user-turn" key={message.id}>
                  <ChatMessage
                    role="user"
                    content={message.content}
                    attachments={message.attachments}
                  />
                  <div className="meri-v3-user-meta">
                    {userLabel.toUpperCase()} · {formatTime(message.createdAt)}
                  </div>
                </div>
              );
            }

            return (
              <div className="meri-v3-assistant-turn" key={message.id}>
                <div className="meri-v3-assistant-mark" aria-hidden="true" />
                <div className="meri-v3-assistant-body">
                  <div className="meri-v3-assistant-heading">
                    <strong>Meri</strong>
                    <span>
                      {formatTime(message.createdAt)}
                      {selectedClient ? ` · SCOPED TO ${selectedClient.name.toUpperCase()}` : ''}
                    </span>
                  </div>
                  {isLastAssistant ? (
                    <WorkPerformed
                      intent={orchestratorIntent}
                      tier={orchestratorTier}
                      steps={trustSteps}
                      planSteps={planSteps}
                      isStreaming={isStreaming}
                    />
                  ) : null}
                  <ChatMessage
                    role="assistant"
                    content={message.content}
                    citations={message.citations}
                    verification={message.verification}
                    groundingCaveat={message.groundingCaveat}
                    attachments={message.attachments}
                    isStreaming={
                      isStreaming && isLastAssistant && message.content !== ''
                    }
                  />
                  {message.chartArtifacts?.length ? (
                    <div className="chat-chart-cards" aria-label="Analysis charts">
                      {message.chartArtifacts.map((chart) => (
                        <AnalysisChartCard
                          key={chart.id}
                          artifactId={chart.id}
                          title={chart.title}
                        />
                      ))}
                    </div>
                  ) : null}
                  {researchReports[message.id] ? (
                    <div className="meri-v3-inline-actions">
                      <button
                        type="button"
                        onClick={() =>
                          void fetchResearchExport(researchReports[message.id]!, 'html')
                        }
                      >
                        OPEN AS PAGE
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void fetchResearchExport(researchReports[message.id]!, 'word')
                        }
                      >
                        DOWNLOAD WORD
                      </button>
                    </div>
                  ) : null}
                  {researchOffers[message.id] ? (
                    <div className="meri-v3-inline-actions">
                      <button
                        type="button"
                        disabled={isStreaming}
                        onClick={() =>
                          handleRunResearchOffer(message.id, researchOffers[message.id]!.topic)
                        }
                      >
                        RUN DEEP RESEARCH
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}

          {researchAwaitingAnswers && researchQuestions.length > 0 ? (
            <ResearchClarifyForm
              questions={researchQuestions}
              disabled={isStreaming}
              onSubmit={(answers, skipped) => void submitResearchAnswers(answers, skipped)}
            />
          ) : null}

          {orchestratorConflict ? (
            <div className="meri-v3-conflict" role="status">
              <strong>{orchestratorConflict.title}</strong>
              <span>{orchestratorConflict.detail}</span>
            </div>
          ) : null}

          {pendingApprovals.length > 0 && !isStreaming ? (
            <ActionProposalList
              proposals={pendingApprovals}
              busyProposalId={approvingProposalId}
              onApprove={handleApprovePending}
              onApproveAll={handleApproveAll}
              onDismiss={handleDismissPending}
              onEditProposal={(proposal) =>
                void sendMessage(
                  `Revise the proposed action “${proposal.preview.label}”. Keep proposal ${proposal.proposalId} immutable and ask me what should change, then create a NEW action proposal with the revised fields. Do not execute anything yet.`,
                )
              }
              onRepropose={(proposal) =>
                void sendMessage(
                  `Re-propose the expired or blocked action “${proposal.preview.label}” using current policy and current context. Create a NEW action proposal; do not reuse or mutate proposal ${proposal.proposalId}.`,
                )
              }
            />
          ) : null}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="meri-v3-thread-composer">{composer}</div>

      {activeArtifact ? (
        <MeriCanvas
          artifact={activeArtifact}
          onClose={() => setActiveArtifact(null)}
          apiBaseUrl={config.apiBaseUrl}
          getAuthHeaders={authHeaders}
        />
      ) : null}
    </div>
  );
}
