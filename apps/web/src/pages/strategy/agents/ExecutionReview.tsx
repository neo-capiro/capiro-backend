/*
 * Stage G Execution review (/strategies/agents/execution) — the human surface
 * over the Execution Agent. It lists execution runs (an sp_agent_run whose
 * findings carry planned/staged TASKS) for the tenant, or one strategy when
 * deep-linked with ?strategyId. Per run:
 *
 *  - ready_for_review  → the reviewed PLAN (workspace_draft / outreach_record /
 *    await_send_approval tasks) with an "Execute plan" button that STAGES the
 *    artifacts (POST execution/runs/:id/execute). No external send.
 *  - waiting_for_input → a CLEAR blocked state carrying the precise reason
 *    (version drift / ineligible / material conflict / requires interactive
 *    session), never a generic error — with a Resume affordance for recoverable
 *    blockers. When the reason is "awaiting send approval", the staged outreach
 *    preview + a send-approval panel render instead.
 *  - executing/planning/queued → in-progress; completed → staged artifacts with
 *    links; failed → the error.
 *
 * SAFETY BOUNDARY (plan §G, non-negotiable): the actual EXTERNAL SEND is
 * HARD-DISABLED until Stage H security evals. The APPROVE THIS SEND control is
 * fully WIRED (it would resume the run with the staged approval token) but
 * VISIBLY DISABLED with the Stage-H copy — mirroring the backend hard-disable
 * behind STRATEGY_EXECUTION_SEND_ENABLED (an env that does not exist yet, never
 * set in Stage G). Nothing on this surface performs autonomous external contact.
 *
 * Gating: route-level on /me features.agenticMeri (the UI belt); the server's
 * AgenticGuard + the per-intent executionAgent flags are authoritative — a
 * tenant without them sees the list/actions error out with the server's reason.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { App } from 'antd';
import { Chip, Icon, btnGhost, btnPrimary, chipBtn } from '../strategy-ui.js';
import {
  useApprovalStatus,
  useApproveExactDraft,
  useCancelRun,
  useExecutionRuns,
  useExecuteRun,
  useMarkRunFailed,
  useReconcileRun,
  useResolveReservation,
  useRejectApproval,
  useResumeRun,
  useRetryRun,
  useRunPolicy,
  useStrategies,
} from '../api.js';
import { useClientsLite } from '../clients-lite.js';
import { errorMessage } from '../../../lib/error-message.js';
import { relativeTime } from '../constants.js';
import {
  classifyWaitingReason,
  isAwaitingSendApproval,
  isPriorApprovalInvalidated,
  sendApprovalTask,
} from './agent-utils.js';
import type {
  ExecutionRun,
  ExecutionTask,
  ExecutionTaskType,
  ReconcileResult,
  RunAction,
  RunState,
  SendApprovalPreview,
} from '../types.js';

/**
 * Stage-H hard-disable (plan §G). The backend gates the actual external send
 * behind STRATEGY_EXECUTION_SEND_ENABLED — an env that DOES NOT EXIST yet and
 * is never set in Stage G. This mirror keeps the approve control inert. NEVER
 * flip this to true before the Stage-H security evals land.
 */
const SEND_APPROVAL_ENABLED = false as boolean;

/** The safety-critical copy on the disabled approve control (exported for the test). */
export const SEND_DISABLED_COPY = 'External send is disabled until security review (Stage H)';

const emptyBox: React.CSSProperties = {
  padding: 24,
  textAlign: 'center',
  fontSize: 'var(--text-sm)',
  color: 'var(--ink-3)',
  border: '1px dashed var(--border-2)',
  borderRadius: 12,
};

const sectionHead: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  fontWeight: 700,
  color: 'var(--ink-1)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

/** Amber banner (same palette as the high-risk badge literals). */
const warnBox: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  background: '#FCEDE6',
  border: '1px solid #D97742',
  borderRadius: 8,
  padding: '9px 12px',
  fontSize: 'var(--text-xs)',
  color: '#A14D12',
  lineHeight: 1.5,
};

/*
 * P0-2 run vocabulary. `Staged` is deliberately worded as "staged, not sent" and
 * `Recoverable` as a repairable failure — the audit's P1-13 point that success,
 * generated, staged and completed must not read as the same thing.
 */
const RUN_STATE_META: Record<
  RunState,
  { label: string; tone: 'accent' | 'notable' | 'info' | 'success' | 'critical' | 'ink' }
> = {
  queued: { label: 'Queued', tone: 'ink' },
  planning: { label: 'Planning', tone: 'info' },
  waiting_for_input: { label: 'Waiting', tone: 'notable' },
  ready_for_review: { label: 'Ready for review', tone: 'accent' },
  approved: { label: 'Approved', tone: 'accent' },
  executing: { label: 'Executing', tone: 'info' },
  staged: { label: 'Staged — not sent', tone: 'success' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'critical' },
  failed_recoverable: { label: 'Failed — recoverable', tone: 'critical' },
  failed_terminal: { label: 'Failed', tone: 'critical' },
  canceled: { label: 'Canceled', tone: 'ink' },
  superseded: { label: 'Superseded', tone: 'ink' },
};

const TASK_META: Record<ExecutionTaskType, { label: string; icon: string }> = {
  workspace_draft: { label: 'Workspace draft', icon: 'doc' },
  outreach_record: { label: 'Outreach record', icon: 'users' },
  await_send_approval: { label: 'Send approval', icon: 'lock' },
};

export function ExecutionReview() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const strategyFilter = params.get('strategyId');
  const runs = useExecutionRuns(strategyFilter);
  const strategies = useStrategies();
  const clients = useClientsLite();

  const strategyLabel = (strategyId: string | null): { title: string; client: string } => {
    if (!strategyId) return { title: 'Firm-level', client: '' };
    const s = strategies.data?.find((r) => r.id === strategyId);
    const client = s ? (clients.data?.find((c) => c.id === s.clientId)?.name ?? 'Client') : '';
    return { title: s?.title ?? 'Strategy', client };
  };

  // Newest first, and float the runs that need a human (ready_for_review /
  // waiting_for_input) to the top so review obligations lead.
  const rows = useMemo(() => {
    // P0-2: a recoverable failure is a review obligation too — it is exactly the
    // stranded run a human needs to see, so it floats with the parked ones.
    const NEEDS_ATTENTION: ReadonlySet<RunState> = new Set([
      'ready_for_review',
      'waiting_for_input',
      'failed_recoverable',
      'staged',
    ]);
    return [...(runs.data ?? [])].sort((a, b) => {
      const aa = NEEDS_ATTENTION.has(a.state) ? 0 : 1;
      const bb = NEEDS_ATTENTION.has(b.state) ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
  }, [runs.data]);

  const filterTitle = strategyFilter ? strategyLabel(strategyFilter).title : null;

  return (
    <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-canvas)', height: '100%' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '28px 40px 60px' }}>
        <button
          onClick={() => navigate(strategyFilter ? `/strategies/${strategyFilter}` : '/strategies')}
          style={{ ...btnGhost, marginBottom: 14 }}
        >
          <Icon name="chevleft" size={14} color="var(--ink-2)" />{' '}
          {strategyFilter ? 'Back to strategy' : 'Strategies'}
        </button>

        <h1
          style={{
            fontSize: 'var(--text-xl)',
            fontWeight: 700,
            color: 'var(--ink-1)',
            letterSpacing: '-0.02em',
            margin: 0,
          }}
        >
          Execution
        </h1>
        <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-2)', marginTop: 4, maxWidth: 700 }}>
          Meri's Execution Agent prepares work against your plan — drafting documents in Workspace
          and staging outreach — and parks here for your review.{' '}
          <b>No message is ever sent externally without your approval</b>, and sending itself stays
          disabled until security review.
          {filterTitle ? (
            <>
              {' '}
              Showing runs for <b>{filterTitle}</b>.
            </>
          ) : null}
        </p>

        <div style={{ marginTop: 26, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={sectionHead}>Execution runs</span>
          <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)', color: 'var(--ink-4)' }}>
            {rows.length} total
          </span>
        </div>

        {runs.isLoading && <div style={emptyBox}>Loading execution runs…</div>}
        {!runs.isLoading && runs.isError && (
          <div style={{ ...emptyBox, color: 'var(--critical)', borderColor: 'var(--critical)' }}>
            The execution list could not be loaded —{' '}
            {errorMessage(runs.error, 'you may not have access, or the request failed.')}
          </div>
        )}
        {!runs.isLoading && !runs.isError && rows.length === 0 && (
          <div style={emptyBox}>
            No execution runs yet. Open a strategy step and use <b>Prepare in Workspace (agent)</b> or{' '}
            <b>Stage outreach (agent)</b> to have Meri prepare work for your review here.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((run) => (
            <ExecutionRunCard
              key={run.id}
              run={run}
              label={strategyLabel(run.strategyId)}
              onOpenStrategy={() =>
                run.strategyId && navigate(`/strategies/${run.strategyId}`)
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** One execution run: state header + tasks, plus the state-specific action area. */
function ExecutionRunCard({
  run,
  label,
  onOpenStrategy,
}: {
  run: ExecutionRun;
  label: { title: string; client: string };
  onOpenStrategy: () => void;
}) {
  const { message } = App.useApp();
  const execute = useExecuteRun();
  const resume = useResumeRun();

  const stateMeta = RUN_STATE_META[run.state];
  const awaitingSend = isAwaitingSendApproval(run);
  const block =
    run.state === 'waiting_for_input' ? classifyWaitingReason(run.waitingReason) : null;

  const onExecute = () => {
    execute.mutate(
      { id: run.id },
      {
        onSuccess: () =>
          message.success('Plan executed — artifacts staged for review. Nothing was sent.'),
        // A parked/ineligible outcome surfaces the server's precise reason (the
        // run refetch re-renders it as a blocked state below).
        onError: (err) => message.error(errorMessage(err, 'Could not execute the plan.')),
      },
    );
  };

  const onResume = () => {
    resume.mutate(
      { id: run.id },
      {
        onSuccess: () => message.success('Run resumed.'),
        onError: (err) => message.error(errorMessage(err, 'Could not resume the run.')),
      },
    );
  };

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-1)',
        borderRadius: 10,
        padding: '13px 16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Chip tone={stateMeta.tone}>{stateMeta.label}</Chip>
        {label.title && (
          <button
            onClick={onOpenStrategy}
            disabled={!run.strategyId}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: run.strategyId ? 'pointer' : 'default',
              fontSize: 'var(--text-sm)',
              fontWeight: 700,
              fontFamily: 'var(--font-sans)',
              color: 'var(--ink-1)',
            }}
          >
            {label.title}
          </button>
        )}
        {label.client && (
          <span
            style={{
              fontSize: 'var(--text-2xs)',
              color: 'var(--ink-3)',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {label.client}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)' }}>
          {relativeTime(run.createdAt)}
        </span>
        {run.state === 'ready_for_review' && (
          <button
            onClick={onExecute}
            disabled={execute.isPending}
            style={{ ...btnPrimary, padding: '7px 15px', fontSize: 'var(--text-xs)' }}
          >
            {execute.isPending ? 'Executing…' : 'Execute plan'}
          </button>
        )}
      </div>

      {run.summary && (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-1)', fontWeight: 600, marginTop: 10 }}>
          {run.summary}
        </div>
      )}

      {/* P0-2: all three failure states surface the reason, not just legacy `failed`. */}
      {(run.state === 'failed' ||
        run.state === 'failed_recoverable' ||
        run.state === 'failed_terminal') &&
        run.error && (
          <div style={{ ...warnBox, marginTop: 10, background: 'var(--critical-soft)', border: '1px solid var(--critical)', color: 'var(--critical)' }}>
            <Icon name="alert" size={14} color="var(--critical)" />
            <span style={{ flex: 1 }}>{run.error}</span>
          </div>
        )}

      {/* tasks (read-only) */}
      {run.tasks.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {run.tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </div>
      )}

      {/* send-approval park: the staged outreach preview + the inert approve control */}
      {awaitingSend && <SendApprovalPanel run={run} />}

      {/*
       * P0-3 approval panel. Shown wherever an approval DECISION exists: a
       * reviewed/approved plan (approving stages), or a run parked on the send gate
       * (approving would send — grant stays disabled until Stage H). Deliberately
       * NOT shown mid-flight, where there is nothing to approve.
       */}
      {(run.state === 'ready_for_review' || run.state === 'approved' || awaitingSend) && (
        <ApprovalPanel run={run} />
      )}

      {/* other blocked states: a clear reason, never a generic error */}
      {block && block.kind !== 'send_approval' && (
        <BlockedNotice
          block={block}
          onResume={onResume}
          resuming={resume.isPending}
        />
      )}

      {/* P0-2 recovery controls — rendered from the SERVER's allowed-action list */}
      <RecoveryControls run={run} onOpenStrategy={onOpenStrategy} />
    </div>
  );
}

/**
 * P0-2: the audit's missing run controls — Retry, Cancel run, Reconcile, Mark
 * failed, Copy diagnostic ID, Return to strategy — plus the operator resolution
 * for the one recovery case reconciliation refuses to guess at.
 *
 * Which buttons appear is decided by the SERVER (GET .../policy returns the
 * state's allowed-action list), not by a table in this file. That is deliberate: a
 * client-side copy of the state machine is exactly how a UI ends up offering a
 * button the API rejects — the "misleading state" class of defect this audit is
 * about.
 */
function RecoveryControls({
  run,
  onOpenStrategy,
}: {
  run: ExecutionRun;
  onOpenStrategy: () => void;
}) {
  const { message } = App.useApp();
  const policy = useRunPolicy(run.id);
  const cancel = useCancelRun();
  const retry = useRetryRun();
  const markFailed = useMarkRunFailed();
  const reconcile = useReconcileRun();
  const resolveReservation = useResolveReservation();
  const [outcome, setOutcome] = useState<ReconcileResult | null>(null);
  const [adoptRef, setAdoptRef] = useState('');

  const allowed = (a: RunAction): boolean => !!policy.data?.actions.includes(a);
  const reservationFinding = outcome?.findings.find(
    (f) => f.code === 'RESERVATION_WITHOUT_ARTIFACT',
  );

  const onReconcile = () =>
    reconcile.mutate(
      { id: run.id },
      {
        onSuccess: (res) => {
          setOutcome(res);
          if (res.applied) {
            message.success(`Reconciled — the run is now ${res.applied.to.replace(/_/g, ' ')}.`);
          } else if (res.needsHuman) {
            message.warning('Reconciliation needs your decision — see the detail below.');
          } else {
            message.info('Nothing to repair: this run is consistent.');
          }
        },
        onError: (err) => message.error(errorMessage(err, 'Could not reconcile the run.')),
      },
    );

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border-1)', paddingTop: 10 }}>
      {/* The plain-words meaning of the state — the audit's user-readable reason. */}
      {policy.data?.reason && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          {policy.data.reason}
        </div>
      )}

      {(policy.data?.attempt ?? 1) > 1 && (
        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)', marginTop: 3 }}>
          Attempt {policy.data!.attempt}
          {run.supersededByRunId ? ' · superseded by a later attempt' : ''}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 9 }}>
        {allowed('reconcile') && (
          <button
            onClick={onReconcile}
            disabled={reconcile.isPending}
            style={{ ...chipBtn }}
            title="Work out what actually happened to this run, and repair it"
          >
            <Icon name="refresh" size={12} color="var(--ink-2)" />{' '}
            {reconcile.isPending ? 'Reconciling…' : 'Reconcile'}
          </button>
        )}
        {allowed('retry') && (
          <button
            onClick={() =>
              retry.mutate(
                { id: run.id },
                {
                  onSuccess: () =>
                    message.success('New attempt created — review its plan before executing.'),
                  onError: (err) => message.error(errorMessage(err, 'Could not retry the run.')),
                },
              )
            }
            disabled={retry.isPending}
            style={{ ...chipBtn }}
            title="Start a fresh attempt. Nothing is inherited — it re-plans from scratch."
          >
            <Icon name="play" size={12} color="var(--ink-2)" /> Retry
          </button>
        )}
        {allowed('cancel') && (
          <button
            onClick={() =>
              cancel.mutate(
                { id: run.id },
                {
                  onSuccess: () => message.success('Run canceled.'),
                  onError: (err) => message.error(errorMessage(err, 'Could not cancel the run.')),
                },
              )
            }
            disabled={cancel.isPending}
            style={{ ...chipBtn }}
          >
            <Icon name="x" size={12} color="var(--ink-2)" /> Cancel run
          </button>
        )}
        {allowed('mark_failed') && (
          <button
            onClick={() =>
              markFailed.mutate(
                { id: run.id },
                {
                  onSuccess: () => message.success('Marked failed.'),
                  onError: (err) => message.error(errorMessage(err, 'Could not mark it failed.')),
                },
              )
            }
            disabled={markFailed.isPending}
            style={{ ...chipBtn }}
            title="Give up on this run — it will no longer be reconciled"
          >
            <Icon name="alert" size={12} color="var(--ink-2)" /> Mark failed
          </button>
        )}
        {allowed('return_to_node') && (
          <button onClick={onOpenStrategy} disabled={!run.strategyId} style={{ ...chipBtn }}>
            <Icon name="chevleft" size={12} color="var(--ink-2)" /> Return to strategy
          </button>
        )}
        {/* Always available: a correlation id the user can paste into a report. */}
        <button
          onClick={() => {
            void navigator.clipboard
              ?.writeText(run.id)
              .then(() => message.success('Diagnostic ID copied.'))
              .catch(() => message.error('Could not copy the diagnostic ID.'));
          }}
          style={{ ...chipBtn }}
          title="Copy this run's id for support"
        >
          <Icon name="link" size={12} color="var(--ink-2)" /> Copy diagnostic ID
        </button>
      </div>

      {/* What reconciliation found, in words. */}
      {outcome && outcome.findings.length > 0 && (
        <div style={{ ...warnBox, marginTop: 9 }}>
          <Icon name="info" size={14} color="#A14D12" />
          <div style={{ flex: 1 }}>
            {outcome.findings.map((f) => (
              <div key={f.code} style={{ marginBottom: 3 }}>
                {f.detail}
              </div>
            ))}
          </div>
        </div>
      )}

      {/*
       * The one case reconciliation refuses to guess at: a staging reservation with
       * no recorded artifact. The artifact client is create-only, so the server
       * cannot ask Workspace/Outreach whether the document exists — the operator
       * checks and tells us. Both branches are unrecoverable if wrong, hence an
       * explicit two-button choice rather than an automatic repair.
       */}
      {reservationFinding && (
        <div
          style={{
            marginTop: 9,
            border: '1px solid var(--border-2)',
            borderRadius: 8,
            padding: '9px 11px',
            background: 'var(--bg-surface-2)',
          }}
        >
          <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--ink-1)' }}>
            Check Workspace and Outreach for a document from this run
          </div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)', marginTop: 3 }}>
            If one exists, paste its id to link it. If nothing was created, release the slot so a
            retry can stage cleanly.
          </div>
          <div style={{ display: 'flex', gap: 7, marginTop: 8, alignItems: 'center' }}>
            <input
              value={adoptRef}
              onChange={(e) => setAdoptRef(e.target.value)}
              placeholder="Created document id"
              aria-label="Created document id"
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 'var(--text-xs)',
                fontFamily: 'var(--font-mono)',
                padding: '6px 9px',
                borderRadius: 7,
                border: '1px solid var(--border-2)',
                background: 'var(--bg-surface)',
                color: 'var(--ink-1)',
              }}
            />
            <button
              onClick={() =>
                resolveReservation.mutate(
                  { id: run.id, action: 'adopt', artifactRef: adoptRef.trim() },
                  {
                    onSuccess: () => {
                      setOutcome(null);
                      setAdoptRef('');
                      message.success('Linked. Reconcile again to advance the run.');
                    },
                    onError: (err) => message.error(errorMessage(err, 'Could not link that id.')),
                  },
                )
              }
              disabled={!adoptRef.trim() || resolveReservation.isPending}
              style={{ ...chipBtn }}
            >
              Link it
            </button>
            <button
              onClick={() =>
                resolveReservation.mutate(
                  { id: run.id, action: 'release' },
                  {
                    onSuccess: () => {
                      setOutcome(null);
                      message.success('Reservation released — you can retry now.');
                    },
                    onError: (err) =>
                      message.error(errorMessage(err, 'Could not release the reservation.')),
                  },
                )
              }
              disabled={resolveReservation.isPending}
              style={{ ...chipBtn }}
            >
              Nothing was created
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * P0-3 approval panel — "approve the EXACT draft, not its metadata".
 *
 * Everything shown here is a SERVER-computed fact from GET .../approval: the
 * exact recipients, exact subject, the full body, and the disclosures the audit
 * requires (fallback content, grounding status, unresolved conflicts, plan-version
 * drift, and a changed-since-review badge). Approving posts the contentHash the
 * reviewer was actually looking at, so the server 409s rather than let an approval
 * land on content nobody saw.
 *
 * SAFETY: for a SEND decision the grant control stays DISABLED with the Stage-H
 * copy, matching the backend hard-disable. Enabling a button labelled "approve
 * this send" while nothing can send would itself be the misleading-success-state
 * defect this audit is about. The binding and invalidation are fully live for both
 * decisions; only the send GRANT waits for Stage H.
 */
function ApprovalPanel({ run }: { run: ExecutionRun }) {
  const { message } = App.useApp();
  const status = useApprovalStatus(run.id);
  const approve = useApproveExactDraft();
  const reject = useRejectApproval();
  const [showBody, setShowBody] = useState(false);
  const data = status.data;

  if (status.isLoading || !data) return null;

  const isSend = data.action === 'send';
  const w = data.warnings;
  const approvedRecord = data.approval;
  // A live approval is one that exists AND still verifies against what is staged.
  const liveApproval = approvedRecord?.status === 'approved' && data.approvalValid;

  const onApprove = () =>
    approve.mutate(
      { id: run.id, contentHash: data.contentHash },
      {
        onSuccess: () =>
          message.success(
            isSend
              ? 'Approval recorded. Nothing was sent — sending stays disabled.'
              : 'Approved. This exact plan is now authorised to stage.',
          ),
        onError: (err) =>
          message.error(
            errorMessage(err, 'Could not approve — the draft may have changed. Reload and retry.'),
          ),
      },
    );

  const onReject = (reason: string, label: string) =>
    reject.mutate(
      { id: run.id, reason },
      {
        onSuccess: () => message.success(label),
        onError: (err) => message.error(errorMessage(err, 'Could not record that.')),
      },
    );

  return (
    <div
      style={{
        marginTop: 12,
        border: '1px solid var(--border-2)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 13px',
          background: 'var(--bg-surface-2)',
          borderBottom: '1px solid var(--border-1)',
        }}
      >
        <Icon name="lock" size={15} color="var(--ink-2)" />
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--ink-1)' }}>
          Approval
        </span>
        {/* The audit's "whether the action stages or sends". */}
        <Chip tone={isSend ? 'critical' : 'info'}>
          {isSend ? 'Approving SENDS externally' : 'Approving STAGES internally'}
        </Chip>
        {liveApproval && <Chip tone="success">Approved</Chip>}
        {w.changedSinceReview && <Chip tone="critical">Changed since review</Chip>}
      </div>

      <div style={{ padding: 13, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* changed-since-review / invalidation, with the precise fields that moved */}
        {w.changedSinceReview && (
          <div style={warnBox}>
            <Icon name="alert" size={14} color="#A14D12" />
            <span style={{ flex: 1 }}>
              A prior approval no longer applies: {data.approvalInvalidReason}
              {data.changedFields.length > 0 ? ` (${data.changedFields.join(', ')})` : ''}. Review
              the current content and approve again.
            </span>
          </div>
        )}

        {/* fallback-content warning — the audit's exact wording intent */}
        {w.fallbackContent && (
          <div style={warnBox}>
            <Icon name="alert" size={14} color="#A14D12" />
            <span style={{ flex: 1 }}>
              Generated content was unavailable. This draft uses fallback content and requires
              completion before use.
            </span>
          </div>
        )}

        {/* plan-version drift */}
        {w.versionDrift && (
          <div style={warnBox}>
            <Icon name="alert" size={14} color="#A14D12" />
            <span style={{ flex: 1 }}>
              The plan changed since this run was prepared — it was built against an earlier
              version.
            </span>
          </div>
        )}

        {/* unresolved conflicts */}
        {w.openMaterialConflicts.length > 0 && (
          <div style={warnBox}>
            <Icon name="alert" size={14} color="#A14D12" />
            <div style={{ flex: 1 }}>
              {w.openMaterialConflicts.length} unresolved context conflict
              {w.openMaterialConflicts.length === 1 ? '' : 's'}:
              {w.openMaterialConflicts.map((c) => (
                <div key={c.id} style={{ marginTop: 3 }}>
                  “{c.factA}” vs “{c.factB}”
                </div>
              ))}
            </div>
          </div>
        )}

        {/* grounding status + missing context */}
        {(w.groundingStatus !== 'ok' || w.missingRequiredContext.length > 0) && (
          <div style={warnBox}>
            <Icon name="info" size={14} color="#A14D12" />
            <span style={{ flex: 1 }}>
              Grounding is <b>{w.groundingStatus ?? 'unknown'}</b>
              {w.missingRequiredContext.length > 0
                ? ` — missing context: ${w.missingRequiredContext.join(', ')}`
                : ''}
              .
            </span>
          </div>
        )}

        {/* exact recipients */}
        <Field label={`Exact recipients (${data.binding.recipients.length})`}>
          {data.binding.recipients.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {data.binding.recipients.map((r, i) => (
                <span
                  key={r.id ?? i}
                  style={{
                    fontSize: 'var(--text-2xs)',
                    fontWeight: 600,
                    color: 'var(--ink-2)',
                    background: 'var(--bg-surface-2)',
                    border: '1px solid var(--border-1)',
                    borderRadius: 6,
                    padding: '2px 7px',
                  }}
                >
                  {r.name}
                  {r.address ? ` · ${r.address}` : ''}
                </span>
              ))}
            </div>
          ) : (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)' }}>
              No recipient resolved — nothing would be addressed.
            </span>
          )}
        </Field>

        <Field label="Exact subject">{data.binding.subject || '—'}</Field>

        {/* full content preview */}
        <Field label="Full content">
          {data.binding.body ? (
            <>
              <div
                style={{
                  whiteSpace: 'pre-wrap',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--ink-2)',
                  lineHeight: 1.6,
                  maxHeight: showBody ? 'none' : 120,
                  overflow: 'hidden',
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-1)',
                  borderRadius: 8,
                  padding: '9px 11px',
                }}
              >
                {data.binding.body}
              </div>
              <button
                onClick={() => setShowBody((v) => !v)}
                style={{ ...chipBtn, marginTop: 6 }}
              >
                {showBody ? 'Collapse' : 'Show full content'}
              </button>
            </>
          ) : (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)' }}>
              No content generated yet — approving authorises this plan, not prose.
            </span>
          )}
        </Field>

        {/* what the approval is bound to — the audit trail, visible */}
        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)', lineHeight: 1.6 }}>
          Bound to plan version <code>{(w.headVersionId ?? 'unknown').slice(0, 8)}</code>, template{' '}
          <code>{data.binding.templateVersion ?? 'none'}</code>
          {data.binding.model ? (
            <>
              , model <code>{data.binding.model}</code>
            </>
          ) : null}
          . Content hash <code>{data.contentHash.slice(0, 12)}</code>. Any change to the recipients,
          subject, content, plan version, template or grounding invalidates this approval.
        </div>

        {liveApproval && approvedRecord && (
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)' }}>
            Approved {relativeTime(approvedRecord.approvedAt)} · hash{' '}
            <code>{approvedRecord.contentHash.slice(0, 12)}</code>
          </div>
        )}

        {/* ---- controls ---- */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 2 }}>
          {isSend ? (
            <button
              disabled
              aria-disabled="true"
              title={SEND_DISABLED_COPY}
              style={{ ...btnPrimary, padding: '7px 14px', fontSize: 'var(--text-xs)', opacity: 0.5 }}
            >
              Approve exact draft
            </button>
          ) : (
            <button
              onClick={onApprove}
              disabled={approve.isPending || liveApproval}
              style={{
                ...btnPrimary,
                padding: '7px 14px',
                fontSize: 'var(--text-xs)',
                opacity: approve.isPending || liveApproval ? 0.55 : 1,
              }}
            >
              {approve.isPending
                ? 'Approving…'
                : liveApproval
                  ? 'Approved'
                  : 'Approve exact draft'}
            </button>
          )}
          <button
            onClick={() => onReject('changes requested by the reviewer', 'Changes requested.')}
            disabled={reject.isPending}
            style={{ ...chipBtn }}
          >
            Request changes
          </button>
          <button
            onClick={() => onReject('rejected by the reviewer', 'Rejected.')}
            disabled={reject.isPending}
            style={{ ...chipBtn }}
          >
            Reject
          </button>
        </div>

        {isSend && (
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--critical)', fontWeight: 600 }}>
            {SEND_DISABLED_COPY}
          </div>
        )}
        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)' }}>
          Regenerate and Cancel run are in the recovery controls below. To edit the content, open
          the staged draft.
        </div>
      </div>
    </div>
  );
}

/** One task line: icon + title + status + artifact link / blocked reason. */
function TaskRow({ task }: { task: ExecutionTask }) {
  const navigate = useNavigate();
  const meta = TASK_META[task.type];

  const openArtifact = () => {
    if (!task.artifactRef) return;
    // workspace_draft -> straight to the editor, not Setup: the staging call
    // (stageWorkspace/onRoute) already set client/product and seeded
    // config.sectionContent, so Setup has nothing left to configure — it was
    // just an extra click between the user and the content they staged.
    const target =
      task.type === 'outreach_record'
        ? `/engagement/outreach/draft/${encodeURIComponent(task.artifactRef)}`
        : `/workspace/draft/${encodeURIComponent(task.artifactRef)}`;
    navigate(target);
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        background: 'var(--bg-surface-2)',
        border: '1px solid var(--border-1)',
        borderRadius: 8,
        padding: '9px 11px',
      }}
    >
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: 7,
          background: 'var(--accent-soft)',
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
        }}
      >
        <Icon name={meta.icon} size={14} color="var(--accent-ink)" />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--ink-1)' }}>
            {task.title}
          </span>
          <span
            style={{
              fontSize: 'var(--text-2xs)',
              fontWeight: 700,
              color: 'var(--ink-3)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {meta.label}
          </span>
          <TaskStatusChip status={task.status} />
        </div>
        {task.model && (
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)', marginTop: 3 }}>
            Grounded in {task.groundedFactCount ?? 0} fact{task.groundedFactCount === 1 ? '' : 's'} · {task.model}
          </div>
        )}
        {task.blockedReason && (
          <div style={{ fontSize: 'var(--text-2xs)', color: '#A14D12', marginTop: 3, lineHeight: 1.45 }}>
            {task.blockedReason}
          </div>
        )}
        {task.type === 'await_send_approval' && (
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)', marginTop: 3 }}>
            Outreach is staged only — sending stays disabled until Stage H.
          </div>
        )}
        {task.artifactRef && (
          <button
            onClick={openArtifact}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              marginTop: 5,
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: 'var(--accent-ink)',
              fontSize: 'var(--text-2xs)',
              fontWeight: 600,
              fontFamily: 'var(--font-sans)',
            }}
          >
            Open in Capiro <Icon name="external" size={12} color="var(--accent-ink)" />
          </button>
        )}
      </div>
    </div>
  );
}

function TaskStatusChip({ status }: { status: ExecutionTask['status'] }) {
  const tone: 'accent' | 'notable' | 'info' | 'success' | 'critical' | 'ink' =
    status === 'staged' || status === 'done'
      ? 'success'
      : status === 'blocked'
        ? 'critical'
        : status === 'awaiting_approval'
          ? 'notable'
          : status === 'skipped'
            ? 'ink'
            : 'info';
  return <Chip tone={tone}>{status.replace(/_/g, ' ')}</Chip>;
}

/**
 * A clear blocked state (waiting_for_input, non-send). Renders the precise
 * reason the run parked on, plus a Resume affordance for recoverable blockers
 * (re-planned against the current head, or picked up interactively). Resume
 * never sends — it re-attempts STAGING.
 */
function BlockedNotice({
  block,
  onResume,
  resuming,
}: {
  block: ReturnType<typeof classifyWaitingReason>;
  onResume: () => void;
  resuming: boolean;
}) {
  return (
    <div style={{ ...warnBox, marginTop: 10, flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
        <Icon name="alert" size={14} color="#A14D12" />
        <span style={{ fontWeight: 700, flex: 1 }}>{block.label}</span>
        <button
          onClick={onResume}
          disabled={resuming}
          style={{
            ...chipBtn,
            background: 'transparent',
            borderColor: '#D97742',
            color: '#A14D12',
          }}
        >
          {resuming ? 'Resuming…' : 'Resume'}
        </button>
      </div>
      <span style={{ width: '100%' }}>{block.reason}</span>
    </div>
  );
}

/**
 * The send-approval panel (safety-critical). Echoes exactly what a send WOULD
 * carry (recipients, subject, ask, window, staged body), notes that any content
 * edit invalidates a prior approval, and renders the APPROVE THIS SEND control
 * VISIBLY DISABLED with the Stage-H copy. The approve handler is fully wired
 * (it would resume the run with the staged approval token) but the control is
 * inert — the actual send is hard-disabled server-side until Stage H.
 */
function SendApprovalPanel({ run }: { run: ExecutionRun }) {
  const { message } = App.useApp();
  const resume = useResumeRun();
  const task = sendApprovalTask(run);
  const send: SendApprovalPreview | null = task?.send ?? null;
  const priorInvalidated = isPriorApprovalInvalidated(send);

  // Wired, but inert: gated behind SEND_APPROVAL_ENABLED (false in Stage G).
  // This is the exact call the Stage-H approve path will make — it must never
  // fire from a disabled control.
  const onApprove = () => {
    if (!SEND_APPROVAL_ENABLED) return;
    resume.mutate(
      { id: run.id, input: { approvalToken: send?.approvalToken ?? undefined } },
      {
        onSuccess: () => message.success('Send approved.'),
        onError: (err) => message.error(errorMessage(err, 'Could not approve the send.')),
      },
    );
  };

  const recipientCount = send?.recipients.length ?? 0;

  return (
    <div
      style={{
        marginTop: 12,
        border: '1px solid var(--border-2)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 13px',
          background: 'var(--notable-soft)',
          borderBottom: '1px solid var(--border-1)',
        }}
      >
        <Icon name="lock" size={15} color="var(--notable)" />
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--ink-1)' }}>
          Outreach staged — awaiting send approval
        </span>
      </div>

      <div style={{ padding: '13px', display: 'flex', flexDirection: 'column', gap: 11 }}>
        {!send ? (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-3)' }}>
            The staged outreach preview is unavailable on this run.
          </div>
        ) : (
          <>
            {/* what will be approved — computed echo */}
            <div
              style={{
                background: 'var(--bg-surface-2)',
                border: '1px solid var(--border-1)',
                borderRadius: 8,
                padding: '9px 11px',
                fontSize: 'var(--text-xs)',
                color: 'var(--ink-2)',
                lineHeight: 1.5,
              }}
            >
              Approving this send would deliver to <b>{recipientCount}</b> recipient
              {recipientCount === 1 ? '' : 's'}
              {send.subject ? (
                <>
                  {' '}the message <b>“{send.subject}”</b>
                </>
              ) : null}
              {send.ask ? (
                <>
                  , asking: <b>{send.ask}</b>
                </>
              ) : null}
              {send.window ? (
                <>
                  , during <b>{send.window}</b>
                </>
              ) : null}
              .
            </div>

            <Field label={`Recipients (${recipientCount})`}>
              {recipientCount > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {send.recipients.map((r, i) => (
                    <span
                      key={i}
                      style={{
                        fontSize: 'var(--text-2xs)',
                        fontWeight: 600,
                        color: 'var(--ink-2)',
                        background: 'var(--bg-surface-2)',
                        border: '1px solid var(--border-1)',
                        borderRadius: 6,
                        padding: '2px 7px',
                      }}
                    >
                      {r}
                    </span>
                  ))}
                </div>
              ) : (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)' }}>
                  No recipients resolved on this staged send.
                </span>
              )}
            </Field>

            {send.subject && <Field label="Subject">{send.subject}</Field>}
            {send.ask && <Field label="Ask">{send.ask}</Field>}
            {send.window && <Field label="Send window">{send.window}</Field>}

            <Field label="Staged content">
              <div
                style={{
                  fontSize: 'var(--text-xs)',
                  color: 'var(--ink-1)',
                  lineHeight: 1.55,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 220,
                  overflow: 'auto',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-1)',
                  borderRadius: 8,
                  padding: '9px 11px',
                }}
              >
                {send.body ?? '(no content staged)'}
              </div>
            </Field>
          </>
        )}

        {/* any edit invalidates a prior approval — always informational */}
        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)', lineHeight: 1.5 }}>
          Any edit to the staged content invalidates a prior approval — a changed draft must be
          re-approved before it could be sent.
        </div>
        {priorInvalidated && (
          <div style={warnBox} role="status">
            <Icon name="alert" size={14} color="#A14D12" />
            <span style={{ flex: 1 }}>
              The staged content changed since it was last approved — the earlier approval no longer
              applies and would have to be renewed.
            </span>
          </div>
        )}

        {/* the inert approve control */}
        <div
          style={{
            borderTop: '1px solid var(--border-1)',
            paddingTop: 11,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            aria-disabled={true}
            disabled={!SEND_APPROVAL_ENABLED}
            title={SEND_DISABLED_COPY}
            onClick={onApprove}
            style={{
              ...btnPrimary,
              padding: '9px 16px',
              fontSize: 'var(--text-xs)',
              background: 'var(--ink-4)',
              cursor: 'not-allowed',
              opacity: 0.6,
            }}
          >
            <Icon name="lock" size={13} color="#fff" /> Approve this send
          </button>
          <span
            role="note"
            style={{
              fontSize: 'var(--text-2xs)',
              fontWeight: 700,
              color: 'var(--ink-3)',
              lineHeight: 1.4,
            }}
          >
            {SEND_DISABLED_COPY}
          </span>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 'var(--text-2xs)',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--ink-4)',
          marginBottom: 5,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-1)', lineHeight: 1.5 }}>
        {children}
      </div>
    </div>
  );
}
