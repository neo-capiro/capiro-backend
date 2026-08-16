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
  useStrategies,
} from '../strategies-api.js';
import {
  classifyWaitingReason,
  isAwaitingSendApproval,
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
import { BannerLockGlyph, fmtRelative, isForbidden, shortId, StaleNote, staleOrError } from './agents-shared.js';

/** spStrategy.id is a UUID column; anything else is a malformed link, not a query. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/*
 * Server run state → §7.9 display token + pill tone. The label is the exact
 * vocabulary token (mono — §5.1 run-state tokens); the dot carries the tone.
 * `staged` renders as "staged_not_sent" — a TERMINAL SUCCESS state in this
 * release (§8.11), never a failure and never "sent".
 */
const RUN_PILL: Record<RunState, { token: string; tone: string }> = {
  queued: { token: 'queued', tone: '' },
  planning: { token: 'planning', tone: 'st-pill--accent' },
  waiting_for_input: { token: 'waiting', tone: 'st-pill--warning' },
  ready_for_review: { token: 'ready', tone: 'st-pill--accent' },
  approved: { token: 'approved', tone: 'st-pill--accent' },
  executing: { token: 'executing', tone: 'st-pill--accent' },
  staged: { token: 'staged_not_sent', tone: 'st-pill--success' },
  completed: { token: 'completed', tone: 'st-pill--success' },
  failed: { token: 'failed', tone: 'st-pill--error' },
  failed_recoverable: { token: 'recoverable', tone: 'st-pill--warning' },
  failed_terminal: { token: 'failed', tone: 'st-pill--error' },
  canceled: { token: 'canceled', tone: '' },
  superseded: { token: 'superseded', tone: '' },
};

/** The §7.9 run-state model card — the full supported vocabulary, verbatim. */
const RUN_STATE_MODEL: ReadonlyArray<{ token: string; note: string }> = [
  { token: 'queued', note: 'Accepted, waiting for a worker.' },
  { token: 'planning', note: 'The agent is drafting the task plan.' },
  { token: 'waiting', note: 'Parked for human input — the reason stays on the run.' },
  { token: 'ready', note: 'Plan staged and awaiting human review.' },
  { token: 'approved', note: 'Plan approved by a person; execution has not started.' },
  { token: 'executing', note: 'Tasks are being staged.' },
  { token: 'completed', note: 'Every task finished.' },
  { token: 'recoverable', note: 'Failed in a repairable way — Resume is available.' },
  { token: 'failed', note: 'Terminal failure; the reason stays visible.' },
  { token: 'canceled', note: 'Stopped by a person.' },
  { token: 'superseded', note: 'Replaced by a newer attempt.' },
  { token: 'staged_not_sent', note: 'Artifacts staged, nothing sent. Terminal success in this release.' },
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
  const [params] = useSearchParams();
  /* The filter is a URL (?strategyId=…) — back/forward works (§6). */
  const strategyFilter = params.get('strategyId');
  const runs = useExecutionRuns(strategyFilter, true);
  const strategies = useStrategies();
  const clients = useClientsLite();
  /* "View Stage H criteria" — purely a local expand/collapse over the SAME
   * static criteria text already in the security card below; no fetch, no
   * mutation, no navigation (§11 rule 7 stays intact). */
  const [stageHOpen, setStageHOpen] = useState(false);

  const strategyLabel = (strategyId: string | null): { title: string; client: string } => {
    if (!strategyId) return { title: 'Firm-level', client: '' };
    const s = strategies.data?.find((r) => r.id === strategyId);
    return { title: s?.title ?? 'Strategy', client: clientName(clients.data, s?.clientId) };
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
            External send is disabled until security review (Stage H).
          </p>
          <p className="st-dark-banner__sub">
            The Execution Agent stages artifacts — Workspace drafts and outreach records — for human
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

          {/* ---- Run state model (§7.9) — the full supported vocabulary --- */}
          <div className="st-agents__section">
            <div className="st-card">
              <div className="st-card__header">
                <h2 className="st-card__title">Run state model</h2>
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

          {/* ---- Security control (§7.9/§11 rule 9) — NOT decorative ------
            GAP (logged): the handoff links this card to the Stage-H criteria,
            but no criteria route/document exists yet — the criteria render
            inline here instead of as a dead link. */}
          <div className="st-agents__section">
            <div className="st-card st-agents__security">
              <div className="st-card__header">
                <h2 className="st-card__title">Security control</h2>
              </div>
              <div className="st-card__body">
                <p className="st-agents__security-headline">No direct send action is available.</p>
                <p className="st-agents__security-copy">
                  No direct send action exists on this surface. Outreach artifacts are staged for
                  human review, and external send stays disabled until the Stage H security review
                  clears it.
                </p>
                <ul className="st-agents__security-list">
                  <li>Stage H security evals pass before any send path ships.</li>
                  <li>The send grant is enabled server-side only — no client control can turn it on.</li>
                  <li>
                    When it ships, approval binds to the exact staged content hash; any edit
                    invalidates it.
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
                  onClick={() => setStageHOpen(true)}
                >
                  View Stage H criteria
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
        title="Stage H security criteria"
        onClose={() => setStageHOpen(false)}
      >
        <p className="st-agents__modal-copy">
          No direct send action exists on this surface. Outreach artifacts are staged for human
          review, and external send stays disabled until the Stage H security review clears it.
        </p>
        <ul className="st-agents__modal-list">
          <li>Stage H security evals pass before any send path ships.</li>
          <li>The send grant is enabled server-side only — no client control can turn it on.</li>
          <li>When it ships, approval binds to the exact staged content hash; any edit invalidates it.</li>
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
 * failure ⇒ Resume + Cancel; in-flight ⇒ Cancel; terminal ⇒ none. NO send
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
  const cancel = useCancelRun();
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
  const busy = execute.isPending || resume.isPending || cancel.isPending;

  const onExecute = () => {
    execute.mutate(
      { id: run.id },
      {
        onSuccess: () => setActionError(null),
        onError: (err) => setActionError(errorMessage(err, 'Could not execute the plan.')),
      },
    );
  };

  const onResume = () => {
    resume.mutate(
      { id: run.id },
      {
        onSuccess: () => setActionError(null),
        onError: (err) => setActionError(errorMessage(err, 'Could not resume the run.')),
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
              {label.title}
            </button>
          ) : (
            <span className="st-agents__summary-inline">{label.title}</span>
          )}
          {label.client && label.client !== '—' && (
            <span className="st-agents__group-client">{label.client}</span>
          )}
          <span className="st-agents__spacer" />
          <span className="st-agents__meta">
            {triggerLabel(run.trigger)}
            {' · '}
            run{' '}
            <span className="st-mono" title={run.id}>
              {shortId(run.id)}
            </span>
            {' · '}
            {fmtRelative(run.createdAt)}
          </span>
        </div>

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
                ? 'This run failed in a recoverable way — Resume picks it up against the current plan.'
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
              Staged outreach — parked for send approval (disabled until Stage H)
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
                and would need to be re-granted after Stage H.
              </p>
            )}
          </div>
        )}

        {/* Other blocked states: the precise classified reason, never a
            generic error; Resume for the recoverable park. */}
        {block && (
          <div className="st-agents__block">
            <div className="st-agents__block-text">
              <b>{block.label}.</b> {block.reason}
            </div>
            <CapiroButton size="compact" disabled={busy} onClick={onResume}>
              {resume.isPending ? 'Resuming…' : 'Resume'}
            </CapiroButton>
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
          (run.state === 'waiting_for_input' && !awaitingSend)) && (
          <div className="st-agents__run-actions">
            <CapiroButton variant="quiet" size="compact" disabled={busy} onClick={() => setConfirm('cancel')}>
              Cancel
            </CapiroButton>
            {(run.state === 'ready_for_review' || run.state === 'approved') && (
              <>
                <CapiroButton
                  size="compact"
                  disabled={busy || !run.strategyId}
                  onClick={() => setConfirm('edit')}
                >
                  Edit plan
                </CapiroButton>
                <span className="st-agents__meta">Editing the plan invalidates prior approval.</span>
              </>
            )}
            {run.state === 'ready_for_review' && (
              <CapiroButton
                variant="primary"
                size="compact"
                className="st-agents__run-actions-primary"
                disabled={busy}
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
                disabled={busy}
                onClick={onResume}
              >
                {resume.isPending ? 'Resuming…' : 'Resume run'}
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
            artifact{' '}
            <span className="st-mono" title={task.artifactRef}>
              {shortId(task.artifactRef)}
            </span>
          </span>
        )}
      </div>
      <span className={`st-pill ${status.tone}`.trim()}>{status.label}</span>
    </li>
  );
}
