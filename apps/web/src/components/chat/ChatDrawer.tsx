import {
  CloseOutlined,
  DeleteOutlined,
  HistoryOutlined,
  PlusOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { toggleChat, toggleSessionRail } from './chat-store.js';
import { AnalysisChartCard } from './AnalysisChartCard.js';
import { ChatInput } from './ChatInput.js';
import { ChatMessage } from './ChatMessage.js';
import { SessionRail } from './SessionRail.js';
import { WorkPerformed } from './WorkPerformed.js';
import { ActionProposalList } from './ActionProposalList.js';
import { MessageFeedback } from './MessageFeedback.js';
import { deriveVerificationDisplay, VerificationStatus } from '../trust/VerificationStatus.js';
import { MeriCanvas } from './MeriCanvas.js';
import { ResearchClarifyForm } from './ResearchClarifyForm.js';
import { MeriClientScopeSelect } from './MeriClientScopeSelect.js';
import { MeriMemoryPanel } from './MeriMemoryPanel.js';
import { MeriInboxBanner } from './MeriInboxBanner.js';
import { MeriEmptyState } from './MeriEmptyState.js';
import { config } from '../../env.js';
import {
  useMeriChatController,
  type ChatDrawerProps,
  type MeriChatController,
} from './useMeriChatController.js';
import meriBubbleImage from '../../assets/chat/meri-bubble.png';
import './chat.css';

// Subtle inline action button (Regenerate / Edit / Save / Cancel).
const turnActionStyle = {
  background: 'none',
  border: 'none',
  color: 'var(--accent-ink)',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 4px',
} as const;

export function ChatDrawer(props: ChatDrawerProps) {
  const controller = useMeriChatController(props);
  return <MeriLegacyDrawer controller={controller} />;
}

export function MeriLegacyDrawer({
  controller,
  embedded = false,
  surface = 'legacy',
  showSessionRail = true,
}: {
  controller: MeriChatController;
  embedded?: boolean;
  surface?: 'legacy' | 'docked' | 'undocked';
  showSessionRail?: boolean;
}) {
  const {
    isOpen,
    messages,
    isStreaming,
    alertsBadge,
    pendingAlerts,
    alertsOpen,
    setAlertsOpen,
    sessionTitle,
    setSessionTitle,
    clients,
    selectedClientValue,
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
  } = controller;


  return (
    <>
      {!embedded && isOpen && (
        <div className="chat-backdrop" onClick={handleClose} aria-hidden="true" />
      )}

      <div
        ref={drawerRef}
        className={
          embedded ? 'meri-overlay-content' : `chat-drawer${isOpen ? ' chat-drawer--open' : ''}`
        }
        role="complementary"
        aria-label="Meri assistant"
        aria-hidden={embedded ? false : !isOpen}
        style={embedded ? undefined : { width: `${drawerWidth}px` }}
      >
        {!embedded && (
          <button
            type="button"
            className="chat-resize-handle"
            onPointerDown={startResize}
            aria-label="Resize chat panel"
            title="Drag to resize"
          />
        )}
        {!embedded && (
          <div className="chat-header">
            <span className="chat-header-title">
              <span className="chat-header-logo" aria-hidden="true">
                <img src={meriBubbleImage} alt="" className="chat-header-logo-img" />
                <span className="chat-header-dot" aria-hidden="true" />
              </span>
              Meri
            </span>
            <div className="chat-header-actions">
              <button
                type="button"
                className="chat-header-btn"
                onClick={toggleSessionRail}
                title="Conversation history"
                aria-label="Toggle conversation history"
              >
                <HistoryOutlined />
              </button>
              <button
                type="button"
                className="chat-header-btn"
                onClick={() => void handleNewSession()}
                title="New conversation"
                aria-label="Start new conversation"
              >
                <PlusOutlined />
              </button>
              <button
                type="button"
                className="chat-header-btn"
                onClick={handleClose}
                aria-label="Close Meri"
              >
                <CloseOutlined />
              </button>
            </div>
          </div>
        )}

        <div className="chat-context-bar">
          <span className="chat-context-icon" aria-hidden="true">
            ●
          </span>
          <span className="chat-context-value">{contextLabel}</span>
        </div>

        <div className="chat-session-meta" aria-label="Conversation settings">
          <div className="chat-session-meta-row">
            <input
              className="chat-session-input"
              value={sessionTitle}
              onChange={(event) => setSessionTitle(event.target.value)}
              placeholder="Conversation title"
              maxLength={160}
            />
            {/* Changing the scope PERSISTS immediately (changeSessionClient) —
                the model is scoped by the stored conversation row, so a
                selection that only lived in local state left the session
                answering firm-wide while displaying one client. */}
            {embedded ? (
              <MeriClientScopeSelect
                clients={clients}
                value={selectedClientValue}
                onChange={(value) => void changeSessionClient(value)}
              />
            ) : (
              <select
                className="chat-session-select"
                value={selectedClientValue}
                onChange={(event) => void changeSessionClient(event.target.value)}
              >
                <option value="">General (no client)</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="chat-session-btn"
              onClick={() => void saveConversationMeta()}
              disabled={!activeConversationId || isSavingMeta}
              title="Save title/client assignment"
              aria-label="Save conversation settings"
            >
              <SaveOutlined />
            </button>
            <button
              type="button"
              className="chat-session-btn chat-session-btn--danger"
              onClick={() => void archiveConversation()}
              disabled={!activeConversationId}
              title="Archive conversation"
              aria-label="Archive conversation"
            >
              <DeleteOutlined />
            </button>
          </div>
          {metaError && <div className="chat-session-error">{metaError}</div>}
          {/* ONE memory surface for both layouts. The legacy drawer used to render
              its own chips that hard-coded "Meri learned", showed only firm-vs-private,
              and offered edit + forget on every row regardless of authority — so a
              standard user was invited to mutate firm memory the API would refuse.
              MeriMemoryPanel renders the server's real scope, provenance, review
              state, dates, expiry, and per-row authorization instead. */}
          <MeriMemoryPanel
            memories={learnedMemories}
            forgotten={forgottenMemories}
            expanded={learnedExpanded}
            onExpandedChange={setLearnedExpanded}
            onSave={(id, value) => void saveMemoryEdit(id, value)}
            onForget={forgetMemory}
            onUndo={undoForgetMemory}
            onSuggestCorrection={(id, value) => void suggestMemoryCorrection(id, value)}
          />
          {orchestratorConflict && (
            <div className="chat-orchestrator-conflict" role="status">
              <strong>{orchestratorConflict.title}</strong>: {orchestratorConflict.detail}
            </div>
          )}
          {pendingApprovals.length > 0 && !isStreaming && (
            <ActionProposalList
              proposals={pendingApprovals}
              busyProposalId={approvingProposalId}
              onApprove={handleApprovePending}
              onApproveAll={handleApproveAll}
              onDismiss={handleDismissPending}
              onEditProposal={(proposal) => {
                void sendMessage(
                  `Revise the proposed action “${proposal.preview.label}”. Keep proposal ${proposal.proposalId} immutable and ask me what should change, then create a NEW action proposal with the revised fields. Do not execute anything yet.`,
                );
              }}
              onRepropose={(proposal) => {
                void sendMessage(
                  `Re-propose the expired or blocked action “${proposal.preview.label}” using current policy and current context. Create a NEW action proposal; do not reuse or mutate proposal ${proposal.proposalId}.`,
                );
              }}
            />
          )}
          {orchestratorTemplate && (
            <div className="chat-orchestrator-template" role="note">
              <div className="chat-orchestrator-template-title">{orchestratorTemplate.heading}</div>
              <div className="chat-orchestrator-template-sections">
                {orchestratorTemplate.sections.join(' · ')}
              </div>
            </div>
          )}
        </div>

        {showSessionRail && <SessionRail />}

        <MeriInboxBanner
          alerts={pendingAlerts}
          count={alertsBadge}
          expanded={alertsOpen}
          onExpandedChange={setAlertsOpen}
          onDismiss={(id) => void handleDismissAlert(id)}
          onClearAll={() => void handleClearAllAlerts()}
        />

        <div className="chat-messages" role="log" aria-live="polite" aria-label="Conversation">
          {messages.length === 0 && !isStreaming && (
            <MeriEmptyState surface={surface} onSend={(prompt) => void sendMessage(prompt)} />
          )}

          {messages.map((msg, i) => {
            const isLastAssistant = msg.role === 'assistant' && i === messages.length - 1;
            const verificationDisplay =
              msg.role === 'assistant' && msg.content !== ''
                ? deriveVerificationDisplay({
                    verification: msg.verification ?? null,
                    findings: msg.groundingCaveat?.findings ?? [],
                    ran: Boolean(msg.verification),
                  })
                : null;
            return (
              <div key={msg.id} className={`meri-turn meri-turn--${msg.role}`}>
                {isLastAssistant && (
                  <WorkPerformed
                    intent={orchestratorIntent}
                    tier={orchestratorTier}
                    steps={trustSteps}
                    planSteps={planSteps}
                    isStreaming={isStreaming}
                  />
                )}
                <ChatMessage
                  role={msg.role}
                  content={msg.content}
                  citations={msg.citations}
                  verification={msg.verification}
                  groundingCaveat={msg.groundingCaveat}
                  attachments={msg.attachments}
                  isStreaming={
                    isStreaming &&
                    i === messages.length - 1 &&
                    msg.role === 'assistant' &&
                    msg.content !== ''
                  }
                />
                {verificationDisplay &&
                  !(isStreaming && i === messages.length - 1) && (
                    <div className="chat-verification-summary">
                      <VerificationStatus display={verificationDisplay} compact />
                    </div>
                  )}
                {msg.role === 'assistant' &&
                  msg.chartArtifacts &&
                  msg.chartArtifacts.length > 0 && (
                    <div className="chat-chart-cards" aria-label="Analysis charts">
                      {msg.chartArtifacts.map((chart) => (
                        <AnalysisChartCard
                          key={chart.id}
                          artifactId={chart.id}
                          title={chart.title}
                        />
                      ))}
                    </div>
                  )}
                {msg.role === 'assistant' &&
                  msg.content !== '' &&
                  !(isStreaming && i === messages.length - 1) && (
                    <div style={{ marginLeft: 40, marginTop: 2 }}>
                      <MessageFeedback
                        currentRating={msg.feedback ?? null}
                        onSubmit={(feedback) => submitFeedback(msg.id, feedback)}
                      />
                    </div>
                  )}
                {isLastAssistant && !isStreaming && !researchReports[msg.id] && (
                  <div className="meri-regenerate-action" style={{ marginLeft: 40, marginTop: 2 }}>
                    <button
                      type="button"
                      onClick={handleRegenerate}
                      aria-label="Regenerate response"
                      style={turnActionStyle}
                    >
                      ↻ Regenerate
                    </button>
                  </div>
                )}
                {isLastAssistant &&
                  !isStreaming &&
                  msg.suggestions &&
                  msg.suggestions.length > 0 && (
                    <div
                      className="meri-suggestion-actions"
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 6,
                      }}
                    >
                      {msg.suggestions.map((s, si) => (
                        <button
                          key={si}
                          type="button"
                          onClick={() => sendMessage(s)}
                          aria-label={`Ask: ${s}`}
                          className="chat-suggestion-chip"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                {msg.role === 'user' &&
                  msg.id === lastUserMessageId &&
                  !isStreaming &&
                  (editingMessageId === msg.id ? (
                    <div className="meri-user-edit" style={{ marginTop: 4 }}>
                      <textarea
                        value={editingText}
                        onChange={(e) => setEditingText(e.target.value)}
                        rows={3}
                        aria-label="Edit message"
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          font: 'inherit',
                          padding: 6,
                        }}
                      />
                      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                        <button type="button" onClick={handleEditResend} style={turnActionStyle}>
                          Save &amp; resend
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingMessageId(null)}
                          style={turnActionStyle}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="meri-user-edit" style={{ marginTop: 2 }}>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingMessageId(msg.id);
                          setEditingText(msg.content);
                        }}
                        aria-label="Edit and resend"
                        style={turnActionStyle}
                      >
                        ✎ Edit
                      </button>
                    </div>
                  ))}
                {researchReports[msg.id] && (
                  <div className="chat-research-actions">
                    <button
                      type="button"
                      className="chat-research-action"
                      onClick={() => void fetchResearchExport(researchReports[msg.id]!, 'html')}
                    >
                      Open as page
                    </button>
                    <button
                      type="button"
                      className="chat-research-action"
                      onClick={() => void fetchResearchExport(researchReports[msg.id]!, 'word')}
                    >
                      Download Word
                    </button>
                  </div>
                )}
                {researchOffers[msg.id] && (
                  <div className="chat-research-actions">
                    <button
                      type="button"
                      className="chat-research-action chat-research-action--primary"
                      disabled={isStreaming}
                      onClick={() => handleRunResearchOffer(msg.id, researchOffers[msg.id]!.topic)}
                    >
                      Run as Deep Research
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {researchAwaitingAnswers && researchQuestions.length > 0 && (
            <ResearchClarifyForm
              questions={researchQuestions}
              disabled={isStreaming}
              onSubmit={(answers, skipped) => void submitResearchAnswers(answers, skipped)}
            />
          )}

          {showTypingIndicator && (
            <div className="chat-typing" aria-label="Meri is typing">
              <span />
              <span />
              <span />
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {activeArtifact && (
          <MeriCanvas
            artifact={activeArtifact}
            onClose={() => setActiveArtifact(null)}
            apiBaseUrl={config.apiBaseUrl}
            getAuthHeaders={authHeaders}
          />
        )}

        <div className="chat-input-area">
          {isStreaming && (
            <button
              type="button"
              onClick={handleStop}
              aria-label="Stop generating"
              style={{
                alignSelf: 'center',
                marginBottom: 8,
                padding: '4px 16px',
                borderRadius: 999,
                border: '1px solid var(--border-2)',
                background: 'var(--bg-surface)',
                cursor: 'pointer',
                fontSize: 13,
                color: 'var(--critical)',
              }}
            >
              ■ Stop
            </button>
          )}
          <ChatInput
            disabled={isStreaming}
            onSend={(c) => void sendMessage(c)}
            attachments={stagedAttachments}
            onAttachFiles={handleAttachFiles}
            onRemoveAttachment={removeStagedAttachment}
            uploadsInFlight={stagedAttachments.some((att) => att.status === 'uploading')}
            attachmentNotice={attachmentNotice}
            writeMode={writeMode}
            onToggleWriteMode={() => {
              setWriteMode((current) => !current);
              if (researchMode) setResearchMode(false);
            }}
            researchMode={researchMode}
            researchAwaitingAnswers={researchAwaitingAnswers}
            onToggleResearchMode={() => {
              setResearchMode((current) => {
                const next = !current;
                if (!next) {
                  // Leaving research mode resets any in-progress research session.
                  researchSessionRef.current = null;
                  setResearchAwaitingAnswers(false);
                  setResearchQuestions([]);
                } else if (writeMode) {
                  setWriteMode(false);
                }
                return next;
              });
            }}
          />
        </div>
      </div>

      {/* Toggle FAB, only visible when drawer is closed — and hidden on the
          workspace draft editor, which has its own embedded Meri panel. */}
      {!embedded && !hideMeriFab && (
        <button
          type="button"
          className={`chat-toggle-fab${isOpen ? ' chat-toggle-fab--hidden' : ''}`}
          data-tour="Meri"
          onClick={toggleChat}
          aria-label="Open Meri"
          title="Meri"
          aria-expanded={isOpen}
        >
          <img src={meriBubbleImage} alt="" className="chat-toggle-fab-logo" />
          {alertsBadge > 0 && <span className="chat-fab-badge">{alertsBadge}</span>}
        </button>
      )}
    </>
  );
}
