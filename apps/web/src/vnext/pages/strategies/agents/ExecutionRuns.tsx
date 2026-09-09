/*
 * Execution runs — /strategies/agents/runs (STRATEGIES-HANDOFF §7.9).
 *
 * Governance invariants (§11, BUILD-CONTRACT hard rules — release blockers):
 *  7. Execution STAGES only. This surface renders NO send control — no send
 *     button, no send-approval grant, nothing that marks a staged artifact as
 *     sent. A parked send-approval task renders its staged preview READ-ONLY.
 *     The Stage-H security card below is not decorative — it stays.
 *  8. A failed run is never hidden: every failure state renders its reason.
 *  9. Run states are rendered exactly as the server reports them (mapped only
 *     to the §7.9 display vocabulary) — never derived client-side.
 *  - "Edit plan" invalidates prior approval, and says so before navigating.
 *
 * The dark banner copy is product policy — do not reword.
 */
import { strategyArtifactHref } from '../lib/artifact-link.js';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../../components/feedback/index.js';
import {
  CapiroBellIcon,
  CapiroFileTextIcon,
  CapiroSafetyCertificateIcon,
} from '../../../components/icons/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import {
  clientName,
  useCancelRun,
  useClientsLite,
  useExecuteRun,
  useExecutionRuns,
  useResumeRun,
  useRetryRun,
  useRunPolicy,
  useReconcileRun,
  useStrategy,
  useStrategies,
} from '../strategies-api.js';
import {
  classifyWaitingReason,
  isAwaitingSendApproval,
  isAmbiguousRequestError,
  isPriorApprovalInvalidated,
  sendApprovalTask,
} from '../../../../pages/strategy/agents/agent-utils.js';
import { errorMessage } from '../../../../lib/error-message.js';
import type {
  ExecutionRun,
  ExecutionTask,
  ExecutionTaskStatus,
  RunState,
} from '../../../../pages/strategy/types.js';
import { BannerLockGlyph, fmtRelative, isForbidden, StaleNote, staleOrError } from './agents-shared.js';

/** spStrategy.id is a UUID column; anything else is a malformed link, not a query. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/*
 * Server run state → §7.9 display token + pill tone. The label is the exact
 * vocabulary token (mono — §5.1 run-state tokens); the dot carries the tone.
 * `staged` renders as "staged_not_sent" — a TERMINAL SUCCESS state in this
 * release (§8.11), never a failure and never "sent".
 */
const RUN_PILL: Record<RunState, { token: string; tone: string }> = {
  queued: { token: 'Queued', tone: '' },
  planning: { token: 'Preparing plan', tone: 'st-pill--accent' },
  waiting_for_input: { token: 'Needs attention', tone: 'st-pill--warning' },
  ready_for_review: { token: 'Ready for review', tone: 'st-pill--accent' },
  approved: { token: 'Approved', tone: 'st-pill--accent' },
  executing: { token: 'Preparing drafts', tone: 'st-pill--accent' },
  staged: { token: 'Drafts ready · not sent', tone: 'st-pill--success' },
  completed: { token: 'Completed', tone: 'st-pill--success' },
  failed: { token: 'Failed', tone: 'st-pill--error' },
  failed_recoverable: { token: 'Can retry', tone: 'st-pill--warning' },
  failed_terminal: { token: 'Failed', tone: 'st-pill--error' },
  canceled: { token: 'Canceled', tone: '' },
  superseded: { token: 'Replaced', tone: '' },
};

/** The §7.9 run-state model card — the full supported vocabulary, verbatim. */
const RUN_STATE_MODEL: ReadonlyArray<{ token: string; note: string }> = [
  { token: 'Queued', note: 'Accepted, waiting for a worker.' },
  { token: 'Preparing plan', note: 'The agent is drafting the task plan.' },
  { token: 'Needs attention', note: 'Parked for human input — the reason stays on the run.' },
  { token: 'Ready for review', note: 'Plan staged and awaiting human review.' },
  { token: 'Approved', note: 'Plan approved by a person; execution has not started.' },
  { token: 'Preparing drafts', note: 'Tasks are being staged.' },
  { token: 'Completed', note: 'Every task finished.' },
  { token: 'Can retry', note: 'Failed in a repairable way — Retry is available.' },
  { token: 'Failed', note: 'Terminal failure; the reason stays visible.' },
  { token: 'Canceled', note: 'Stopped by a person.' },
  { token: 'Replaced', note: 'Replaced by a newer attempt.' },
  { token: 'Drafts ready · not sent', note: 'Drafts are ready for review. Nothing was sent.' },
];

const TERMINAL: ReadonlySet<RunState> = new Set([
  'completed',
  'staged',
  'failed',
  'failed_terminal',
  'canceled',
  'superseded',
]);

/* Runs that need a human float: review obligations and repairable failures
 * lead, then in-flight work; history sinks. Newest first within a rank. */
const ATTENTION_RANK: Record<RunState, number> = {
  ready_for_review: 0,
  waiting_for_input: 1,
  failed_recoverable: 2,
  approved: 3,
  executing: 4,
  planning: 5,
  queued: 6,
  failed: 7,
  failed_terminal: 7,
  completed: 8,
  staged: 8,
  canceled: 9,
  superseded: 9,
};

const TASK_STATUS_PILL: Record<ExecutionTaskStatus, { label: string; tone: string }> = {
  planned: { label: 'Planned', tone: '' },
  staged: { label: 'Staged', tone: 'st-pill--accent' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'st-pill--warning' },
  blocked: { label: 'Blocked', tone: 'st-pill--error' },
  done: { label: 'Done', tone: 'st-pill--success' },
  skipped: { label: 'Skipped', tone: '' },
};

const TASK_TYPE_LABEL: Record<ExecutionTask['type'], string> = {
  workspace_draft: 'Workspace draft',
  outreach_record: 'Outreach record',
  await_send_approval: 'Send approval',
};

/* Task icon tile glyph (design handoff — "a 32px tinted icon tile"), by task
 * TYPE. The tile's tint reuses the SAME tone already computed for the task's
 * own status pill (TASK_STATUS_PILL) — real, already-fetched data — rather
 * than inventing a second, type-based color scheme. */
const TASK_TYPE_ICON: Record<ExecutionTask['type'], typeof CapiroFileTextIcon> = {
  workspace_draft: CapiroFileTextIcon,
  outreach_record: CapiroBellIcon,
  await_send_approval: CapiroSafetyCertificateIcon,
};

function RunPill({ state }: { state: RunState }) {
  const meta = RUN_PILL[state] ?? { token: state, tone: '' };
  return (
    <span className={`st-pill ${meta.tone}`.trim()}>
      <span className="st-mono">{meta.token}</span>
    </span>
  );
}

export function ExecutionRuns() {
  const [params, setParams] = useSearchParams();
  /* The filter is a URL (?strategyId=…) — back/forward works (§6). */
  const strategyFilter = params.get('strategyId');
  /* The criteria modal follows its URL param on direct loads and navigation. */
  const stageHOpen = params.get('stage-h') === '1';
  const openStageH = () => {
    const next = new URLSearchParams(params);
    next.set('stage-h', '1');
    setParams(next, { replace: true });
  };
  const closeStageH = () => {
    const next = new URLSearchParams(params);
    next.delete('stage-h');
    setParams(next, { replace: true });
  };
  const runs = useExecutionRuns(strategyFilter, true);
  const strategies = useStrategies();
  const clients = useClientsLite();
  /* "View approval rules" — purely a local expand/collapse over the SAME
   * static criteria text already in the security card below; no fetch, no
   * mutation, no navigation (§11 rule 7 stays intact). The URL param
   * ?stage-h=1 is the deep-link target (see openStageH/closeStageH above). */

  const strategyLabel = (strategyId: string | null): { title: string; client: string } => {
    if (!strategyId) return { title: 'Firm-level', client: '' };
    const s = strategies.data?.find((r) => r.id === strategyId);
    return { title: s?.title ?? 'Strategy unavailable', client: clientName(clients.data, s?.clientId) };
  };

  const rows = useMemo(() => {
    const list = [...(runs.data ?? [])];
    list.sort((a, b) => {
      const rank = ATTENTION_RANK[a.state] - ATTENTION_RANK[b.state];
      if (rank !== 0) return rank;
      return (a.createdAt < b.createdAt ? 1 : -1);
    });
    return list;
  }, [runs.data]);

  const active = rows.filter((r) => !TERMINAL.has(r.state));
  const history = rows.filter((r) => TERMINAL.has(r.state));
  const state = staleOrError(runs);
  /* Design handoff "runSummary" ("4 runs · 2 need review") — real, already-
   * classified data (ready_for_review is a human-obligation state; a
   * recoverable failure is too), never a fabricated count. */
  const needsReview = rows.filter(
    (r) => r.state === 'ready_for_review' || r.state === 'failed_recoverable',
  ).length;

  return (
    <div className="st-agents">
      {/* Policy copy — do not reword (§7.9, BUILD-CONTRACT). */}
      <div className="st-dark-banner st-dark-banner--agents">
        <span className="st-dark-banner__icon" aria-hidden="true">
          <BannerLockGlyph />
        </span>
        <div>
          <p className="st-dark-banner__title">
            Drafts stay here for your review. Nothing is sent.
          </p>
          <p className="st-dark-banner__sub">
            The Execution Agent prepares Workspace drafts and outreach records for human
            review. Nothing is sent from this surface.
          </p>
        </div>
        <span className="st-dark-banner__chip">Stage only</span>
      </div>

      {state === 'stale' && <StaleNote dataUpdatedAt={runs.dataUpdatedAt} />}

      {/* Two-column layout (design handoff "Execution runs tab" — 1fr/380px):
          active run(s) + the run-state-model card on the left, execution
          history + the security-control card on the right. The two static
          reference cards render unconditionally in their column regardless of
          the run list's own loading/error/empty state — they are reference
          material, not run data, and must never disappear (§9.1: a panel
          never disappears because a source failed). */}
      <div className="st-agents__run-grid">
        <div className="st-agents__run-col">
          {runs.isLoading ? (
            <div className="st-agents__list">
              {[0, 1].map((i) => (
                <div key={i} className="st-card">
                  <div className="st-card__body st-agents__skeleton-card">
                    <CapiroSkeleton height={18} width="45%" />
                    <CapiroSkeleton height={14} width="85%" />
                    <CapiroSkeleton height={14} width="65%" />
                  </div>
                </div>
              ))}
            </div>
          ) : state === 'error' ? (
            isForbidden(runs.error) ? (
              <CapiroEmptyState
                title="No access to execution runs"
                description="Your role does not include agent execution review. The runs are intact — ask an administrator for the agentic-Meri feature if you should see them."
              />
            ) : (
              <CapiroErrorState
                title="Execution runs could not be loaded"
                description={`${errorMessage(runs.error, 'The strategy service did not respond.')} Your data is intact — retry to reload the runs.`}
                onRetry={() => void runs.refetch()}
              />
            )
          ) : rows.length === 0 ? (
            <CapiroEmptyState
              title="No execution runs yet"
              description="Stage a node's execution from the strategy editor — the planned run lands here for review before anything is staged."
            />
          ) : active.length > 0 ? (
            <div className="st-agents__section">
              {/* Design handoff — label stacked above a real "runSummary"
                  line ("N runs · M need review"), both real already-computed
                  counts over the full run list, never fabricated. */}
              <div className="st-agents__section-head st-agents__section-head--stack">
                <h2 className="st-section-label">Runs</h2>
                <span className="st-agents__section-summary">
                  {rows.length} run{rows.length === 1 ? '' : 's'}
                  {needsReview > 0
                    ? ` · ${needsReview} need${needsReview === 1 ? 's' : ''} review`
                    : ''}
                </span>
              </div>
              <div className="st-agents__list">
                {active.map((run) => (
                  <RunCard key={run.id} run={run} label={strategyLabel(run.strategyId)} />
                ))}
              </div>
            </div>
          ) : null}

          {/* ---- What each status means (§7.9) — the full supported vocabulary --- */}
          <div className="st-agents__section">
            <div className="st-card">
              <div className="st-card__header">
                <h2 className="st-card__title">What each status means</h2>
              </div>
              <div className="st-card__body">
                <div className="st-agents__states-grid">
                  {RUN_STATE_MODEL.map((s) => (
                    <div key={s.token} className="st-agents__state-row">
                      <span className="st-mono st-agents__state-token">{s.token}</span>
                      <span className="st-agents__meta">{s.note}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="st-agents__run-col">
          {!runs.isLoading && state !== 'error' && history.length > 0 && (
            <div className="st-agents__section">
              <div className="st-agents__section-head">
                <h2 className="st-section-label">Execution history</h2>
                <span className="st-mono st-agents__count">{history.length}</span>
              </div>
              <div className="st-agents__list">
                {history.map((run) => (
                  <RunCard key={run.id} run={run} label={strategyLabel(run.strategyId)} />
                ))}
              </div>
            </div>
          )}

          {/* ---- Sending and approval (§7.9/§11 rule 9) — NOT decorative ------
            The handoff links this card to the Stage-H criteria via the
            ?stage-h=1 URL param (deep-linkable, bookmarkable). The criteria
            also render inline in the modal as a read-only expansion of the
            same static text. */}
          <div className="st-agents__section">
            <div className="st-card st-agents__security">
              <div className="st-card__header">
                <h2 className="st-card__title">Sending and approval</h2>
              </div>
              <div className="st-card__body">
                <p className="st-agents__security-headline">No direct send action is available.</p>
                <p className="st-agents__security-copy">
                  No direct send action exists on this surface. Outreach drafts are prepared for
                  human review. Sending is not available from this screen.
                </p>
                <ul className="st-agents__security-list">
                  <li>Draft preparation does not authorize sending.</li>
                  <li>Sending requires separate organization authorization and security controls.</li>
                  <li>
                    Approval applies to the exact content reviewed. A material edit requires a new review.
                  </li>
                </ul>
                {/* The single most safety-emphasized control in the design
                    handoff — solid red (`--st-error-fg`, the same #B42318
                    token this file already uses for error states elsewhere).
                    Purely informational: it only expands the SAME static
                    criteria text above into a focused view. No mutation, no
                    external link, nothing that sends/approves/transmits
                    anything (§11 rule 7 stays intact). */}
                <button
                  type="button"
                  className="st-agents__stageh-btn"
                  onClick={openStageH}
                >
                  View approval rules
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Read-only expanded view of the SAME criteria rendered in the card
          above — never a second, divergent copy of the policy text. */}
      <CapiroModal
        open={stageHOpen}
        title="Sending and approval rules"
        onClose={closeStageH}
      >
        <p className="st-agents__modal-copy">
          No direct send action exists on this surface. Outreach drafts are prepared for human
          review. Sending is not available from this screen.
        </p>
        <ul className="st-agents__modal-list">
          <li>Draft preparation does not authorize sending.</li>
          <li>Sending requires separate organization authorization and security controls.</li>
          <li>Approval applies to the exact content reviewed. A material edit requires a new review.</li>
        </ul>
      </CapiroModal>
    </div>
  );
}

/*
 * run.trigger (agent-utils.ts normalizeRun: `str(item.trigger) ?? 'manual'`)
 * carries the same real values as the AgentRun union it is projected from —
 * 'manual' | 'scheduled' | 'event' — though ExecutionRun's own field type
 * stays a bare `string` for forward compatibility, so any other server value
 * still renders (verbatim) rather than being hidden.
 */
const TRIGGER_LABEL: Record<string, string> = {
  manual: 'Triggered manually',
  scheduled: 'Triggered on schedule',
  event: 'Triggered by an event',
};

function triggerLabel(trigger: string): string {
  return TRIGGER_LABEL[trigger] ?? `Trigger: ${trigger}`;
}

/**
 * One execution run: state pill, summary, numbered tasks with per-task state,
 * the blocked/failed reasons, and the state-appropriate affordances. Actions
 * per state: ready ⇒ Execute plan (STAGES artifacts — never sends) + Edit
 * plan + Cancel; waiting ⇒ Resume (recoverable blockers) + Cancel; recoverable
 * failure ⇒ Retry + Cancel; in-flight ⇒ Cancel; terminal ⇒ none. NO send
 * control exists anywhere below (rule 7).
 */
function RunCard({
  run,
  label,
}: {
  run: ExecutionRun;
  label: { title: string; client: string };
}) {
  const navigate = useNavigate();
  const execute = useExecuteRun();
  const resume = useResumeRun();
  const retry = useRetryRun();
  const cancel = useCancelRun();
  const policy = useRunPolicy(run.id, !TERMINAL.has(run.state));
  const reconcile = useReconcileRun();
  const detail = useStrategy(label.title === 'Strategy unavailable' ? run.strategyId ?? '' : null);
  const can = (action: string) => policy.data?.state === run.state && policy.data.actions.some((a) => a === action);
  const nodeId = run.nodeId ?? run.tasks.find((t) => t.nodeId)?.nodeId;
  const repairPath = run.strategyId ? `/strategies/${run.strategyId}${nodeId ? `?step=${encodeURIComponent(nodeId)}&tab=step` : ''}` : null;
  const heartbeat = policy.data?.heartbeatAt ?? run.startedAt ?? run.createdAt;
  const overdueQueue = !!policy.data?.timeoutMinutes && Date.now() - new Date(heartbeat).getTime() > policy.data.timeoutMinutes * 60_000;
  const [recoveryNote, setRecoveryNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'cancel' | 'edit' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const awaitingSend = isAwaitingSendApproval(run);
  const sendTask = awaitingSend ? sendApprovalTask(run) : null;
  const block =
    run.state === 'waiting_for_input' && !awaitingSend
      ? classifyWaitingReason(run.waitingReason)
      : null;
  const failed =
    run.state === 'failed' || run.state === 'failed_recoverable' || run.state === 'failed_terminal';
  const busy = execute.isPending || resume.isPending || retry.isPending || cancel.isPending || reconcile.isPending;

  const onExecute = () => {
    execute.mutate(
      { id: run.id },
      {
        onSuccess: () => setActionError(null),
        onError: (err) =>
          setActionError(
            isAmbiguousRequestError(err)
              ? 'The request timed out before the result returned. Checking the recorded run status — do not execute again until that status is current.'
              : errorMessage(err, 'Could not execute the plan.'),
          ),
      },
    );
  };

  const onResume = () => {
    resume.mutate(
      { id: run.id },
      {
        onSuccess: () => setActionError(null),
        onError: (err) =>
          setActionError(
            isAmbiguousRequestError(err)
              ? 'The request timed out before the result returned. Checking the recorded run status — do not resume again until that status is current.'
              : errorMessage(err, 'Could not resume the run.'),
          ),
      },
    );
  };

  const onCancel = () => {
    cancel.mutate(
      { id: run.id },
      {
        onSuccess: () => setActionError(null),
        onError: (err) => setActionError(errorMessage(err, 'Could not cancel the run.')),
      },
    );
  };

  const onRetry = () => {
    retry.mutate({ id: run.id }, {
      onSuccess: () => setActionError(null),
      onError: (err) => setActionError(errorMessage(err, 'Could not retry the run.')),
    });
  };

  return (
    <div className="st-card st-agents__run-card">
      <div className="st-card__body">
        <div className="st-agents__card-head">
          <RunPill state={run.state} />
          {run.strategyId && UUID_RE.test(run.strategyId) ? (
            <button
              type="button"
              className="st-agents__link"
              onClick={() => navigate(`/strategies/${run.strategyId}`)}
            >
              {detail.data?.title ?? label.title}
            </button>
          ) : (
            <span className="st-agents__summary-inline">{detail.data?.title ?? label.title}</span>
          )}
          {label.client && label.client !== '—' && (
            <span className="st-agents__group-client">{label.client}</span>
          )}
          <span className="st-agents__spacer" />
          <span className="st-agents__meta">
            {triggerLabel(run.trigger)}
            {' · '}
            {fmtRelative(run.createdAt)}
          </span>
        </div>

        <details className="st-agents__meta"><summary>Run details</summary><p>Run reference: {run.id}</p><p>Recorded state: {run.state}</p>{policy.data?.heartbeatAt && <p>Last activity: {new Date(policy.data.heartbeatAt).toLocaleString()}</p>}</details>
        {policy.isError && !TERMINAL.has(run.state) && <p role="alert">Available actions could not be checked. <button type="button" onClick={() => void policy.refetch()}>Try again</button></p>}
        {overdueQueue && <div className="st-agents__block"><p>This run has had no recorded progress beyond its normal {policy.data?.timeoutMinutes}-minute window. Check its recorded state before retrying; a delay alone does not establish why it stopped.</p>
          {can('reconcile') && <CapiroButton disabled={busy} onClick={() => reconcile.mutate({ id: run.id }, { onSuccess: (result) => setRecoveryNote(result.findings.map((f) => f.detail).join(' ') || 'No repair was needed. The recorded run state is current.'), onError: (err) => setActionError(errorMessage(err, 'Could not check this run.')) })}>{reconcile.isPending ? 'Checking…' : 'Check run status'}</CapiroButton>}
        </div>}
        {recoveryNote && <p role="status">{recoveryNote}</p>}

        {/* Plan well (design handoff — a labeled #F9FAFB box). The reference
            also shows an "Operator · Name" line, but no such field exists on
            ExecutionRun — omitted rather than fabricated. */}
        {run.summary && (
          <div className="st-agents__plan-well">
            <span className="st-agents__plan-well-label">Plan</span>
            <p className="st-agents__summary">{run.summary}</p>
          </div>
        )}

        {/* Every failure state surfaces its reason — a failed run is never
            hidden behind a bare pill (§7.9 must-not). */}
        {failed && (
          <div className="st-agents__error-box" role="alert">
            {run.error ??
              (run.state === 'failed_recoverable'
                ? 'This run failed in a recoverable way — Retry prepares a new attempt against the current plan for review.'
                : 'This run failed terminally. No further reason was reported by the server.')}
          </div>
        )}

        {/* Numbered tasks with per-task state (read-only). */}
        {run.tasks.length > 0 && (
          <ol className="st-agents__tasks">
            {run.tasks.map((t, i) => (
              <TaskRow key={t.id} task={t} index={i + 1} />
            ))}
          </ol>
        )}

        {/* Send-approval park: the staged outreach preview is READ-ONLY. The
            approval control is deliberately absent — no send control renders
            until Stage H (rule 7). */}
        {awaitingSend && (
          <div className="st-agents__send-preview">
            <p className="st-agents__send-preview-title">
              Outreach draft ready — sending is unavailable
            </p>
            {sendTask?.send ? (
              <dl className="st-agents__send-preview-grid">
                {sendTask.send.subject && (
                  <>
                    <dt>Subject</dt>
                    <dd>{sendTask.send.subject}</dd>
                  </>
                )}
                {sendTask.send.recipients.length > 0 && (
                  <>
                    <dt>Recipients</dt>
                    <dd>{sendTask.send.recipients.join(', ')}</dd>
                  </>
                )}
                {sendTask.send.ask && (
                  <>
                    <dt>Ask</dt>
                    <dd>{sendTask.send.ask}</dd>
                  </>
                )}
                {sendTask.send.window && (
                  <>
                    <dt>Window</dt>
                    <dd>{sendTask.send.window}</dd>
                  </>
                )}
                {sendTask.send.body && (
                  <>
                    <dt>Body</dt>
                    <dd className="st-agents__send-preview-body">{sendTask.send.body}</dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="st-agents__meta">
                The staged preview was not returned by the server for this run.
              </p>
            )}
            {isPriorApprovalInvalidated(sendTask?.send ?? null) && (
              <p className="st-agents__send-preview-warning" role="status">
                The staged content changed since a prior approval — that approval no longer binds
                and needs a new review before any authorized send.
              </p>
            )}
          </div>
        )}

        {/* Other blocked states: the precise classified reason, never a
            generic error; Resume for the recoverable park. */}
        {block && (
          <div className="st-agents__block">
            <div className="st-agents__block-text">
              <b>{block.kind === 'ineligible' ? 'Update this step before preparing work' : block.label}.</b>{' '}
              {block.kind === 'ineligible'
                ? 'Check the step type, subject, owner and dates in the editor, then return here to resume.'
                : block.kind === 'material_conflict'
                  ? 'Resolve conflicting client information in Context review, then resume.'
                  : block.kind === 'missing_prerequisites'
                    ? 'Restore the required client context (strategy brief and client constraints) in Context review before retrying. Execute plan stays unavailable until prerequisites are current.'
                    : block.kind === 'version_drift'
                      ? 'Review the updated strategy and prepare a new plan before continuing.'
                      : block.reason}
              <details>
                <summary>Reported reason</summary>
                {block.reason}
              </details>
            </div>
            {repairPath && (block.kind === 'ineligible' || block.kind === 'version_drift') && (
              <CapiroButton size="compact" onClick={() => navigate(repairPath)}>
                Review step
              </CapiroButton>
            )}
            {(block.kind === 'material_conflict' || block.kind === 'missing_prerequisites') && (
              <CapiroButton size="compact" onClick={() => navigate('/strategies/context/steward')}>
                Review context
              </CapiroButton>
            )}
            {block.kind === 'version_drift' && can('retry') && (
              <CapiroButton size="compact" disabled={busy} onClick={onRetry}>
                Prepare updated plan
              </CapiroButton>
            )}
            {block.kind !== 'version_drift' && can('resume') && (
              <CapiroButton size="compact" disabled={busy} onClick={onResume}>
                {resume.isPending ? 'Resuming…' : 'Resume'}
              </CapiroButton>
            )}
          </div>
        )}

        {actionError && (
          <div className="st-agents__error-box" role="alert">
            {actionError}
          </div>
        )}

        {/* State-appropriate affordances — no send control anywhere. Order
            (design handoff): Cancel (ghost) → Edit plan (secondary) → the
            row's primary CTA, which is pushed to the far right via
            `.st-agents__run-actions-primary` (margin-left:auto). */}
        {(run.state === 'ready_for_review' ||
          run.state === 'failed_recoverable' ||
          run.state === 'queued' ||
          run.state === 'planning' ||
          run.state === 'executing' ||
          run.state === 'approved' ||
          run.state === 'waiting_for_input') && (
          <div className="st-agents__run-actions">
            <CapiroButton variant="quiet" size="compact" disabled={busy || !can('cancel')} onClick={() => setConfirm('cancel')}>
              Cancel
            </CapiroButton>
            {(run.state === 'ready_for_review' || run.state === 'approved') && (
              <>
                <CapiroButton
                  size="compact"
                  disabled={busy || !run.strategyId || !UUID_RE.test(run.strategyId)}
                  onClick={() => setConfirm('edit')}
                >
                  Edit plan
                </CapiroButton>
                <span className="st-agents__meta">Editing the plan invalidates prior approval.</span>
              </>
            )}
            {(run.state === 'ready_for_review' || run.state === 'approved') && (
              <CapiroButton
                variant="primary"
                size="compact"
                className="st-agents__run-actions-primary"
                disabled={busy || !can('execute')}
                onClick={onExecute}
              >
                {execute.isPending ? 'Executing…' : 'Execute plan'}
              </CapiroButton>
            )}
            {run.state === 'failed_recoverable' && (
              <CapiroButton
                variant="primary"
                size="compact"
                className="st-agents__run-actions-primary"
                disabled={busy || !can('retry')}
                onClick={onRetry}
              >
                {retry.isPending ? 'Retrying…' : 'Retry run'}
              </CapiroButton>
            )}
          </div>
        )}
      </div>

      {/* Cancel confirm — a canceled run stops staging; record stays. */}
      <CapiroModal open={confirm === 'cancel'} title="Cancel this run?" onClose={() => setConfirm(null)}>
        <p className="st-agents__modal-copy">
          The run stops where it is. Artifacts already staged stay staged for review — nothing is
          sent, and the cancellation is recorded.
        </p>
        <div className="st-agents__modal-actions">
          <CapiroButton size="compact" onClick={() => setConfirm(null)}>
            Keep run
          </CapiroButton>
          <CapiroButton
            variant="primary"
            size="compact"
            disabled={cancel.isPending}
            onClick={() => {
              setConfirm(null);
              onCancel();
            }}
          >
            {cancel.isPending ? 'Canceling…' : 'Cancel run'}
          </CapiroButton>
        </div>
      </CapiroModal>

      {/* Edit plan — invalidates prior approval, and says so (§7.9). */}
      <CapiroModal open={confirm === 'edit'} title="Edit the plan?" onClose={() => setConfirm(null)}>
        <p className="st-agents__modal-copy">
          Editing the plan invalidates any prior approval on this run — a changed plan is a
          different payload and must be reviewed again. You will be taken to the strategy editor.
        </p>
        <div className="st-agents__modal-actions">
          <CapiroButton size="compact" onClick={() => setConfirm(null)}>
            Stay here
          </CapiroButton>
          <CapiroButton
            variant="primary"
            size="compact"
            onClick={() => {
              setConfirm(null);
              if (run.strategyId && UUID_RE.test(run.strategyId)) navigate(`/strategies/${run.strategyId}`);
            }}
          >
            Open the editor
          </CapiroButton>
        </div>
      </CapiroModal>
    </div>
  );
}

/** One numbered task: icon tile, index, type label, title, per-task state pill, blocked reason. */
function TaskRow({ task, index }: { task: ExecutionTask; index: number }) {
  const status = TASK_STATUS_PILL[task.status] ?? { label: task.status, tone: '' };
  const Icon = TASK_TYPE_ICON[task.type] ?? CapiroFileTextIcon;
  return (
    <li className="st-agents__task">
      <span className={`st-agents__task-icon ${status.tone}`.trim()} aria-hidden="true">
        <Icon size={0.9} />
      </span>
      <span className="st-mono st-agents__task-index">{String(index).padStart(2, '0')}.</span>
      <div className="st-agents__task-body">
        <span className="st-agents__task-title">
          <span className="st-agents__task-type">{TASK_TYPE_LABEL[task.type] ?? task.type}</span>
          {task.title}
        </span>
        {task.blockedReason && <span className="st-agents__task-blocked">{task.blockedReason}</span>}
        {task.artifactRef && (
          <span className="st-agents__meta">
            <a href={strategyArtifactHref(task.type === 'workspace_draft' ? 'workspace_draft' : 'outreach_record', task.artifactRef)}>
              {task.type === 'workspace_draft' ? 'Open Workspace draft' : 'Open outreach record'}
            </a>
          </span>
        )}
      </div>
      <span className={`st-pill ${status.tone}`.trim()}>{status.label}</span>
    </li>
  );
}
