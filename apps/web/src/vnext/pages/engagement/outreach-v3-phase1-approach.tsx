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

import { EmptyState, RecipientPresentation, StatusChip, VersionChip, paragraphs, recipientPresentation, sourceLines, wordCount } from './outreach-v3-phase1-shared.js';

export function SampleCard({
  draft,
  recipient,
  index,
  busy,
  error,
  onEdit,
  onRegenerate,
}: {
  draft: OutreachV3DraftArtifact;
  recipient: RecipientPresentation;
  index: number;
  busy: boolean;
  error: string | null;
  onEdit: () => void;
  onRegenerate: () => void;
}) {
  const current = draft.current;
  const [historyOpen, setHistoryOpen] = useState(false);
  if (!current) return null;
  const label = recipient.label;
  const attention = statusTone(current.auditStatus) === 'amber' || statusTone(current.auditStatus) === 'red';

  return (
    <article className="ov3p1-sample-card">
      <header>
        <span className="ov3p1-avatar">{initials(label)}</span>
        <div>
          <strong>{label}</strong>
          <span>{recipient.subtitle}</span>
        </div>
        <VersionChip version={current.version} />
      </header>

      <section className="ov3p1-why-card">
        <span>Why I picked this one</span>
        <p>
          {index === 0
            ? 'This recipient tests whether the approved facts and the individual tailoring read naturally together.'
            : 'This recipient tests whether the same approach remains clear when fewer person-specific facts are available.'}
        </p>
      </section>

      <section className="ov3p1-message-copy">
        <span>Subject</span>
        <h4>{current.subject}</h4>
        <div>
          {paragraphs(current.body).map((paragraph, paragraphIndex) => (
            <p key={`${paragraphIndex}-${paragraph.slice(0, 20)}`}>{paragraph}</p>
          ))}
        </div>
        <small>{wordCount(current.body)} words</small>
      </section>

      <section className="ov3p1-source-list">
        <span>What it drew on</span>
        {sourceLines(draft).map((source) => (
          <div key={`${source.label}-${source.scope}`}>
            <p>{source.label}</p>
            <StatusChip tone={source.scope === 'Needs judgment' ? 'amber' : 'neutral'}>
              {source.scope}
            </StatusChip>
          </div>
        ))}
      </section>

      <div className="ov3p1-assurance" data-tone={attention ? 'amber' : 'navy'}>
        {attention ? <AlertTriangle size={16} /> : <ShieldCheck size={16} />}
        <div>
          <strong>{attention ? 'One thing needs your judgment' : 'No blocking assurance finding'}</strong>
          <p>
            {attention
              ? 'Read the highlighted source and refine this sample before approving the approach.'
              : 'The current version uses the governed campaign context and remains unsendable until you approve it.'}
          </p>
        </div>
      </div>

      {error ? <p className="ov3p1-error" role="alert">{error}</p> : null}

      <footer>
        <button type="button" className="ov3p1-button is-secondary" onClick={onEdit}>
          <Pencil size={14} /> Edit manually
        </button>
        <button
          type="button"
          className="ov3p1-button is-quiet"
          disabled={busy}
          onClick={onRegenerate}
        >
          {busy ? <Loader2 className="ov3p1-spin" size={14} /> : <RefreshCcw size={14} />}
          Regenerate
        </button>
        <button
          type="button"
          className="ov3p1-button is-quiet"
          onClick={() => setHistoryOpen((value) => !value)}
        >
          <FileClock size={14} /> View history
          <ChevronDown size={13} />
        </button>
      </footer>

      {historyOpen ? (
        <div className="ov3p1-history">
          {draft.history.map((item) => (
            <span key={item.id}>
              V{item.version} · {item.auditStatus.replaceAll('_', ' ')} ·{' '}
              {item.approvalStatus.replaceAll('_', ' ')}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function RefinePanel({
  open,
  proposed,
  instruction,
  busy,
  onOpen,
  onInstruction,
  onPreview,
  onApply,
  onCancel,
}: {
  open: boolean;
  proposed: boolean;
  instruction: string;
  busy: boolean;
  onOpen: () => void;
  onInstruction: (value: string) => void;
  onPreview: () => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  if (!open) {
    return (
      <button type="button" className="ov3p1-button is-secondary" onClick={onOpen}>
        <Sparkles size={15} /> Refine both with Meri
      </button>
    );
  }

  return (
    <section className="ov3p1-refine-panel">
      <header>
        <div>
          <span>Refine the approach</span>
          <h3>Tell Meri what should change in both samples</h3>
        </div>
        <button type="button" className="ov3p1-icon-button" onClick={onCancel} aria-label="Close refinement">
          <X size={16} />
        </button>
      </header>
      <textarea
        rows={3}
        value={instruction}
        onChange={(event) => onInstruction(event.target.value)}
        placeholder="Example: Make both shorter and put the ask in the first paragraph."
      />
      <div className="ov3p1-quick-chips">
        {[
          'Shorter and more direct',
          'Move the ask up',
          'Use a warmer opening',
          'Reduce person-specific detail',
        ].map((value) => (
          <button type="button" key={value} onClick={() => onInstruction(value)}>
            {value}
          </button>
        ))}
      </div>
      {!proposed ? (
        <button
          type="button"
          className="ov3p1-button is-primary"
          disabled={!instruction.trim()}
          onClick={onPreview}
        >
          Show me what that changes
        </button>
      ) : (
        <section className="ov3p1-proposed-effect">
          <span>Proposed effect</span>
          <dl>
            <div>
              <dt>Length</dt>
              <dd>Both samples become more concise.</dd>
            </div>
            <div>
              <dt>Ask</dt>
              <dd>The meeting request moves earlier where the instruction calls for it.</dd>
            </div>
            <div>
              <dt>Approval</dt>
              <dd>New immutable versions are created; approach approval remains unset.</dd>
            </div>
          </dl>
          <div>
            <button
              type="button"
              className="ov3p1-button is-primary"
              disabled={busy}
              onClick={onApply}
            >
              {busy ? <Loader2 className="ov3p1-spin" size={15} /> : <Sparkles size={15} />}
              Rewrite both samples
            </button>
            <button type="button" className="ov3p1-button is-secondary" onClick={onCancel}>
              Leave them as they are
            </button>
          </div>
        </section>
      )}
    </section>
  );
}

export function ApproachScreen({
  plan,
  drafts,
  generationBusy,
  approvalBusy,
  refinementBusy,
  error,
  onGenerateSamples,
  onApprove,
  onEdit,
  onRegenerate,
  onRefineAll,
}: {
  plan: OutreachV3GenerationPlan | null;
  drafts: OutreachV3DraftArtifact[];
  generationBusy: boolean;
  approvalBusy: boolean;
  refinementBusy: boolean;
  error: string | null;
  onGenerateSamples: () => void;
  onApprove: () => void;
  onEdit: (draft: OutreachV3DraftArtifact) => void;
  onRegenerate: (draft: OutreachV3DraftArtifact) => void;
  onRefineAll: (instruction: string) => void;
}) {
  const sampleKeys = new Set(plan?.representativeSampleKeys ?? []);
  const samples = drafts.filter((draft) => sampleKeys.has(draft.generationKey));
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineProposed, setRefineProposed] = useState(false);
  const [instruction, setInstruction] = useState('');

  if (!plan?.eligible) {
    return (
      <EmptyState
        icon={<AlertTriangle size={24} />}
        title="Finish the campaign plan first"
        body={plan?.blockers?.join(' · ') || 'Goal, audience, delivery, context and voice need to be ready before samples can be written.'}
      />
    );
  }

  if (!samples.length) {
    return (
      <div className="ov3p1-content ov3p1-content--narrow">
        <EmptyState
          icon={<Sparkles size={24} />}
          title="Write two samples first"
          body="Meri will choose a bounded representative set. Nothing else is written, approved or sent until you read them."
          action={
            <button
              type="button"
              className="ov3p1-button is-primary"
              disabled={generationBusy}
              onClick={onGenerateSamples}
            >
              {generationBusy ? <Loader2 className="ov3p1-spin" size={16} /> : <Sparkles size={16} />}
              Write two samples
            </button>
          }
        />
        {error ? <p className="ov3p1-error" role="alert">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="ov3p1-content ov3p1-content--narrow">
      <span className="ov3p1-step-badge">Step 1 of 2 · the approach</span>
      <h2>Read two before I write the other {Math.max(0, (plan.slots.length || drafts.length) - samples.length)}</h2>
      <p className="ov3p1-lead">
        The other drafts are written to whatever you approve here. Nothing else is written until you approve this approach.
      </p>

      <div className="ov3p1-sample-stack">
        {samples.map((draft, index) => (
          <SampleCard
            key={draft.id}
            draft={draft}
            recipient={recipientPresentation(draft, plan)}
            index={index}
            busy={generationBusy}
            error={null}
            onEdit={() => onEdit(draft)}
            onRegenerate={() => onRegenerate(draft)}
          />
        ))}
      </div>

      <RefinePanel
        open={refineOpen}
        proposed={refineProposed}
        instruction={instruction}
        busy={refinementBusy}
        onOpen={() => setRefineOpen(true)}
        onInstruction={setInstruction}
        onPreview={() => setRefineProposed(true)}
        onApply={() => onRefineAll(instruction)}
        onCancel={() => {
          setRefineOpen(false);
          setRefineProposed(false);
          setInstruction('');
        }}
      />

      {error ? <p className="ov3p1-error" role="alert">{error}</p> : null}

      <div className="ov3p1-primary-row">
        <button
          type="button"
          className="ov3p1-button is-primary"
          disabled={approvalBusy || samples.some((draft) => !draft.current)}
          onClick={onApprove}
        >
          {approvalBusy ? <Loader2 className="ov3p1-spin" size={16} /> : <Check size={16} />}
          Approve this approach
        </button>
        <span>Approval is pinned to these exact sample versions.</span>
      </div>
    </div>
  );
}
