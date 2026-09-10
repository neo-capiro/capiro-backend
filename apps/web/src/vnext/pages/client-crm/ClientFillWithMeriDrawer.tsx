import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { useApi } from '../../../lib/use-api.js';
import {
  errorText,
  useClientFillWithMeri,
  type FillFinding,
  type FillProgress,
  type FillTask,
  type FillTaskStatus,
} from '../../adapters/legacy/useClientFillWithMeri.js';
import { UIcon } from './portfolio-primitives.js';
import type { AdvocacyMatterSummary } from './tabs/AdvocacyMattersTab.js';
import { appliedFindingCount, clientAttributionEvidence, sourceUrl } from './client-fill-review-evidence.js';
import './client-fill-with-meri-drawer.css';

/**
 * Fill with Meri — prototype-parity review drawer.
 *
 * This is a durable enrichment workflow, not chat. The six-pass presentation
 * is derived from the server's real task ledger. Profile changes are staged in
 * this drawer and sent only as explicit finding IDs; Advocacy Matter actions
 * are labelled separately because that backend endpoint commits immediately.
 */
export function ClientFillWithMeriDrawer({
  clientId,
  clientName,
  open,
  onClose,
  initialWebsite = '',
  onOpenMatter,
}: {
  clientId: string;
  clientName: string;
  open: boolean;
  onClose: () => void;
  initialWebsite?: string | null;
  onOpenMatter?: (matterId: string) => void;
}) {
  const fill = useClientFillWithMeri(clientId, open);
  const api = useApi();
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [websiteInput, setWebsiteInput] = useState(initialWebsite ?? '');

  useEffect(() => setWebsiteInput(initialWebsite ?? ''), [clientId, initialWebsite]);

  const hasPendingAdvocacy = fill.proposals.some(isAdvocacyFinding);
  const mattersForPicker = useQuery<AdvocacyMatterSummary[]>({
    queryKey: ['client-advocacy-matters', clientId],
    queryFn: async () =>
      (await api.get<AdvocacyMatterSummary[]>(`/api/clients/${clientId}/advocacy-matters`)).data,
    enabled: open && hasPendingAdvocacy,
  });

  const persistedAttachmentId = documentAttachmentId(fill.run?.sourceStates);

  const startEnrichment = () => {
    setRetryError(null);
    fill.start({ website: websiteInput.trim() || undefined });
  };

  const retryRun = () => {
    const isDocumentRun = Object.prototype.hasOwnProperty.call(
      fill.run?.sourceStates ?? {},
      'client_document',
    );
    const attachmentId = isDocumentRun ? persistedAttachmentId ?? selectedAttachmentId : null;
    if (isDocumentRun && attachmentId) {
      setRetryError(null);
      fill.startForAttachment(attachmentId);
      return;
    }
    if (isDocumentRun) {
      setRetryError('The original document is no longer available for retry.');
      return;
    }
    startEnrichment();
  };

  const uploadCapabilityDocument = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || uploading) return;
    if (file.size > 25 * 1024 * 1024) {
      setUploadError('Choose a file smaller than 25 MB.');
      return;
    }
    const contentType = contentTypeFor(file.name);
    if (!contentType) {
      setUploadError('Upload PDF, DOC/DOCX, PPTX, XLSX, CSV, TXT, or Markdown.');
      return;
    }

    setUploading(true);
    setUploadError(null);
    try {
      const presigned = (
        await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>(
          '/api/engagement/attachments/upload-url',
          { clientId, fileName: file.name, contentType, contentLength: file.size },
        )
      ).data;
      const form = new FormData();
      Object.entries(presigned.fields).forEach(([key, value]) => form.append(key, value));
      form.append('file', file);
      const stored = await fetch(presigned.url, { method: 'POST', body: form });
      if (!stored.ok) throw new Error('Storage rejected the upload');
      const confirmed = (
        await api.post<{ id: string }>('/api/engagement/attachments/confirm', {
          clientId,
          fileName: file.name,
          contentType,
          s3Key: presigned.s3Key,
          source: 'fill-with-meri-capability',
        })
      ).data;
      setSelectedAttachmentId(confirmed.id);
      fill.startForAttachment(confirmed.id);
    } catch (error) {
      setUploadError(errorText(error, 'Could not upload and extract this document.'));
    } finally {
      setUploading(false);
    }
  };

  return (
    <FillDrawerShell
      open={open}
      clientName={clientName}
      title={drawerTitle(fill.phase)}
      subtitle={drawerSubtitle(fill.phase)}
      running={fill.phase === 'preparing' || fill.phase === 'researching'}
      onClose={onClose}
    >
      <input
        ref={uploadRef}
        className="meri-fill-visually-hidden"
        type="file"
        accept=".pdf,.doc,.docx,.pptx,.xlsx,.csv,.txt,.md"
        disabled={uploading || fill.phase === 'researching'}
        onChange={uploadCapabilityDocument}
      />
      {fill.phase === 'idle' || (fill.phase === 'cancelled' && !fill.run?.findings.length) ? (
        <IdleReview
          cancelled={fill.phase === 'cancelled'}
          website={websiteInput}
          onWebsiteChange={setWebsiteInput}
          onStart={startEnrichment}
          onUpload={() => uploadRef.current?.click()}
          uploading={uploading}
          error={uploadError ?? retryError}
        />
      ) : (fill.phase === 'failed' && !fill.run?.findings.length) || fill.phase === 'permission-denied' ? (
        <BlockedReview
          message={
            fill.phase === 'permission-denied'
              ? 'You do not have permission to run or apply this review. An administrator can complete it.'
              : retryError ?? fill.run?.error ?? errorText(fill.startError, 'The review could not be started.')
          }
          attemptedAt={fill.run?.startedAt ?? null}
          onRetry={retryRun}
          onClose={onClose}
        />
      ) : (
        <ReviewWorkspace
          clientName={clientName}
          fill={fill}
          retryError={retryError}
          onRetryRun={retryRun}
          onRunAgain={startEnrichment}
          matterOptions={mattersForPicker.data ?? []}
          onOpenMatter={onOpenMatter}
        />
      )}
    </FillDrawerShell>
  );
}

type Fill = ReturnType<typeof useClientFillWithMeri>;

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function FillDrawerShell({
  open,
  clientName,
  title,
  subtitle,
  running,
  onClose,
  children,
}: {
  open: boolean;
  clientName: string;
  title: string;
  subtitle: string;
  running: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.tabIndex !== -1 && !element.hasAttribute('disabled'));
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="meri-fill-overlay" role="presentation">
      <button className="meri-fill-scrim" aria-label="Close" onClick={onClose} />
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="meri-fill-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="meri-fill-header">
          <span className="meri-fill-mark" aria-hidden>
            <UIcon name="Stars02" size={19} />
            {running ? <span className="meri-fill-mark__pulse" /> : null}
          </span>
          <span className="meri-fill-header__copy">
            <span className="meri-fill-eyebrow">{clientName}</span>
            <strong className="meri-fill-title">{title}</strong>
            <span className="meri-fill-subtitle">{subtitle}</span>
          </span>
          <button className="meri-fill-icon-button" aria-label="Close" onClick={onClose}>
            <UIcon name="XClose" size={19} />
          </button>
        </header>
        <div className="meri-fill-scroll">{children}</div>
      </section>
    </div>
  );
}

const REVIEW_PLAN = [
  ['Understand client', 'Client context and account setup'],
  ['Research company', 'Website, SAM.gov and client documents'],
  ['Reconstruct relationships', 'Synced email and known contacts'],
  ['Government & market footprint', 'Program elements, bills, facilities and districts'],
  ['Advocacy history', 'LDA filings, activity and lifecycle outcomes'],
  ['Verify & reconcile', 'Conflict review and completion audit'],
] as const;

function IdleReview({
  cancelled,
  website,
  onWebsiteChange,
  onStart,
  onUpload,
  uploading,
  error,
}: {
  cancelled: boolean;
  website: string;
  onWebsiteChange: (value: string) => void;
  onStart: () => void;
  onUpload: () => void;
  uploading: boolean;
  error: string | null;
}) {
  return (
    <div className="meri-fill-idle">
      {cancelled ? (
        <div className="meri-fill-inline-note" role="status">
          <UIcon name="CheckCircle" size={17} />
          <span>The last run was cancelled. Any updates already applied remain on the record.</span>
        </div>
      ) : null}
      <p className="meri-fill-intro">
        Meri works through the record in six passes, then brings back what she found. Every
        proposal keeps the source it came from, and nothing reaches the profile until you accept
        and apply it.
      </p>
      <div className="meri-fill-plan">
        {REVIEW_PLAN.map(([label, sources], index) => (
          <div className="meri-fill-plan__row" key={label}>
            <span className="meri-fill-plan__number">{index + 1}</span>
            <strong>{label}</strong>
            <span>{sources}</span>
          </div>
        ))}
      </div>
      <details className="meri-fill-source-settings">
        <summary>Review source settings</summary>
        <label>
          <span>Company website</span>
          <input
            type="url"
            value={website}
            placeholder="https://example.com"
            onChange={(event) => onWebsiteChange(event.target.value)}
          />
        </label>
        <p>Optional. Meri uses this site for company research when the profile is thin.</p>
      </details>
      {error ? <p className="meri-fill-error-text">{error}</p> : null}
      <div className="meri-fill-idle__actions">
        <button className="meri-fill-button meri-fill-button--primary" onClick={onStart}>
          Start the review
        </button>
        <button
          className="meri-fill-button meri-fill-button--brand"
          disabled={uploading}
          onClick={onUpload}
        >
          <UIcon name="File04" size={16} />
          {uploading ? 'Preparing document…' : 'Add a capability document'}
        </button>
        <span className="meri-fill-file-help">
          Max 25 MB · PDF, DOC/DOCX, PPTX, XLSX, CSV, TXT, MD
        </span>
      </div>
    </div>
  );
}

function BlockedReview({
  message,
  attemptedAt,
  onRetry,
  onClose,
}: {
  message: string;
  attemptedAt: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="meri-fill-blocked">
      <div className="meri-fill-blocked__card">
        <span className="meri-fill-blocked__icon"><UIcon name="AlertCircle" size={18} /></span>
        <span>
          <strong>Meri could not complete this review</strong>
          <p>{message} Any updates already applied remain on the record.</p>
          {attemptedAt ? <small>Last attempted {formatTime(attemptedAt)}</small> : null}
        </span>
      </div>
      <div className="meri-fill-blocked__actions">
        <button className="meri-fill-button meri-fill-button--primary" onClick={onRetry}>Try again</button>
        <button className="meri-fill-button meri-fill-button--quiet" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function ReviewWorkspace({
  clientName,
  fill,
  retryError,
  onRetryRun,
  onRunAgain,
  matterOptions,
  onOpenMatter,
}: {
  clientName: string;
  fill: Fill;
  retryError: string | null;
  onRetryRun: () => void;
  onRunAgain: () => void;
  matterOptions: AdvocacyMatterSummary[];
  onOpenMatter?: (matterId: string) => void;
}) {
  const running = fill.phase === 'preparing' || fill.phase === 'researching';
  const allFindings = fill.run?.findings ?? [];
  const reviewFindings = allFindings.filter((finding) => finding.source !== 'completion_audit');
  const conflicts = reviewFindings.filter(hasCurrentConflict);
  const safeIds = fill.proposals
    .filter((finding) => !isAdvocacyFinding(finding) && !hasCurrentConflict(finding))
    .map((finding) => finding.id);

  return (
    <div className="meri-fill-work">
      {fill.phase === 'failed' || fill.phase === 'cancelled' ? (
        <p role="status" className="meri-fill-error-text meri-fill-work__error">
          {fill.phase === 'cancelled' ? 'This run was cancelled.' : `This run could not complete. ${fill.run?.error ?? ''}`}
          {' '}Existing findings are available below. Applied updates remain on the record.
        </p>
      ) : null}
      {!running ? <CompletionSummary fill={fill} conflictCount={conflicts.length} onRetry={onRetryRun} /> : null}
      {retryError ? <p className="meri-fill-error-text meri-fill-work__error">{retryError}</p> : null}
      {fill.cancelError ? <p className="meri-fill-error-text meri-fill-work__error">{errorText(fill.cancelError, 'Could not cancel this run.')}</p> : null}
      {fill.retryTaskError ? <p className="meri-fill-error-text meri-fill-work__error">{errorText(fill.retryTaskError, 'Could not retry that task.')}</p> : null}
      <div className="meri-fill-work__columns">
        <ActivityRail fill={fill} onRetryRun={onRetryRun} />
        <FindingsPanel
          clientName={clientName}
          fill={fill}
          findings={reviewFindings}
          running={running}
          matterOptions={matterOptions}
          onOpenMatter={onOpenMatter}
        />
      </div>
      <footer className="meri-fill-footer">
        <span className="meri-fill-footer__copy">
          <strong>{running ? 'Meri is still working' : footerTitle(fill)}</strong>
          <span>{running ? 'Findings appear as each pass completes. Closing this drawer does not stop the run.' : 'Unapplied proposals stay separate from the saved record. Attaching advocacy to a matter applies it immediately.'}</span>
        </span>
        {running ? (
          <button className="meri-fill-button meri-fill-button--quiet" disabled={fill.cancelPending} onClick={fill.cancelRun}>
            {fill.cancelPending ? 'Cancelling…' : 'Cancel run'}
          </button>
        ) : (
          <span className="meri-fill-footer__actions">
            <button className="meri-fill-button meri-fill-button--quiet" onClick={onRunAgain}>Run again</button>
            <button
              className="meri-fill-button meri-fill-button--brand"
              disabled={!safeIds.length}
              onClick={() => fill.setSelectedFindings([...new Set([...fill.selected, ...safeIds])])}
            >
              Accept all safe changes
            </button>
            <button className="meri-fill-button meri-fill-button--primary" disabled={!fill.selected.size || fill.phase === 'applying'} onClick={fill.applySelected}>
              {fill.phase === 'applying' ? 'Applying…' : `Apply ${fill.selected.size} update${fill.selected.size === 1 ? '' : 's'}`}
            </button>
          </span>
        )}
      </footer>
    </div>
  );
}

function CompletionSummary({
  fill,
  conflictCount,
  onRetry,
}: {
  fill: Fill;
  conflictCount: number;
  onRetry: () => void;
}) {
  const coverage = profileCoverage(fill.run?.findings ?? []);
  const progress = fill.run?.progress;
  const checks = progress?.completed ?? countCompletedTasks(fill.run?.tasks ?? []);
  const partial = fill.phase === 'partial' || fill.failedSources.length > 0;
  const applied = appliedFindingCount(fill.run?.findings ?? [], fill.applyOutcome?.applied ?? 0);
  return (
    <section className="meri-fill-summary">
      <div className="meri-fill-summary__message">
        <strong>{fill.phase === 'failed' || fill.phase === 'cancelled' ? 'Review saved findings from this run' : partial ? 'Meri completed most of the review' : 'Meri finished the first pass'}</strong>
        <p>
          {applied
            ? `${applied} update${applied === 1 ? ' has' : 's have'} already been applied from this run. Those changes remain on the record; review the remaining proposals below.`
            : fill.applyError
              ? 'The last apply request did not complete. Refresh the findings to confirm which changes were saved before retrying.'
              : 'Review the evidence and decide what belongs on the record. No updates from this run have been applied yet.'}
        </p>
      </div>
      {coverage ? (
        <div className="meri-fill-coverage">
          <span className="meri-fill-eyebrow">Profile coverage</span>
          <strong>{coverage.score}%</strong>
          <span className="meri-fill-coverage__bar" aria-hidden>
            <span style={{ width: `${coverage.score}%` }} />
          </span>
          <small>Deterministic coverage represented by this run; the API does not provide a before score.</small>
        </div>
      ) : null}
      <div className="meri-fill-summary__stats">
        <SummaryStat value={checks} label="checks completed" />
        <SummaryStat value={fill.proposals.length} label="proposed updates" />
        <SummaryStat value={fill.contextFindings.length} label="informational" />
        <SummaryStat value={conflictCount} label="need judgment" />
      </div>
      {partial ? (
        <div className="meri-fill-warning">
          <UIcon name="AlertCircle" size={16} />
          <span>
            <strong>Some sources were unavailable.</strong>{' '}
            {fill.failedSources.length ? `Could not read ${fill.failedSources.map(sourceLabel).join(', ')}.` : ''}
            {' '}Unavailable data is never reported as zero.
          </span>
          <button onClick={onRetry}>Retry</button>
        </div>
      ) : null}
    </section>
  );
}

function SummaryStat({ value, label }: { value: number; label: string }) {
  return <span><strong>{value}</strong><small>{label}</small></span>;
}

type StageDefinition = {
  id: string;
  label: string;
  taskTypes: string[];
  sourceCopy: string;
};

const STAGES: StageDefinition[] = [
  { id: 'understand', label: 'Understand client', taskTypes: [], sourceCopy: 'Client context and account setup' },
  { id: 'company', label: 'Research company', taskTypes: ['public_web', 'sam_gov', 'client_document'], sourceCopy: 'Website, SAM.gov and client documents' },
  { id: 'relationships', label: 'Reconstruct relationships', taskTypes: ['synced_email', 'relationship_history'], sourceCopy: 'Synced email and relationship history' },
  { id: 'government', label: 'Government & market footprint', taskTypes: ['program_elements', 'bill_tracker', 'federal_market', 'facility_resolution', 'district_nexus'], sourceCopy: 'Programs, bills, facilities and district nexus' },
  { id: 'advocacy', label: 'Advocacy history', taskTypes: ['lda', 'advocacy_history', 'lifecycle_outcomes'], sourceCopy: 'LDA, activity and lifecycle outcomes' },
  { id: 'verify', label: 'Verify & reconcile', taskTypes: ['reconciliation', 'completion_audit'], sourceCopy: 'Reconciliation and completion audit' },
];

type DisplayTask = Pick<FillTask, 'id' | 'taskType' | 'status' | 'errorMessage' | 'attempt' | 'maxAttempts'>;

function ActivityRail({ fill, onRetryRun }: { fill: Fill; onRetryRun: () => void }) {
  const tasks = useMemo(() => displayTasks(fill.run?.tasks, fill.run?.sourceStates), [fill.run]);
  const [openStages, setOpenStages] = useState<Set<string>>(new Set(['understand']));
  const stages = STAGES.map((stage) => {
    const children = tasks.filter((task) => stage.taskTypes.includes(task.taskType));
    return { stage, children, status: stageStatus(stage.id, children, fill.run?.stage, fill.run?.status) };
  });
  const active = stages.find(({ status }) => status === 'running') ?? stages.find(({ status }) => status === 'queued');
  const complete = stages.filter(({ status }) => status === 'completed').length;

  useEffect(() => {
    if (!active) return;
    setOpenStages((previous) => new Set(previous).add(active.stage.id));
  }, [active?.stage.id]);

  return (
    <aside className="meri-fill-activity">
      <div className="meri-fill-section-head">
        <span>Meri activity</span><small>{complete} of 6 passes complete</small>
      </div>
      <div className="meri-fill-stages">
        {stages.map(({ stage, children, status }) => {
          const expanded = openStages.has(stage.id);
          return (
            <div className="meri-fill-stage" key={stage.id}>
              <button
                className="meri-fill-stage__button"
                aria-expanded={expanded}
                onClick={() => setOpenStages((previous) => toggleSet(previous, stage.id))}
              >
                <StatusDot status={status} />
                <span className="meri-fill-stage__copy">
                  <strong>{stage.label}</strong>
                  <small>{stageMeta(status, children)}</small>
                </span>
                <UIcon name="ChevronRight" size={14} />
              </button>
              {expanded ? (
                <div className="meri-fill-stage__children">
                  {stage.id === 'understand' ? (
                    <TaskRow
                      task={{ id: 'client-context', taskType: 'client_context', status, errorMessage: null, attempt: 1, maxAttempts: 1 }}
                      aggregate
                    />
                  ) : children.length ? (
                    children.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        retrying={fill.retryTaskPending}
                        onRetry={() => task.id.startsWith('legacy-') ? onRetryRun() : fill.retryTask(task.id)}
                      />
                    ))
                  ) : (
                    <span className="meri-fill-stage__not-run">Not included in this run.</span>
                  )}
                  <span className="meri-fill-stage__sources">{stage.sourceCopy}</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {fill.phase === 'preparing' || fill.phase === 'researching' ? (
        <div className="meri-fill-current" role="status" aria-live="polite">
          <span className="meri-fill-current__mark"><UIcon name="Stars02" size={14} /></span>
          <p>{narration(active?.stage.label, active?.children)}</p>
          <div className="meri-fill-current__card">
            <span className="meri-fill-eyebrow">Current activity</span>
            <strong>{active?.stage.label ?? 'Preparing the review'}</strong>
            <span>{active?.stage.sourceCopy ?? 'Collecting governed client context.'}</span>
            <i><span /></i>
            <small>{taskCounts(fill.run?.progress, tasks)}</small>
          </div>
        </div>
      ) : null}
      {fill.run?.status === 'failed' && !tasks.some((task) => task.status === 'failed') ? (
        <button className="meri-fill-rail-retry" onClick={onRetryRun}>Retry the review</button>
      ) : null}
    </aside>
  );
}

function TaskRow({
  task,
  aggregate = false,
  retrying = false,
  onRetry,
}: {
  task: DisplayTask;
  aggregate?: boolean;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="meri-fill-task">
      <StatusDot status={task.status} small />
      <span><strong>{aggregate ? 'Governed client context' : taskLabel(task.taskType)}</strong><small>{taskDetail(task)}</small></span>
      {task.status === 'failed' && onRetry ? (
        <button disabled={retrying} onClick={onRetry}>{retrying ? 'Retrying…' : 'Retry'}</button>
      ) : null}
    </div>
  );
}

function StatusDot({ status, small = false }: { status: FillTaskStatus; small?: boolean }) {
  return <span className={`meri-fill-status-dot meri-fill-status-dot--${status}${small ? ' meri-fill-status-dot--small' : ''}`} aria-label={status} />;
}

const FINDING_GROUPS = [
  { id: 'company', label: 'Company' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'people', label: 'People & relationships' },
  { id: 'government', label: 'Government footprint' },
  { id: 'advocacy', label: 'Advocacy' },
] as const;

function FindingsPanel({
  clientName,
  fill,
  findings,
  running,
  matterOptions,
  onOpenMatter,
}: {
  clientName: string;
  fill: Fill;
  findings: FillFinding[];
  running: boolean;
  matterOptions: AdvocacyMatterSummary[];
  onOpenMatter?: (matterId: string) => void;
}) {
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(['company', 'capabilities', 'advocacy']));
  const grouped = FINDING_GROUPS.map((group) => ({
    ...group,
    findings: findings.filter((finding) => findingGroup(finding) === group.id),
  })).filter((group) => group.findings.length > 0);

  return (
    <section className="meri-fill-findings">
      <div className="meri-fill-section-head meri-fill-section-head--findings">
        <span>What Meri found</span>
        <small>{findingMeta(fill, running)}</small>
      </div>
      {!findings.length ? (
        <div className="meri-fill-none">
          <span />
          {running
            ? 'Findings appear here as each pass completes. You can review them while Meri is still working.'
            : 'Meri did not find any changes or related records to review.'}
        </div>
      ) : null}
      {grouped.map((group) => {
        const expanded = openGroups.has(group.id);
        const pending = group.findings.filter((finding) => finding.status === 'pending').length;
        return (
          <div className="meri-fill-finding-group" key={group.id}>
            <button
              className="meri-fill-finding-group__head"
              aria-expanded={expanded}
              onClick={() => setOpenGroups((previous) => toggleSet(previous, group.id))}
            >
              <UIcon name="ChevronRight" size={14} />
              <strong>{group.label}</strong>
              <small>{pending ? `${pending} to review` : `${group.findings.length} informational or settled`}</small>
            </button>
            {expanded ? (
              <div className="meri-fill-finding-group__items">
                {group.findings.map((finding) => (
                  <FindingCard
                    clientName={clientName}
                    key={finding.id}
                    finding={finding}
                    selected={fill.selected.has(finding.id)}
                    onAccept={() => fill.setSelectedFinding(finding.id, true)}
                    onUndoAccept={() => fill.setSelectedFinding(finding.id, false)}
                    onIgnore={() => fill.rejectFinding(finding.id, 'Kept current value in Fill with Meri review')}
                    onRestore={() => fill.restoreFinding(finding.id)}
                    matterOptions={matterOptions}
                    onAssignMatter={
                      finding.kind === 'advocacy_record'
                        ? (target) => fill.assignFindingMatter(finding.id, target)
                        : undefined
                    }
                    onNotAdvocacy={() => fill.rejectFinding(finding.id, 'Not advocacy (reviewed in Fill with Meri)')}
                    onOpenMatter={onOpenMatter}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
      {fill.applyError ? (
        <p className="meri-fill-error-text meri-fill-findings__error">
          {errorText(fill.applyError, 'Could not apply the accepted changes.')}
          {' '}Some updates may already be saved. <button onClick={() => void fill.refreshRun()}>Refresh findings</button>
        </p>
      ) : null}
      {fill.rejectError || fill.restoreError ? (
        <p className="meri-fill-error-text meri-fill-findings__error">
          {errorText(fill.rejectError ?? fill.restoreError, 'Could not save that review decision.')}
        </p>
      ) : null}
    </section>
  );
}

function FindingCard({
  clientName,
  finding,
  selected,
  onAccept,
  onUndoAccept,
  onIgnore,
  onRestore,
  matterOptions,
  onAssignMatter,
  onNotAdvocacy,
  onOpenMatter,
}: {
  clientName: string;
  finding: FillFinding;
  selected: boolean;
  onAccept: () => void;
  onUndoAccept: () => void;
  onIgnore: () => void;
  onRestore: () => void;
  matterOptions: AdvocacyMatterSummary[];
  onAssignMatter?: (
    target: { matterId: string } | { newMatter: { title: string; matterType?: string; summary?: string | null } },
  ) => Promise<{ findingId: string; matterId: string | null; alreadyApplied: boolean }>;
  onNotAdvocacy: () => void;
  onOpenMatter?: (matterId: string) => void;
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [matterOpen, setMatterOpen] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const advocacy = isAdvocacyFinding(finding);
  const conflict = hasCurrentConflict(finding);
  const informational = finding.status === 'informational';
  const rejected = finding.status === 'rejected';
  const accepted = finding.status === 'accepted' || Boolean(finding.appliedAt);
  const staged = selected && finding.status === 'pending' && !accepted;
  const proposed = finding.proposedValue as Record<string, unknown> | null | undefined;
  const title = advocacy
    ? (typeof proposed?.title === 'string' && proposed.title) ||
      (typeof proposed?.label === 'string' && proposed.label) ||
      humanizeKey(finding.targetKey)
    : humanizeKey(finding.targetKey);

  const handleAssign = async (
    target: { matterId: string } | { newMatter: { title: string } },
  ) => {
    if (!onAssignMatter) return;
    setAssigning(true);
    setAssignError(null);
    try {
      const result = await onAssignMatter(target);
      setMatterOpen(false);
      if (result.matterId) onOpenMatter?.(result.matterId);
    } catch (error) {
      setAssignError(errorText(error, 'Could not assign this finding to a matter.'));
    } finally {
      setAssigning(false);
    }
  };

  return (
    <article className={`meri-fill-card${conflict ? ' meri-fill-card--conflict' : ''}${staged ? ' meri-fill-card--selected' : ''}`}>
      <div className="meri-fill-card__body">
        <div className="meri-fill-card__label">
          <span>{title}</span>
          <small>{findingTag(finding, conflict)}</small>
        </div>
        {advocacy ? (
          <div className="meri-fill-card__advocacy">
            <strong>{formatValue(finding.proposedValue) ?? title}</strong>
            <small>{freshnessOf(finding) ?? sourceLabel(finding.source)}</small>
            {finding.kind === 'advocacy_outcome' ? (
              <p>This may be a related outcome. Applying it does not claim the client's advocacy caused it.</p>
            ) : null}
          </div>
        ) : informational ? (
          <div className="meri-fill-card__information">
            <strong>{formatValue(finding.proposedValue) ?? 'Related record'}</strong>
            <span>Related context · nothing to apply</span>
          </div>
        ) : (
          <div className="meri-fill-card__values">
            <span><small>Current</small><span className={!formatValue(finding.currentValue) ? 'is-empty' : ''}>{formatValue(finding.currentValue) ?? 'Not set'}</span></span>
            <span><small>Meri found</small><strong>{formatValue(finding.proposedValue) ?? '—'}</strong></span>
          </div>
        )}
        {conflict && finding.status === 'pending' ? (
          <div className="meri-fill-card__conflict">
            <UIcon name="AlertCircle" size={15} />
            <span>This differs from the record. The existing value stays in place until you decide.</span>
          </div>
        ) : null}
      </div>
      <div className="meri-fill-card__source">
        <span><b>{sourceLabel(finding.source)}</b>{sourceWhere(finding)}</span>
        {finding.evidence.length || advocacy ? (
          <button aria-expanded={evidenceOpen} onClick={() => setEvidenceOpen((value) => !value)}>
            {evidenceOpen ? 'Hide evidence' : 'Evidence'}
          </button>
        ) : null}
      </div>
      {evidenceOpen ? <EvidencePanel finding={finding} clientName={clientName} /> : null}
      <div className="meri-fill-card__actions">
        {accepted ? (
          <span className="meri-fill-card__settled meri-fill-card__settled--accepted">
            <UIcon name="CheckCircle" size={15} /><strong>Applied</strong>
          </span>
        ) : staged ? (
          <span className="meri-fill-card__settled meri-fill-card__settled--accepted">
            <UIcon name="CheckCircle" size={15} /><strong>Accepted for apply</strong><button onClick={onUndoAccept}>Undo</button>
          </span>
        ) : rejected ? (
          <span className="meri-fill-card__settled">
            <strong>{advocacy ? 'Marked not advocacy' : 'Keeping current value'}</strong><button onClick={onRestore}>Undo</button>
          </span>
        ) : informational ? (
          <span className="meri-fill-card__no-action">Related record · nothing to apply</span>
        ) : advocacy ? (
          <>
            {onAssignMatter ? (
              <button className="meri-fill-mini-button meri-fill-mini-button--brand" onClick={() => setMatterOpen(true)}>Attach to Matter</button>
            ) : null}
            <button className="meri-fill-mini-button" onClick={onNotAdvocacy}>Not advocacy</button>
            {!onAssignMatter ? <button className="meri-fill-mini-button meri-fill-mini-button--dark" onClick={onAccept}>Accept</button> : null}
          </>
        ) : conflict ? (
          <>
            <button className="meri-fill-mini-button" onClick={onIgnore}>Keep current</button>
            <button className="meri-fill-mini-button meri-fill-mini-button--dark" onClick={onAccept}>Use Meri's finding</button>
          </>
        ) : (
          <>
            <button className="meri-fill-mini-button meri-fill-mini-button--dark" onClick={onAccept}>Accept</button>
            <button className="meri-fill-mini-button" onClick={onIgnore}>Ignore</button>
          </>
        )}
      </div>
      {matterOpen ? (
        <CapiroModal open title="Attach to a Matter" onClose={() => setMatterOpen(false)}>
          <AssignFindingMatterForm
            findingTitle={title}
            matterOptions={matterOptions}
            busy={assigning}
            error={assignError}
            onCancel={() => setMatterOpen(false)}
            onAttach={(matterId) => handleAssign({ matterId })}
            onCreate={(newTitle) => handleAssign({ newMatter: { title: newTitle } })}
          />
        </CapiroModal>
      ) : null}
    </article>
  );
}

function EvidencePanel({ finding, clientName }: { finding: FillFinding; clientName: string }) {
  const freshness = freshnessOf(finding);
  const attribution = clientAttributionEvidence(finding);
  const visibleEvidence = finding.evidence.slice(0, 4);
  const links = visibleEvidence.map((item) => sourceUrl(item.url)).filter(Boolean);
  return (
    <div className="meri-fill-evidence">
      {attribution ? (
        <>
          <span><small>Client under review</small><span>{clientName}</span></span>
          <span><small>Client attribution</small><strong>{attribution.confirmed ? 'Confirmed client mapping' : 'Needs identity verification'}</strong></span>
          <span><small>Match basis</small><span>{attribution.basis}</span></span>
          {attribution.identity.map(([label, value]) => <span key={label}><small>{label}</small><span>{value}</span></span>)}
          {!attribution.identity.length ? <p>No organization or witness affiliation was supplied with this proposal.</p> : null}
          {!attribution.confirmed ? <p>A similar name or a high proposal score does not establish that this record belongs to this client. Verify the source organization before confirming the client mapping.</p> : null}
          {attribution.url && !links.includes(attribution.url) ? <span><small>Original source</small><a href={attribution.url} target="_blank" rel="noreferrer noopener">Open original source</a></span> : null}
          {!attribution.url && !links.length ? <p>No source link was provided. Verify the original record before accepting this match.</p> : null}
        </>
      ) : null}
      {!finding.evidence.length && !attribution ? <p>No source evidence was supplied with this proposal.</p> : null}
      {visibleEvidence.map((item, index) => (
        <span key={`${finding.id}-evidence-${index}`}>
          <small>{index === 0 ? 'Evidence' : ''}</small>
          <span>
            {sourceUrl(item.url) ? <a href={sourceUrl(item.url)!} target="_blank" rel="noreferrer noopener">{item.label}</a> : item.label}
            {item.excerpt ? <em>{item.excerpt}</em> : null}
          </span>
        </span>
      ))}
      <span><small>{attribution ? 'Proposal score' : 'Confidence'}</small><span>{Math.round(finding.confidence * 100)}%{attribution ? ' · not proof of identity' : ''}{freshness ? ` · ${freshness}` : ' · observation date unavailable'}</span></span>
    </div>
  );
}

function AssignFindingMatterForm({
  findingTitle,
  matterOptions,
  busy,
  error,
  onCancel,
  onAttach,
  onCreate,
}: {
  findingTitle: string;
  matterOptions: AdvocacyMatterSummary[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onAttach: (matterId: string) => void;
  onCreate: (title: string) => void;
}) {
  const [mode, setMode] = useState<'existing' | 'new'>(matterOptions.length ? 'existing' : 'new');
  const [matterId, setMatterId] = useState('');
  const [newTitle, setNewTitle] = useState(findingTitle);
  return (
    <div className="meri-fill-assign">
      <p>
        This action applies the advocacy finding immediately and assigns it to the Matter. It does
        not wait for the drawer's final Apply button.
      </p>
      {matterOptions.length ? (
        <div className="meri-fill-assign__modes" role="radiogroup" aria-label="Matter target">
          <label><input type="radio" name="meri-fill-matter-mode" checked={mode === 'existing'} onChange={() => setMode('existing')} disabled={busy} />Existing Matter</label>
          <label><input type="radio" name="meri-fill-matter-mode" checked={mode === 'new'} onChange={() => setMode('new')} disabled={busy} />Create new</label>
        </div>
      ) : <small>No Matters exist for this client yet. This will create the first one.</small>}
      {mode === 'existing' && matterOptions.length ? (
        <select value={matterId} onChange={(event) => setMatterId(event.target.value)} disabled={busy}>
          <option value="">Select a Matter…</option>
          {matterOptions.map((matter) => <option key={matter.id} value={matter.id}>{matter.title}</option>)}
        </select>
      ) : (
        <label className="meri-fill-assign__title">Matter title<input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} maxLength={300} disabled={busy} /></label>
      )}
      {error ? <p className="meri-fill-error-text">{error}</p> : null}
      <div className="meri-fill-assign__actions">
        <CapiroButton variant="secondary" size="compact" disabled={busy} onClick={onCancel}>Cancel</CapiroButton>
        {mode === 'existing' && matterOptions.length ? (
          <CapiroButton variant="primary" size="compact" disabled={busy || !matterId} onClick={() => onAttach(matterId)}>{busy ? 'Applying…' : 'Attach now'}</CapiroButton>
        ) : (
          <CapiroButton variant="primary" size="compact" disabled={busy || !newTitle.trim()} onClick={() => onCreate(newTitle.trim())}>{busy ? 'Applying…' : 'Create and apply'}</CapiroButton>
        )}
      </div>
    </div>
  );
}

const FILE_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/plain',
};

const SOURCE_LABELS: Record<string, string> = {
  public_web: 'Public web', website: 'Client website', synced_email: 'Synced email',
  sam_gov: 'SAM.gov', lda: 'LDA filings', program_elements: 'Program elements',
  bill_tracker: 'Bill tracker', client_document: 'Capability document',
  federal_market: 'Federal market data', facility_resolution: 'Facility resolution',
  district_nexus: 'District nexus', advocacy_history: 'Advocacy history',
  lifecycle_outcomes: 'Lifecycle outcomes', reconciliation: 'Reconciliation',
  completion_audit: 'Completion audit',
};

const TASK_LABELS: Record<string, string> = {
  public_web: 'Public web research', sam_gov: 'SAM.gov identity', client_document: 'Capability document',
  synced_email: 'Synced email', relationship_history: 'Relationship history',
  program_elements: 'Program elements', bill_tracker: 'Bill tracker', federal_market: 'Federal market footprint',
  facility_resolution: 'Facility resolution', district_nexus: 'District nexus', lda: 'LDA filings',
  advocacy_history: 'Advocacy history', lifecycle_outcomes: 'Lifecycle outcomes',
  reconciliation: 'Reconcile findings', completion_audit: 'Completion audit', client_context: 'Governed client context',
};

function drawerTitle(phase: Fill['phase']): string {
  if (phase === 'preparing' || phase === 'researching') return 'Meri is updating this record';
  if (['proposals', 'partial', 'context-only', 'no-changes', 'applying', 'apply-partial', 'applied'].includes(phase)) return 'Client record review';
  return 'Fill with Meri';
}

function drawerSubtitle(phase: Fill['phase']): string {
  if (phase === 'preparing' || phase === 'researching') return 'Researching, connecting records, and checking what Capiro already knows.';
  if (phase === 'failed' || phase === 'permission-denied') return 'Meri could not complete the review. Check existing findings before retrying.';
  if (phase === 'partial') return 'Meri completed most of the review. Check applied updates and remaining proposals below.';
  if (['proposals', 'context-only', 'no-changes', 'applying', 'apply-partial', 'applied'].includes(phase)) return 'Meri finished the first pass. Review every finding before it reaches the profile.';
  return 'Complete and improve this client record from connected and reliable public sources.';
}

function footerTitle(fill: Fill): string {
  if (fill.phase === 'applied') return `${fill.applyOutcome?.applied ?? 0} updates applied`;
  if (fill.phase === 'apply-partial') return `${fill.applyOutcome?.failed ?? 0} updates still need attention`;
  if (!fill.proposals.length) return 'Review complete';
  return `${fill.proposals.length} proposal${fill.proposals.length === 1 ? '' : 's'} ready for review`;
}

function contentTypeFor(name: string): string | null {
  return FILE_CONTENT_TYPES[name.trim().toLowerCase().split('.').pop() ?? ''] ?? null;
}

function documentAttachmentId(sourceStates: Record<string, unknown> | undefined): string | null {
  const state = sourceStates?.client_document;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const attachmentId = (state as { attachmentId?: unknown }).attachmentId;
  return typeof attachmentId === 'string' && attachmentId ? attachmentId : null;
}

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? humanizeKey(source);
}

function taskLabel(taskType: string): string {
  return TASK_LABELS[taskType] ?? humanizeKey(taskType);
}

function humanizeKey(key: string): string {
  const leaf = key.split('.').pop() ?? key;
  const spaced = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function formatValue(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((entry) => formatValue(entry) ?? '—').join(', ');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const name = record.name ?? record.title ?? record.label ?? record.summary;
    if (typeof name === 'string') return name;
    return Object.entries(record)
      .filter(([key, entry]) => entry != null && entry !== '' && !['warnings', 'calculatedAt', 'completed', 'missing'].includes(key))
      .slice(0, 6)
      .map(([key, entry]) => `${humanizeKey(key)}: ${formatValue(entry) ?? '—'}`)
      .join(' · ');
  }
  return String(value);
}

function isAdvocacyFinding(finding: FillFinding): boolean {
  return finding.kind === 'advocacy_record' || finding.kind === 'advocacy_outcome';
}

function hasCurrentConflict(finding: FillFinding): boolean {
  if (finding.status !== 'pending' || isAdvocacyFinding(finding)) return false;
  if (finding.currentValue == null || finding.currentValue === '') return false;
  return stableValue(finding.currentValue) !== stableValue(finding.proposedValue);
}

function stableValue(value: unknown): string {
  if (typeof value !== 'object' || value == null) return String(value).trim().toLowerCase();
  try { return JSON.stringify(value); } catch { return String(value); }
}

function findingTag(finding: FillFinding, conflict: boolean): string {
  if (finding.status === 'informational') return 'Information';
  if (isAdvocacyFinding(finding)) return finding.kind === 'advocacy_outcome' ? 'Related outcome' : 'Advocacy record';
  if (conflict) return 'Needs your judgment';
  return finding.factKind === 'recommendation' ? 'Recommendation' : 'Proposed update';
}

function sourceWhere(finding: FillFinding): string {
  const evidenceSource = finding.evidence.find((item) => item.source)?.source;
  return evidenceSource && evidenceSource !== finding.source ? ` · ${sourceLabel(evidenceSource)}` : '';
}

function findingGroup(finding: FillFinding): typeof FINDING_GROUPS[number]['id'] {
  if (isAdvocacyFinding(finding) || ['lda_history', 'advocacy_record', 'advocacy_outcome'].includes(finding.kind)) return 'advocacy';
  if (['capability', 'product', 'offering'].includes(finding.kind) || /capabil|product|offering/i.test(finding.targetKey)) return 'capabilities';
  if (['person', 'relationship', 'relationship_link'].includes(finding.kind) || /person|contact|relationship/i.test(finding.targetKey)) return 'people';
  if (['government_identity', 'facility', 'facility_resolution', 'district_nexus', 'federal_footprint', 'program_element', 'bill_recommendation'].includes(finding.kind) || ['sam_gov', 'program_elements', 'bill_tracker', 'federal_market', 'facility_resolution', 'district_nexus'].includes(finding.source)) return 'government';
  return 'company';
}

function freshnessOf(finding: FillFinding): string | null {
  const observed = finding.evidence.map((item) => item.observedAt).find(Boolean);
  if (!observed) return null;
  const date = new Date(observed);
  if (Number.isNaN(date.getTime())) return null;
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return 'Seen today';
  if (days === 1) return 'Seen yesterday';
  if (days < 45) return `Seen ${days} days ago`;
  return `Seen ${date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
}

function profileCoverage(findings: FillFinding[]): { score: number } | null {
  const finding = findings.find((item) => item.source === 'completion_audit' && item.kind === 'profile_completion');
  const proposed = finding?.proposedValue as { score?: unknown } | null | undefined;
  return typeof proposed?.score === 'number' ? { score: Math.max(0, Math.min(100, proposed.score)) } : null;
}

function displayTasks(tasks: FillTask[] | undefined, states: Record<string, unknown> | undefined): DisplayTask[] {
  if (tasks?.length) return tasks;
  return Object.entries(states ?? {}).map(([taskType, state], index) => {
    const record = state && typeof state === 'object' && !Array.isArray(state) ? state as Record<string, unknown> : {};
    const rawStatus = typeof state === 'string' ? state : record.status;
    return {
      id: `legacy-${taskType}-${index}`,
      taskType,
      status: normalizeTaskStatus(rawStatus),
      errorMessage: typeof record.error === 'string' ? record.error : null,
      attempt: 1,
      maxAttempts: 1,
    };
  });
}

function normalizeTaskStatus(value: unknown): FillTaskStatus {
  if (value === 'complete' || value === 'succeeded' || value === 'success') return 'completed';
  if (value === 'error' || value === 'unavailable') return 'failed';
  if (['queued', 'running', 'completed', 'failed', 'skipped', 'cancelled'].includes(String(value))) return String(value) as FillTaskStatus;
  return 'queued';
}

function stageStatus(
  id: string,
  tasks: DisplayTask[],
  runStage: string | undefined,
  runStatus: string | undefined,
): FillTaskStatus {
  if (id === 'understand') {
    if (runStage === 'preparing' || (!runStage && runStatus === 'running')) return 'running';
    if (runStage === 'failed') return 'failed';
    if (runStage === 'cancelled') return 'cancelled';
    return 'completed';
  }
  if (!tasks.length) return 'skipped';
  if (tasks.some((task) => task.status === 'running')) return 'running';
  if (tasks.some((task) => task.status === 'failed')) return 'failed';
  if (tasks.some((task) => task.status === 'queued')) return 'queued';
  if (tasks.every((task) => task.status === 'cancelled')) return 'cancelled';
  return 'completed';
}

function stageMeta(status: FillTaskStatus, tasks: DisplayTask[]): string {
  if (status === 'running') return 'Working now';
  if (status === 'failed') return `${tasks.filter((task) => task.status === 'failed').length || 1} check failed`;
  if (status === 'queued') return 'Waiting';
  if (status === 'skipped') return 'Not included in this run';
  if (status === 'cancelled') return 'Cancelled';
  return `${tasks.filter((task) => task.status === 'completed').length || 1} check${tasks.length === 1 ? '' : 's'} completed`;
}

function taskDetail(task: DisplayTask): string {
  if (task.status === 'failed') return task.errorMessage ?? `Failed after ${task.attempt} attempt${task.attempt === 1 ? '' : 's'}`;
  if (task.status === 'running') return 'Reading and reconciling source records…';
  if (task.status === 'queued') return task.errorMessage ?? 'Queued to run';
  if (task.status === 'completed') return 'Completed';
  if (task.status === 'cancelled') return 'Cancelled';
  return 'Not required';
}

function narration(label: string | undefined, tasks: DisplayTask[] | undefined): string {
  const activeTask = tasks?.find((task) => task.status === 'running');
  return activeTask ? `Meri is working on ${taskLabel(activeTask.taskType).toLowerCase()}.` : `Meri is ${label?.toLowerCase() ?? 'preparing the review'}.`;
}

function taskCounts(progress: FillProgress | undefined, tasks: DisplayTask[]): string {
  if (typeof progress?.total === 'number') return `${progress.completed} of ${progress.total} checks complete${progress.failed ? ` · ${progress.failed} failed` : ''}`;
  return `${tasks.filter((task) => task.status === 'completed').length} of ${tasks.length} checks complete`;
}

function countCompletedTasks(tasks: FillTask[]): number {
  return tasks.filter((task) => task.status === 'completed').length;
}

function findingMeta(fill: Fill, running: boolean): string {
  if (running) return `${fill.proposals.length} proposed so far`;
  return `${fill.proposals.length} proposed · ${fill.contextFindings.length} informational`;
}

function toggleSet(previous: Set<string>, id: string): Set<string> {
  const next = new Set(previous);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
