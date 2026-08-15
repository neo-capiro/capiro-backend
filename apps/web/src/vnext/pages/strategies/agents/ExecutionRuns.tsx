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
import { fmtRelative, isForbidden, shortId, StaleNote, staleOrError } from './agents-shared.js';

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

  return (
    <div className="st-agents">
      {/* Policy copy — do not reword (§7.9, BUILD-CONTRACT). */}
      <div className="st-dark-banner">
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
      ) : (
        <>
          {active.length > 0 && (
            <div className="st-agents__section">
              <div className="st-agents__section-head">
                <h2 className="st-section-label">Runs</h2>
                <span className="st-mono st-agents__count">{active.length} active</span>
              </div>
              <div className="st-agents__list">
                {active.map((run) => (
                  <RunCard key={run.id} run={run} label={strategyLabel(run.strategyId)} />
                ))}
              </div>
            </div>
          )}

          {history.length > 0 && (
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
        </>
      )}

      {/* ---- Run state model (§7.9) — the full supported vocabulary --------- */}
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

      {/* ---- Security control (§7.9/§11 rule 9) — NOT decorative ------------
        GAP (logged): the handoff links this card to the Stage-H criteria, but
        no criteria route/document exists yet — the criteria render inline here
        instead of as a dead link. */}
      <div className="st-agents__section">
        <div className="st-card st-agents__security">
          <div className="st-card__header">
            <h2 className="st-card__title">Security control</h2>
          </div>
          <div className="st-card__body">
            <p className="st-agents__security-copy">
              No direct send action exists on this surface. Outreach artifacts are staged for human
              review, and external send stays disabled until the Stage H security review clears it.
            </p>
            <ul className="st-agents__security-list">
              <li>Stage H security evals pass before any send path ships.</li>
              <li>The send grant is enabled server-side only — no client control can turn it on.</li>
              <li>When it ships, approval binds to the exact staged content hash; any edit invalidates it.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
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
    <div className="st-card">
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
            run{' '}
            <span className="st-mono" title={run.id}>
              {shortId(run.id)}
            </span>
            {' · '}
            {fmtRelative(run.createdAt)}
          </span>
        </div>

        {run.summary && <p className="st-agents__summary">{run.summary}</p>}

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

        {/* State-appropriate affordances — no send control anywhere. */}
        {(run.state === 'ready_for_review' ||
          run.state === 'failed_recoverable' ||
          run.state === 'queued' ||
          run.state === 'planning' ||
          run.state === 'executing' ||
          run.state === 'approved' ||
          (run.state === 'waiting_for_input' && !awaitingSend)) && (
          <div className="st-agents__run-actions">
            {run.state === 'ready_for_review' && (
              <CapiroButton variant="primary" size="compact" disabled={busy} onClick={onExecute}>
                {execute.isPending ? 'Executing…' : 'Execute plan'}
              </CapiroButton>
            )}
            {run.state === 'failed_recoverable' && (
              <CapiroButton variant="primary" size="compact" disabled={busy} onClick={onResume}>
                {resume.isPending ? 'Resuming…' : 'Resume run'}
              </CapiroButton>
            )}
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
            <CapiroButton size="compact" disabled={busy} onClick={() => setConfirm('cancel')}>
              Cancel
            </CapiroButton>
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

/** One numbered task: index, type label, title, per-task state pill, blocked reason. */
function TaskRow({ task, index }: { task: ExecutionTask; index: number }) {
  const status = TASK_STATUS_PILL[task.status] ?? { label: task.status, tone: '' };
  return (
    <li className="st-agents__task">
      <span className="st-mono st-agents__task-index">{index}.</span>
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
