import { Children, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { Components } from 'react-markdown';
import type {
  ChatMessage,
  ChatMessageAttachment,
  MeriCitation,
} from '../../components/chat/chat-store.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { MeriAnalysisChartCard } from './MeriAnalysisChartCard.js';
import { MeriMessageFeedback } from './MeriMessageFeedback.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';
import { visibleMarkdown } from './meri-presentation.js';
import { meriRuntimeStatusText } from '../../components/chat/meri-runtime-status.js';
import type {
  MeriEvidenceClaim,
  MeriEvidenceSource,
  MeriEvidenceStat,
} from './MeriEvidenceTray.js';
import { MeriAttachmentChip, attachmentChipSpec } from './MeriAttachmentChip.js';
import { MeriWorkPerformed } from './MeriWorkPerformed.js';
import { MeriResearchProgress } from './MeriResearchProgress.js';
import { MeriMemoryCallout } from './MeriMemoryCallout.js';
import { deleteMeriResearch } from './meri-vnext-api.js';
import { INTENT_LABELS } from '../../components/chat/work-performed-shared.js';
import { useApi } from '../../lib/use-api.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import type { MeriThinkingTabProps } from './MeriThinkingTab.js';
import type { MeriEvidenceTabProps } from './MeriEvidenceTab.js';
import type { MeriTurnInspectorData, MeriTurnInspectorTab } from './MeriTurnInspector.js';

interface VNextMeriMessageProps {
  message: ChatMessage;
  isLastAssistant: boolean;
  isStreaming: boolean;
  controller: MeriChatController;
  onOpenMemory: () => void;
  onOpenSourceDetail: (citations: MeriCitation[], index: number) => void;
  onOpenTurnInspector: (data: MeriTurnInspectorData, tab: MeriTurnInspectorTab) => void;
}

export function VNextMeriMessage({
  message,
  isLastAssistant,
  isStreaming,
  controller,
  onOpenMemory,
  onOpenSourceDetail,
  onOpenTurnInspector,
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
                  fontFamily:
                    "var(--meri-font-mono, Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif)",
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
                style={{
                  height: 32,
                  padding: '0 12px',
                  borderRadius: 8,
                  border: '1px solid #D0D5DD',
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#344054',
                  background: 'transparent',
                }}
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
                  background:
                    'var(--m-metal-bg, linear-gradient(180deg,#39424F 0%,#1B2430 46%,#0E141C 100%))',
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
          {message.content}
        </div>
        <AttachmentList attachments={message.attachments} />
        <div
          className="vnext-meri__user-meta"
          style={{ display: 'flex', alignItems: 'center', gap: 10 }}
        >
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
                padding: 0,
                fontFamily:
                  "var(--meri-font-sans, Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif)",
                fontSize: 11.5,
                fontWeight: 500,
                color: '#98A2B3',
                cursor: 'pointer',
              }}
            >
              <MeriIcon name="Edit01" size={13} />
              Edit and resend
            </button>
          ) : null}
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
      onOpenTurnInspector={onOpenTurnInspector}
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
  onOpenTurnInspector,
}: {
  message: ChatMessage;
  isLastAssistant: boolean;
  isStreaming: boolean;
  controller: MeriChatController;
  onOpenMemory: () => void;
  onOpenSourceDetail: (citations: MeriCitation[], index: number) => void;
  onOpenTurnInspector: (data: MeriTurnInspectorData, tab: MeriTurnInspectorTab) => void;
}) {
  const api = useApi();
  const toast = useCapiroToast();
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const [deletedResearch, setDeletedResearch] = useState(false);
  const [activeCitation, setActiveCitation] = useState<MeriCitation | null>(null);
  const citations = message.citations ?? [];
  const researchReport = controller.researchReports[message.id] ?? message.researchSessionId;
  const researchOffer = controller.researchOffers[message.id];
  const messageIsStreaming = isStreaming && isLastAssistant;
  // Only the active turn owns the controller's transient work state. Completed
  // turns keep their own saved work across later turns and history reloads.
  const workPlanSteps = messageIsStreaming ? controller.planSteps : (message.planSteps ?? []);
  const workTrustSteps = messageIsStreaming ? controller.trustSteps : (message.trustSteps ?? []);
  const workIntent = messageIsStreaming
    ? controller.orchestratorIntent
    : (message.orchestratorIntent ?? null);
  const workTier = messageIsStreaming
    ? controller.orchestratorTier
    : (message.orchestratorTier ?? null);
  // Deep research and the ordinary tool loop both stream into trustSteps, but
  // only research has a real elapsed/budget time — so it gets the dedicated
  // MeriResearchProgress hero instead of MeriWorkPerformed's step-count one.
  const showResearchProgress = isLastAssistant && controller.isResearchStreaming;
  const showExecutionEvidence =
    !showResearchProgress &&
    (messageIsStreaming ||
      workPlanSteps.length > 0 ||
      workTrustSteps.length > 0 ||
      Boolean(workIntent));

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
  const runtimeStatusText = meriRuntimeStatusText(message.runtimeStatus);

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
        {
          label: `UNSUPPORTED · ${message.verification.unsupportedCount}`,
          tone: message.verification.unsupportedCount ? 'w' : 'g',
        },
      ]
    : [];

  /**
   * v6 turn-inspector data for this message. The live/streaming latest turn
   * still reads controller-global state (it updates in real time before the
   * `finally` block in useMeriChatController.ts's sendMessage persists it
   * onto the message record); every other turn — including the latest one
   * once streaming has actually finished — reads the per-message fields
   * Meri v6's thinking-persistence piece added to ChatMessage. Older rows
   * persisted before that shipped simply have these fields undefined, which
   * MeriThinkingTab/MeriEvidenceTab already render as an honest empty state,
   * not an error.
   */
  const thinkingData: MeriThinkingTabProps = {
    plan: workPlanSteps.join(' '),
    steps: workTrustSteps,
    intent: workIntent,
    tier: workTier,
  };
  const hasThinkingData =
    thinkingData.plan.length > 0 || thinkingData.steps.length > 0 || Boolean(thinkingData.intent);
  const evidenceTabData: MeriEvidenceTabProps = {
    sources: evidenceSources,
    verifyStats: evidenceStats,
    claims: evidenceClaims,
    groundingCaveat: message.groundingCaveat ?? null,
    retrieval: message.retrieval ?? null,
    onOpenSource: (_source, index) => setActiveCitation(citations[index] ?? null),
  };
  const openThisTurnInspector = (tab: MeriTurnInspectorTab) =>
    onOpenTurnInspector(
      {
        turnId: message.id,
        thinking: thinkingData,
        evidence: evidenceTabData,
        approvals: controller.pendingApprovals,
      },
      tab,
    );

  return (
    <div className="vnext-meri__assistant-message">
      <span className="vnext-meri__assistant-mark">
        <MeriIcon name="Stars02" size={14} color="#FFFFFF" />
      </span>
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
          ) : null}
          {/* One cursor, whether or not any prose has arrived yet (handoff §4g). */}
          {messageIsStreaming ? <ComposingCursor /> : null}
        </div>

        {runtimeStatusText && !messageIsStreaming ? <p role="status">{runtimeStatusText}</p> : null}

        {showResearchProgress ? (
          <MeriResearchProgress
            isStreaming={controller.isResearchStreaming}
            progress={controller.researchProgress}
            steps={controller.trustSteps}
          />
        ) : null}

        {/*
          v6: the ordinary tool loop renders as quiet trace lines under the
          answer (12px icon + 11.5px muted text per line) instead of the dark
          metal work-performed hero — the transcript keeps the prototype's
          calm surface and the full plan/step detail stays one "Show work"
          click away in the turn inspector. MeriWorkPerformed remains the
          renderer for the pinned contract test; the hero only mounts when
          nothing else can express the run (never in the v6 transcript).

          Below the trace lines, a SHOW/HIDE REASONING disclosure (prototype
          pattern) reveals the same bounded plan text already surfaced in the
          turn inspector's Thinking tab — never raw model chain-of-thought,
          which this app deliberately never retains in browser state.
        */}
        {showExecutionEvidence && workTrustSteps.length > 0 ? (
          <>
            <div className="vnext-meri__trace" aria-label="Work performed">
              {workTrustSteps.map((step, index) => {
                const running = messageIsStreaming && step.status === 'running';
                const statusLabel = running
                  ? 'Running'
                  : step.status === 'done'
                    ? 'Completed'
                    : step.status === 'error'
                      ? 'Not completed'
                      : 'Incomplete';
                return (
                  <div key={`${step.tool}-${index}`} className="vnext-meri__trace-line">
                    <MeriIcon
                      name={
                        running
                          ? 'Loading01'
                          : step.status === 'done'
                            ? 'CheckCircle'
                            : step.status === 'error'
                              ? 'AlertCircle'
                              : 'Clock'
                      }
                      size={12}
                      color={running ? '#98A2B3' : '#D0D5DD'}
                    />
                    <span
                      className="vnext-meri__trace-text"
                      title={step.detail ? `${statusLabel}: ${step.detail}` : statusLabel}
                    >
                      {step.label}
                    </span>
                  </div>
                );
              })}
            </div>
            {!messageIsStreaming && workPlanSteps.length > 0 ? (
              <>
                <button
                  type="button"
                  className="vnext-meri__reasoning-disclosure-toggle"
                  aria-expanded={reasoningExpanded}
                  onClick={() => setReasoningExpanded((expanded) => !expanded)}
                >
                  <MeriIcon name="Beaker02" size={13} color="#475467" />
                  {reasoningExpanded ? 'HIDE REASONING' : 'SHOW REASONING'}
                </button>
                {reasoningExpanded ? (
                  <div className="vnext-meri__reasoning-disclosure-body">
                    {workPlanSteps.join(' ')}
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        ) : showExecutionEvidence && workPlanSteps.length > 0 ? (
          /* A turn that announced a plan but has no tool steps yet still owes
             the user its run state — the hero renders the plan honestly here,
             and the trace lines take over as soon as the first step lands. */
          <MeriWorkPerformed
            intent={workIntent}
            tier={workTier}
            steps={workTrustSteps}
            planSteps={workPlanSteps}
            isStreaming={messageIsStreaming}
          />
        ) : null}

        {/*
          v6: the grounding-caveat and coverage-warning cards that used to
          mount separately here are now folded into the turn inspector's
          Evidence tab (MeriEvidenceTab) instead of duplicated inline.
        */}

        {isLastAssistant && !messageIsStreaming ? (
          <MeriMemoryCallout onOpenMemory={onOpenMemory} />
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
                if (
                  !window.confirm(
                    'Remove this research session? Its report will no longer be available for export.',
                  )
                )
                  return;
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
          <div className="vnext-meri__followups" data-meri-followups>
            {/* handoff §11c — "Clicking fills the composer", it does not send.
                The composer listens for this event (same channel MeriStartWork
                uses), so the user still reviews and presses Send. */}
            <div className="vnext-meri__followups-eyebrow">SUGGESTED NEXT</div>
            <div className="vnext-meri__followups-chips">
              {message.suggestions.map((suggestion) => (
                <button
                  type="button"
                  key={suggestion}
                  className="vnext-meri__followup-chip"
                  disabled={isStreaming}
                  onClick={() =>
                    window.dispatchEvent(new CustomEvent('meri-fill-draft', { detail: suggestion }))
                  }
                >
                  <MeriIcon name="CornerDownRight" size={12} color="#98A2B3" />
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/*
          v6: the inline evidence tray (sources/verification/work/context
          tabs, expanded in place via evidenceOpen) is retired from this mount
          point — the EVIDENCE button below now opens the same content in the
          rail's turn inspector instead.

          The inline source-strip (citation chips, coverage pill,
          verification chip, NOT GROUNDED stamp) is likewise removed: all of
          that data already renders in the right panel's Evidence tab (one
          "Show work" click away, in the message-actions row below), so
          keeping it here just duplicated the same information twice on
          screen.
        */}

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
                  const index = citations.findIndex(
                    (c) => c.id === activeCitation.id && c.n === activeCitation.n,
                  );
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
          <div className="vnext-meri__message-actions" data-meri-message-actions>
            {/* v6 feedback row — 26×26 icon buttons: copy, thumbs (MeriMessageFeedback
                keeps the down-click reasons form), regenerate, then the quiet
                "Show work" text button opening the turn inspector. The audit
                stamp moves with the trust signals into the inspector's Evidence
                tab, so the row stays the prototype's four quiet controls. */}
            <button
              type="button"
              className="vnext-meri__inline-action-btn"
              aria-label="Copy answer"
              title="Copy answer"
              onClick={() => {
                const copy = async () => {
                  if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(message.content);
                    return;
                  }
                  const area = document.createElement('textarea');
                  area.value = message.content;
                  area.setAttribute('readonly', '');
                  area.style.position = 'fixed';
                  area.style.opacity = '0';
                  document.body.appendChild(area);
                  area.select();
                  const copied = document.execCommand('copy');
                  area.remove();
                  if (!copied) throw new Error('Copy is not supported');
                };
                void copy()
                  .then(() => toast.success('Answer copied.'))
                  .catch(() => toast.error('The answer could not be copied.'));
              }}
            >
              <MeriIcon name="Copy01" size={14} />
            </button>
            <MeriMessageFeedback
              currentRating={message.feedback}
              onSubmit={(payload) => controller.submitFeedback(message.id, payload)}
            />
            {isLastAssistant ? (
              <button
                type="button"
                className="vnext-meri__inline-action-btn"
                aria-label="Regenerate"
                title="Regenerate"
                disabled={isStreaming}
                onClick={() => controller.handleRegenerate()}
              >
                <MeriIcon name="RefreshCcw02" size={14} />
              </button>
            ) : null}
            {hasThinkingData ? (
              <button
                type="button"
                className="vnext-meri__show-work"
                onClick={() => openThisTurnInspector('thinking')}
              >
                Show work
                <MeriIcon name="LayersThree01" size={13} />
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

function ComposingCursor() {
  // v6 — the block cursor alone (the streaming indicator row below the log
  // carries the "Meri is responding" wording; the transcript stays clean).
  return (
    <span className="vnext-meri__composing" aria-label="Meri is composing an answer">
      <span className="vnext-meri__composing-cursor" aria-hidden="true" />
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
    strong: ({ children }) => (
      <strong className="vnext-meri-md__strong">{withCitations(children)}</strong>
    ),
    em: ({ children }) => <em className="vnext-meri-md__em">{withCitations(children)}</em>,
  };
}
