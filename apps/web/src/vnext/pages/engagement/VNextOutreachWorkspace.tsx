import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FileClock,
  Loader2,
  Paperclip,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { CurrentDecisionSurface } from '../../../pages/engagement/outreach/v3/CurrentDecisionSurface.js';
import type {
  OutreachV3Stage,
  OutreachV3TranscriptTurn,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import { useOutreachV3Session } from '../../../pages/engagement/outreach/v3/useOutreachV3Session.js';
import { useApi } from '../../../lib/use-api.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
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
  listOutreachV3Drafts,
  listOutreachReplyCandidates,
  proposeOutreachReplyLearning,
  refreshOutreachV3SendIntent,
  retryOutreachV3GenerationItem,
  reviseOutreachV3Draft,
  runOutreachV3Preflight,
  saveOutreachV3SendSettings,
  startOutreachV3FullGeneration,
  uploadOutreachAttachment,
  type OutreachAttachment,
  type OutreachV3DraftArtifact,
  type OutreachV3DraftVersion,
  type OutreachV3GenerationPlan,
  type OutreachV3NamedPreflightCheck,
  type OutreachV3PreflightInput,
  type OutreachV3SendIntentView,
  type OutreachV3ServerPreflight,
} from './engagement-api.js';
import '../../../pages/engagement/outreach/v3/outreach-v3.css';
import '../../../pages/engagement/outreach/v3/planning-surfaces.css';

export type EngagementOutreachStep =
  | 'goal'
  | 'targets'
  | 'delivery'
  | 'context'
  | 'drafts'
  | 'send';

interface IntegrationConnection {
  id: string;
  provider: string;
  status: string;
  accountEmail?: string | null;
  displayName?: string | null;
}

interface Props {
  clients: Client[];
  selectedClientId: string | null;
  integrations: IntegrationConnection[];
  step: EngagementOutreachStep;
  onStepChange: (step: EngagementOutreachStep) => void;
}

const USER_STEPS: Array<{ key: EngagementOutreachStep; label: string; number: string }> = [
  { key: 'goal', label: 'Goal', number: '01' },
  { key: 'targets', label: 'Targets', number: '02' },
  { key: 'delivery', label: 'Delivery', number: '03' },
  { key: 'context', label: 'Context', number: '04' },
  { key: 'drafts', label: 'Drafts', number: '05' },
  { key: 'send', label: 'Send', number: '06' },
];

const PLANNING_STAGE_INDEX: Record<OutreachV3Stage, number> = {
  goal: 0,
  sponsor: 0,
  targets: 1,
  delivery: 2,
  context: 3,
  strategy: 4,
  ready_for_generation: 4,
};

function stepIndex(step: EngagementOutreachStep): number {
  return USER_STEPS.findIndex((candidate) => candidate.key === step);
}

function stageForStep(step: EngagementOutreachStep, current: OutreachV3Stage): OutreachV3Stage {
  if (step === 'goal') return current === 'sponsor' ? 'sponsor' : 'goal';
  if (step === 'targets') return 'targets';
  if (step === 'delivery') return 'delivery';
  if (step === 'context') return 'context';
  return current === 'ready_for_generation' ? 'ready_for_generation' : 'strategy';
}

function safeError(error: unknown, fallback: string): string {
  const response = (error as { response?: { data?: { message?: unknown } } })?.response?.data
    ?.message;
  if (typeof response === 'string') return response;
  if (Array.isArray(response) && typeof response[0] === 'string') return response[0];
  return error instanceof Error ? error.message : fallback;
}

function statusTone(status: string): 'navy' | 'warning' | 'neutral' | 'error' {
  const normalized = status.toLowerCase();
  if (normalized.includes('fail') || normalized.includes('block') || normalized.includes('reject'))
    return 'error';
  if (
    normalized.includes('held') ||
    normalized.includes('stale') ||
    normalized.includes('review') ||
    normalized.includes('pending')
  )
    return 'warning';
  if (
    normalized.includes('approve') ||
    normalized.includes('pass') ||
    normalized.includes('sent') ||
    normalized.includes('complete')
  )
    return 'navy';
  return 'neutral';
}

function SectionStatus({ value }: { value: 'Waiting' | 'In progress' | 'Locked' }) {
  return (
    <span
      className="uui-outreach-section-status"
      data-state={value.toLowerCase().replace(' ', '-')}
    >
      <i />
      {value}
    </span>
  );
}

function transcriptLabel(turn: OutreachV3TranscriptTurn): string {
  return turn.role === 'assistant' ? 'Meri' : turn.role === 'user' ? 'You' : 'System';
}

function campaignBrief(
  session: ReturnType<typeof useOutreachV3Session>['session'],
  drafts: OutreachV3DraftArtifact[],
): string {
  if (!session) return 'New governed outreach campaign';
  const selected = session.spec.targeting.selectedTargetRefs.length;
  const topic = session.spec.goal.topic || session.spec.goal.goal || 'Goal not set';
  const pattern =
    session.spec.delivery.pattern === 'undecided'
      ? 'Delivery undecided'
      : session.spec.delivery.pattern.replaceAll('_', ' ');
  if (drafts.length) {
    const approved = drafts.filter(
      (artifact) => artifact.current?.approvalStatus === 'approved',
    ).length;
    return `${drafts.length} immutable draft${drafts.length === 1 ? '' : 's'} · ${approved} approved · ${pattern}`;
  }
  return `${topic} · ${selected ? `${selected} selected` : 'audience open'} · ${pattern}`;
}

function summaryForStep(
  step: EngagementOutreachStep,
  session: NonNullable<ReturnType<typeof useOutreachV3Session>['session']>,
  drafts: OutreachV3DraftArtifact[],
  preflight: OutreachV3ServerPreflight | null,
): string {
  const spec = session.spec;
  if (step === 'goal') {
    return (
      [
        spec.goal.topic || spec.goal.goal,
        spec.goal.ask.text,
        spec.sponsor.label || spec.sponsor.kind,
      ]
        .filter(Boolean)
        .join(' · ') || 'Goal and sponsor'
    );
  }
  if (step === 'targets')
    return `${spec.targeting.selectedTargetRefs.length} selected target${spec.targeting.selectedTargetRefs.length === 1 ? '' : 's'}`;
  if (step === 'delivery')
    return `${spec.delivery.pattern.replaceAll('_', ' ')} · ${spec.delivery.personalization.replaceAll('_', ' ')}`;
  if (step === 'context') {
    const used =
      spec.context.requiredPolicyRefs.length +
      spec.context.writingGuidanceRefs.length +
      spec.context.campaignFactRefs.length +
      spec.context.targetSpecificRefs.length +
      spec.context.groupSafeRefs.length;
    return `${used} governed sources · ${spec.context.excludedRefs.length} excluded`;
  }
  if (step === 'drafts') {
    const approved = drafts.filter(
      (artifact) => artifact.current?.approvalStatus === 'approved',
    ).length;
    const held = drafts.filter((artifact) =>
      ['held', 'unavailable'].includes(artifact.current?.auditStatus ?? ''),
    ).length;
    return drafts.length
      ? `${drafts.length} immutable versions · ${approved} approved${held ? ` · ${held} held` : ''}`
      : 'Strategy, representative samples and immutable drafts';
  }
  return preflight
    ? `${preflight.draftVersionIds.length} eligible · ${preflight.excludedGenerationKeys.length} held out`
    : 'Server preflight, test send and durable send intent';
}

function DraftEditModal({
  draft,
  onClose,
  onSave,
  pending,
}: {
  draft: OutreachV3DraftArtifact;
  onClose: () => void;
  onSave: (subject: string, body: string) => void;
  pending: boolean;
}) {
  const initialSubject = draft.current?.subject ?? '';
  const initialBody = draft.current?.body ?? '';
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  return (
    <EngagementDialog
      open
      eyebrow="Immutable version · revise"
      title={`Create Version ${(draft.current?.version ?? 0) + 1}`}
      description="Saving appends a new version and clears exact-version approval. Earlier versions remain in history."
      width={760}
      busy={pending}
      dirty={subject !== initialSubject || body !== initialBody}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="uui-button" disabled={pending} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="uui-button uui-button--primary"
            disabled={pending || !subject.trim() || !body.trim()}
            onClick={() => onSave(subject.trim(), body.trim())}
          >
            {pending ? 'Saving…' : `Save V${(draft.current?.version ?? 0) + 1}`}
          </button>
        </>
      }
    >
      <div className="engagement-dialog__field-grid">
        <label className="engagement-dialog__field is-full">
          Subject
          <input autoFocus value={subject} onChange={(event) => setSubject(event.target.value)} />
        </label>
        <label className="engagement-dialog__field is-full">
          Body
          <textarea rows={18} value={body} onChange={(event) => setBody(event.target.value)} />
        </label>
      </div>
    </EngagementDialog>
  );
}

function DraftPanel({
  plan,
  drafts,
  approvalCurrent,
  generationBusy,
  job,
  onGenerateSamples,
  onApproveApproach,
  onGenerateRemaining,
  onCancelGeneration,
  onRetryItem,
  onEdit,
  onApproveDraft,
  approvalBusy,
}: {
  plan: OutreachV3GenerationPlan | null;
  drafts: OutreachV3DraftArtifact[];
  approvalCurrent: boolean;
  generationBusy: boolean;
  job: {
    status: string;
    totals: Record<string, number> | null;
    items?: Array<{ id: string; status: string; error?: { message?: string } | null }>;
  } | null;
  onGenerateSamples: () => void;
  onApproveApproach: () => void;
  onGenerateRemaining: () => void;
  onCancelGeneration: () => void;
  onRetryItem: (itemId: string) => void;
  onEdit: (draft: OutreachV3DraftArtifact) => void;
  onApproveDraft: (draft: OutreachV3DraftArtifact) => void;
  approvalBusy: boolean;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const samples = plan
    ? drafts.filter((artifact) => plan.representativeSampleKeys.includes(artifact.generationKey))
    : [];
  const selected =
    drafts.find((artifact) => artifact.generationKey === selectedKey) ?? drafts[0] ?? null;
  const totals = job?.totals ?? null;
  const total = Number(totals?.total ?? totals?.queued ?? 0);
  const succeeded = Number(totals?.succeeded ?? 0);
  const failed = Number(totals?.failed ?? 0);
  const held = Number(totals?.held ?? 0);
  const finished = succeeded + failed + held + Number(totals?.skipped ?? 0);

  return (
    <div className="uui-outreach-drafts">
      {!plan?.eligible ? (
        <div className="uui-recovery-panel is-warning">
          <AlertTriangle size={18} />
          <div>
            <strong>Finish planning before generation</strong>
            <p>
              {plan?.blockers?.join(' · ') ||
                'Goal, targets, delivery, context and strategy must be ready.'}
            </p>
          </div>
        </div>
      ) : !samples.length ? (
        <div className="uui-generation-start">
          <Sparkles size={22} />
          <div>
            <span className="uui-eyebrow">Representative samples · maximum 3</span>
            <h3>Review the approach before full generation</h3>
            <p>
              Capiro will generate a bounded sample set from the current plan. Nothing is approved
              or sendable automatically.
            </p>
          </div>
          <button
            type="button"
            className="uui-button uui-button--primary"
            disabled={generationBusy}
            onClick={onGenerateSamples}
          >
            {generationBusy ? <Loader2 className="uui-spin" size={16} /> : <Sparkles size={16} />}{' '}
            Generate samples
          </button>
        </div>
      ) : !approvalCurrent ? (
        <div className="uui-approach-grid">
          <article className="uui-strategy-card">
            <span className="uui-eyebrow">Strategy</span>
            <h3>Lead with what changed, then the recipient's most relevant open question.</h3>
            <p>
              The current delivery policy and governed context determine which facts may reach each
              sample.
            </p>
            <dl>
              <div>
                <dt>Personalization</dt>
                <dd>
                  {plan.deliveryPattern === 'personalized_separate'
                    ? 'High where grounded'
                    : 'Group-safe'}
                </dd>
              </div>
              <div>
                <dt>Delivery</dt>
                <dd>{plan.deliveryPattern.replaceAll('_', ' ')}</dd>
              </div>
              <div>
                <dt>Evidence</dt>
                <dd>Current governed context only</dd>
              </div>
              <div>
                <dt>Shared safety</dt>
                <dd>No target facts cross recipients</dd>
              </div>
            </dl>
          </article>
          <section className="uui-sample-list">
            <header>
              <div>
                <span className="uui-eyebrow">Representative samples · {samples.length}</span>
                <h3>Review exact sample versions</h3>
              </div>
              <span className="uui-state-pill" data-tone="warning">
                Not approved
              </span>
            </header>
            {samples.map((artifact) => (
              <article key={artifact.id}>
                <div>
                  <strong>{artifact.current?.recipientKey || artifact.generationKey}</strong>
                  <span
                    className="uui-state-pill"
                    data-tone={statusTone(artifact.current?.auditStatus ?? 'pending')}
                  >
                    {artifact.current?.auditStatus ?? 'Pending'}
                  </span>
                </div>
                <p>
                  {artifact.current?.body.slice(0, 220)}
                  {(artifact.current?.body.length ?? 0) > 220 ? '…' : ''}
                </p>
                <button type="button" className="uui-button" onClick={() => onEdit(artifact)}>
                  Edit sample
                </button>
              </article>
            ))}
          </section>
          <div className="uui-approach-actions">
            <p>
              Approach approval is pinned to these exact sample version IDs. Editing any sample
              clears it.
            </p>
            <button
              type="button"
              className="uui-button uui-button--primary"
              disabled={approvalBusy || samples.some((sample) => !sample.current)}
              onClick={onApproveApproach}
            >
              {approvalBusy ? 'Approving…' : 'Approve approach'}
            </button>
          </div>
        </div>
      ) : (
        <>
          {job && !['complete', 'failed', 'canceled'].includes(job.status) ? (
            <div className="uui-generation-progress">
              <div>
                <span className="uui-eyebrow">Generation recovery</span>
                <strong>
                  {finished} of {total || plan.slots.length} complete
                </strong>
                <p>
                  Finished drafts persist as immutable versions. Retry resumes unfinished keys only.
                </p>
              </div>
              <div className="uui-progress-track">
                <i style={{ width: `${Math.min(100, total ? (finished / total) * 100 : 0)}%` }} />
              </div>
              <div className="uui-generation-progress__actions">
                <button type="button" className="uui-button" onClick={onGenerateRemaining}>
                  Continue
                </button>
                <button type="button" className="uui-button" onClick={onCancelGeneration}>
                  Cancel
                </button>
              </div>
            </div>
          ) : drafts.length < (plan?.slots.length ?? 0) ? (
            <div className="uui-generation-start is-compact">
              <Sparkles size={20} />
              <div>
                <span className="uui-eyebrow">Approach approved</span>
                <h3>
                  {drafts.length} of {plan?.slots.length ?? 0} immutable drafts exist
                </h3>
                <p>
                  Generate only the unfinished plan slots. Existing versions are not regenerated.
                </p>
              </div>
              <button
                type="button"
                className="uui-button uui-button--primary"
                disabled={generationBusy}
                onClick={onGenerateRemaining}
              >
                {generationBusy ? 'Starting…' : 'Generate remaining drafts'}
              </button>
            </div>
          ) : null}

          {job?.items?.some((item) => item.status === 'failed') ? (
            <div className="uui-generation-failures">
              {job.items
                .filter((item) => item.status === 'failed')
                .map((item) => (
                  <div key={item.id}>
                    <span>{item.error?.message || 'Generation failed'}</span>
                    <button
                      type="button"
                      className="uui-button"
                      onClick={() => onRetryItem(item.id)}
                    >
                      Retry
                    </button>
                  </div>
                ))}
            </div>
          ) : null}

          <div className="uui-draft-state-summary">
            <span>{drafts.length} drafts</span>
            <span>
              {drafts.filter((artifact) => artifact.current?.approvalStatus === 'approved').length}{' '}
              approved
            </span>
            <span>
              {
                drafts.filter((artifact) =>
                  ['held', 'unavailable'].includes(artifact.current?.auditStatus ?? ''),
                ).length
              }{' '}
              held
            </span>
            <span>
              {drafts.filter((artifact) => artifact.current?.approvalStatus !== 'approved').length}{' '}
              needs review
            </span>
          </div>
          <div className="uui-draft-layout">
            <nav className="uui-draft-recipient-list" aria-label="Draft recipients">
              {drafts.map((artifact) => (
                <button
                  type="button"
                  key={artifact.id}
                  data-selected={artifact.id === selected?.id || undefined}
                  onClick={() => setSelectedKey(artifact.generationKey)}
                >
                  <span>
                    <strong>{artifact.current?.recipientKey || artifact.generationKey}</strong>
                    <small>Version {artifact.current?.version ?? artifact.currentVersion}</small>
                  </span>
                  <span
                    className="uui-state-pill"
                    data-tone={statusTone(
                      artifact.current?.approvalStatus ??
                        artifact.current?.auditStatus ??
                        'pending',
                    )}
                  >
                    {artifact.current?.approvalStatus === 'approved'
                      ? 'Approved'
                      : artifact.current?.auditStatus === 'held'
                        ? 'Held'
                        : 'Ready for review'}
                  </span>
                </button>
              ))}
            </nav>
            {selected?.current ? (
              <article className="uui-draft-preview">
                <header>
                  <div>
                    <strong>{selected.current.recipientKey}</strong>
                    <span
                      className="uui-state-pill"
                      data-tone={statusTone(selected.current.approvalStatus)}
                    >
                      {selected.current.approvalStatus}
                    </span>
                    <span className="uui-version-pill">V{selected.current.version}</span>
                  </div>
                  <small>
                    Immutable ·{' '}
                    {new Intl.DateTimeFormat(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    }).format(new Date(selected.current.createdAt))}
                  </small>
                </header>
                <dl>
                  <div>
                    <dt>To</dt>
                    <dd>{selected.current.recipientKey}</dd>
                  </div>
                  <div>
                    <dt>Subject</dt>
                    <dd>{selected.current.subject}</dd>
                  </div>
                </dl>
                <div className="uui-draft-body">
                  {selected.current.body.split('\n').map((paragraph, index) => (
                    <p key={`${index}-${paragraph.slice(0, 20)}`}>{paragraph || <br />}</p>
                  ))}
                </div>
                <section className="uui-provenance">
                  <span className="uui-eyebrow">What Meri used</span>
                  <p>
                    {selected.current.contextNote ||
                      'Governed campaign context and the exact recipient snapshot.'}
                  </p>
                </section>
                <footer>
                  <button type="button" className="uui-button" onClick={() => onEdit(selected)}>
                    Revise
                  </button>
                  <details>
                    <summary className="uui-button">
                      <FileClock size={15} /> History
                    </summary>
                    <div>
                      {selected.history.map((item) => (
                        <span key={item.id}>
                          V{item.version} · {item.auditStatus} · {item.approvalStatus}
                        </span>
                      ))}
                    </div>
                  </details>
                  <button
                    type="button"
                    className="uui-button uui-button--primary"
                    disabled={approvalBusy || selected.current.approvalStatus === 'approved'}
                    onClick={() => onApproveDraft(selected)}
                  >
                    {selected.current.approvalStatus === 'approved' ? (
                      <>
                        <Check size={15} /> Approved
                      </>
                    ) : (
                      'Approve exact version'
                    )}
                  </button>
                </footer>
              </article>
            ) : null}
            <aside className="uui-draft-side-note">
              <ShieldCheck size={20} />
              <strong>Exact-version control</strong>
              <p>
                Subject, body, sender, signature, attachment or target change creates a new
                immutable version and clears approval.
              </p>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

function SendPanel({
  sessionId,
  clientId,
  integrations,
  drafts,
  preflight,
  activeIntent,
  onPreflight,
  onIntent,
}: {
  sessionId: string;
  clientId: string | null;
  integrations: IntegrationConnection[];
  drafts: OutreachV3DraftArtifact[];
  preflight: OutreachV3ServerPreflight | null;
  activeIntent: OutreachV3SendIntentView | null;
  onPreflight: (value: OutreachV3ServerPreflight | null) => void;
  onIntent: (intentId: string) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['outreach-v3', 'send-settings', sessionId],
    queryFn: () => getOutreachV3SendSettings(api, sessionId),
  });
  const [senderConnectionId, setSenderConnectionId] = useState('');
  const [appendSignature, setAppendSignature] = useState(true);
  const [attachments, setAttachments] = useState<OutreachAttachment[]>([]);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [acknowledgeHeldOut, setAcknowledgeHeldOut] = useState(false);
  const [testGenerationKey, setTestGenerationKey] = useState<string>('');
  const [uploading, setUploading] = useState(false);
  const [selectedReplyId, setSelectedReplyId] = useState('');
  const [proposedLearning, setProposedLearning] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const replySelectRef = useRef<HTMLSelectElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const settings = settingsQuery.data;
    if (!settings) return;
    setSenderConnectionId(settings.senderConnectionId);
    setAppendSignature(settings.appendSignature);
    setAttachmentIds(settings.attachmentIds);
  }, [settingsQuery.data]);

  useEffect(() => {
    if (!senderConnectionId) {
      const first = integrations.find(
        (connection) =>
          connection.status === 'connected' &&
          ['microsoft_365', 'google_workspace'].includes(connection.provider),
      );
      if (first) setSenderConnectionId(first.id);
    }
  }, [integrations, senderConnectionId]);

  useEffect(() => {
    if (!testGenerationKey && drafts[0]) setTestGenerationKey(drafts[0].generationKey);
  }, [drafts, testGenerationKey]);

  const replyCandidates = useQuery({
    queryKey: ['outreach-v3', 'reply-candidates', activeIntent?.id ?? null],
    queryFn: () => listOutreachReplyCandidates(api, activeIntent!.id),
    enabled: Boolean(activeIntent && !activeIntent.testMode),
    staleTime: 15_000,
  });
  const proposeLearning = useMutation({
    mutationFn: async () => {
      if (!activeIntent) throw new Error('No send intent is active.');
      return proposeOutreachReplyLearning(api, {
        sendIntentId: activeIntent.id,
        mailMessageId: selectedReplyId,
        learning: proposedLearning,
      });
    },
    onSuccess: () => {
      setSelectedReplyId('');
      setProposedLearning('');
    },
  });

  const saveSettings = useMutation({
    mutationFn: () =>
      saveOutreachV3SendSettings(api, sessionId, {
        senderConnectionId,
        appendSignature,
        attachmentIds,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'send-settings', sessionId] });
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'drafts', sessionId] });
      onPreflight(null);
    },
  });
  const preflightMutation = useMutation({
    mutationFn: (input: OutreachV3PreflightInput) => runOutreachV3Preflight(api, sessionId, input),
    onSuccess: onPreflight,
  });
  const testSend = useMutation({
    mutationFn: () =>
      createOutreachV3TestSend(api, sessionId, {
        requestKey: `test-${crypto.randomUUID()}`,
        testGenerationKey,
        acknowledgeHeldOut: true,
      }),
    onSuccess: (result) => onIntent(result.intentId),
  });
  const realSend = useMutation({
    mutationFn: () =>
      createOutreachV3SendIntent(api, sessionId, {
        requestKey: `send-${crypto.randomUUID()}`,
        excludedGenerationKeys: preflight?.excludedGenerationKeys ?? [],
        acknowledgeHeldOut,
      }),
    onSuccess: (result) => onIntent(result.intentId),
  });
  const refreshIntent = useMutation({
    mutationFn: async () => {
      if (!activeIntent) throw new Error('No send intent is active.');
      return refreshOutreachV3SendIntent(api, sessionId, activeIntent.id);
    },
    onSuccess: (value) => {
      qc.setQueryData(['outreach-v3', 'send-intent', sessionId, value.id], value);
      onIntent(value.id);
    },
  });
  const cancelIntent = useMutation({
    mutationFn: async () => {
      if (!activeIntent) throw new Error('No send intent is active.');
      return cancelOutreachV3SendIntent(api, sessionId, activeIntent.id);
    },
    onSuccess: (value) => {
      qc.setQueryData(['outreach-v3', 'send-intent', sessionId, value.id], value);
      onIntent(value.id);
    },
  });

  const connected = integrations.filter(
    (connection) =>
      connection.status === 'connected' &&
      ['microsoft_365', 'google_workspace'].includes(connection.provider),
  );
  const heldOut = preflight?.excludedGenerationKeys.length ?? 0;
  const runPreflight = () =>
    preflightMutation.mutate({
      acknowledgeHeldOut,
      excludedGenerationKeys: preflight?.excludedGenerationKeys ?? [],
    });
  const upload = async (file: File) => {
    setUploading(true);
    try {
      const attachment = await uploadOutreachAttachment(api, file, clientId);
      setAttachments((current) => [...current, attachment]);
      setAttachmentIds((current) => [...new Set([...current, attachment.id])]);
    } finally {
      setUploading(false);
    }
  };

  if (activeIntent) {
    const entries = activeIntent.deliveries ?? [];
    const totals = activeIntent.totals ?? {};
    const cancelable = !['sent', 'failed', 'complete', 'canceled', 'delivery_unknown'].includes(
      activeIntent.status,
    );
    return (
      <div className="uui-delivery-view">
        <div className="uui-delivery-stats">
          {[
            ['Sent', totals.sent ?? 0],
            ['Failed', totals.failed ?? 0],
            ['Unknown', totals.unknown ?? 0],
            ['Skipped', totals.skipped ?? 0],
            ['Held', totals.held ?? 0],
          ].map(([label, value]) => (
            <article key={String(label)}>
              <strong>{value}</strong>
              <span>{label}</span>
            </article>
          ))}
        </div>
        <section className="uui-delivery-records">
          <header>
            <div>
              <span className="uui-eyebrow">Delivery records</span>
              <h3>Durable provider outcomes</h3>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                className="uui-button"
                disabled={refreshIntent.isPending}
                onClick={() => refreshIntent.mutate()}
              >
                {refreshIntent.isPending ? 'Refreshing…' : 'Refresh provider state'}
              </button>
              <button
                type="button"
                className="uui-button"
                disabled={!cancelable || cancelIntent.isPending}
                onClick={() => cancelIntent.mutate()}
              >
                {cancelIntent.isPending ? 'Canceling…' : 'Cancel pending send'}
              </button>
              <span className="uui-state-pill" data-tone={statusTone(activeIntent.status)}>
                {activeIntent.status}
              </span>
            </div>
          </header>
          {entries.length ? (
            entries.map((entry) => (
              <article key={entry.id}>
                <div>
                  <strong>
                    {entry.to?.[0]?.email || entry.to?.[0]?.name || entry.recipientKey}
                  </strong>
                  <p>
                    {entry.errorMessage || entry.providerMessageId || 'Provider state recorded.'}
                  </p>
                </div>
                <span className="uui-state-pill" data-tone={statusTone(entry.status)}>
                  {entry.status}
                </span>
              </article>
            ))
          ) : (
            <p>No delivery rows are available yet.</p>
          )}
          <div className="uui-reconciliation-note">
            <ShieldCheck size={18} />
            <p>
              <strong>Unknown is terminal for automation.</strong> Refresh reads stored/provider
              state only. Capiro does not automatically retry or resend.
            </p>
          </div>
          {refreshIntent.error || cancelIntent.error ? (
            <p className="uui-field-error">
              {safeError(
                refreshIntent.error || cancelIntent.error,
                'The delivery state could not be updated.',
              )}
            </p>
          ) : null}
        </section>
        <section className="uui-next-actions">
          <span className="uui-eyebrow">Next actions</span>
          <h3>Follow-up remains explicit</h3>
          <div>
            {/*
              These are real actions, not decoration. "Record reply" works off the
              inbound replies actually matched to THIS send intent's envelope —
              there is no standalone /mailbox route to link to — and the other two
              use client-side navigation so campaign state is not thrown away by a
              full document load.
            */}
            <button
              type="button"
              className="uui-button"
              disabled={replyCandidates.isFetching}
              onClick={async () => {
                const refreshed = await replyCandidates.refetch();
                if ((refreshed.data ?? []).length > 0) {
                  const first = refreshed.data![0]!;
                  setSelectedReplyId((current) => current || first.id);
                }
                replySelectRef.current?.scrollIntoView({ block: 'center' });
                replySelectRef.current?.focus();
              }}
            >
              {replyCandidates.isFetching
                ? 'Checking replies…'
                : `Record reply${
                    (replyCandidates.data ?? []).length
                      ? ` (${(replyCandidates.data ?? []).length})`
                      : ''
                  }`}
            </button>
            <button
              type="button"
              className="uui-button"
              onClick={() => navigate('/engagement/outreach')}
            >
              Schedule follow-up
            </button>
            <button
              type="button"
              className="uui-button"
              onClick={() => navigate('/engagement/meetings?compose=meeting')}
            >
              Create meeting
            </button>
          </div>
          <article className="uui-learning-proposal">
            <div>
              <strong>Propose reply-backed learning</strong>
              <p>
                Select a real inbound reply, describe the durable learning, and submit it to
                governed memory review. This never writes active memory automatically.
              </p>
            </div>
            <div className="uui-learning-proposal__form">
              <div className="uui-learning-proposal__heading">
                <span className="uui-eyebrow">Verified reply source</span>
                <button
                  type="button"
                  className="uui-button"
                  disabled={replyCandidates.isFetching}
                  onClick={() => replyCandidates.refetch()}
                >
                  {replyCandidates.isFetching ? 'Checking…' : 'Refresh replies'}
                </button>
              </div>
              <select
                ref={replySelectRef}
                aria-label="Reply source for learning proposal"
                value={selectedReplyId}
                onChange={(event) => setSelectedReplyId(event.target.value)}
              >
                <option value="">Select an inbound reply</option>
                {(replyCandidates.data ?? []).map((reply) => (
                  <option key={reply.id} value={reply.id}>
                    {reply.fromName || reply.fromEmail} · {reply.subject || 'No subject'} ·{' '}
                    {new Intl.DateTimeFormat(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    }).format(new Date(reply.receivedAt))}
                  </option>
                ))}
              </select>
              {selectedReplyId ? (
                <p className="uui-learning-proposal__excerpt">
                  {(replyCandidates.data ?? []).find((reply) => reply.id === selectedReplyId)
                    ?.excerpt || 'The selected reply contains no plain-text excerpt.'}
                </p>
              ) : null}
              <textarea
                aria-label="Proposed outreach learning"
                rows={3}
                value={proposedLearning}
                onChange={(event) => setProposedLearning(event.target.value)}
                placeholder="Example: Priya prefers the implementation timeline before the meeting offer."
              />
              <button
                type="button"
                className="uui-button uui-button--primary"
                disabled={
                  proposeLearning.isPending ||
                  !selectedReplyId ||
                  proposedLearning.trim().length < 12
                }
                onClick={() => proposeLearning.mutate()}
              >
                {proposeLearning.isPending ? 'Submitting…' : 'Submit for memory review'}
              </button>
              {!replyCandidates.isLoading && (replyCandidates.data ?? []).length === 0 ? (
                <p className="uui-field-note">
                  No matching inbound replies are synced yet. Refresh after the recipient replies.
                </p>
              ) : null}
              {proposeLearning.data ? (
                <p className="uui-field-success">
                  Learning proposal submitted for governed review. Nothing was auto-committed.
                </p>
              ) : null}
              {replyCandidates.error || proposeLearning.error ? (
                <p className="uui-field-error">
                  {safeError(
                    replyCandidates.error || proposeLearning.error,
                    'The learning proposal could not be submitted.',
                  )}
                </p>
              ) : null}
            </div>
          </article>
        </section>
      </div>
    );
  }

  return (
    <div className="uui-send-panel">
      <section className="uui-send-settings">
        <header>
          <div>
            <span className="uui-eyebrow">Send settings</span>
            <h3>Exact sending identity</h3>
          </div>
          <span className="uui-state-pill" data-tone={settingsQuery.data ? 'navy' : 'warning'}>
            {settingsQuery.data ? 'Saved' : 'Review'}
          </span>
        </header>
        <label>
          <span>From</span>
          <select
            value={senderConnectionId}
            onChange={(event) => setSenderConnectionId(event.target.value)}
          >
            <option value="">Select a connected mailbox</option>
            {connected.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.displayName || connection.accountEmail || connection.provider} ·{' '}
                {connection.accountEmail || connection.provider}
              </option>
            ))}
          </select>
        </label>
        <label className="uui-switch-row">
          <div>
            <span>Signature</span>
            <small>
              {appendSignature
                ? 'Append your current Capiro signature'
                : 'No signature will be appended'}
            </small>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={appendSignature}
            data-on={appendSignature || undefined}
            onClick={() => setAppendSignature((value) => !value)}
          >
            <i />
          </button>
        </label>
        <div className="uui-attachments-setting">
          <div>
            <span>Attachments</span>
            <small>Changing attachments creates a new version and clears approval.</small>
          </div>
          {attachments.map((attachment) => (
            <span key={attachment.id} className="uui-attachment-chip">
              <Paperclip size={13} />
              {attachment.fileName}
              <button
                type="button"
                aria-label={`Remove ${attachment.fileName}`}
                onClick={() => {
                  setAttachments((current) => current.filter((item) => item.id !== attachment.id));
                  setAttachmentIds((current) => current.filter((id) => id !== attachment.id));
                }}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          {attachmentIds
            .filter((id) => !attachments.some((attachment) => attachment.id === id))
            .map((id) => (
              <span key={id} className="uui-attachment-chip">
                <Paperclip size={13} />
                Attached file · {id.slice(0, 8)}
              </span>
            ))}
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            className="uui-button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={15} />
            {uploading ? 'Uploading…' : 'Add attachment'}
          </button>
        </div>
        <button
          type="button"
          className="uui-button uui-button--primary"
          disabled={!senderConnectionId || saveSettings.isPending}
          onClick={() => saveSettings.mutate()}
        >
          {saveSettings.isPending ? 'Saving…' : 'Save send settings'}
        </button>
        {saveSettings.error ? (
          <p className="uui-field-error">
            {safeError(saveSettings.error, 'Settings could not be saved.')}
          </p>
        ) : null}
      </section>

      <section className="uui-preflight-card">
        <header>
          <div>
            <span className="uui-eyebrow">14 deterministic checks</span>
            <h3>Server-authoritative preflight</h3>
          </div>
          <button
            type="button"
            className="uui-button"
            disabled={preflightMutation.isPending || !settingsQuery.data}
            onClick={runPreflight}
          >
            {preflightMutation.isPending ? (
              <Loader2 className="uui-spin" size={15} />
            ) : (
              <RotateCcw size={15} />
            )}{' '}
            Run preflight
          </button>
        </header>
        {preflight ? (
          <div className="uui-preflight-list">
            {preflight.checks.map((check) => (
              <PreflightRow key={check.key} check={check} />
            ))}
          </div>
        ) : (
          <div className="uui-empty-panel is-compact">
            <ShieldCheck size={22} />
            <strong>Preflight has not run for the current versions</strong>
            <p>
              Save sender, signature and attachments, then run all checks on fresh server reads.
            </p>
          </div>
        )}
      </section>

      {preflight ? (
        <aside className="uui-send-summary">
          <div>
            <strong>
              {preflight.draftVersionIds.length} approved email
              {preflight.draftVersionIds.length === 1 ? '' : 's'}{' '}
              {preflight.eligible ? 'are eligible' : 'can be reviewed'}
            </strong>
            <p>
              {heldOut
                ? `${heldOut} recipient${heldOut === 1 ? '' : 's'} will be held out until their blockers are resolved.`
                : 'No recipients are held out.'}
            </p>
          </div>
          {heldOut ? (
            <section>
              <span className="uui-eyebrow">Held out · {heldOut}</span>
              {preflight.excludedGenerationKeys.map((key) => (
                <p key={key}>{key} · blocked by current preflight</p>
              ))}
              <label className="uui-consent-row">
                <input
                  type="checkbox"
                  checked={acknowledgeHeldOut}
                  onChange={(event) => setAcknowledgeHeldOut(event.target.checked)}
                />
                <span>
                  <strong>I understand the held-out recipients</strong>
                  <small>This acknowledgment does not remove their blockers or send to them.</small>
                </span>
              </label>
            </section>
          ) : null}
          <section className="uui-test-send">
            <div>
              <span className="uui-eyebrow">Test send</span>
              <strong>Send one exact version to your own mailbox</strong>
              <p>No target receives anything.</p>
            </div>
            <select
              value={testGenerationKey}
              onChange={(event) => setTestGenerationKey(event.target.value)}
            >
              {drafts.map((artifact) => (
                <option key={artifact.id} value={artifact.generationKey}>
                  {artifact.current?.recipientKey || artifact.generationKey} · V
                  {artifact.current?.version ?? artifact.currentVersion}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="uui-button"
              disabled={!testGenerationKey || testSend.isPending}
              onClick={() => testSend.mutate()}
            >
              <Send size={15} />
              {testSend.isPending ? 'Creating test…' : 'Send test'}
            </button>
          </section>
          <button
            type="button"
            className="uui-button uui-button--primary uui-send-action"
            disabled={
              !preflight.eligible || (heldOut > 0 && !acknowledgeHeldOut) || realSend.isPending
            }
            onClick={() => realSend.mutate()}
          >
            <Send size={16} />
            {realSend.isPending
              ? 'Creating durable intent…'
              : `Send ${preflight.draftVersionIds.length} approved email${preflight.draftVersionIds.length === 1 ? '' : 's'}`}
          </button>
          {realSend.error || testSend.error ? (
            <p className="uui-field-error">
              {safeError(
                realSend.error || testSend.error,
                'The send action could not be completed.',
              )}
            </p>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

function PreflightRow({ check }: { check: OutreachV3NamedPreflightCheck }) {
  return (
    <div className="uui-preflight-row" data-state={check.state}>
      <strong>{check.label}</strong>
      <span>{check.detail}</span>
      <em>
        <i />
        {check.state}
      </em>
    </div>
  );
}

export function VNextOutreachWorkspace({
  clients,
  selectedClientId,
  integrations,
  step,
  onStepChange,
}: Props) {
  const api = useApi();
  const qc = useQueryClient();
  const controller = useOutreachV3Session({ title: 'New outreach campaign' });
  const [composer, setComposer] = useState('');
  const [openSections, setOpenSections] = useState<Set<EngagementOutreachStep>>(new Set([step]));
  const [editingDraft, setEditingDraft] = useState<OutreachV3DraftArtifact | null>(null);
  const [generationJobId, setGenerationJobId] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<OutreachV3ServerPreflight | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const sessionId = controller.sessionId;
  const session = controller.session;
  const planningIndex = PLANNING_STAGE_INDEX[controller.stage];

  const plan = useQuery({
    queryKey: ['outreach-v3', 'generation-plan', sessionId],
    queryFn: () => getOutreachV3GenerationPlan(api, sessionId!),
    enabled: Boolean(sessionId) && controller.stage === 'ready_for_generation',
    retry: false,
  });
  const drafts = useQuery({
    queryKey: ['outreach-v3', 'drafts', sessionId],
    queryFn: () => listOutreachV3Drafts(api, sessionId!),
    enabled: Boolean(sessionId),
    retry: false,
  });
  const approach = useQuery({
    queryKey: ['outreach-v3', 'approach-approval', sessionId],
    queryFn: () => getOutreachV3ApproachApproval(api, sessionId!),
    enabled: Boolean(sessionId) && Boolean(plan.data?.eligible),
    retry: false,
  });
  const generationJob = useQuery({
    queryKey: ['outreach-v3', 'generation-job', sessionId, generationJobId],
    queryFn: () => getOutreachV3GenerationJob(api, sessionId!, generationJobId!),
    enabled: Boolean(sessionId && generationJobId),
    refetchInterval: (query) =>
      ['complete', 'failed', 'canceled'].includes(String(query.state.data?.status ?? ''))
        ? false
        : 3_000,
  });
  const intent = useQuery({
    queryKey: ['outreach-v3', 'send-intent', sessionId, intentId],
    queryFn: () => getOutreachV3SendIntent(api, sessionId!, intentId!),
    enabled: Boolean(sessionId && intentId),
    refetchInterval: (query) =>
      ['sent', 'failed', 'complete', 'canceled', 'delivery_unknown'].includes(
        String(query.state.data?.status ?? ''),
      )
        ? false
        : 5_000,
  });

  useEffect(() => {
    setOpenSections((current) => new Set(current).add(step));
  }, [step]);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [controller.turns.length]);
  useEffect(() => {
    if (
      generationJob.data &&
      ['complete', 'failed', 'canceled'].includes(generationJob.data.status)
    )
      void qc.invalidateQueries({ queryKey: ['outreach-v3', 'drafts', sessionId] });
  }, [generationJob.data, qc, sessionId]);

  const sampleMutation = useMutation({
    mutationFn: () => generateOutreachV3Samples(api, sessionId!),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'drafts', sessionId] });
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'approach-approval', sessionId] });
    },
  });
  const approachMutation = useMutation({
    mutationFn: (versionIds: string[]) => approveOutreachV3Approach(api, sessionId!, versionIds),
    onSuccess: async () =>
      qc.invalidateQueries({ queryKey: ['outreach-v3', 'approach-approval', sessionId] }),
  });
  const fullGeneration = useMutation({
    mutationFn: () => startOutreachV3FullGeneration(api, sessionId!, `full-${crypto.randomUUID()}`),
    onSuccess: (result) => {
      if (result.jobId) setGenerationJobId(result.jobId);
      else void qc.invalidateQueries({ queryKey: ['outreach-v3', 'drafts', sessionId] });
    },
  });
  const revise = useMutation({
    mutationFn: ({
      draft,
      subject,
      body,
    }: {
      draft: OutreachV3DraftArtifact;
      subject: string;
      body: string;
    }) =>
      reviseOutreachV3Draft(api, sessionId!, draft.id, {
        baseVersionId: draft.current!.id,
        subject,
        body,
        editKind: 'manual',
      }),
    onSuccess: async () => {
      setEditingDraft(null);
      setPreflight(null);
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'drafts', sessionId] });
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'approach-approval', sessionId] });
    },
  });
  const approveDraft = useMutation({
    mutationFn: (versionId: string) => approveOutreachV3Draft(api, sessionId!, versionId),
    onSuccess: async () => {
      setPreflight(null);
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'drafts', sessionId] });
    },
  });

  const currentDrafts = drafts.data ?? [];
  const reachedIndex = Math.max(planningIndex, currentDrafts.length ? 5 : 4);
  const activeIntent = intent.data ?? null;

  const sendComposer = async (text = composer) => {
    const value = text.trim();
    if (!value || controller.sendingTurn) return;
    setComposer('');
    await controller.sendTurn(value);
  };

  const selectStep = (value: EngagementOutreachStep) => {
    const index = stepIndex(value);
    if (index > reachedIndex) return;
    onStepChange(value);
    setOpenSections((current) => new Set(current).add(value));
  };

  const toggleSection = (value: EngagementOutreachStep) => {
    const index = stepIndex(value);
    if (index > reachedIndex) return;
    setOpenSections((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
    onStepChange(value);
  };

  const currentPlanningStage = stageForStep(step, controller.stage);
  const sampleVersions = plan.data
    ? currentDrafts
        .filter((draft) => plan.data.representativeSampleKeys.includes(draft.generationKey))
        .map((draft) => draft.current?.id)
        .filter((id): id is string => Boolean(id))
    : [];

  if (controller.isBootstrapping) {
    return (
      <div className="uui-outreach-loading">
        <div className="uui-chat-skeleton">
          <i />
          <i />
          <i />
        </div>
        <div className="uui-canvas-skeleton">
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
    );
  }
  if (!session || !sessionId) {
    return (
      <div className="uui-engagement-error">
        <strong>Outreach could not start</strong>
        <p>{controller.errorMessage || 'A governed campaign session was not available.'}</p>
        <button
          type="button"
          className="uui-button"
          onClick={() => void controller.startNewSession()}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="uui-outreach-workspace">
      <aside className="uui-outreach-chat">
        <header>
          <div>
            <span className="uui-live-dot" />
            <strong>Meri · Outreach</strong>
          </div>
          <span>{step.toUpperCase()}</span>
        </header>
        {controller.reasoningUnavailable ? (
          <div className="uui-model-outage">
            <AlertTriangle size={17} />
            <div>
              <strong>Meri is temporarily unavailable</strong>
              <p>
                {controller.reasoningErrorMessage ||
                  'Planning controls and current campaign data remain available.'}
              </p>
              <button type="button" onClick={() => controller.retryReasoning()}>
                Retry Meri
              </button>
            </div>
          </div>
        ) : null}
        <div className="uui-outreach-transcript">
          {controller.turns.length ? (
            controller.turns.map((turn, index) => (
              <article key={turn.id ?? `${turn.role}-${index}`} data-role={turn.role}>
                <span>{transcriptLabel(turn)}</span>
                <div>{turn.text}</div>
              </article>
            ))
          ) : (
            <article data-role="assistant">
              <span>Meri</span>
              <div>
                What do you need to accomplish? Give me the goal in your own words — client, sponsor
                and audience stay optional until you choose them.
              </div>
            </article>
          )}
          <InlineActions
            step={step}
            controllerStage={controller.stage}
            plan={plan.data ?? null}
            drafts={currentDrafts}
            approachCurrent={Boolean(approach.data)}
            preflight={preflight}
            onSuggested={(value) => void sendComposer(value)}
            onGenerateSamples={() => sampleMutation.mutate()}
            onApproveApproach={() => approachMutation.mutate(sampleVersions)}
            onGenerateRemaining={() => fullGeneration.mutate()}
            onGoToPreflight={() => {
              selectStep('send');
              setTimeout(() => setPreflight(null), 0);
            }}
          />
          <div ref={chatEndRef} />
        </div>
        <footer>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void sendComposer();
            }}
          >
            <input
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              placeholder="Tell Meri what you need to send…"
              aria-label="Message Meri"
            />
            <button
              type="submit"
              aria-label="Send to Meri"
              disabled={!composer.trim() || controller.sendingTurn}
            >
              {controller.sendingTurn ? (
                <Loader2 className="uui-spin" size={17} />
              ) : (
                <ArrowUp size={18} />
              )}
            </button>
          </form>
          <p>Reply to Meri, or use the action above.</p>
        </footer>
      </aside>

      <main className="uui-outreach-canvas">
        <div className="uui-campaign-brief">
          <span className="uui-eyebrow">Campaign brief</span>
          <p>{campaignBrief(session, currentDrafts)}</p>
          <button type="button" onClick={() => selectStep('goal')}>
            Edit
          </button>
        </div>
        <nav className="uui-outreach-step-strip" aria-label="Campaign steps">
          {USER_STEPS.map((candidate, index) => (
            <button
              key={candidate.key}
              type="button"
              data-active={candidate.key === step || undefined}
              data-reached={index <= reachedIndex || undefined}
              disabled={index > reachedIndex}
              onClick={() => selectStep(candidate.key)}
            >
              {candidate.label}
            </button>
          ))}
        </nav>
        <div className="uui-outreach-sections">
          {USER_STEPS.map((candidate, index) => {
            const waiting = index > reachedIndex;
            const inProgress = candidate.key === step && !waiting;
            const locked =
              index < planningIndex ||
              (candidate.key === 'drafts' && currentDrafts.length > 0 && step !== 'drafts') ||
              (candidate.key === 'send' && Boolean(activeIntent));
            const status: 'Waiting' | 'In progress' | 'Locked' = waiting
              ? 'Waiting'
              : locked
                ? 'Locked'
                : inProgress
                  ? 'In progress'
                  : index < reachedIndex
                    ? 'Locked'
                    : 'In progress';
            const open = openSections.has(candidate.key) && !waiting;
            return (
              <section
                key={candidate.key}
                className="uui-outreach-section"
                data-waiting={waiting || undefined}
                data-open={open || undefined}
              >
                <button
                  type="button"
                  className="uui-outreach-section__header"
                  disabled={waiting}
                  onClick={() => toggleSection(candidate.key)}
                >
                  <span className="uui-outreach-section__number">{candidate.number}</span>
                  <strong>{candidate.label}</strong>
                  <small>
                    {status === 'Locked'
                      ? summaryForStep(candidate.key, session, currentDrafts, preflight)
                      : ''}
                  </small>
                  <SectionStatus value={status} />
                  {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                {open ? (
                  <div className="uui-outreach-section__body">
                    {candidate.key === 'drafts' && controller.stage === 'ready_for_generation' ? (
                      <DraftPanel
                        plan={plan.data ?? null}
                        drafts={currentDrafts}
                        approvalCurrent={Boolean(approach.data)}
                        generationBusy={sampleMutation.isPending || fullGeneration.isPending}
                        job={generationJob.data ?? null}
                        onGenerateSamples={() => sampleMutation.mutate()}
                        onApproveApproach={() => approachMutation.mutate(sampleVersions)}
                        onGenerateRemaining={() => fullGeneration.mutate()}
                        onCancelGeneration={() =>
                          generationJobId &&
                          cancelOutreachV3GenerationJob(api, sessionId, generationJobId).then(() =>
                            generationJob.refetch(),
                          )
                        }
                        onRetryItem={(itemId) =>
                          generationJobId &&
                          retryOutreachV3GenerationItem(
                            api,
                            sessionId,
                            generationJobId,
                            itemId,
                          ).then(() => generationJob.refetch())
                        }
                        onEdit={setEditingDraft}
                        onApproveDraft={(draft) =>
                          draft.current && approveDraft.mutate(draft.current.id)
                        }
                        approvalBusy={approachMutation.isPending || approveDraft.isPending}
                      />
                    ) : candidate.key === 'send' ? (
                      <SendPanel
                        sessionId={sessionId}
                        clientId={selectedClientId}
                        integrations={integrations}
                        drafts={currentDrafts}
                        preflight={preflight}
                        activeIntent={activeIntent}
                        onPreflight={setPreflight}
                        onIntent={setIntentId}
                      />
                    ) : (
                      <CurrentDecisionSurface
                        session={session}
                        stage={
                          candidate.key === step
                            ? currentPlanningStage
                            : stageForStep(candidate.key, controller.stage)
                        }
                        clients={clients}
                        selectedClientId={selectedClientId}
                        busy={controller.applyingCommands}
                        applyCommands={controller.applyCommands}
                        pendingProposals={controller.pendingProposals}
                        proposalBusy={controller.proposalBusy}
                        applyProposal={controller.applyProposal}
                        rejectProposal={controller.rejectProposal}
                        searchTargets={controller.searchTargets}
                        targetCandidates={controller.targetCandidates}
                        targetSearchPending={controller.targetSearchPending}
                        targetSearchError={controller.targetSearchError}
                        getTargetProfile={controller.getTargetProfile}
                        targetProfile={controller.targetProfile}
                        targetProfilePending={controller.targetProfilePending}
                        coverage={controller.coverage}
                        coveragePending={controller.coveragePending}
                        searchContext={controller.searchContext}
                        contextCandidates={controller.contextCandidates}
                        contextSearchPending={controller.contextSearchPending}
                        contextSearchError={controller.contextSearchError}
                        contextReview={controller.contextReview}
                        contextReviewPending={controller.contextReviewPending}
                        contextReviewError={controller.contextReviewError}
                        strategy={controller.strategy}
                        strategyPending={controller.strategyPending}
                        strategyError={controller.strategyError}
                        onFinish={() => undefined}
                        onSelectStage={(stage) => {
                          const target: EngagementOutreachStep =
                            stage === 'goal' || stage === 'sponsor'
                              ? 'goal'
                              : stage === 'strategy' || stage === 'ready_for_generation'
                                ? 'drafts'
                                : stage;
                          selectStep(target);
                        }}
                      />
                    )}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </main>

      {editingDraft?.current ? (
        <DraftEditModal
          draft={editingDraft}
          pending={revise.isPending}
          onClose={() => setEditingDraft(null)}
          onSave={(subject, body) => revise.mutate({ draft: editingDraft, subject, body })}
        />
      ) : null}
      {controller.lifecycleErrorMessage ? (
        <div className="uui-toast is-error">
          <CircleAlert size={16} />
          {controller.lifecycleErrorMessage}
        </div>
      ) : null}
    </div>
  );
}

function InlineActions({
  step,
  controllerStage,
  plan,
  drafts,
  approachCurrent,
  preflight,
  onSuggested,
  onGenerateSamples,
  onApproveApproach,
  onGenerateRemaining,
  onGoToPreflight,
}: {
  step: EngagementOutreachStep;
  controllerStage: OutreachV3Stage;
  plan: OutreachV3GenerationPlan | null;
  drafts: OutreachV3DraftArtifact[];
  approachCurrent: boolean;
  preflight: OutreachV3ServerPreflight | null;
  onSuggested: (value: string) => void;
  onGenerateSamples: () => void;
  onApproveApproach: () => void;
  onGenerateRemaining: () => void;
  onGoToPreflight: () => void;
}) {
  if (step === 'goal' && controllerStage === 'goal')
    return (
      <div className="uui-chat-actions">
        {['Share an update', 'Make an ask', 'Invite people', 'Something else'].map((label) => (
          <button type="button" key={label} onClick={() => onSuggested(label)}>
            {label}
          </button>
        ))}
      </div>
    );
  if (controllerStage !== 'ready_for_generation')
    return (
      <div className="uui-chat-actions">
        <button type="button" onClick={() => onSuggested(`Continue with the current ${step}.`)}>
          Use the current {step}
        </button>
      </div>
    );
  const samples = plan
    ? drafts.filter((draft) => plan.representativeSampleKeys.includes(draft.generationKey))
    : [];
  if (!samples.length)
    return (
      <div className="uui-chat-actions">
        <button type="button" onClick={onGenerateSamples}>
          Generate representative samples
        </button>
      </div>
    );
  if (!approachCurrent)
    return (
      <div className="uui-chat-actions">
        <button type="button" onClick={onApproveApproach}>
          Approve approach
        </button>
      </div>
    );
  if (plan && drafts.length < plan.slots.length)
    return (
      <div className="uui-chat-actions">
        <button type="button" onClick={onGenerateRemaining}>
          Generate remaining drafts
        </button>
      </div>
    );
  if (!preflight)
    return (
      <div className="uui-chat-actions">
        <button type="button" onClick={onGoToPreflight}>
          Go to preflight
        </button>
      </div>
    );
  return null;
}
