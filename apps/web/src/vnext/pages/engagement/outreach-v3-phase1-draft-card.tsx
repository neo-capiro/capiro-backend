import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Eye,
  FileClock,
  Loader2,
  Mail,
  MoreHorizontal,
  Paperclip,
  PauseCircle,
  Pencil,
  Play,
  RefreshCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  StopCircle,
  Upload,
  X,
} from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import { OutreachConversation } from '../../../pages/engagement/outreach/v3/OutreachConversation.js';
import type { OutreachV3Proposal } from '../../../pages/engagement/outreach/v3/contracts.js';
import { useOutreachV3Session } from '../../../pages/engagement/outreach/v3/useOutreachV3Session.js';
import { safeOutreachV3Error } from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import {
  approveOutreachV3Approach,
  approveOutreachV3Draft,
  cancelOutreachV3GenerationJob,
  cancelOutreachV3SendIntent,
  createOutreachV3SendIntent,
  createOutreachV3TestSend,
  generateOutreachV3Samples,
  getOutreachV3ApproachApproval,
  getOutreachV3GenerationJob,
  getOutreachV3GenerationPlan,
  getOutreachV3SendIntent,
  getOutreachV3SendSettings,
  listOutreachAttachments,
  listOutreachReplyCandidates,
  listOutreachV3Drafts,
  proposeOutreachReplyLearning,
  refineOutreachV3Draft,
  refreshOutreachV3SendIntent,
  retryOutreachV3GenerationItem,
  reviseOutreachV3Draft,
  runOutreachV3Preflight,
  saveOutreachV3SendSettings,
  startOutreachV3FullGeneration,
  uploadOutreachAttachment,
  type OutreachAttachment,
  type OutreachReplyCandidate,
  type OutreachV3DraftArtifact,
  type OutreachV3DraftVersion,
  type OutreachV3GenerationJob,
  type OutreachV3GenerationPlan,
  type OutreachV3NamedPreflightCheck,
  type OutreachV3PreflightInput,
  type OutreachV3SendIntentView,
  type OutreachV3SendSettings,
  type OutreachV3ServerPreflight,
} from './engagement-api.js';
import {
  describeOutreachProposal,
  outreachStepForStage,
  type VNextOutreachOperatorWorkspaceProps,
} from './VNextOutreachOperatorWorkspace.js';
import {
  approvalCount,
  deriveOutreachPhase1View,
  generationProgress,
  initials,
  isGenerationTerminal,
  isSendTerminal,
  partitionDrafts,
  recipientLabel,
  sendProgress,
  statusLabel,
  statusTone,
  type OutreachPhase1View,
} from './outreach-v3-phase1-model.js';

import { DraftDiff, ProgressBar, RecipientPresentation, StatusChip, VersionChip, VersionDiffPanel, draftReason, formatDateTime, paragraphs } from './outreach-v3-phase1-shared.js';

export function GenerationScreen({
  plan,
  drafts,
  job,
  busy,
  error,
  onStart,
  onRetry,
  onCancel,
}: {
  plan: OutreachV3GenerationPlan | null;
  drafts: OutreachV3DraftArtifact[];
  job: OutreachV3GenerationJob | null;
  busy: boolean;
  error: string | null;
  onStart: () => void;
  onRetry: (itemId: string) => void;
  onCancel: () => void;
}) {
  const progress = generationProgress({ plan, drafts, job });
  const sampleKeys = new Set(plan?.representativeSampleKeys ?? []);
  const remainingSlots = (plan?.slots ?? []).filter((slot) => !sampleKeys.has(slot.generationKey));
  const byKey = new Map(drafts.map((draft) => [draft.generationKey, draft]));
  const jobItems = new Map((job?.items ?? []).map((item) => [item.generationKey, item]));
  const failedItems = (job?.items ?? []).filter((item) => item.status === 'failed');
  const active = Boolean(job && !isGenerationTerminal(job.status));

  return (
    <div className="ov3p1-content ov3p1-content--narrow">
      <h2>Writing the remaining {Math.max(0, (plan?.slots.length ?? drafts.length) - (plan?.representativeSampleKeys.length ?? 0))}</h2>
      <p className="ov3p1-lead">
        {progress.complete} of {progress.total || remainingSlots.length} written, in the approach you approved. Nothing sends when this finishes — you read them next.
      </p>
      <ProgressBar percent={progress.percent} />

      <section className="ov3p1-generation-list">
        {remainingSlots.map((slot) => {
          const draft = byKey.get(slot.generationKey);
          const item = jobItems.get(slot.generationKey);
          const state = draft
            ? draft.current?.auditStatus === 'held'
              ? 'Needs review'
              : 'Written'
            : item?.status === 'failed'
              ? 'Needs review'
              : item?.status === 'running'
                ? 'Writing'
                : 'Waiting';
          return (
            <div key={slot.generationKey}>
              <span>{slot.recipients[0]?.displayName || slot.recipients[0]?.email || slot.generationKey}</span>
              <small>{slot.recipients[0]?.organization || slot.recipients[0]?.chamber || 'Campaign recipient'}</small>
              <StatusChip tone={statusTone(state)}>{state}</StatusChip>
              {item?.status === 'failed' ? (
                <button type="button" className="ov3p1-button is-small" onClick={() => onRetry(item.id)}>
                  Retry
                </button>
              ) : null}
            </div>
          );
        })}
      </section>

      {!job || (isGenerationTerminal(job.status) && drafts.length < (plan?.slots.length ?? 0)) ? (
        <button type="button" className="ov3p1-button is-primary" disabled={busy} onClick={onStart}>
          {busy ? <Loader2 className="ov3p1-spin" size={15} /> : <Play size={15} />}
          Continue writing
        </button>
      ) : null}
      {active ? (
        <button type="button" className="ov3p1-button is-quiet" onClick={onCancel}>
          <StopCircle size={15} /> Stop generation
        </button>
      ) : null}
      {failedItems.length ? (
        <p className="ov3p1-note">{failedItems.length} recipient{failedItems.length === 1 ? '' : 's'} can be retried without rewriting completed drafts.</p>
      ) : null}
      {error ? <p className="ov3p1-error" role="alert">{error}</p> : null}
      <p className="ov3p1-muted">You can leave this page. Capiro keeps writing, and nothing sends on its own.</p>
    </div>
  );
}

export function DraftCard({
  draft,
  recipient,
  selected,
  open,
  busy,
  restoreBusy,
  diff,
  onSelect,
  onToggle,
  onApprove,
  onViewVersion,
  onRestoreVersion,
}: {
  draft: OutreachV3DraftArtifact;
  recipient: RecipientPresentation;
  selected: boolean;
  open: boolean;
  busy: boolean;
  restoreBusy: boolean;
  diff?: DraftDiff;
  onSelect: () => void;
  onToggle: () => void;
  onApprove: () => void;
  onViewVersion: (versionId: string) => Promise<OutreachV3DraftVersion | null>;
  onRestoreVersion: (version: OutreachV3DraftVersion) => void;
}) {
  const current = draft.current;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewingVersionId, setViewingVersionId] = useState<string | null>(null);
  const [viewedVersion, setViewedVersion] = useState<OutreachV3DraftVersion | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  if (!current) return null;
  const label = recipient.label;

  const viewVersion = async (versionId: string) => {
    if (viewingVersionId === versionId) {
      // Toggle closed on a second click of the same row.
      setViewingVersionId(null);
      setViewedVersion(null);
      return;
    }
    setViewingVersionId(versionId);
    setViewedVersion(null);
    setViewError(null);
    const version = await onViewVersion(versionId).catch(() => null);
    if (!version) {
      setViewError('This version could not be loaded.');
      return;
    }
    setViewedVersion(version);
  };

  return (
    <article className="ov3p1-draft-card" data-open={open || undefined}>
      <header>
        <button
          type="button"
          className="ov3p1-checkbox"
          data-checked={selected || undefined}
          aria-pressed={selected}
          aria-label={`Select ${label}`}
          onClick={onSelect}
        >
          {selected ? <Check size={13} /> : <Square size={13} />}
        </button>
        <span className="ov3p1-avatar">{initials(label)}</span>
        <button type="button" className="ov3p1-draft-card__identity" onClick={onToggle}>
          <strong>{label}</strong>
          <span>{recipient.subtitle}</span>
        </button>
        <StatusChip tone={statusTone(statusLabel(draft))}>{statusLabel(draft)}</StatusChip>
        <VersionChip version={current.version} />
        <button type="button" className="ov3p1-icon-button" onClick={onToggle} aria-label={open ? 'Collapse draft' : 'Open draft'}>
          <ChevronDown size={16} />
        </button>
      </header>

      {open ? (
        <div className="ov3p1-draft-card__body">
          <p className="ov3p1-needs-line">{draftReason(draft)}</p>
          <section className="ov3p1-message-copy is-draft">
            <span>Subject</span>
            <h4>{current.subject}</h4>
            <div>
              {paragraphs(current.body).map((paragraph, index) => (
                <p key={`${index}-${paragraph.slice(0, 20)}`}>{paragraph}</p>
              ))}
            </div>
          </section>

          <dl className="ov3p1-meta-grid">
            <div>
              <dt>Recipient</dt>
              <dd>{label}</dd>
            </div>
            <div>
              <dt>This version</dt>
              <dd>V{current.version} · {formatDateTime(current.createdAt)}</dd>
            </div>
            <div>
              <dt>Drew on</dt>
              <dd>{current.contextNote || 'Governed campaign context'}</dd>
            </div>
            <div>
              <dt>Traceable to</dt>
              <dd>{current.contentHash.slice(0, 12)}…</dd>
            </div>
            <div>
              <dt>Checks</dt>
              <dd>{current.auditChecks.length || 'No blocking'} assurance finding{current.auditChecks.length === 1 ? '' : 's'}</dd>
            </div>
            <div>
              <dt>Approved version</dt>
              <dd>{current.approvalStatus === 'approved' ? `V${current.version}` : 'None'}</dd>
            </div>
          </dl>

          {diff ? <VersionDiffPanel diff={diff} /> : null}

          <footer>
            <button
              type="button"
              className="ov3p1-button is-primary"
              disabled={busy || current.approvalStatus === 'approved'}
              onClick={onApprove}
            >
              {current.approvalStatus === 'approved' ? <Check size={15} /> : <ShieldCheck size={15} />}
              {current.approvalStatus === 'approved' ? 'Exact version approved' : 'This is good — approve'}
            </button>
            <button type="button" className="ov3p1-button is-quiet" onClick={() => setHistoryOpen((value) => !value)}>
              <FileClock size={14} /> History{draft.history.length > 1 ? ` (${draft.history.length})` : ''}
            </button>
          </footer>

          {historyOpen ? (
            <div className="ov3p1-history">
              {draft.history.length <= 1 ? (
                <p className="ov3p1-muted">This is the only version.</p>
              ) : null}
              {draft.history
                .slice()
                .sort((a, b) => b.version - a.version)
                .map((item) => {
                  const isCurrent = item.id === current.id;
                  const isViewing = viewingVersionId === item.id;
                  return (
                    <div key={item.id} className="ov3p1-history-row" data-current={isCurrent || undefined}>
                      <button
                        type="button"
                        className="ov3p1-history-row__toggle"
                        onClick={() => void viewVersion(item.id)}
                        aria-expanded={isViewing}
                      >
                        <ChevronRight
                          size={13}
                          className={isViewing ? 'ov3p1-history-row__chevron is-open' : 'ov3p1-history-row__chevron'}
                        />
                        <span>
                          V{item.version} · {item.auditStatus.replaceAll('_', ' ')} · {item.approvalStatus.replaceAll('_', ' ')}
                          {isCurrent ? ' · current' : ''}
                        </span>
                      </button>
                      {isViewing ? (
                        <div className="ov3p1-history-row__body">
                          {!viewedVersion && !viewError ? (
                            <span className="ov3p1-history-row__loading">
                              <Loader2 className="ov3p1-spin" size={13} /> Loading…
                            </span>
                          ) : viewError ? (
                            <p className="ov3p1-error" role="alert">{viewError}</p>
                          ) : viewedVersion ? (
                            <>
                              <strong>{viewedVersion.subject}</strong>
                              <div>
                                {paragraphs(viewedVersion.body).map((paragraph, index) => (
                                  <p key={`${index}-${paragraph.slice(0, 20)}`}>{paragraph}</p>
                                ))}
                              </div>
                              {!isCurrent ? (
                                <button
                                  type="button"
                                  className="ov3p1-button is-secondary"
                                  disabled={restoreBusy}
                                  onClick={() => onRestoreVersion(viewedVersion)}
                                >
                                  {restoreBusy ? <Loader2 className="ov3p1-spin" size={14} /> : <FileClock size={14} />}
                                  Make this the current version
                                </button>
                              ) : (
                                <p className="ov3p1-muted">This is the current version.</p>
                              )}
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
