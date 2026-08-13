import { useState } from 'react';
import type { ChatMessage, MeriCitation } from '../../components/chat/chat-store.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';

function formatTime(value: Date | string | undefined): string {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

interface VNextMeriMessageProps {
  message: ChatMessage;
  isLastAssistant: boolean;
  isStreaming: boolean;
  controller: MeriChatController;
  selectedClientName: string | null;
  userLabel: string;
}

export function VNextMeriMessage({
  message,
  isLastAssistant,
  isStreaming,
  controller,
  selectedClientName,
  userLabel,
}: VNextMeriMessageProps) {
  if (message.role === 'user') {
    return (
      <div>
        <div className="vnext-meri__user-message">
          <div className="vnext-meri__user-bubble">{message.content}</div>
        </div>
        <div className="vnext-meri__user-meta">
          {userLabel.toUpperCase()} · {formatTime(message.createdAt)}
        </div>
      </div>
    );
  }

  return (
    <VNextMeriAssistantMessage
      message={message}
      isLastAssistant={isLastAssistant}
      isStreaming={isStreaming}
      controller={controller}
      selectedClientName={selectedClientName}
    />
  );
}

function VNextMeriAssistantMessage({
  message,
  isLastAssistant,
  isStreaming,
  controller,
  selectedClientName,
}: {
  message: ChatMessage;
  isLastAssistant: boolean;
  isStreaming: boolean;
  controller: MeriChatController;
  selectedClientName: string | null;
}) {
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const citations = message.citations ?? [];
  const visibleCitations = sourcesExpanded ? citations : citations.slice(0, 3);
  const hasMore = citations.length > 3 && !sourcesExpanded;
  const researchReport = controller.researchReports[message.id];
  const researchOffer = controller.researchOffers[message.id];
  const messageIsStreaming = isStreaming && isLastAssistant && message.content !== '';

  return (
    <div className="vnext-meri__assistant-message">
      <div className="vnext-meri__assistant-heading">
        <span className="vnext-meri__assistant-mark">M</span>
        <span className="vnext-meri__assistant-time">
          {formatTime(message.createdAt)}
          {selectedClientName ? ` · SCOPED TO ${selectedClientName.toUpperCase()}` : ''}
        </span>
      </div>
      <div className="vnext-meri__assistant-card">
        <div className="vnext-meri__assistant-body">
          {message.content ? (
            message.content.split('\n').map((line, i) => (
              <p key={i}>{line || '\u00A0'}</p>
            ))
          ) : messageIsStreaming ? (
            <span className="vnext-meri__assistant-streaming">
              <span className="vnext-meri__assistant-streaming-dot" />
              <span className="vnext-meri__assistant-streaming-dot" />
              <span className="vnext-meri__assistant-streaming-dot" />
            </span>
          ) : null}
          {messageIsStreaming ? (
            <span className="vnext-meri__assistant-streaming">
              <span className="vnext-meri__assistant-streaming-dot" />
              <span className="vnext-meri__assistant-streaming-dot" />
              <span className="vnext-meri__assistant-streaming-dot" />
            </span>
          ) : null}
        </div>

        {researchOffer ? (
          <div className="vnext-meri__research-offer">
            <span className="vnext-meri__research-offer-text">
              {researchOffer.reason || `Deeper research on "${researchOffer.topic}" is available.`}
            </span>
            <button
              type="button"
              className="vnext-meri__research-offer-btn"
              disabled={isStreaming}
              onClick={() =>
                void controller.handleRunResearchOffer(message.id, researchOffer.topic)
              }
            >
              RUN DEEP RESEARCH
            </button>
          </div>
        ) : null}

        {researchReport ? (
          <div className="vnext-meri__inline-actions">
            <button
              type="button"
              className="vnext-meri__inline-action-btn"
              onClick={() => void controller.fetchResearchExport(researchReport, 'html')}
            >
              OPEN AS PAGE
            </button>
            <button
              type="button"
              className="vnext-meri__inline-action-btn"
              onClick={() => void controller.fetchResearchExport(researchReport, 'word')}
            >
              DOWNLOAD WORD
            </button>
          </div>
        ) : null}

        {citations.length > 0 ? (
          <div className="vnext-meri__source-strip">
            {visibleCitations.map((citation) => (
              <SourceChip key={citation.n} citation={citation} />
            ))}
            {hasMore ? (
              <button
                type="button"
                className="vnext-meri__source-more"
                onClick={() => setSourcesExpanded(true)}
              >
                +{citations.length - 3} SOURCES
              </button>
            ) : null}
            <span style={{ flex: 1 }} />
            <span className="vnext-meri__grounded-stamp">
              <span className="vnext-meri__grounded-dot" />
              GROUNDED
            </span>
          </div>
        ) : !messageIsStreaming && message.content ? (
          <div className="vnext-meri__source-strip">
            <span className="vnext-meri__ungrounded-note">
              No sources were used for this answer. Meri answered from its own reasoning.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SourceChip({ citation }: { citation: MeriCitation }) {
  return (
    <button type="button" className="vnext-meri__source-chip" title={citation.title}>
      <span className="vnext-meri__source-chip-label">
        {citation.n} · {citation.title}
      </span>
    </button>
  );
}
