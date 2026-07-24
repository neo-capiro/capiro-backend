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
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { App } from 'antd';
import { Chip, Icon, btnGhost, btnPrimary, chipBtn } from '../strategy-ui.js';
import { useExecutionRuns, useExecuteRun, useResumeRun, useStrategies } from '../api.js';
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

const RUN_STATE_META: Record<
  RunState,
  { label: string; tone: 'accent' | 'notable' | 'info' | 'success' | 'critical' | 'ink' }
> = {
  queued: { label: 'Queued', tone: 'ink' },
  planning: { label: 'Planning', tone: 'info' },
  waiting_for_input: { label: 'Waiting', tone: 'notable' },
  executing: { label: 'Executing', tone: 'info' },
  ready_for_review: { label: 'Ready for review', tone: 'accent' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'critical' },
  canceled: { label: 'Canceled', tone: 'ink' },
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
    const NEEDS_ATTENTION: ReadonlySet<RunState> = new Set(['ready_for_review', 'waiting_for_input']);
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

      {run.state === 'failed' && run.error && (
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

      {/* other blocked states: a clear reason, never a generic error */}
      {block && block.kind !== 'send_approval' && (
        <BlockedNotice
          block={block}
          onResume={onResume}
          resuming={resume.isPending}
        />
      )}
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
