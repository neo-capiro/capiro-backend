import { Children, useMemo, useState, type ReactNode } from 'react';
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
import { MeriIcon, type MeriIconName } from './meri-icons.js';
import { formatRecordTime, MERI_LOGO_SRC, visibleMarkdown } from './meri-presentation.js';
import { VNextMeriSourceChip } from './VNextMeriSourceChip.js';
import type { MeriEvidenceClaim, MeriEvidenceSource, MeriEvidenceStat } from './MeriEvidenceTray.js';
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
                  fontFamily: "var(--meri-font-mono, Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif)",
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
                style={{ height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid #D0D5DD', fontSize: 13, fontWeight: 600, color: '#344054', background: 'transparent' }}
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
                fontFamily: "var(--meri-font-mono, Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif)",
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
              fontFamily: "var(--meri-font-mono, Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif)",
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
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [deletedResearch, setDeletedResearch] = useState(false);
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
  /**
   * Verification chip (handoff §10a). The handoff's six verification states map
   * onto what the orchestrator actually sends: a claim-level verification block
   * with total/unsupported counts and an optional confidence level, plus the
   * post-hoc grounding auditor's caveat. `NOT GROUNDED` is handled separately
   * below (the ungrounded strip), so this only covers grounded turns.
   *
   * Sources, verification, coverage and context stay four distinct signals
   * (§10a rule) — this chip never absorbs the coverage pill beside it.
   */
  const verificationChip = useMemo<{
    label: string;
    icon: MeriIconName;
    tone: 'good' | 'warn' | 'neutral';
  } | null>(() => {
    if (message.groundingCaveat?.findings.length) {
      return { label: 'REVIEW FLAGGED', icon: 'AlertTriangle', tone: 'warn' };
    }
    const verification = message.verification;
    if (verification?.totalCount) {
      if (verification.unsupportedCount > 0) {
        return {
          label: `${verification.unsupportedCount} CLAIM${
            verification.unsupportedCount === 1 ? '' : 'S'
          } UNSUPPORTED`,
          icon: 'AlertTriangle',
          tone: 'warn',
        };
      }
      if (verification.lowConfidence || verification.confidence?.level === 'low') {
        return { label: 'LOW CONFIDENCE', icon: 'AlertTriangle', tone: 'warn' };
      }
      if (verification.confidence?.level === 'medium') {
        return { label: 'MEDIUM CONFIDENCE', icon: 'Shield01', tone: 'neutral' };
      }
      if (verification.confidence?.level === 'unknown') {
        return { label: 'NOT VERIFIED', icon: 'HelpCircle', tone: 'neutral' };
      }
      return { label: 'ALL CLAIMS CHECKED', icon: 'ShieldTick', tone: 'good' };
    }
    // Citations resolved but the server ran no claim-level verification: say
    // exactly that rather than claiming the claims were checked.
    if (citations.length > 0) {
      return { label: 'NOT VERIFIED', icon: 'HelpCircle', tone: 'neutral' };
    }
    return null;
  }, [citations.length, message.groundingCaveat, message.verification]);

  /**
   * Audit stamp (handoff §11a, right-aligned in the message-actions row).
   *
   * Composed only from facts the server actually attached to THIS turn:
   * resolved citations and the verification claim counts. The handoff's
   * fixture reads `AUDIT TRAIL ON · 7 OF 9 SOURCES CHECKED`, but inventing a
   * "sources attempted" figure the orchestrator does not send would be a
   * fabricated provenance claim — so the checked-count variant only renders
   * when verification really carries an unsupported count, and a turn with no
   * citations and no verification gets no stamp at all rather than "0 SOURCES".
   */
  const auditStamp = useMemo(() => {
    const parts: string[] = [];
    if (citations.length > 0) {
      parts.push(`${citations.length} SOURCE${citations.length === 1 ? '' : 'S'}`);
    }
    const verification = message.verification;
    if (verification?.totalCount) {
      const checked = verification.totalCount - verification.unsupportedCount;
      parts.push(`${checked} OF ${verification.totalCount} CLAIMS VERIFIED`);
    }
    if (parts.length === 0) return null;
    return `AUDIT TRAIL ON · ${parts.join(' · ')}`;
  }, [citations.length, message.verification]);

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
    plan: (isLastAssistant ? controller.planSteps : (message.planSteps ?? [])).join(' '),
    steps: isLastAssistant ? controller.trustSteps : (message.trustSteps ?? []),
    intent: isLastAssistant ? controller.orchestratorIntent : (message.orchestratorIntent ?? null),
    tier: isLastAssistant ? controller.orchestratorTier : (message.orchestratorTier ?? null),
  };
  const hasThinkingData = thinkingData.plan.length > 0 || thinkingData.steps.length > 0 || Boolean(thinkingData.intent);
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
      { turnId: message.id, thinking: thinkingData, evidence: evidenceTabData, approvals: controller.pendingApprovals },
      tab,
    );

  /**
   * Skill tag (handoff §4d, e.g. `SKILL · CLIENT CHANGES`, `DEEP RESEARCH ·
   * COMPLETE`). Derived only from server facts about this turn: a finished
   * research report for this message id, or the router's own intent code via
   * the shared INTENT_LABELS map. A turn the router did not classify gets no
   * tag rather than a guessed one.
   */
  const skillTag = useMemo(() => {
    if (researchReport && !messageIsStreaming) return 'DEEP RESEARCH · COMPLETE';
    if (!isLastAssistant) return null;
    const intent = controller.orchestratorIntent;
    if (!intent) return null;
    const label = INTENT_LABELS[intent];
    if (!label) return null;
    return `SKILL · ${label.toUpperCase()}`;
  }, [controller.orchestratorIntent, isLastAssistant, messageIsStreaming, researchReport]);

  /**
   * Evidence toggle (handoff §10a) — the last control in the trust row. Shared
   * by the grounded and ungrounded strips below, which are mutually exclusive
   * branches of the same row, so this exists once rather than twice.
   *
   * v6: opens the rail's turn-inspector Evidence tab (which folds in what
   * used to be the inline tray plus the separate grounding/coverage warning
   * cards) instead of expanding an inline tray in place — so this is a
   * one-way "open" now, not a local expand/collapse toggle.
   */
  const evidenceToggle = (
    <button
      type="button"
      className="vnext-meri__evidence-toggle"
      onClick={() => openThisTurnInspector('evidence')}
    >
      EVIDENCE
      <MeriIcon name="ChevronRight" size={12} color="#667085" />
    </button>
  );

  return (
    <div className="vnext-meri__assistant-message">
      <div className="vnext-meri__assistant-heading">
        <span className="vnext-meri__assistant-mark">
          <img src={MERI_LOGO_SRC} alt="" width={13} height={13} />
        </span>
        <span className="vnext-meri__assistant-time">{formatRecordTime(message.createdAt)}</span>
        {/* Skill tag — handoff §4d. Only rendered from what the server told us
            about THIS turn: a completed deep-research report, or the router's
            own intent label. Never inferred from the answer text. */}
        {skillTag ? <span className="vnext-meri__skill-tag">{skillTag}</span> : null}
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
          ) : null}
          {/* One cursor, whether or not any prose has arrived yet (handoff §4g). */}
          {messageIsStreaming ? <ComposingCursor /> : null}
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
                    window.dispatchEvent(
                      new CustomEvent('meri-fill-draft', { detail: suggestion }),
                    )
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
        */}

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
            {verificationChip ? (
              <span
                className={`vnext-meri__verification-chip is-${verificationChip.tone}`}
                data-meri-verification-chip
              >
                <MeriIcon name={verificationChip.icon} size={12} />
                {verificationChip.label}
              </span>
            ) : null}
            {!messageIsStreaming && message.content ? evidenceToggle : null}
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
            {evidenceToggle}
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
          <div className="vnext-meri__message-actions" data-meri-message-actions>
            {/* handoff §11a — COPY / REGENERATE / thumbs, then the right-aligned
                audit stamp. The stamp is built only from facts this turn
                actually carries (resolved citations, server verification
                counts); when the server sent neither, it is omitted rather
                than asserting a source count of 0. */}
            <button
              type="button"
              className="vnext-meri__inline-action-btn"
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
              <MeriIcon name="Copy01" size={13} color="#344054" />
              COPY
            </button>
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
                <MeriIcon name="RefreshCcw02" size={13} color="#344054" />
                REGENERATE
              </button>
            ) : null}
            {/*
              v6: opens the turn inspector's Thinking tab — the full plan/
              step list this turn's subtle work-performed feed only shows a
              trace of. Hidden when there's genuinely nothing recorded (e.g.
              a plain answer with no tool use) rather than opening to an
              empty tab.
            */}
            {hasThinkingData ? (
              <button
                type="button"
                className="vnext-meri__inline-action-btn"
                onClick={() => openThisTurnInspector('thinking')}
              >
                <MeriIcon name="CpuChip01" size={13} color="#344054" />
                SHOW WORK
              </button>
            ) : null}
            {auditStamp ? (
              <span className="vnext-meri__audit-stamp">{auditStamp}</span>
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

function ComposingCursor() {
  // handoff §4g — an 8×16px block cursor pulsing beside a mono status label,
  // not a three-dot ellipsis. The label is what tells the user the answer is
  // still being composed rather than finished-and-short.
  return (
    <span className="vnext-meri__composing" aria-label="Meri is composing an answer">
      <span className="vnext-meri__composing-cursor" aria-hidden="true" />
      <span className="vnext-meri__composing-label">COMPOSING ANSWER…</span>
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
