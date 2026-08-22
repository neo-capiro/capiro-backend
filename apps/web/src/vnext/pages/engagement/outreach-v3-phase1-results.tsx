import { useState } from 'react';
import {
  ArrowRight,
  Check,
  CircleAlert,
  Loader2,
  PauseCircle,
  RefreshCcw,
  Send,
  ShieldCheck,
  StopCircle,
} from 'lucide-react';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import {
  type OutreachReplyCandidate,
  type OutreachV3DraftArtifact,
  type OutreachV3GenerationPlan,
  type OutreachV3SendIntentView,
} from './engagement-api.js';
import { OutreachTemplateSaveDialog } from './OutreachTemplateSaveDialog.js';
import { OutreachTemplateUpdateDialog } from './OutreachTemplateUpdateDialog.js';
import {
  isSendTerminal,
  sendProgress,
  statusTone,
} from './outreach-v3-phase1-model.js';
import {
  ProgressBar,
  StatusChip,
  formatDateTime,
  recipientPresentation,
} from './outreach-v3-phase1-shared.js';

export function SendConfirmDialog({
  count,
  held,
  sender,
  pending,
  onClose,
  onConfirm,
}: {
  count: number;
  held: number;
  sender: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <EngagementDialog
      open
      eyebrow="Final confirmation"
      title={`Send ${count} email${count === 1 ? '' : 's'} now?`}
      description="Capiro will create one durable send record. Refreshing or opening another tab will not create a second send."
      width={560}
      busy={pending}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ov3p1-button is-secondary" disabled={pending} onClick={onClose}>Go back</button>
          <button type="button" className="ov3p1-button is-primary is-send" disabled={pending} onClick={onConfirm}>
            {pending ? <Loader2 className="ov3p1-spin" size={15} /> : <Send size={15} />}
            Send {count} email{count === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <div className="ov3p1-confirm-body">
        {held ? <div className="ov3p1-confirm-warning"><PauseCircle size={18} /><span><strong>{held} recipient{held === 1 ? '' : 's'} will remain held</strong><small>They will not receive an email.</small></span></div> : null}
        <dl>
          <div><dt>Recipients</dt><dd>{count}</dd></div>
          <div><dt>Sender</dt><dd>{sender}</dd></div>
          <div><dt>Timing</dt><dd>Start now</dd></div>
          <div><dt>Authority</dt><dd>Exact approved versions only</dd></div>
        </dl>
      </div>
    </EngagementDialog>
  );
}

export function SendingScreen({
  intent,
  plan,
  drafts,
  cancelBusy,
  error,
  onCancel,
  onRefresh,
}: {
  intent: OutreachV3SendIntentView;
  plan: OutreachV3GenerationPlan | null;
  drafts: OutreachV3DraftArtifact[];
  cancelBusy: boolean;
  error: string | null;
  onCancel: () => void;
  onRefresh: () => void;
}) {
  const progress = sendProgress(intent);
  const cancelable = !isSendTerminal(intent.status);
  const rows = intent.deliveries.length
    ? intent.deliveries
    : drafts.map((draft) => ({
        id: draft.id,
        generationKey: draft.generationKey,
        recipientKey: recipientPresentation(draft, plan).label,
        status: 'queued',
        attempt: 0,
        provider: '',
        correlationId: '',
        to: [],
        cc: [],
        bcc: [],
        subject: draft.current?.subject ?? '',
        providerMessageId: null,
        providerThreadId: null,
        providerDraftId: null,
        errorCode: null,
        errorMessage: null,
        acceptedAt: null,
      }));

  return (
    <div className="ov3p1-content ov3p1-content--narrow">
      <div className="ov3p1-status-title">
        {intent.status === 'failed' ? <CircleAlert size={22} /> : <Loader2 className={cancelable ? 'ov3p1-spin' : ''} size={22} />}
        <h2>{intent.status === 'failed' ? 'The send stopped safely' : cancelable ? 'Sending now' : 'The send has finished'}</h2>
      </div>
      <p className="ov3p1-lead">{progress.complete} of {progress.total} recipient records have reached a terminal provider state.</p>
      <ProgressBar percent={progress.percent} />
      <div className="ov3p1-progress-meta">
        <span>{progress.complete} of {progress.total}</span>
        <div>
          <button type="button" className="ov3p1-button is-quiet" onClick={onRefresh}><RefreshCcw size={14} /> Refresh</button>
          {cancelable ? <button type="button" className="ov3p1-button is-quiet" disabled={cancelBusy} onClick={onCancel}><StopCircle size={14} /> Stop the rest</button> : null}
        </div>
      </div>
      <section className="ov3p1-generation-list is-send">
        {rows.map((row) => (
          <div key={row.id}>
            <span>{row.to[0]?.name || row.to[0]?.email || row.recipientKey}</span>
            <small>{row.errorMessage || row.providerMessageId || 'One durable recipient record'}</small>
            <StatusChip tone={statusTone(row.status)}>{row.status.replaceAll('_', ' ')}</StatusChip>
          </div>
        ))}
      </section>
      <div className="ov3p1-idempotency-note"><ShieldCheck size={18} /><p><strong>One send record.</strong> Refreshing, retrying the page, or opening a second tab cannot create another send with this request key.</p></div>
      {error ? <p className="ov3p1-error" role="alert">{error}</p> : null}
    </div>
  );
}

export function MetricTile({ value, label, tone }: { value: number; label: string; tone?: 'navy' | 'amber' | 'red' | 'neutral' }) {
  return <article className="ov3p1-metric" data-tone={tone ?? 'neutral'}><strong>{value}</strong><span>{label}</span></article>;
}

export function ResultsScreen({
  sessionId,
  campaignName,
  selectedClientId,
  intent,
  plan,
  drafts,
  replies,
  learningBusy,
  learningResult,
  error,
  onRefresh,
  onOpenDraft,
  onProposeLearning,
}: {
  sessionId: string;
  campaignName: string;
  selectedClientId: string | null;
  intent: OutreachV3SendIntentView;
  plan: OutreachV3GenerationPlan | null;
  drafts: OutreachV3DraftArtifact[];
  replies: OutreachReplyCandidate[];
  learningBusy: boolean;
  learningResult: boolean;
  error: string | null;
  onRefresh: () => void;
  onOpenDraft: () => void;
  onProposeLearning: (replyId: string, learning: string) => void;
}) {
  const totals = intent.totals ?? {};
  const [templateMode, setTemplateMode] = useState<'save' | 'update' | null>(null);
  const [resultNotice, setResultNotice] = useState('');
  const [selectedReplyId, setSelectedReplyId] = useState(replies[0]?.id ?? '');
  const [learning, setLearning] = useState('');
  const [expandedReply, setExpandedReply] = useState<string | null>(null);
  const sent = Number(totals.sent ?? 0);
  const failed = Number(totals.failed ?? 0);
  const unknown = Number(totals.unknown ?? 0);
  const skipped = Number(totals.skipped ?? 0);
  const held = Number(totals.held ?? 0);
  const clean = failed === 0 && held === 0;

  return (
    <div className="ov3p1-content ov3p1-content--wide">
      <div className="ov3p1-results-heading">
        <div><h2>{clean ? `${sent} left cleanly.` : `${sent} sent. ${failed + held} need attention.`}</h2><p>Provider outcomes remain explicit. Unknown is never silently treated as delivered, and nothing retries itself.</p></div>
        <button type="button" className="ov3p1-button is-secondary" onClick={onRefresh}><RefreshCcw size={14} /> Refresh results</button>
      </div>

      <div className="ov3p1-metrics">
        <MetricTile value={sent} label="Sent" tone="navy" />
        <MetricTile value={failed} label="Failed" tone={failed ? 'red' : 'neutral'} />
        <MetricTile value={unknown} label="In flight / unknown" tone={unknown ? 'amber' : 'neutral'} />
        <MetricTile value={skipped} label="Skipped" />
        <MetricTile value={held} label="Held" tone={held ? 'amber' : 'neutral'} />
        <MetricTile value={replies.length} label="Replies synced" tone={replies.length ? 'navy' : 'neutral'} />
      </div>

      <section className="ov3p1-results-table">
        <header><span>Recipient</span><span>Version</span><span>Sent</span><span>Delivery</span><span>Reply</span><span>Action</span></header>
        {intent.deliveries.map((delivery) => {
          const draft = drafts.find((item) => item.generationKey === delivery.generationKey);
          const email = delivery.to[0]?.email ?? '';
          const reply = replies.find((candidate) => candidate.fromEmail.toLowerCase() === email.toLowerCase());
          const notSent = !['sent', 'accepted', 'delivered'].some((value) => delivery.status.toLowerCase().includes(value));
          return (
            <article key={delivery.id} data-attention={notSent || undefined}>
              <span><strong>{delivery.to[0]?.name || (draft ? recipientPresentation(draft, plan).label : '') || email || delivery.recipientKey}</strong><small>{draft ? recipientPresentation(draft, plan).subtitle : delivery.recipientKey}</small></span>
              <span>V{draft?.current?.version ?? draft?.currentVersion ?? '—'}</span>
              <span>{formatDateTime(delivery.acceptedAt || intent.startedAt)}</span>
              <span><StatusChip tone={statusTone(delivery.status)}>{delivery.status.replaceAll('_', ' ')}</StatusChip></span>
              <span>{reply ? <><strong>{reply.subject || 'Reply received'}</strong><small>{formatDateTime(reply.receivedAt)}</small></> : <small>No synced reply</small>}</span>
              <span>{reply ? <button type="button" onClick={() => setExpandedReply(expandedReply === reply.id ? null : reply.id)}>Open reply</button> : notSent ? <button type="button" onClick={onOpenDraft}>Resolve draft</button> : <button type="button" disabled>Follow up</button>}</span>
              {reply && expandedReply === reply.id ? <p className="ov3p1-result-excerpt">{reply.excerpt}</p> : null}
            </article>
          );
        })}
      </section>

      <div className="ov3p1-result-actions">
        <button type="button" className="ov3p1-button is-primary" onClick={() => setResultNotice('Follow-up campaign creation is reserved for the next workflow release. No campaign was created from this control.')}><ArrowRight size={15} /> Create follow-up campaign</button>
        <button type="button" className="ov3p1-button is-secondary" onClick={() => setTemplateMode('save')}>Save this campaign as a template</button>
        <button type="button" className="ov3p1-button is-quiet" onClick={() => setTemplateMode('update')}>Update a template from this campaign</button>
      </div>
      {resultNotice ? <p className="ov3p1-result-notice">{resultNotice}</p> : null}

      <section className="ov3p1-learning-section">
        <header><span>Governed learning</span><h3>Turn a real reply into a reviewable memory proposal</h3><p>Nothing becomes active memory automatically.</p></header>
        <article className="ov3p1-learning-card">
          <div>
            <strong>What Meri may learn</strong>
            <select value={selectedReplyId} onChange={(event) => setSelectedReplyId(event.target.value)}><option value="">Select a real inbound reply</option>{replies.map((reply) => <option key={reply.id} value={reply.id}>{reply.fromName || reply.fromEmail} · {reply.subject || 'No subject'}</option>)}</select>
            <textarea rows={3} value={learning} onChange={(event) => setLearning(event.target.value)} placeholder="Example: This office prefers a specific meeting offer rather than an open-ended follow-up." />
          </div>
          <dl>
            <div><dt>Evidence</dt><dd>{selectedReplyId ? replies.find((reply) => reply.id === selectedReplyId)?.excerpt || 'Selected reply' : 'Choose a reply'}</dd></div>
            <div><dt>Memory type</dt><dd>Reply-backed outreach preference</dd></div>
            <div><dt>Scope</dt><dd>Client when the reply is client-linked; otherwise firm</dd></div>
            <div><dt>Destination</dt><dd>Governed memory review queue</dd></div>
            <div><dt>Expiration</dt><dd>Set by governance policy</dd></div>
            <div><dt>Approval</dt><dd>Required before activation</dd></div>
          </dl>
          <div>
            <button type="button" className="ov3p1-button is-primary" disabled={learningBusy || !selectedReplyId || learning.trim().length < 12} onClick={() => onProposeLearning(selectedReplyId, learning.trim())}>{learningBusy ? <Loader2 className="ov3p1-spin" size={14} /> : <Check size={14} />}Remember this — send for review</button>
            <button type="button" className="ov3p1-button is-secondary" onClick={() => setLearning('')}>Edit it first</button>
            <button type="button" className="ov3p1-button is-quiet" onClick={() => { setLearning(''); setSelectedReplyId(''); }}>Do not remember</button>
          </div>
          {learningResult ? <p className="ov3p1-success">Submitted for governed review. Nothing was auto-committed.</p> : null}
        </article>
      </section>

      {error ? <p className="ov3p1-error" role="alert">{error}</p> : null}
      {templateMode === 'save' ? <OutreachTemplateSaveDialog sessionId={sessionId} defaultName={campaignName} selectedClientId={selectedClientId} onClose={() => setTemplateMode(null)} /> : null}
      {templateMode === 'update' ? <OutreachTemplateUpdateDialog sessionId={sessionId} selectedClientId={selectedClientId} onClose={() => setTemplateMode(null)} /> : null}
    </div>
  );
}
