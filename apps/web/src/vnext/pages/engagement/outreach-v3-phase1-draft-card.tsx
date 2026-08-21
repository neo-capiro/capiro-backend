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
              <span>{slot.recipients[0]?.label || slot.recipients[0]?.email || slot.generationKey}</span>
              <small>{slot.recipients[0]?.targetType || 'Campaign recipient'}</small>
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
  refineBusy,
  diff,
  onSelect,
  onToggle,
  onApprove,
  onEdit,
  onRefine,
}: {
  draft: OutreachV3DraftArtifact;
  recipient: RecipientPresentation;
  selected: boolean;
  open: boolean;
  busy: boolean;
  refineBusy: boolean;
  diff?: DraftDiff;
  onSelect: () => void;
  onToggle: () => void;
  onApprove: () => void;
  onEdit: () => void;
  onRefine: (instruction: string) => void;
}) {
  const current = draft.current;
  const [askOpen, setAskOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  if (!current) return null;
  const label = recipient.label;

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

          {askOpen ? (
            <section className="ov3p1-ask-box">
              <span>Ask Meri about this exact draft</span>
              <textarea
                rows={3}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="Example: Remove the disputed number and keep the ask in the first paragraph."
              />
              <div>
                <button
                  type="button"
                  className="ov3p1-button is-primary"
                  disabled={refineBusy || !instruction.trim()}
                  onClick={() => onRefine(instruction.trim())}
                >
                  {refineBusy ? <Loader2 className="ov3p1-spin" size={14} /> : <Sparkles size={14} />}
                  Create a new version
                </button>
                <button type="button" className="ov3p1-button is-secondary" onClick={() => setAskOpen(false)}>
                  Cancel
                </button>
              </div>
            </section>
          ) : null}

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
            <button type="button" className="ov3p1-button is-secondary" onClick={() => setAskOpen(true)}>
              <Sparkles size={14} /> Ask for a change
            </button>
            <button type="button" className="ov3p1-button is-secondary" onClick={onEdit}>
              <Pencil size={14} /> Edit it myself
            </button>
            <button type="button" className="ov3p1-button is-quiet" onClick={() => setHistoryOpen((value) => !value)}>
              <FileClock size={14} /> History
            </button>
          </footer>

          {historyOpen ? (
            <div className="ov3p1-history">
              {draft.history.map((item) => (
                <span key={item.id}>
                  V{item.version} · {item.auditStatus.replaceAll('_', ' ')} · {item.approvalStatus.replaceAll('_', ' ')}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
