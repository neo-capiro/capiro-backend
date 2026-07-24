/*
 * Stage F ChangeSet review queue (/strategies/agents/review) — the human
 * approval surface over Watcher proposals (sp_change_set). Four blocks:
 * firm-level check runs (findings with NO change-set — GET
 * /agents/runs/firm-review is their ONLY viewer, since the change-set lists
 * below can never carry them and WatchRail is strategy-scoped; "Mark
 * reviewed" = the ready_for_review→completed run transition), proposed +
 * approved change-sets grouped by strategy (summary, risk badge, linked-run
 * findings, ops as a readable before/after diff with PER-OP selective
 * approval), and the applied list — the first-class Undo surface (undo =
 * restore the pinned pre-apply version).
 *
 * Gating: route-level on /me features.agenticMeri (the UI belt); the server's
 * AgenticGuard + the strategyWatcher flag are authoritative — a tenant that
 * lost the flag simply sees the queue error out with the server's reason.
 * Apply's 409 stale path ("plan changed since proposed", matched on the
 * response body via isStaleApplyConflict — a concurrent-apply 409 like
 * "Change-set is applied" surfaces the server's message instead): the server
 * marks the row stale and the list refetch drops it out of "Awaiting review",
 * so the Regenerate hint is held as QUEUE-level state (staleNotices) — a
 * card-local note would unmount with the row and the 409 would look like a
 * silent success.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App } from 'antd';
import { Chip, Icon, btnGhost, btnPrimary, chipBtn } from '../strategy-ui.js';
import {
  useAgentRun,
  useApplyChangeSet,
  useApproveChangeSet,
  useChangeSets,
  useFirmReviewRuns,
  useRejectChangeSet,
  useStrategies,
  useStrategy,
  useTransitionRun,
  useUndoChangeSet,
} from '../api.js';
import { useClientsLite } from '../clients-lite.js';
import { errorMessage } from '../../../lib/error-message.js';
import { relativeTime } from '../constants.js';
import {
  extractRunFindings,
  isStaleApplyConflict,
  opDiff,
  requiresImpactSummary,
  riskColors,
  runRiskLevel,
} from './agent-utils.js';
import type { AgentRun, ChangeSet, ChangeSetRisk, RunFinding, StrategyNode } from '../types.js';

const emptyBox: React.CSSProperties = {
  padding: 24,
  textAlign: 'center',
  fontSize: 'var(--text-sm)',
  color: 'var(--ink-3)',
  border: '1px dashed var(--border-2)',
  borderRadius: 12,
};

/** Amber stale-apply notice (same palette as the high-risk badge literals). */
const staleNoticeBox: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  marginBottom: 10,
  background: '#FCEDE6',
  border: '1px solid #D97742',
  borderRadius: 8,
  padding: '8px 11px',
  fontSize: 'var(--text-xs)',
  color: '#A14D12',
  lineHeight: 1.5,
};

const sectionHead: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  fontWeight: 700,
  color: 'var(--ink-1)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

/** Risk badge — low green / medium amber / high orange / critical red. */
export function RiskBadge({ risk }: { risk: ChangeSetRisk }) {
  const { bg, fg } = riskColors(risk);
  return (
    <span
      style={{
        background: bg,
        color: fg,
        fontSize: 'var(--text-2xs)',
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        padding: '3px 8px',
        borderRadius: 5,
        whiteSpace: 'nowrap',
      }}
    >
      {risk}
    </span>
  );
}

export function ReviewQueue() {
  const navigate = useNavigate();
  const proposed = useChangeSets({ status: 'proposed' });
  const approved = useChangeSets({ status: 'approved' });
  const applied = useChangeSets({ status: 'applied' });
  const firmRuns = useFirmReviewRuns();
  const strategies = useStrategies();
  const clients = useClientsLite();
  // Apply→409 explanations. Owned HERE (not by the card): the failed row is
  // stale server-side and leaves the approved list on the very next refetch,
  // unmounting its card — the hint must outlive that or the 409 is invisible.
  const [staleNotices, setStaleNotices] = useState<{ id: string; summary: string }[]>([]);
  const noteStale = (cs: ChangeSet) =>
    setStaleNotices((prev) =>
      prev.some((n) => n.id === cs.id) ? prev : [...prev, { id: cs.id, summary: cs.summary }],
    );

  const strategyLabel = (strategyId: string): { title: string; client: string } => {
    const s = strategies.data?.find((r) => r.id === strategyId);
    const client = s ? (clients.data?.find((c) => c.id === s.clientId)?.name ?? 'Client') : '';
    return { title: s?.title ?? 'Strategy', client };
  };

  // Open work (proposed + approved) grouped by strategy, newest group first.
  const groups = useMemo(() => {
    const rows = [...(proposed.data ?? []), ...(approved.data ?? [])];
    const byStrategy = new Map<string, ChangeSet[]>();
    for (const cs of rows) {
      const list = byStrategy.get(cs.strategyId) ?? [];
      list.push(cs);
      byStrategy.set(cs.strategyId, list);
    }
    for (const list of byStrategy.values()) {
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }
    return [...byStrategy.entries()].sort((a, b) =>
      (a[1][0]?.createdAt ?? '') < (b[1][0]?.createdAt ?? '') ? 1 : -1,
    );
  }, [proposed.data, approved.data]);

  const loading = proposed.isLoading || approved.isLoading;
  const loadError = proposed.isError || approved.isError;
  const openCount = (proposed.data?.length ?? 0) + (approved.data?.length ?? 0);
  const appliedRows = applied.data ?? [];
  // Firm-level runs carry the review obligation on the RUN (no change-set), so
  // an error/empty result simply renders no section — the change-set queue
  // below is unaffected either way.
  const firmRunRows = firmRuns.data ?? [];

  return (
    <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-canvas)', height: '100%' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '28px 40px 60px' }}>
        <button onClick={() => navigate('/strategies')} style={{ ...btnGhost, marginBottom: 14 }}>
          <Icon name="chevleft" size={14} color="var(--ink-2)" /> Strategies
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
          Agent review queue
        </h1>
        <p style={{ fontSize: 'var(--text-md)', color: 'var(--ink-2)', marginTop: 4, maxWidth: 680 }}>
          Changes Meri's Watcher proposed against your strategies. Nothing here touches a plan
          until you approve and apply it — and every applied change-set can be undone (a version
          restore, logged like any other edit).
        </p>

        {/* ---- firm-level check runs — findings with NO change-set ----------- */}
        {firmRunRows.length > 0 && (
          <>
            <div style={{ marginTop: 26, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={sectionHead}>Firm-level checks</span>
              <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)', color: 'var(--ink-4)' }}>
                {firmRunRows.length} awaiting review
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {firmRunRows.map((run) => (
                <FirmRunCard key={run.id} run={run} />
              ))}
            </div>
          </>
        )}

        {/* ---- proposed + approved, grouped by strategy ---------------------- */}
        <div style={{ marginTop: 26, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={sectionHead}>Awaiting review</span>
          <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)', color: 'var(--ink-4)' }}>
            {openCount} open
          </span>
        </div>

        {staleNotices.map((n) => (
          <div key={n.id} role="status" style={staleNoticeBox}>
            <span style={{ flex: 1 }}>
              <b>“{n.summary}”</b> was not applied — the plan changed since it was proposed, so
              the change-set is now stale and has left this queue. Regenerate it (run the check
              again from the strategy rail) to propose against the current plan.
            </span>
            <button
              onClick={() => setStaleNotices((prev) => prev.filter((x) => x.id !== n.id))}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                color: '#A14D12',
                fontSize: 'var(--text-2xs)',
                fontWeight: 700,
                fontFamily: 'var(--font-sans)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                flexShrink: 0,
              }}
            >
              Dismiss
            </button>
          </div>
        ))}

        {loading && <div style={emptyBox}>Loading change-sets…</div>}
        {!loading && loadError && (
          <div style={{ ...emptyBox, color: 'var(--critical)', borderColor: 'var(--critical)' }}>
            The review queue could not be loaded —{' '}
            {errorMessage(proposed.error ?? approved.error, 'you may not have access, or the request failed.')}
          </div>
        )}
        {!loading && !loadError && groups.length === 0 && (
          <div style={emptyBox}>
            Nothing to review — the Watcher has no open proposals. Enable Watch on a strategy (or
            run a check from its rail) to get proactive suggestions here.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {groups.map(([strategyId, rows]) => (
            <StrategyGroup
              key={strategyId}
              strategyId={strategyId}
              label={strategyLabel(strategyId)}
              rows={rows}
              onOpenStrategy={() => navigate(`/strategies/${strategyId}`)}
              onStale={noteStale}
            />
          ))}
        </div>

        {/* ---- applied — the Undo surface ------------------------------------ */}
        <div style={{ marginTop: 34, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={sectionHead}>Applied</span>
          <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)', color: 'var(--ink-4)' }}>
            {appliedRows.length} — undo restores the pre-apply version
          </span>
        </div>
        {applied.isLoading && <div style={emptyBox}>Loading applied change-sets…</div>}
        {applied.isSuccess && appliedRows.length === 0 && (
          <div style={emptyBox}>No applied change-sets yet.</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {appliedRows.map((cs) => (
            <AppliedRow
              key={cs.id}
              cs={cs}
              label={strategyLabel(cs.strategyId)}
              onOpenStrategy={() => navigate(`/strategies/${cs.strategyId}`)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * One firm-level Watcher run awaiting review (strategyId null — the F2
 * firm-calendar placeholder). It carries findings but NO change-set, so the
 * change-set sections can never surface it; this card is its review surface.
 * "Mark reviewed" = the ready_for_review -> completed run transition (logged
 * server-side like any other run move) — that is what drains the row from
 * the firm-review list.
 */
function FirmRunCard({ run }: { run: AgentRun }) {
  const { message } = App.useApp();
  const ack = useTransitionRun();
  const findings = useMemo(() => extractRunFindings(run.findings), [run.findings]);
  // The RiskRouter classification the run persisted (firm-level => critical).
  const risk = runRiskLevel(run.findings);

  const onAcknowledge = () => {
    ack.mutate(
      { id: run.id, to: 'completed' },
      {
        onSuccess: () => message.success('Firm-level check marked reviewed.'),
        onError: (err) => message.error(errorMessage(err, 'Could not mark the check reviewed.')),
      },
    );
  };

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-1)',
        borderRadius: 10,
        padding: '12px 15px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <RiskBadge risk={risk} />
        <Chip tone="ink">Watcher</Chip>
        <span
          style={{
            fontSize: 'var(--text-2xs)',
            color: 'var(--ink-3)',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Firm-wide
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)' }}>
          {relativeTime(run.createdAt)}
        </span>
        <button
          onClick={onAcknowledge}
          disabled={ack.isPending}
          style={{ ...btnPrimary, padding: '6px 14px', fontSize: 'var(--text-xs)' }}
        >
          {ack.isPending ? 'Saving…' : 'Mark reviewed'}
        </button>
      </div>
      <div style={{ marginTop: 9 }}>
        <FindingsList findings={findings} />
      </div>
    </div>
  );
}

/**
 * One strategy's open change-sets. Loads the CURRENT plan once for the whole
 * group so op diffs can show before-values + real node titles (the proposal
 * was pinned to an older head, so "where derivable" — a since-deleted node
 * renders without a before-side).
 */
function StrategyGroup({
  strategyId,
  label,
  rows,
  onOpenStrategy,
  onStale,
}: {
  strategyId: string;
  label: { title: string; client: string };
  rows: ChangeSet[];
  onOpenStrategy: () => void;
  onStale: (cs: ChangeSet) => void;
}) {
  const detail = useStrategy(strategyId);
  const nodesById = useMemo(
    () => new Map<string, StrategyNode>((detail.data?.nodes ?? []).map((n) => [n.id, n])),
    [detail.data],
  );
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <button
          onClick={onOpenStrategy}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            fontSize: 'var(--text-md)',
            fontWeight: 700,
            fontFamily: 'var(--font-sans)',
            color: 'var(--ink-1)',
          }}
        >
          {label.title}
        </button>
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
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((cs) => (
          <ChangeSetCard key={cs.id} cs={cs} nodesById={nodesById} onStale={onStale} />
        ))}
      </div>
    </div>
  );
}

/** Linked-run findings block (a change-set carries runId; findings live on the run). */
function RunFindings({ runId }: { runId: string }) {
  const run = useAgentRun(runId);
  const findings = useMemo(() => extractRunFindings(run.data?.findings), [run.data]);
  if (!run.data || findings.length === 0) return null;
  return <FindingsList findings={findings} />;
}

const FINDING_COLOR: Record<RunFinding['severity'], string> = {
  error: 'var(--critical)',
  warning: 'var(--notable)',
  info: 'var(--ink-3)',
};

export function FindingsList({ findings }: { findings: RunFinding[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {findings.slice(0, 6).map((f, i) => (
        <div key={i} style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: FINDING_COLOR[f.severity],
              marginTop: 5,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)', lineHeight: 1.45 }}>
            {f.message}
            {f.suggestion ? (
              <span style={{ color: 'var(--ink-3)' }}> — {f.suggestion}</span>
            ) : null}
          </span>
        </div>
      ))}
      {findings.length > 6 && (
        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)' }}>
          +{findings.length - 6} more finding{findings.length - 6 === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}

/**
 * One proposed/approved change-set: risk badge, summary, findings, ops diff.
 * Proposed ⇒ per-op checkboxes drive SELECTIVE approval (all → no opIndexes;
 * subset → opIndexes; empty subset is blocked — reject instead). Critical risk
 * ⇒ impact-summary confirmation before approve (RiskRouter ladder). Approved ⇒
 * Apply (409 stale reports up via onStale — see ReviewQueue.staleNotices) +
 * Reject.
 */
function ChangeSetCard({
  cs,
  nodesById,
  onStale,
}: {
  cs: ChangeSet;
  nodesById: ReadonlyMap<string, StrategyNode>;
  onStale: (cs: ChangeSet) => void;
}) {
  const { message, modal } = App.useApp();
  const approve = useApproveChangeSet();
  const reject = useRejectChangeSet();
  const apply = useApplyChangeSet();
  // null = all ops selected (the default); a Set once the user narrows it.
  const [picked, setPicked] = useState<Set<number> | null>(null);

  const isProposed = cs.status === 'proposed';
  // What apply will actually replay: the approved subset when selective.
  const displayOps = isProposed ? cs.ops : (cs.approvedOps ?? cs.ops);
  const diffs = displayOps.map((op) => opDiff(op, nodesById));
  const selected = picked ?? new Set(cs.ops.map((_, i) => i));
  const busy = approve.isPending || reject.isPending || apply.isPending;

  const toggleOp = (i: number) => {
    const next = new Set(selected);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setPicked(next);
  };

  const doApprove = () => {
    const all = selected.size === cs.ops.length;
    approve.mutate(
      { id: cs.id, input: all ? {} : { opIndexes: [...selected].sort((a, b) => a - b) } },
      {
        onSuccess: () =>
          message.success(all ? 'Change-set approved.' : `Approved ${selected.size} of ${cs.ops.length} changes.`),
        onError: (err) => message.error(errorMessage(err, 'Could not approve the change-set.')),
      },
    );
  };

  const onApprove = () => {
    if (selected.size === 0) return;
    if (!requiresImpactSummary(cs.risk)) {
      doApprove();
      return;
    }
    // Critical/firm-level: explicit confirmation WITH an impact summary.
    const lines = [...selected]
      .sort((a, b) => a - b)
      .map((i) => diffs[i])
      .filter((d): d is NonNullable<typeof d> => !!d);
    modal.confirm({
      title: 'Confirm this critical change',
      width: 520,
      content: (
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <p style={{ marginTop: 0 }}>
            <b>{cs.summary}</b>
          </p>
          <p>
            This is a <b>critical-risk</b> change-set. Approving it stages {lines.length} change
            {lines.length === 1 ? '' : 's'} for apply:
          </p>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            {lines.slice(0, 8).map((d, i) => (
              <li key={i}>
                {d.verb} — {d.nodeTitle}
                {d.changes.length > 0 ? ` (${d.changes.map((c) => c.field).join(', ')})` : ''}
              </li>
            ))}
            {lines.length > 8 && <li>+{lines.length - 8} more</li>}
          </ul>
        </div>
      ),
      okText: 'Approve anyway',
      onOk: doApprove,
    });
  };

  const onReject = () => {
    modal.confirm({
      title: 'Reject this change-set?',
      content: 'The proposal is closed without touching the plan. The Watcher can propose again.',
      okText: 'Reject',
      okButtonProps: { danger: true },
      onOk: () =>
        new Promise<void>((resolve, rejectP) => {
          reject.mutate(cs.id, {
            onSuccess: () => {
              message.success('Change-set rejected.');
              resolve();
            },
            onError: (err) => {
              message.error(errorMessage(err, 'Could not reject the change-set.'));
              rejectP(new Error('reject failed'));
            },
          });
        }),
    });
  };

  const onApply = () => {
    apply.mutate(
      { id: cs.id, strategyId: cs.strategyId },
      {
        onSuccess: () => message.success('Change-set applied — one new version was cut. Undo is available below.'),
        onError: (err) => {
          if (isStaleApplyConflict(err)) {
            // Stale-head 409 (keyed on the response BODY — apply also 409s
            // when a concurrent reviewer already applied/rejected this set,
            // and that case must NOT read as "regenerate"). The mutation's
            // onError already invalidated the change-set lists and this row
            // is stale server-side, so this card is about to unmount — the
            // explanation must live on the queue, not here.
            onStale(cs);
          } else {
            // Non-stale 409s land here too: surface the server's reason
            // ("Change-set is applied — approve it before applying").
            message.error(errorMessage(err, 'Could not apply the change-set.'));
          }
        },
      },
    );
  };

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-1)',
        borderRadius: 10,
        padding: '12px 15px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <RiskBadge risk={cs.risk} />
        <Chip tone={isProposed ? 'accent' : 'info'}>{cs.status}</Chip>
        {cs.createdByUserId === null && <Chip tone="ink">Watcher</Chip>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)' }}>
          {relativeTime(cs.createdAt)}
        </span>
        {isProposed ? (
          <>
            <button
              onClick={onReject}
              disabled={busy}
              style={{ ...btnGhost, padding: '6px 12px', fontSize: 'var(--text-xs)' }}
            >
              Reject
            </button>
            <button
              onClick={onApprove}
              disabled={busy || selected.size === 0}
              title={selected.size === 0 ? 'Select at least one change (or Reject the proposal)' : ''}
              style={{
                ...btnPrimary,
                padding: '6px 14px',
                fontSize: 'var(--text-xs)',
                opacity: selected.size === 0 ? 0.45 : 1,
              }}
            >
              {selected.size === cs.ops.length ? 'Approve' : `Approve ${selected.size} of ${cs.ops.length}`}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={onReject}
              disabled={busy}
              style={{ ...btnGhost, padding: '6px 12px', fontSize: 'var(--text-xs)' }}
            >
              Reject
            </button>
            <button
              onClick={onApply}
              disabled={busy}
              style={{ ...btnPrimary, padding: '6px 14px', fontSize: 'var(--text-xs)' }}
            >
              {apply.isPending ? 'Applying…' : 'Apply'}
            </button>
          </>
        )}
      </div>

      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-1)', fontWeight: 600, marginTop: 9 }}>
        {cs.summary}
      </div>
      {!isProposed && cs.approvedOps !== null && cs.approvedOps.length !== cs.ops.length && (
        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)', marginTop: 3 }}>
          {cs.approvedOps.length} of {cs.ops.length} proposed changes were approved — apply replays
          only those.
        </div>
      )}

      {cs.runId && (
        <div style={{ marginTop: 9 }}>
          <RunFindings runId={cs.runId} />
        </div>
      )}

      {/* ops diff */}
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {diffs.map((d, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 9,
              alignItems: 'flex-start',
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-1)',
              borderRadius: 8,
              padding: '8px 10px',
              opacity: isProposed && !selected.has(i) ? 0.5 : 1,
            }}
          >
            {isProposed && (
              <input
                type="checkbox"
                checked={selected.has(i)}
                disabled={busy}
                onChange={() => toggleOp(i)}
                style={{ marginTop: 2, cursor: 'pointer' }}
              />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-1)' }}>
                <b>{d.verb}</b> · {d.nodeTitle}
                {d.unknownNode && (
                  <span style={{ color: 'var(--notable)' }}> (step no longer in the plan)</span>
                )}
              </span>
              {d.changes.length > 0 && (
                <div style={{ marginTop: 3, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {d.changes.map((c, j) => (
                    <span
                      key={j}
                      style={{
                        fontSize: 'var(--text-2xs)',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--ink-3)',
                      }}
                    >
                      {c.field}:{' '}
                      {c.before !== null && (
                        <>
                          <span style={{ textDecoration: 'line-through' }}>{c.before}</span>
                          {' → '}
                        </>
                      )}
                      <span style={{ color: 'var(--ink-1)' }}>{c.after}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {diffs.length === 0 && (
          <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)' }}>
            No ops on this change-set.
          </span>
        )}
      </div>
    </div>
  );
}

/** One applied change-set row — the Undo surface (restore the pinned pre-apply version). */
function AppliedRow({
  cs,
  label,
  onOpenStrategy,
}: {
  cs: ChangeSet;
  label: { title: string; client: string };
  onOpenStrategy: () => void;
}) {
  const { message, modal } = App.useApp();
  const undo = useUndoChangeSet();

  const onUndo = () => {
    modal.confirm({
      title: 'Undo this change-set?',
      content:
        'The plan is restored to the version it was on before this change-set was applied ' +
        '(a normal version restore — it is itself logged and reversible from History). Only the ' +
        'most recent apply can be undone this way; anything later must go through version history.',
      okText: 'Undo change-set',
      onOk: () =>
        new Promise<void>((resolve, rejectP) => {
          undo.mutate(
            { id: cs.id, strategyId: cs.strategyId },
            {
              onSuccess: () => {
                message.success('Change-set undone — the pre-apply version was restored.');
                resolve();
              },
              onError: (err) => {
                message.error(errorMessage(err, 'Could not undo the change-set.'));
                rejectP(new Error('undo failed'));
              },
            },
          );
        }),
    });
  };

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-1)',
        borderRadius: 10,
        padding: '10px 15px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <RiskBadge risk={cs.risk} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-1)', fontWeight: 600 }}>
          {cs.summary}
        </div>
        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-3)', marginTop: 2 }}>
          <button
            onClick={onOpenStrategy}
            style={{
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
            {label.title}
          </button>
          {label.client ? ` · ${label.client}` : ''} · applied {relativeTime(cs.appliedAt ?? cs.updatedAt)}
        </div>
      </div>
      <button
        onClick={onUndo}
        disabled={undo.isPending}
        style={{ ...chipBtn, color: 'var(--critical)', borderColor: 'var(--critical)' }}
      >
        {undo.isPending ? 'Undoing…' : 'Undo'}
      </button>
    </div>
  );
}
