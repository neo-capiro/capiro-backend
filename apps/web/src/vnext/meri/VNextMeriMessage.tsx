import { Children, useEffect, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { Components } from 'react-markdown';
import type {
  ChatMessage,
  ChatMessageAttachment,
  ChatMessageRetrieval,
  MeriCitation,
} from '../../components/chat/chat-store.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { MeriAnalysisChartCard } from './MeriAnalysisChartCard.js';
import { MeriMessageFeedback } from './MeriMessageFeedback.js';
import { MeriIcon } from './meri-icons.js';
import { formatRecordTime, MERI_LOGO_SRC, visibleMarkdown } from './meri-presentation.js';
import { VNextMeriSourceChip } from './VNextMeriSourceChip.js';
import {
  MeriEvidenceTray,
  type MeriEvidenceClaim,
  type MeriEvidenceSource,
  type MeriEvidenceStat,
  type MeriWorkStep,
} from './MeriEvidenceTray.js';
import { evidenceContextPacket } from './meri-context-packet.js';
import { MeriAttachmentChip, attachmentChipSpec } from './MeriAttachmentChip.js';
import { MeriGroundingWarning, type MeriGroundingItem } from './MeriGroundingWarning.js';
import { MeriCoverageWarning } from './MeriCoverageWarning.js';
import { MeriWorkPerformed } from './MeriWorkPerformed.js';
import { MeriResearchProgress } from './MeriResearchProgress.js';
import { MeriMemoryCallout } from './MeriMemoryCallout.js';
import { deleteMeriResearch, fetchMeriContextPacket } from './meri-vnext-api.js';
import { useApi } from '../../lib/use-api.js';

interface VNextMeriMessageProps {
  message: ChatMessage;
  isLastAssistant: boolean;
  isStreaming: boolean;
  controller: MeriChatController;
  onOpenMemory: () => void;
  onOpenSourceDetail: (citations: MeriCitation[], index: number) => void;
}

export function VNextMeriMessage({
  message,
  isLastAssistant,
  isStreaming,
  controller,
  onOpenMemory,
  onOpenSourceDetail,
}: VNextMeriMessageProps) {
  if (message.role === 'user') {
    // Editing is only offered on the still-standing last user turn — editing
    // an earlier one would need to explain which later turns disappear too,
    // and the controller only ever tracks one edit target at a time.
    const canEdit = message.id === controller.lastUserMessageId && !isStreaming;
    const isEditingThis = controller.editingMessageId === message.id;

    if (isEditingThis) {
      return (
        <div className="vnext-meri__user-message">
          <div
            style={{
              width: '76%',
              marginLeft: 'auto',
              padding: 12,
              borderRadius: 12,
              background: '#ffffff',
              boxShadow: 'inset 0 0 0 1px #98A2B3, 0 0 0 4px #F2F4F7',
            }}
          >
            <textarea
              value={controller.editingText}
              onChange={(event) => controller.setEditingText(event.target.value)}
              aria-label="Edit message"
              style={{
                width: '100%',
                minHeight: 66,
                padding: 0,
                border: 0,
                outline: 'none',
                background: 'none',
                fontSize: 14,
                lineHeight: '21px',
                color: '#101828',
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 10 }}>
              <span
                style={{
                  flex: 1,
                  fontFamily: "var(--meri-font-mono, 'IBM Plex Mono', monospace)",
                  fontSize: 9,
                  fontWeight: 500,
                  letterSpacing: '.08em',
                  color: '#98A2B3',
                }}
              >
                RESENDING REPLACES THE ANSWER BELOW
              </span>
              <button
                type="button"
                onClick={() => controller.setEditingMessageId(null)}
                style={{ height: 32, padding: '0 12px', borderRadius: 8, boxShadow: 'inset 0 0 0 1px #D0D5DD', fontSize: 13, fontWeight: 600, color: '#344054', background: 'transparent' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => controller.handleEditResend()}
                disabled={!controller.editingText.trim()}
                style={{
                  height: 32,
                  padding: '0 13px',
                  borderRadius: 8,
                  border: 0,
                  background: 'var(--m-metal-bg, linear-gradient(180deg,#39424F 0%,#1B2430 46%,#0E141C 100%))',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,.14)',
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#ffffff',
                  opacity: controller.editingText.trim() ? 1 : 0.6,
                }}
              >
                Save &amp; resend
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="vnext-meri__user-message">
        <div className="vnext-meri__user-bubble" data-meri-user-bubble>
          <AttachmentList attachments={message.attachments} />
          {message.content}
        </div>
        <div className="vnext-meri__user-meta" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {canEdit ? (
            <button
              type="button"
              onClick={() => {
                controller.setEditingMessageId(message.id);
                controller.setEditingText(message.content);
              }}
              aria-label="Edit and resend"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                border: 0,
                background: 'transparent',
                fontFamily: "var(--meri-font-mono, 'IBM Plex Mono', monospace)",
                fontSize: 9,
                fontWeight: 500,
                letterSpacing: '.08em',
                color: '#667085',
                cursor: 'pointer',
              }}
            >
              <MeriIcon name="Edit01" size={12} color="#667085" />
              EDIT
            </button>
          ) : null}
          <span
            style={{
              fontFamily: "var(--meri-font-mono, 'IBM Plex Mono', monospace)",
              fontSize: 9,
              letterSpacing: '.07em',
              color: '#98A2B3',
            }}
          >
            {formatRecordTime(message.createdAt)}
          </span>
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
      onOpenMemory={onOpenMemory}
      onOpenSourceDetail={onOpenSourceDetail}
    />
  );
}

function VNextMeriAssistantMessage({
  message,
  isLastAssistant,
  isStreaming,
  controller,
  onOpenMemory,
  onOpenSourceDetail,
}: {
  message: ChatMessage;
  isLastAssistant: boolean;
  isStreaming: boolean;
  controller: MeriChatController;
  onOpenMemory: () => void;
  onOpenSourceDetail: (citations: MeriCitation[], index: number) => void;
}) {
  const api = useApi();
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [deletedResearch, setDeletedResearch] = useState(false);
  const [contextPacket, setContextPacket] = useState<Awaited<ReturnType<typeof fetchMeriContextPacket>> | null>(null);
  const [activeCitation, setActiveCitation] = useState<MeriCitation | null>(null);
  const citations = message.citations ?? [];
  const visibleCitations = sourcesExpanded ? citations : citations.slice(0, 3);
  const researchReport = controller.researchReports[message.id];
  const researchOffer = controller.researchOffers[message.id];
  const messageIsStreaming = isStreaming && isLastAssistant;
  // Deep research and the ordinary tool loop both stream into trustSteps, but
  // only research has a real elapsed/budget time — so it gets the dedicated
  // MeriResearchProgress hero instead of MeriWorkPerformed's step-count one.
  const showResearchProgress = isLastAssistant && controller.isResearchStreaming;
  const showExecutionEvidence =
    isLastAssistant &&
    !showResearchProgress &&
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

  const markdownSource = visibleMarkdown(message.content, messageIsStreaming);
  const verificationLabel = message.groundingCaveat?.findings.length
    ? 'REVIEW FLAGGED'
    : message.verification?.totalCount
      ? message.verification.unsupportedCount === 0
        ? 'GROUNDED'
        : 'PARTIAL SUPPORT'
      : citations.length > 0
        ? 'GROUNDED'
        : null;

  useEffect(() => {
    if (!evidenceOpen || !message.contextPacketId) return;
    let cancelled = false;
    setContextPacket(null);
    void fetchMeriContextPacket(api, message.contextPacketId)
      .then((packet) => {
        if (!cancelled) setContextPacket(packet);
      })
      .catch(() => {
        if (!cancelled) setContextPacket(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, evidenceOpen, message.contextPacketId]);

  const evidenceSources: MeriEvidenceSource[] = citations.map((citation) => ({
    icon: 'File05',
    provider: citation.tool.replace(/_/g, ' ').toUpperCase(),
    date: 'RETRIEVED THIS TURN',
    title: citation.title,
    snippet: citation.snippet ?? 'No excerpt was returned for this source.',
    locator: citation.type.toUpperCase(),
  }));
  const evidenceClaims: MeriEvidenceClaim[] = (message.verification?.claims ?? []).map((claim) => ({
    state: claim.supported ? 'verified' : 'unsupported',
    claim: claim.claim,
  }));
  const evidenceStats: MeriEvidenceStat[] = message.verification?.totalCount
    ? [
        { label: `CLAIMS CHECKED · ${message.verification.totalCount}`, tone: 'n' },
        { label: `UNSUPPORTED · ${message.verification.unsupportedCount}`, tone: message.verification.unsupportedCount ? 'w' : 'g' },
      ]
    : [];
  const evidenceSteps: MeriWorkStep[] = isLastAssistant
    ? controller.trustSteps.map((step) => ({
        state: step.status === 'error' ? 'failed' : step.status === 'running' ? 'running' : 'done',
        title: step.label,
        detail: step.detail ?? step.tool,
      }))
    : [];
  const groundingItems: MeriGroundingItem[] = (message.groundingCaveat?.findings ?? []).map(
    (finding) => ({ kind: finding.check.replace(/_/g, ' ').toUpperCase(), text: finding.detail }),
  );

  return (
    <div className="vnext-meri__assistant-message">
      <div className="vnext-meri__assistant-heading">
        <span className="vnext-meri__assistant-mark">
          <img src={MERI_LOGO_SRC} alt="" width={13} height={13} />
        </span>
        <span className="vnext-meri__assistant-time">{formatRecordTime(message.createdAt)}</span>
      </div>
      <div className="vnext-meri__assistant-card">
        <div className="vnext-meri__assistant-body" data-meri-answer-body>
          <AttachmentList attachments={message.attachments} />
          {markdownSource ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
              components={markdownComponents}
            >
              {markdownSource}
            </ReactMarkdown>
          ) : messageIsStreaming ? (
            <StreamingDots />
          ) : null}
          {messageIsStreaming && message.content ? <StreamingDots /> : null}
        </div>

        {showResearchProgress ? (
          <MeriResearchProgress
            isStreaming={controller.isResearchStreaming}
            progress={controller.researchProgress}
            steps={controller.trustSteps}
          />
        ) : null}

        {showExecutionEvidence ? (
          <MeriWorkPerformed
            intent={controller.orchestratorIntent}
            tier={controller.orchestratorTier}
            steps={controller.trustSteps}
            planSteps={controller.planSteps}
            isStreaming={messageIsStreaming}
          />
        ) : null}

        {groundingItems.length ? (
          <MeriGroundingWarning
            items={groundingItems}
            onInspectEvidence={() => setEvidenceOpen(true)}
          />
        ) : null}

        {message.retrieval ? <MeriCoverageWarning retrieval={message.retrieval} /> : null}

        {isLastAssistant && !messageIsStreaming ? (
          <MeriMemoryCallout memories={controller.learnedMemories} onOpenMemory={onOpenMemory} />
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
              <MeriIcon name="SearchLg" size={14} color="#101828" />
              RUN DEEP RESEARCH
            </button>
          </div>
        ) : null}

        {researchReport && !deletedResearch ? (
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
            <button
              type="button"
              className="vnext-meri__inline-action-btn"
              onClick={() => {
                if (!window.confirm('Remove this research session? Its report will no longer be available for export.')) return;
                void deleteMeriResearch(api, researchReport)
                  .then(() => setDeletedResearch(true))
                  .catch(() => undefined);
              }}
            >
              DELETE RESEARCH
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

        {!messageIsStreaming && message.content ? (
          <div className="vnext-meri__inline-actions">
            <button type="button" className="vnext-meri__inline-action-btn" onClick={() => setEvidenceOpen((open) => !open)}>
              <MeriIcon name="ShieldTick" size={13} color="#344054" />
              {evidenceOpen ? 'HIDE EVIDENCE' : 'VIEW EVIDENCE'}
            </button>
          </div>
        ) : null}

        {evidenceOpen ? (
          <MeriEvidenceTray
            sources={evidenceSources}
            verifyStats={evidenceStats}
            claims={evidenceClaims}
            plan={isLastAssistant ? controller.planSteps.join(' ') : ''}
            workStats={isLastAssistant ? [`SOURCES · ${citations.length}`, `STEPS · ${evidenceSteps.length}`] : []}
            steps={evidenceSteps}
            assumptions={[]}
            context={contextPacket ? evidenceContextPacket(contextPacket) : { degraded: 'Context provenance is loading or unavailable for this answer.', included: [], excluded: [], packet: 'CONTEXT UNAVAILABLE' }}
            onOpenSource={(_source, index) => setActiveCitation(citations[index] ?? null)}
          />
        ) : null}

        {citations.length > 0 ? (
          <div className="vnext-meri__source-strip">
            {visibleCitations.map((citation) => (
              <VNextMeriSourceChip
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
                {sourcesExpanded ? 'FEWER SOURCES' : `+${citations.length - 3} SOURCES`}
                <MeriIcon
                  name={sourcesExpanded ? 'ChevronUp' : 'ChevronDown'}
                  size={12}
                  color="#667085"
                />
              </button>
            ) : null}
            <span style={{ flex: 1 }} />
            {message.retrieval ? <CoveragePill coverage={message.retrieval.coverage} /> : null}
            {verificationLabel ? (
              <span className="vnext-meri__grounded-stamp">
                <MeriIcon name="ShieldTick" size={13} color="#027A48" />
                {verificationLabel}
              </span>
            ) : null}
          </div>
        ) : !messageIsStreaming && message.content ? (
          <div className="vnext-meri__source-strip">
            <span className="vnext-meri__ungrounded-note">
              {message.groundingStatement ??
                'No retrieved sources were attached to this answer.'}
            </span>
            <span style={{ flex: 1 }} />
            {message.retrieval ? <CoveragePill coverage={message.retrieval.coverage} /> : null}
            <span className="vnext-meri__ungrounded-stamp">
              <MeriIcon name="AlertCircle" size={13} color="#B54708" />
              NOT GROUNDED
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
                  Open source
                  <MeriIcon name="ArrowUpRight" size={13} color="#101828" />
                </a>
              ) : null}
              <button
                type="button"
                className="vnext-meri__source-more"
                onClick={() => {
                  const index = citations.findIndex((c) => c.id === activeCitation.id && c.n === activeCitation.n);
                  onOpenSourceDetail(citations, index >= 0 ? index : 0);
                }}
              >
                VIEW FULL SOURCE
              </button>
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
            <MeriMessageFeedback
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
        {message.chartArtifacts?.length ? (
          <div className="vnext-meri__analysis-slot" aria-label="Analysis charts">
            {message.chartArtifacts.map((chart) => (
              <MeriAnalysisChartCard key={chart.id} artifactId={chart.id} title={chart.title} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AttachmentList({ attachments }: { attachments?: ChatMessageAttachment[] }) {
  if (!attachments?.length) return null;
  return (
    <div className="vnext-meri__attachments" aria-label="Attached files">
      {attachments.map((attachment) => {
        const spec = attachmentChipSpec(attachment);
        return (
          <MeriAttachmentChip
            key={attachment.id}
            name={spec.name}
            state={spec.state}
            icon={spec.icon}
            ring={spec.ring}
            fg={spec.fg}
          />
        );
      })}
    </div>
  );
}

/**
 * Coverage pill for the trust strip. The backend reports coverage as
 * `{ complete, stopReason }`, so only the complete/partial distinction is
 * real — the prototype's SOURCES DISAGREE and REQUIRED SOURCE MISSING states
 * have no backing field and are deliberately not synthesised here.
 */
function CoveragePill({ coverage }: { coverage: ChatMessageRetrieval['coverage'] }) {
  const reason = coverage.stopReason?.replace(/_/g, ' ').trim();
  return (
    <span
      className={`vnext-meri__coverage-pill${coverage.complete ? ' is-complete' : ' is-partial'}`}
      title={reason ? `Stop reason: ${reason}` : undefined}
    >
      <MeriIcon
        name={coverage.complete ? 'CheckCircle' : 'AlertTriangle'}
        size={12}
        color={coverage.complete ? '#027A48' : '#B54708'}
      />
      {coverage.complete ? 'FULL COVERAGE' : 'PARTIAL COVERAGE'}
    </span>
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
    p: ({ children }) => <p className="vnext-meri-md__p">{withCitations(children)}</p>,
    li: ({ children }) => <li className="vnext-meri-md__li">{withCitations(children)}</li>,
    h1: ({ children }) => <h1 className="vnext-meri-md__h">{withCitations(children)}</h1>,
    h2: ({ children }) => <h2 className="vnext-meri-md__h">{withCitations(children)}</h2>,
    h3: ({ children }) => <h3 className="vnext-meri-md__h">{withCitations(children)}</h3>,
    h4: ({ children }) => <h4 className="vnext-meri-md__h">{withCitations(children)}</h4>,
    ul: ({ children }) => <ul className="vnext-meri-md__list">{children}</ul>,
    ol: ({ children }) => <ol className="vnext-meri-md__list is-ordered">{children}</ol>,
    blockquote: ({ children }) => (
      <blockquote className="vnext-meri-md__quote">{withCitations(children)}</blockquote>
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
        <code className="vnext-meri-md__code">{children}</code>
      ),
    pre: ({ children }) => <pre className="vnext-meri-md__pre">{children}</pre>,
    table: ({ children }) => (
      <div className="vnext-meri-md__table-wrap">
        <table className="vnext-meri-md__table">{children}</table>
      </div>
    ),
    th: ({ children }) => <th>{withCitations(children)}</th>,
    td: ({ children }) => <td>{withCitations(children)}</td>,
    strong: ({ children }) => <strong className="vnext-meri-md__strong">{withCitations(children)}</strong>,
    em: ({ children }) => <em className="vnext-meri-md__em">{withCitations(children)}</em>,
  };
}
