import { Children, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { Components } from 'react-markdown';
import { AnalysisChartCard } from '../../components/chat/AnalysisChartCard.js';
import {
  attachmentKindIcon,
  truncateFilenameMiddle,
} from '../../components/chat/ChatInput.js';
import type {
  ChatMessage,
  ChatMessageAttachment,
  MeriCitation,
} from '../../components/chat/chat-store.js';
import { MessageFeedback } from '../../components/chat/MessageFeedback.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';

function formatTime(value: Date | string | undefined): string {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) return 'TIME UNKNOWN';
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
          <div className="vnext-meri__user-bubble">
            <AttachmentList attachments={message.attachments} />
            {message.content}
          </div>
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
  const [activeCitation, setActiveCitation] = useState<MeriCitation | null>(null);
  const citations = message.citations ?? [];
  const visibleCitations = sourcesExpanded ? citations : citations.slice(0, 3);
  const researchReport = controller.researchReports[message.id];
  const researchOffer = controller.researchOffers[message.id];
  const messageIsStreaming = isStreaming && isLastAssistant;
  const showExecutionEvidence =
    isLastAssistant &&
    (messageIsStreaming ||
      controller.planSteps.length > 0 ||
      controller.trustSteps.length > 0 ||
      Boolean(controller.orchestratorIntent));

  const citationMap = useMemo(() => {
    const map = new Map<number, MeriCitation>();
    for (const citation of citations) map.set(citation.n, citation);
    return map;
  }, [citations]);
  const markdownComponents = useMemo<Components>(
    () => buildMarkdownComponents(citationMap, setActiveCitation),
    [citationMap],
  );

  const verificationLabel = message.groundingCaveat?.findings.length
    ? 'REVIEW FLAGGED'
    : message.verification?.totalCount
      ? message.verification.unsupportedCount === 0
        ? 'VERIFIED'
        : 'PARTIAL SUPPORT'
      : citations.length > 0
        ? 'SOURCES ATTACHED'
        : null;

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
          <AttachmentList attachments={message.attachments} />
          {message.content ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
              components={markdownComponents}
            >
              {message.content}
            </ReactMarkdown>
          ) : messageIsStreaming ? (
            <StreamingDots />
          ) : null}
          {messageIsStreaming && message.content ? <StreamingDots /> : null}
        </div>

        {showExecutionEvidence ? (
          <details
            className="vnext-meri__attachment-notice"
            open={messageIsStreaming ? true : undefined}
          >
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
              {messageIsStreaming ? 'Meri is working…' : 'Execution evidence'}
            </summary>
            {controller.orchestratorIntent ? (
              <div style={{ marginTop: 8 }}>
                Intent: {controller.orchestratorIntent.replace(/_/g, ' ')}
                {controller.orchestratorTier ? ` · ${controller.orchestratorTier}` : ''}
              </div>
            ) : null}
            {controller.planSteps.length > 0 ? (
              <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {controller.planSteps.map((step, index) => (
                  <li key={`${index}-${step}`}>{step}</li>
                ))}
              </ol>
            ) : null}
            {controller.trustSteps.length > 0 ? (
              <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {controller.trustSteps.map((step, index) => (
                  <li key={`${step.tool}-${index}`}>
                    {step.status.toUpperCase()} · {step.label}
                    {step.detail ? ` — ${step.detail}` : ''}
                    {typeof step.count === 'number' ? ` (${step.count})` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            <div style={{ marginTop: 8, fontSize: 11 }}>
              This shows bounded plans, tools, sources, and checks — not private model reasoning.
            </div>
          </details>
        ) : null}

        {message.groundingCaveat?.findings.length ? (
          <div className="vnext-meri__attachment-notice" role="alert">
            <strong>Meri flagged a possible grounding issue.</strong>
            {message.groundingCaveat.findings.map((finding) => (
              <span key={`${finding.check}-${finding.detail}`} style={{ display: 'block' }}>
                {finding.check}: {finding.detail}
              </span>
            ))}
          </div>
        ) : null}

        {message.verification && message.verification.totalCount > 0 ? (
          <div className="vnext-meri__attachment-notice" role="status">
            {message.verification.unsupportedCount === 0
              ? `${message.verification.totalCount} claims were checked against retrieved sources.`
              : `${message.verification.unsupportedCount} of ${message.verification.totalCount} claims could not be tied to a retrieved source.`}
          </div>
        ) : null}

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

        {message.suggestions?.length && !messageIsStreaming ? (
          <div className="vnext-meri__inline-actions" aria-label="Suggested follow-ups">
            {message.suggestions.map((suggestion) => (
              <button
                type="button"
                key={suggestion}
                className="vnext-meri__inline-action-btn"
                disabled={isStreaming}
                onClick={() => void controller.sendMessage(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}

        {citations.length > 0 ? (
          <div className="vnext-meri__source-strip">
            {visibleCitations.map((citation) => (
              <SourceChip
                key={`${citation.n}-${citation.id}`}
                citation={citation}
                onOpen={setActiveCitation}
              />
            ))}
            {citations.length > 3 ? (
              <button
                type="button"
                className="vnext-meri__source-more"
                onClick={() => setSourcesExpanded((expanded) => !expanded)}
              >
                {sourcesExpanded ? 'SHOW FEWER' : `+${citations.length - 3} SOURCES`}
              </button>
            ) : null}
            <span style={{ flex: 1 }} />
            {verificationLabel ? (
              <span className="vnext-meri__grounded-stamp">
                <span className="vnext-meri__grounded-dot" />
                {verificationLabel}
              </span>
            ) : null}
          </div>
        ) : !messageIsStreaming && message.content ? (
          <div className="vnext-meri__source-strip">
            <span className="vnext-meri__ungrounded-note">
              No retrieved sources were attached to this answer.
            </span>
          </div>
        ) : null}

        {activeCitation ? (
          <div className="vnext-meri__attachment-notice" role="status">
            <strong>{activeCitation.title}</strong>
            {activeCitation.snippet ? (
              <span style={{ display: 'block', marginTop: 4 }}>{activeCitation.snippet}</span>
            ) : null}
            <span style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
              {activeCitation.url ? (
                <a href={activeCitation.url} target="_blank" rel="noopener noreferrer">
                  Open source ↗
                </a>
              ) : null}
              <button
                type="button"
                className="vnext-meri__source-more"
                onClick={() => setActiveCitation(null)}
              >
                CLOSE
              </button>
            </span>
          </div>
        ) : null}

        {!messageIsStreaming && message.content ? (
          <div
            className="vnext-meri__inline-actions"
            style={{ justifyContent: 'flex-end', alignItems: 'center' }}
          >
            <MessageFeedback
              currentRating={message.feedback}
              onSubmit={(payload) => controller.submitFeedback(message.id, payload)}
            />
            {isLastAssistant ? (
              <button
                type="button"
                className="vnext-meri__inline-action-btn"
                disabled={isStreaming}
                onClick={() => controller.handleRegenerate()}
              >
                REGENERATE
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {message.chartArtifacts?.length ? (
        <div className="chat-chart-cards" aria-label="Analysis charts">
          {message.chartArtifacts.map((chart) => (
            <AnalysisChartCard key={chart.id} artifactId={chart.id} title={chart.title} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AttachmentList({ attachments }: { attachments?: ChatMessageAttachment[] }) {
  if (!attachments?.length) return null;
  return (
    <div className="vnext-meri__attachments" aria-label="Attached files">
      {attachments.map((attachment) => (
        <span key={attachment.id} className="vnext-meri__attachment">
          <span aria-hidden="true">{attachmentKindIcon(attachment.kind)}</span>
          <span title={attachment.filename}>
            {truncateFilenameMiddle(attachment.filename, 28)}
          </span>
          {attachment.status === 'truncated' ? (
            <span className="vnext-meri__attachment-state">TRUNCATED</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function StreamingDots() {
  return (
    <span className="vnext-meri__assistant-streaming" aria-label="Meri is responding">
      <span className="vnext-meri__assistant-streaming-dot" />
      <span className="vnext-meri__assistant-streaming-dot" />
      <span className="vnext-meri__assistant-streaming-dot" />
    </span>
  );
}

function SourceChip({
  citation,
  onOpen,
}: {
  citation: MeriCitation;
  onOpen: (citation: MeriCitation) => void;
}) {
  return (
    <button
      type="button"
      className="vnext-meri__source-chip"
      title={citation.title}
      onClick={() => onOpen(citation)}
    >
      <span className="vnext-meri__source-chip-label">
        {citation.n} · {citation.title}
      </span>
    </button>
  );
}

function injectCitations(
  children: ReactNode,
  citationMap: Map<number, MeriCitation>,
  onOpen: (citation: MeriCitation) => void,
): ReactNode {
  if (citationMap.size === 0) return children;
  return Children.map(children, (child) => {
    if (typeof child !== 'string') return child;
    const parts: ReactNode[] = [];
    const pattern = /\[(\d{1,3})\]/g;
    let last = 0;
    let match: RegExpExecArray | null;
    let key = 0;
    while ((match = pattern.exec(child)) !== null) {
      const citation = citationMap.get(Number(match[1]));
      if (!citation) continue;
      if (match.index > last) parts.push(child.slice(last, match.index));
      parts.push(
        <button
          key={`citation-${citation.n}-${key++}`}
          type="button"
          className="chat-citation"
          title={`View source ${citation.n}`}
          onClick={() => onOpen(citation)}
        >
          [{citation.n}]
        </button>,
      );
      last = match.index + match[0].length;
    }
    if (last < child.length) parts.push(child.slice(last));
    return parts.length ? parts : child;
  });
}

function buildMarkdownComponents(
  citationMap: Map<number, MeriCitation>,
  onOpen: (citation: MeriCitation) => void,
): Components {
  const withCitations = (children: ReactNode) => injectCitations(children, citationMap, onOpen);
  return {
    p: ({ children }) => <p className="chat-md-p">{withCitations(children)}</p>,
    li: ({ children }) => <li>{withCitations(children)}</li>,
    h1: ({ children }) => <h1 className="chat-md-h chat-md-h1">{withCitations(children)}</h1>,
    h2: ({ children }) => <h2 className="chat-md-h chat-md-h2">{withCitations(children)}</h2>,
    h3: ({ children }) => <h3 className="chat-md-h chat-md-h3">{withCitations(children)}</h3>,
    h4: ({ children }) => <h4 className="chat-md-h chat-md-h4">{withCitations(children)}</h4>,
    ul: ({ children }) => <ul className="chat-md-list">{children}</ul>,
    ol: ({ children }) => <ol className="chat-md-list">{children}</ol>,
    blockquote: ({ children }) => (
      <blockquote className="chat-md-quote">{withCitations(children)}</blockquote>
    ),
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
    code: ({ children, className }) =>
      className?.includes('language-') ? (
        <code className={className}>{children}</code>
      ) : (
        <code className="chat-md-code">{children}</code>
      ),
    pre: ({ children }) => <pre className="chat-md-pre">{children}</pre>,
    table: ({ children }) => (
      <div className="chat-md-table-wrap">
        <table className="chat-md-table">{children}</table>
      </div>
    ),
    th: ({ children }) => <th>{withCitations(children)}</th>,
    td: ({ children }) => <td>{withCitations(children)}</td>,
    strong: ({ children }) => <strong>{withCitations(children)}</strong>,
    em: ({ children }) => <em>{withCitations(children)}</em>,
  };
}
