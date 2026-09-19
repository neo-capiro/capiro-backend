/*
 * Agent review queue — /strategies/agents/proposals (STRATEGIES-HANDOFF §7.8).
 *
 * Governance invariants (§11, BUILD-CONTRACT hard rules — release blockers):
 *  1. NO AUTO-APPLY: nothing here applies an operation without an explicit
 *     human click on "Apply N changes". No timer, no effect, no fast path.
 *  2. Approve ≠ apply: two distinct mutations (…/approve with opIndexes, then
 *     …/apply) behind two distinct buttons, separately labelled.
 *  3. Selection is the unit of application: per-op checkboxes drive the
 *     approved subset (opIndexes); apply replays exactly that subset into
 *     exactly ONE new revision.
 *  4. Base-revision checking: a 409 stale-head on apply surfaces the
 *     "this plan changed elsewhere / regenerate" state (queue-level, because
 *     the stale row leaves the list on refetch) — never an overwrite.
 *  5. Every applied set is undoable via …/undo (a NEW revision, never a rewind).
 *  6. No UI edits source documents, fact values, steward decisions, revisions.
 *     No deletes anywhere on this surface.
 *
 * The dark banner copy is product policy — do not reword.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../../components/feedback/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import {
  clientName,
  memberName,
  useApproveChangeSet,
  useApplyChangeSet,
  useChangeSets,
  useClientsLite,
  useFirmReviewRuns,
  useRejectChangeSet,
  useStrategies,
  useStrategy,
  useTenantMembers,
  useTransitionRun,
  useUndoChangeSet,
} from '../strategies-api.js';
import {
  extractRunFindings,
  isStaleApplyConflict,
  opDiff,
  runRiskLevel,
  type OpDiffView,
} from '../../../../pages/strategy/agents/agent-utils.js';
import { errorMessage } from '../../../../lib/error-message.js';
import type {
  ChangeSet,
  ChangeSetRisk,
  ChangeSetStatus,
  NodeKind,
  RunFinding,
  StrategyNode,
} from '../../../../pages/strategy/types.js';
import { proposalSummary, BannerGovernanceGlyph, fmtRelative, isForbidden, shortId, StaleNote, staleOrError } from './agents-shared.js';

/** spStrategy.id is a UUID column; anything else is a malformed link, not a query. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/* Change-set status pills: dot + text label, never colour-only (§5). */
const CS_PILL: Record<ChangeSetStatus, { label: string; tone: string }> = {
  proposed: { label: 'Proposed', tone: 'st-pill--warning' },
  approved: { label: 'Approved', tone: 'st-pill--accent' },
  applied: { label: 'Applied', tone: 'st-pill--success' },
  rejected: { label: 'Rejected', tone: '' },
  stale: { label: 'Stale', tone: 'st-pill--error' },
  undone: { label: 'Undone', tone: '' },
};

const RISK_PILL: Record<ChangeSetRisk, { label: string; tone: string }> = {
  low: { label: 'Low risk', tone: 'st-pill--success' },
  medium: { label: 'Medium risk', tone: 'st-pill--warning' },
  high: { label: 'High risk', tone: 'st-pill--error' },
  critical: { label: 'Critical risk', tone: 'st-pill--error' },
};

/*
 * Risk-level filter (design handoff, "Awaiting review" section) — a
 * threshold ladder over the SAME risk vocabulary the pills above already
 * use ("Medium+"/"High+" read as "at least this severity"), filtering the
 * already-fetched queue client-side rather than re-fetching.
 */
const RISK_RANK: Record<ChangeSetRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };
type RiskFilter = 'all' | 'medium' | 'high';
const RISK_FILTER_MIN: Record<RiskFilter, number> = {
  all: 0,
  medium: RISK_RANK.medium,
  high: RISK_RANK.high,
};

/*
 * Operation kind pill (design handoff "Step-kind table" — Action/brand,
 * Gate/gray, Milestone/purple, Risk/error; Decision keeps its own
 * accent-focus shade per strategies-tokens.css). Reuses the shared pill tone
 * classes (`.st-pill--purple` etc. — strategies.css) already wired to the
 * `--st-kind-*` / `--st-purple-*` tokens; no literal color here. Shown only
 * when the op itself carries a real `kind` (an add, or an update that
 * changes it) — a plain remove/retime with no kind is never given a
 * fabricated one.
 */
const KIND_PILL: Record<NodeKind, { label: string; tone: string }> = {
  action: { label: 'Action', tone: 'st-pill--accent' },
  gate: { label: 'Gate', tone: '' },
  milestone: { label: 'Milestone', tone: 'st-pill--purple' },
  risk: { label: 'Risk', tone: 'st-pill--error' },
  decision: { label: 'Decision', tone: 'st-agents__op-kind--decision' },
};
const NODE_KINDS = new Set<string>(['action', 'gate', 'milestone', 'risk', 'decision']);

function StatusPill({ status }: { status: ChangeSetStatus }) {
  const meta = CS_PILL[status] ?? { label: status, tone: '' };
  return <span className={`st-pill ${meta.tone}`.trim()}>{meta.label}</span>;
}

function RiskPill({ risk }: { risk: ChangeSetRisk }) {
  const meta = RISK_PILL[risk] ?? RISK_PILL.critical;
  return <span className={`st-pill ${meta.tone}`.trim()}>{meta.label}</span>;
}

function OpKindPill({ kind }: { kind: string | undefined }) {
  if (!kind || !NODE_KINDS.has(kind)) return null;
  const meta = KIND_PILL[kind as NodeKind];
  return <span className={`st-pill st-mono st-agents__op-kind ${meta.tone}`.trim()}>{meta.label}</span>;
}

/** §7.8 rail breakdown: counts by op verb over the selected ops. */
function changeBreakdown(diffs: OpDiffView[]): string {
  const counts = new Map<string, number>();
  for (const d of diffs) counts.set(d.verb, (counts.get(d.verb) ?? 0) + 1);
  return [...counts.entries()].map(([verb, n]) => `${n} × ${verb.toLowerCase()}`).join(' · ');
}

export function ProposalsQueue() {
  const proposed = useChangeSets({ status: 'proposed' });
  const approved = useChangeSets({ status: 'approved' });
  const applied = useChangeSets({ status: 'applied' });
  const firmRuns = useFirmReviewRuns();
  const strategies = useStrategies();
  const clients = useClientsLite();
  const members = useTenantMembers();

  /*
   * Apply→409 stale-head explanations live at QUEUE level (canonical pattern):
   * the failed row is stale server-side and leaves the approved list on the
   * next refetch, unmounting its card — the notice must outlive the card or
   * the 409 is invisible (hard rule 4).
   */
  const [staleNotices, setStaleNotices] = useState<Array<{ id: string; summary: string }>>([]);
  const noteStale = (cs: ChangeSet) =>
    setStaleNotices((prev) =>
      prev.some((n) => n.id === cs.id) ? prev : [...prev, { id: cs.id, summary: cs.summary }],
    );

  const strategyLabel = (strategyId: string): { title: string; client: string } => {
    const s = strategies.data?.find((r) => r.id === strategyId);
    return { title: s?.title ?? 'Strategy unavailable', client: clientName(clients.data, s?.clientId) };
  };

  /* Open work (proposed + approved) grouped by strategy, newest group first. */
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

  /* "All risk" default; narrower thresholds filter the SAME grouped data
   * (never a re-fetch). The section summary below stays grounded in the
   * true, unfiltered `groups`/`openCount` — only the rendered list narrows
   * (StewardReviewVNext's "Open only" toggle is the precedent: its own
   * section summary likewise stays on the client-scoped, not further-
   * filtered, total). */
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');
  const visibleGroups = useMemo(() => {
    if (riskFilter === 'all') return groups;
    const min = RISK_FILTER_MIN[riskFilter];
    return groups
      .map(([strategyId, rows]) => [strategyId, rows.filter((cs) => RISK_RANK[cs.risk] >= min)] as const)
      .filter(([, rows]) => rows.length > 0);
  }, [groups, riskFilter]);

  const queueLoading = proposed.isLoading || approved.isLoading;
  const queueQuery = proposed.isError ? proposed : approved;
  const queueState = staleOrError(queueQuery);
  const openCount = (proposed.data?.length ?? 0) + (approved.data?.length ?? 0);
  const appliedRows = applied.data ?? [];

  return (
    <div className="st-agents">
      <div className="st-dark-banner st-dark-banner--agents">
        <span className="st-dark-banner__icon" aria-hidden="true">
          <BannerGovernanceGlyph />
        </span>
        <div>
          <p className="st-dark-banner__title">You decide which proposed changes to apply.</p>
          <p className="st-dark-banner__sub">
            Applying a proposal updates the plan directly and saves a revision you can undo. Direct
            edits by you or Meri follow a separate workflow.
          </p>
        </div>
        <span className="st-dark-banner__chip">No auto-apply</span>
      </div>

      {/* ---- 409 state: "this plan changed elsewhere / regenerate" ---------- */}
      {staleNotices.map((n) => (
        <div key={n.id} className="st-agents__notice" role="status">
          <span className="st-agents__notice-text">
            <b>&ldquo;{proposalSummary(n.summary)}&rdquo;</b> was not applied — this plan changed elsewhere, so the
            change-set is now stale and has left this queue. Regenerate it (run the check again from
            the strategy) to propose against the current plan.
          </span>
          <CapiroButton
            size="compact"
            onClick={() => setStaleNotices((prev) => prev.filter((x) => x.id !== n.id))}
          >
            Dismiss
          </CapiroButton>
        </div>
      ))}

      <FirmChecks
        runs={firmRuns}
      />

      {/* ---- Awaiting review ------------------------------------------------- */}
      <div className="st-agents__section">
        {/* Design handoff — label stacked above a real summary line ("N
            change-sets awaiting review across M strategies"), not the small
            inline mono count this used to show; both numbers are the same
            already-fetched real data (openCount / groups.length), never a
            fabricated total. */}
        <div className="st-agents__section-head st-agents__section-head--stack">
          <h2 className="st-section-label">Awaiting review</h2>
          {!queueLoading && queueState === null && (
            <span className="st-agents__section-summary">
              {openCount} change-set{openCount === 1 ? '' : 's'} awaiting review across{' '}
              {groups.length} strateg{groups.length === 1 ? 'y' : 'ies'}
            </span>
          )}
        </div>

        {/* Risk-level filter — same active/inactive toggle-button visual
            language as StrategyLibraryVNext's owner filter / StewardReviewVNext's
            "Open only" toggle (`.st-segmented`, strategies.css), not a new
            filter-chip pattern. Shown only once there is a real queue to filter. */}
        {!queueLoading && queueState === null && groups.length > 0 && (
          <div className="st-segmented st-agents__risk-filter" role="group" aria-label="Filter by risk level">
            <button type="button" aria-pressed={riskFilter === 'all'} onClick={() => setRiskFilter('all')}>
              All risk
            </button>
            <button type="button" aria-pressed={riskFilter === 'medium'} onClick={() => setRiskFilter('medium')}>
              Medium+
            </button>
            <button type="button" aria-pressed={riskFilter === 'high'} onClick={() => setRiskFilter('high')}>
              High+
            </button>
          </div>
        )}

        {queueState === 'stale' && <StaleNote dataUpdatedAt={queueQuery.dataUpdatedAt} />}

        {queueLoading ? (
          <div className="st-agents__list">
            {[0, 1].map((i) => (
              <div key={i} className="st-card">
                <div className="st-card__body st-agents__skeleton-card">
                  <CapiroSkeleton height={18} width="55%" />
                  <CapiroSkeleton height={14} width="90%" />
                  <CapiroSkeleton height={14} width="75%" />
                </div>
              </div>
            ))}
          </div>
        ) : queueState === 'error' ? (
          isForbidden(queueQuery.error) ? (
            <CapiroEmptyState
              title="No access to the review queue"
              description="Your role does not include agent review. The proposals are intact — ask an administrator for the agentic-Meri feature if you should see them."
            />
          ) : (
            <CapiroErrorState
              title="The review queue could not be loaded"
              description={`${errorMessage(queueQuery.error, 'The strategy service did not respond.')} Your data is intact — retry to reload the queue.`}
              onRetry={() => {
                void proposed.refetch();
                void approved.refetch();
              }}
            />
          )
        ) : groups.length === 0 ? (
          <CapiroEmptyState
            title="Nothing to review"
            description="There are no open proposals. Open a strategy and use Strategy monitoring to enable manual or scheduled checks. An empty queue does not mean a check has run."
          />
        ) : visibleGroups.length === 0 ? (
          <CapiroEmptyState
            title="No change-sets match this risk filter"
            description="Try a lower risk threshold to see the rest of the open queue."
          />
        ) : (
          <div className="st-agents__groups">
            {visibleGroups.map(([strategyId, rows]) => (
              <StrategyGroup
                key={strategyId}
                strategyId={strategyId}
                label={strategyLabel(strategyId)}
                rows={rows}
                onStale={noteStale}
              />
            ))}
          </div>
        )}
      </div>

      {/* ---- Applied — the Undo surface (hard rule 5) ------------------------ */}
      <div className="st-agents__section">
        <div className="st-agents__section-head">
          <h2 className="st-section-label">Applied</h2>
          {applied.isSuccess && (
            <span className="st-mono st-agents__count">
              {appliedRows.length} — undo restores the pre-apply version
            </span>
          )}
        </div>

        {staleOrError(applied) === 'stale' && <StaleNote dataUpdatedAt={applied.dataUpdatedAt} />}

        {applied.isLoading ? (
          <div className="st-agents__list">
            {[0, 1].map((i) => (
              <div key={i} className="st-card">
                <div className="st-card__body">
                  <CapiroSkeleton height={16} width="70%" />
                </div>
              </div>
            ))}
          </div>
        ) : staleOrError(applied) === 'error' ? (
          isForbidden(applied.error) ? (
            <CapiroEmptyState
              title="No access to applied change-sets"
              description="Your role does not include agent review."
            />
          ) : (
            <CapiroErrorState
              title="Applied change-sets could not be loaded"
              description={errorMessage(applied.error, 'The strategy service did not respond.')}
              onRetry={() => void applied.refetch()}
            />
          )
        ) : appliedRows.length === 0 ? (
          <CapiroEmptyState
            title="No applied change-sets yet"
            description="Applied proposals land here with their undo control — each one is a revision you can walk back."
          />
        ) : (
          <div className="st-agents__list">
            {appliedRows.map((cs) => (
              <AppliedRow
                key={cs.id}
                cs={cs}
                label={strategyLabel(cs.strategyId)}
                appliedBy={memberName(members.data, cs.appliedByUserId, 'Team member')}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/*
 * Firm-level Watcher runs (calendar baseline · firm phase model · outreach
 * guardrails) carry the review obligation on the RUN — there is no change-set,
 * so the queue below can never surface them. A human acknowledges the findings
 * through the existing ready_for_review → completed transition.
 */
function FirmChecks({ runs }: { runs: ReturnType<typeof useFirmReviewRuns> }) {
  const state = staleOrError(runs);
  const rows = runs.data ?? [];
  return (
    <div className="st-agents__section">
      <div className="st-agents__section-head">
        <h2 className="st-section-label">Firm-level checks</h2>
        {runs.isSuccess && rows.length > 0 && (
          <span className="st-mono st-agents__count">{rows.length} awaiting review</span>
        )}
      </div>

      {state === 'stale' && <StaleNote dataUpdatedAt={runs.dataUpdatedAt} />}

      {runs.isLoading ? (
        <div className="st-agents__list">
          <div className="st-card">
            <div className="st-card__body">
              <CapiroSkeleton height={16} width="60%" />
            </div>
          </div>
        </div>
      ) : state === 'error' ? (
        isForbidden(runs.error) ? (
          <CapiroEmptyState
            title="No access to firm-level checks"
            description="Your role does not include agent review."
          />
        ) : (
          <CapiroErrorState
            title="Firm-level checks could not be loaded"
            description={errorMessage(runs.error, 'The strategy service did not respond.')}
            onRetry={() => void runs.refetch()}
          />
        )
      ) : rows.length === 0 ? (
        <CapiroEmptyState
          title="No firm-level checks in review"
          description="Calendar baseline, firm phase model and outreach guardrail checks land here when a firm review run needs attention."
        />
      ) : (
        <div className="st-agents__list st-agents__firm-list">
          {rows.map((run) => {
            const findings = extractRunFindings(run.findings);
            return (
              <div key={run.id} className="st-card st-agents__firm-card">
                <div className="st-card__body">
                  <div className="st-agents__card-head">
                    <RiskPill risk={runRiskLevel(run.findings)} />
                    <span className="st-pill">Firm-wide</span>
                    <span className="st-agents__spacer" />
                    <span className="st-agents__meta">
                      run <span className="st-mono" title={run.id}>{shortId(run.id)}</span>
                      {' · '}
                      {fmtRelative(run.createdAt)}
                    </span>
                  </div>
                  {findings.length > 0 ? (
                    <FindingsList findings={findings} />
                  ) : (
                    <p className="st-agents__meta">This run reported no findings.</p>
                  )}
                  <AcknowledgeFirmCheck runId={run.id} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AcknowledgeFirmCheck({ runId }: { runId: string }) {
  const transition = useTransitionRun();
  const [actionError, setActionError] = useState<string | null>(null);
  return (
    <>
      {actionError && <p className="st-agents__error-box" role="alert">{actionError}</p>}
      <CapiroButton
        size="compact"
        disabled={transition.isPending}
        onClick={() => transition.mutate({ id: runId, to: 'completed' }, {
          onSuccess: () => setActionError(null),
          onError: (error) => setActionError(errorMessage(error, 'Could not mark the check reviewed.')),
        })}
      >
        {transition.isPending ? 'Recording review…' : 'Mark reviewed'}
      </CapiroButton>
    </>
  );
}

const FINDING_CLASS: Record<RunFinding['severity'], string> = {
  error: 'st-agents__finding--error',
  warning: 'st-agents__finding--warning',
  info: 'st-agents__finding--info',
};

function FindingsList({ findings }: { findings: RunFinding[] }) {
  return (
    <div className="st-agents__findings">
      {findings.slice(0, 6).map((f, i) => (
        <div key={i} className={`st-agents__finding ${FINDING_CLASS[f.severity]}`}>
          <span className="st-agents__finding-dot" aria-hidden="true" />
          <span>
            {f.message}
            {f.suggestion ? <span className="st-agents__meta"> — {f.suggestion}</span> : null}
          </span>
        </div>
      ))}
      {findings.length > 6 && (
        <span className="st-agents__meta">+{findings.length - 6} more findings</span>
      )}
    </div>
  );
}

/**
 * One strategy's open change-sets. Loads the CURRENT plan once per group so op
 * diffs show before-values and real step titles (the proposal was pinned to an
 * older head — a since-deleted step renders with no before-side, never a fake).
 */
function StrategyGroup({
  strategyId,
  label,
  rows,
  onStale,
}: {
  strategyId: string;
  label: { title: string; client: string };
  rows: ChangeSet[];
  onStale: (cs: ChangeSet) => void;
}) {
  const navigate = useNavigate();
  const detail = useStrategy(strategyId);
  const nodesById = useMemo(
    () => new Map<string, StrategyNode>((detail.data?.nodes ?? []).map((n) => [n.id, n])),
    [detail.data],
  );
  return (
    <div className="st-agents__group">
      <div className="st-agents__group-head">
        <button
          type="button"
          className="st-agents__link"
          onClick={() => {
            if (!strategyId || !UUID_RE.test(strategyId)) return;
            navigate(`/strategies/${strategyId}`);
          }}
        >
          {detail.data?.title ?? (detail.isLoading ? 'Loading strategy…' : label.title)}
        </button>
        {label.client !== '—' && <span className="st-agents__group-client">{label.client}</span>}
        {detail.isLoading && <span className="st-agents__meta">loading plan…</span>}
      </div>
      <div className="st-agents__list">
        {rows.map((cs) => (
          <ChangeSetCard key={cs.id} cs={cs} nodesById={nodesById} onStale={onStale} />
        ))}
      </div>
    </div>
  );
}

type ConfirmKind = 'reject' | 'approve-critical' | null;

/**
 * One proposed/approved change-set: risk + status pills, summary, base
 * revision, the op list (proposed ⇒ per-op checkboxes for SUBSET approval),
 * and the selected-operations rail with Reject / Approve / Apply N changes.
 * Approve and apply are separate mutations behind separate buttons (rule 2);
 * apply is enabled only for approved sets and replays the approved subset
 * (rule 3); a 409 stale-head on apply reports up to the queue (rule 4).
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
  const approve = useApproveChangeSet();
  const reject = useRejectChangeSet();
  const apply = useApplyChangeSet();
  /* null = all ops selected (default); a Set once the reviewer narrows it. */
  const [picked, setPicked] = useState<ReadonlySet<number> | null>(null);
  const [confirm, setConfirm] = useState<ConfirmKind>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const isProposed = cs.status === 'proposed';
  /* What apply will actually replay: the approved subset when selective. */
  const displayOps = isProposed ? cs.ops : (cs.approvedOps ?? cs.ops);
  const diffs = useMemo(() => displayOps.map((op) => opDiff(op, nodesById)), [displayOps, nodesById]);
  const selected = picked ?? new Set(cs.ops.map((_, i) => i));
  const selectedDiffs = [...selected]
    .sort((a, b) => a - b)
    .map((i) => diffs[i])
    .filter((d): d is OpDiffView => Boolean(d));
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
        onSuccess: () => setActionError(null),
        onError: (err) => setActionError(errorMessage(err, 'Could not approve the change-set.')),
      },
    );
  };

  /* Approve is now an OPTIONAL compat path (the backend accepts a direct apply
   * from `proposed`). It is gated on a non-empty selection; critical risk
   * confirms first WITH an impact summary (the RiskRouter ladder). */
  const onApprove = () => {
    if (selected.size === 0) return;
    if (cs.risk === 'critical') setConfirm('approve-critical');
    else doApprove();
  };

  const onReject = () => {
    reject.mutate(cs.id, {
      onSuccess: () => setActionError(null),
      onError: (err) => setActionError(errorMessage(err, 'Could not reject the change-set.')),
    });
  };

  /* Apply replays the SELECTED subset into ONE revision. Direct apply from
   * `proposed` sends the checked opIndexes (an unchecked op must NOT apply);
   * applying an already-approved set sends no opIndexes (the server replays
   * its recorded approved subset). A 409 keyed on the response BODY as a
   * stale-head conflict surfaces the queue-level regenerate state; any other
   * 409 (e.g. a concurrent reviewer won the race) shows the server's reason
   * inline — never the stale hint. */
  const onApply = () => {
    const subset = isProposed && selected.size < cs.ops.length
      ? [...selected].sort((a, b) => a - b)
      : undefined;
    apply.mutate(
      { id: cs.id, strategyId: cs.strategyId, opIndexes: subset },
      {
        onSuccess: () => setActionError(null),
        onError: (err) => {
          if (isStaleApplyConflict(err)) onStale(cs);
          else setActionError(errorMessage(err, 'Could not apply the change-set.'));
        },
      },
    );
  };

  /*
   * Awaiting-review layout (design handoff "Review queue tab" — 1fr/340px):
   * the change-set + operation list on the left, a dedicated review panel on
   * the right carrying the selected-operation count, the (real, derived —
   * never a fabricated plan-health delta, §8.7 GAP) change breakdown, and the
   * action row. Two SIBLING `.st-card`s in a grid, matching the reference's
   * own two-card split (not one card internally divided).
   */
  return (
    <div className="st-agents__cs-grid">
      <div className="st-card st-agents__cs-main">
        <div className="st-card__body">
          <div className="st-agents__card-head">
            <RiskPill risk={cs.risk} />
            <StatusPill status={cs.status} />
            {cs.createdByUserId === null && <span className="st-pill">Watcher</span>}
            <span className="st-agents__spacer" />
            <span className="st-agents__meta">
              Generated {fmtRelative(cs.createdAt)}
            </span>
          </div>

          <p className="st-agents__summary">{proposalSummary(cs.summary)}</p>
          <details className="st-agents__meta"><summary>Audit details</summary><p>Proposal: {cs.id}</p><p>Base revision: {cs.strategyVersionId}</p><p>Recorded summary: {cs.summary}</p></details>

          {/* ---- operations (read-only diff; checkboxes only while proposed) -- */}
          <div className="st-agents__ops">
            {diffs.length === 0 && <span className="st-agents__meta">No operations on this change-set.</span>}
            {diffs.map((d, i) => (
              <div key={i} className="st-agents__op">
                {isProposed ? (
                  /* The label carries the mobile touch target (agents.css); the
                     input keeps its own aria-label, and the label has no text of
                     its own, so the accessible name is unchanged. */
                  <label className="st-agents__op-checkbox">
                    <input
                      type="checkbox"
                      className="st-agents__op-check"
                      checked={selected.has(i)}
                      disabled={busy}
                      onChange={() => toggleOp(i)}
                      aria-label={`Select change ${i + 1}: ${d.verb} ${d.nodeTitle}`}
                    />
                  </label>
                ) : (
                  <span className="st-agents__op-check-spacer" aria-hidden="true" />
                )}
                <div className="st-agents__op-body">
                  <span className="st-agents__op-title">
                    <OpKindPill kind={displayOps[i]?.kind} />
                    <span className="st-mono st-agents__op-verb">{d.verb}</span> {d.nodeTitle}
                    {d.unknownNode && (
                      <span className="st-agents__op-moved"> (step no longer in the plan)</span>
                    )}
                  </span>
                  {d.changes.length > 0 && (
                    <span className="st-agents__diffs">
                      {/* BEFORE/AFTER value chips (design handoff) — two
                          right-aligned, stacked monospace chips per changed
                          field, replacing the old inline "field: ~~before~~ →
                          **after**" line. Rectangular (4px radius, matching
                          this file's existing `.st-agents__op-verb` chip),
                          not the fully-round `.st-pill` — a value chip, not a
                          status pill. */}
                      {d.changes.map((c, j) => (
                        <span key={j} className="st-agents__diff-row">
                          <span className="st-agents__diff-field">{c.field}</span>
                          <span className="st-agents__diff-chips">
                            {c.before !== null && (
                              <span className="st-mono st-agents__chip st-agents__chip--before">
                                BEFORE · {c.before}
                              </span>
                            )}
                            <span className="st-mono st-agents__chip st-agents__chip--after">
                              AFTER · {c.after}
                            </span>
                          </span>
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ---- review panel (§7.8) ------------------------------------------- */}
      <div className="st-card st-agents__cs-panel">
        <div className="st-card__body">
          <div>
            <span className="st-section-label">Selected operations</span>
            <span className="st-agents__cs-panel-count">
              {isProposed ? selected.size : displayOps.length}
            </span>
            {/* Static product copy from the design handoff — not reworded. */}
            <span className="st-agents__cs-panel-note">
              Reviewing only changes that preserve source grounding and external-send controls.
            </span>
          </div>

          <div className="st-agents__cs-panel-well">
            <span className="st-section-label">Operations</span>
            {isProposed ? (
              selected.size > 0 ? (
                /*
                 * Change breakdown is derived from the selected ops. A plan-
                 * health DELTA is not server-computed (§8.7 GAP — no scalar
                 * exists pre-apply) and is never synthesised here (rule 8).
                 */
                <span className="st-agents__meta">{changeBreakdown(selectedDiffs)}</span>
              ) : (
                <span className="st-agents__meta">
                  Select at least one change to approve — or reject the set.
                </span>
              )
            ) : displayOps.length > 0 ? (
              <span className="st-agents__meta">
                {displayOps.length} approved change{displayOps.length === 1 ? '' : 's'} staged —{' '}
                {changeBreakdown(diffs)}
              </span>
            ) : (
              <span className="st-agents__meta">No operations approved.</span>
            )}
          </div>

          {actionError && (
            <div className="st-agents__error-box" role="alert">
              {actionError}
            </div>
          )}

          <div className="st-agents__cs-panel-actions">
            <CapiroButton variant="quiet" size="compact" disabled={busy} onClick={() => setConfirm('reject')}>
              Reject set
            </CapiroButton>
            {/*
             * Direct apply (approval gates removed): a proposed change-set's
             * primary action applies the selected subset straight into ONE new
             * revision — no separate approve step. The backend accepts apply
             * from `proposed` (backend-audit #1). Approve remains as an
             * optional compatibility control for teams that still want a
             * recorded approval before applying; it is never a prerequisite.
             */}
            {isProposed ? (
              <>
                <CapiroButton
                  variant="secondary"
                  size="compact"
                  disabled={busy || selected.size === 0}
                  title={
                    selected.size === 0
                      ? 'Select at least one change to approve — or reject the set.'
                      : 'Optionally record an approval before applying.'
                  }
                  onClick={onApprove}
                >
                  {approve.isPending
                    ? 'Approving…'
                    : selected.size === cs.ops.length
                      ? 'Approve'
                      : `Approve ${selected.size} of ${cs.ops.length}`}
                </CapiroButton>
                <CapiroButton
                  variant="primary"
                  size="compact"
                  className="st-agents__run-actions-primary"
                  disabled={busy || selected.size === 0}
                  title={
                    selected.size === 0
                      ? 'Select at least one change to apply — or reject the set.'
                      : undefined
                  }
                  onClick={onApply}
                >
                  {apply.isPending
                    ? 'Applying…'
                    : `Apply ${selected.size} change${selected.size === 1 ? '' : 's'}`}
                </CapiroButton>
              </>
            ) : (
              <CapiroButton
                variant="primary"
                size="compact"
                className="st-agents__run-actions-primary"
                disabled={busy || displayOps.length === 0}
                onClick={onApply}
              >
                {apply.isPending ? 'Applying…' : `Apply ${displayOps.length} change${displayOps.length === 1 ? '' : 's'}`}
              </CapiroButton>
            )}
          </div>
          <span className="st-agents__undo-note">
            Applying cuts one new revision. Every applied set is undoable — undo restores the
            pre-apply plan as another revision.
          </span>
          {isProposed && selected.size === 0 && (
            <p className="st-agents__meta st-agents__rail-hint">
              Select at least one change to approve — or reject the set.
            </p>
          )}
        </div>
      </div>

      {/* Reject confirm — rejection is recorded (§11 rule 10); no plan touch. */}
      <CapiroModal open={confirm === 'reject'} title="Reject this change-set?" onClose={() => setConfirm(null)}>
        <p className="st-agents__modal-copy">
          The proposal is closed without touching the plan, and the rejection is recorded. The
          Watcher can propose again after the plan changes.
        </p>
        <div className="st-agents__modal-actions">
          <CapiroButton size="compact" onClick={() => setConfirm(null)}>
            Keep reviewing
          </CapiroButton>
          <CapiroButton
            variant="primary"
            size="compact"
            disabled={reject.isPending}
            onClick={() => {
              setConfirm(null);
              onReject();
            }}
          >
            {reject.isPending ? 'Rejecting…' : 'Reject set'}
          </CapiroButton>
        </div>
      </CapiroModal>

      {/* Critical-risk approve confirm WITH impact summary (RiskRouter ladder). */}
      <CapiroModal
        open={confirm === 'approve-critical'}
        title="Confirm this critical change"
        onClose={() => setConfirm(null)}
      >
        <p className="st-agents__modal-copy">
          <b>{proposalSummary(cs.summary)}</b>
        </p>
        <p className="st-agents__modal-copy">
          This is a critical-risk change-set. Approving it stages {selectedDiffs.length} change
          {selectedDiffs.length === 1 ? '' : 's'} for apply — applying is still a separate step:
        </p>
        <ul className="st-agents__modal-list">
          {selectedDiffs.slice(0, 8).map((d, i) => (
            <li key={i}>
              {d.verb} — {d.nodeTitle}
              {d.changes.length > 0 ? ` (${d.changes.map((c) => c.field).join(', ')})` : ''}
            </li>
          ))}
          {selectedDiffs.length > 8 && <li>+{selectedDiffs.length - 8} more</li>}
        </ul>
        <div className="st-agents__modal-actions">
          <CapiroButton size="compact" onClick={() => setConfirm(null)}>
            Back
          </CapiroButton>
          <CapiroButton
            variant="primary"
            size="compact"
            disabled={approve.isPending}
            onClick={() => {
              setConfirm(null);
              doApprove();
            }}
          >
            {approve.isPending ? 'Approving…' : 'Approve anyway'}
          </CapiroButton>
        </div>
      </CapiroModal>
    </div>
  );
}

/** One applied change-set row — the Undo surface (undo cuts a NEW revision). */
function AppliedRow({
  cs,
  label,
  appliedBy,
}: {
  cs: ChangeSet;
  label: { title: string; client: string };
  appliedBy: string;
}) {
  const navigate = useNavigate();
  const undo = useUndoChangeSet();
  const detail = useStrategy(label.title === 'Strategy unavailable' ? cs.strategyId : null);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const onUndo = () => {
    undo.mutate(
      { id: cs.id, strategyId: cs.strategyId },
      {
        onSuccess: () => setActionError(null),
        onError: (err) => setActionError(errorMessage(err, 'Could not undo the change-set.')),
      },
    );
  };

  return (
    <div className="st-card">
      <div className="st-card__body st-agents__applied">
        <RiskPill risk={cs.risk} />
        <div className="st-agents__applied-body">
          <span className="st-agents__summary">{proposalSummary(cs.summary)}</span>
          <span className="st-agents__meta">
            <button
              type="button"
              className="st-agents__link"
              onClick={() => {
                if (!cs.strategyId || !UUID_RE.test(cs.strategyId)) return;
                navigate(`/strategies/${cs.strategyId}`);
              }}
            >
              {detail.data?.title ?? (detail.isLoading ? 'Loading strategy…' : label.title)}
            </button>
            {label.client !== '—' ? ` · ${label.client}` : ''} · applied{' '}
            {fmtRelative(cs.appliedAt ?? cs.updatedAt)} by {appliedBy}
          </span>
          {actionError && (
            <span className="st-agents__error-box" role="alert">
              {actionError}
            </span>
          )}
        </div>
        <CapiroButton size="compact" disabled={undo.isPending} onClick={() => setConfirming(true)}>
          Undo
        </CapiroButton>
      </div>

      <CapiroModal open={confirming} title="Undo this change-set?" onClose={() => setConfirming(false)}>
        <p className="st-agents__modal-copy">
          The plan is restored to the version it was on before this change-set was applied — undo
          cuts a NEW revision (a normal version restore, logged and reversible from History); it
          never rewinds one. Only the most recent apply can be undone this way; anything later goes
          through version history.
        </p>
        <div className="st-agents__modal-actions">
          <CapiroButton size="compact" onClick={() => setConfirming(false)}>
            Keep applied
          </CapiroButton>
          <CapiroButton
            variant="primary"
            size="compact"
            disabled={undo.isPending}
            onClick={() => {
              setConfirming(false);
              onUndo();
            }}
          >
            {undo.isPending ? 'Undoing…' : 'Undo change-set'}
          </CapiroButton>
        </div>
      </CapiroModal>
    </div>
  );
}
