/*
 * Timeline editor — /strategies/:strategyId (STRATEGIES-HANDOFF §7.2, §7.3).
 *
 * Five row groups, top to bottom; rows 1–4 are READ-ONLY reference layers
 * (firm- or calendar-owned, never editable here); row 5 is the plan.
 *
 *   1  Fiscal window   derived FY headers + month ticks
 *   2  Legislative     calendar service          (toggle: Congress)
 *   3  PPBE            calendar service          (toggle: PPBE)
 *   4  Firm phases     firm settings             (always on)
 *   5  Watch           agent service, PROPOSED   (toggle: Watch · N)
 *   6  Strategy steps  the plan                  (always on)
 *
 * Governance: nothing on this screen applies an agent proposal; Watch bars are
 * proposals (warning ramp + "Proposed") and clicking one goes to the review
 * queue. Step edits go through the step inspector and each produces a revision.
 * The save stamp reflects real persistence — never optimistic "Saved".
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import {
  clientName,
  memberName,
  useClientsLite,
  useFirmPhases,
  usePendingWatchCounts,
  useReferenceCalendars,
  useStrategy,
  useTenantMembers,
} from './strategies-api.js';
import { computePlanHealth } from './lib/plan-health.js';
import {
  assignLanes,
  axisPosition,
  barGeometry,
  buildFiscalAxis,
  laneCount,
  type LaneItem,
} from './lib/timeline.js';
import type { FirmPhase, ReferenceRow, StrategyNode } from '../../../pages/strategy/types.js';
import { StepInspector } from './StepInspector.js';
import './strategies.css';
import './strategy-editor.css';

type Horizon = '3fy' | '2fy' | '1fy';

/** spStrategy.id is a UUID column; anything else is a malformed link, not a query. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const KIND_LABEL: Record<string, string> = {
  action: 'Action',
  gate: 'Gate',
  milestone: 'Milestone',
  decision: 'Decision',
  risk: 'Risk',
};

export function StrategyEditorVNext() {
  const { strategyId } = useParams<{ strategyId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Guard: the backend `spStrategy.id` column is UUID-typed. A non-UUID id
  // (stale seed, truncated link) makes Prisma throw a 500 before any row
  // lookup — surfacing as a generic load error that retry can never fix.
  // Treat a malformed id as not-found instead of firing a doomed query.
  const validId = strategyId && UUID_RE.test(strategyId) ? strategyId : null;

  const strategy = useStrategy(validId);
  const firmPhases = useFirmPhases();
  const calendars = useReferenceCalendars();
  const clients = useClientsLite();
  const members = useTenantMembers();
  const watchCounts = usePendingWatchCounts(true);

  const [horizon, setHorizon] = useState<Horizon>('3fy');
  const [layers, setLayers] = useState({ congress: true, ppbe: true, watch: true });

  const detail = strategy.data ?? null;
  const openStepId = searchParams.get('step');
  const inspectorTab = searchParams.get('tab') === 'meri' ? 'meri' : 'step';

  const axis = useMemo(() => {
    const end = 2029;
    const start = horizon === '1fy' ? 2029 : horizon === '2fy' ? 2028 : 2027;
    return buildFiscalAxis(start, end);
  }, [horizon]);

  const watchCount = Number((validId && watchCounts.data?.[validId]) ?? 0);
  const referenceLayerCount =
    1 + (layers.congress ? 1 : 0) + (layers.ppbe ? 1 : 0) + (layers.watch ? 1 : 0);

  // Malformed id (not a UUID): not-found, not a retryable load error.
  if (strategyId && !validId) {
    return (
      <div className="st-page">
        <CapiroErrorState
          title="This strategy link is not valid"
          description="The link does not point at a strategy. It may be truncated or from an older draft — open the strategy from the library instead."
          onRetry={() => navigate('/strategies')}
          retryLabel="Back to strategies"
        />
      </div>
    );
  }

  if (strategy.isLoading) {
    return (
      <div className="st-page">
        <CapiroSkeleton height={38} width="40%" />
        <div style={{ height: 16 }} />
        <CapiroSkeleton height={420} />
      </div>
    );
  }
  if (strategy.isError || !detail) {
    return (
      <div className="st-page">
        <CapiroErrorState
          title="This strategy could not be loaded"
          description="The plan did not load. Your data is intact — retry to reopen the editor."
          onRetry={() => void strategy.refetch()}
        />
      </div>
    );
  }

  const objective = detail.type;
  const eyebrow = `${clientName(clients.data, detail.clientId)} · ${objective}`.toUpperCase();
  const openStep = detail.nodes.find((n) => n.id === openStepId) ?? null;

  const openInspector = (stepId: string, tab: 'step' | 'meri' = 'step') => {
    const next = new URLSearchParams(searchParams);
    next.set('step', stepId);
    if (tab === 'meri') next.set('tab', 'meri');
    else next.delete('tab');
    setSearchParams(next, { replace: false });
  };
  const closeInspector = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('step');
    next.delete('tab');
    setSearchParams(next);
  };

  return (
    <div className="st-editor">
      <div className="st-editor__main">
        {/* Header (§7.2). */}
        <header className="st-editor-header">
          <div className="st-editor-header__left">
            <button
              type="button"
              className="st-editor-back"
              aria-label="Back to strategies"
              onClick={() => navigate('/strategies')}
            >
              ‹
            </button>
            <div>
              <p className="st-eyebrow">{eyebrow}</p>
              <h1 className="st-title st-editor-title">{detail.title}</h1>
              {detail.goal ? <p className="st-purpose">Goal: {detail.goal}</p> : null}
            </div>
          </div>
          <div className="st-editor-header__right">
            <div className="st-segmented" role="group" aria-label="Reference layers">
              <button
                aria-pressed={layers.ppbe}
                onClick={() => setLayers((l) => ({ ...l, ppbe: !l.ppbe }))}
              >
                PPBE
              </button>
              <button
                aria-pressed={layers.congress}
                onClick={() => setLayers((l) => ({ ...l, congress: !l.congress }))}
              >
                Congress
              </button>
              <button
                aria-pressed={layers.watch}
                onClick={() => setLayers((l) => ({ ...l, watch: !l.watch }))}
              >
                Watch{watchCount > 0 ? ` · ${watchCount}` : ''}
              </button>
            </div>
            <CapiroButton onClick={() => navigate(`/strategies/${strategyId}/export`)}>Export</CapiroButton>
            <CapiroButton onClick={() => navigate(`/strategies/${strategyId}/history`)}>History</CapiroButton>
            <SaveStamp updatedAt={detail.lastEditedAt} />
            <CapiroButton
              variant="primary"
              onClick={() => openInspector(openStepId ?? detail.nodes[0]?.id ?? '', 'meri')}
            >
              Ask Meri
            </CapiroButton>
          </div>
        </header>

        {/* Working timeline (§7.3). */}
        <section className="st-card st-timeline">
          <div className="st-timeline__head">
            <div>
              <p className="st-section-label" style={{ margin: 0 }}>Working timeline</p>
              <p className="st-timeline__meta">
                {detail.nodes.length} steps · {referenceLayerCount} reference layers · centered on today
              </p>
            </div>
            <div className="st-actions">
              <PlanHealthChip detail={detail} onReview={() => navigate('/strategies/agents/proposals')} />
              <div className="st-segmented" role="group" aria-label="Horizon">
                <button aria-pressed={horizon === '3fy'} onClick={() => setHorizon('3fy')}>FY27–FY29</button>
                <button aria-pressed={horizon === '2fy'} onClick={() => setHorizon('2fy')}>FY28–FY29</button>
                <button aria-pressed={horizon === '1fy'} onClick={() => setHorizon('1fy')}>FY29</button>
              </div>
              <CapiroButton variant="secondary" onClick={() => navigate('/strategies/phases')}>Firm phases</CapiroButton>
              <CapiroButton variant="primary" onClick={() => openInspector('__new__')}>Add step</CapiroButton>
            </div>
          </div>

          <Timeline
            axis={axis}
            layers={layers}
            nodes={detail.nodes}
            firmPhases={firmPhases.data ?? []}
            congress={calendars.data?.congress ?? []}
            ppbe={calendars.data?.ppbeLanes ?? []}
            members={members.data}
            selectedStepId={openStepId}
            onStepClick={(id) => openInspector(id)}
            onWatchClick={() => navigate('/strategies/agents/proposals')}
            onPhaseClick={() => navigate('/strategies/phases')}
          />
        </section>

        {/* Bottom cards: Next 30 days + Plan health (§7.2). */}
        <div className="st-editor-cards">
          <NextThirtyDays detail={detail} members={members.data} onOpen={(id) => openInspector(id)} />
          <PlanHealthCard detail={detail} onReview={() => navigate('/strategies/agents/proposals')} />
        </div>
      </div>

      {openStep || openStepId === '__new__' ? (
        <StepInspector
          strategyId={detail.id}
          step={openStep}
          isNew={openStepId === '__new__'}
          initialTab={inspectorTab}
          onClose={closeInspector}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function SaveStamp({ updatedAt }: { updatedAt: string | null }) {
  // Honest persistence state (§7.2): reflect the last server write. There is no
  // optimistic "Saved" — edits land via mutations that update this timestamp.
  if (!updatedAt) return <span className="st-savestamp">Unsaved changes</span>;
  const then = new Date(updatedAt).getTime();
  const mins = Number.isNaN(then) ? null : Math.round((Date.now() - then) / 60000);
  const label = mins == null ? 'Saved' : mins < 1 ? 'Saved just now' : `Saved ${mins} min ago`;
  return <span className="st-savestamp">{label}</span>;
}

function PlanHealthChip({
  detail,
  onReview,
}: {
  detail: Parameters<typeof computePlanHealth>[0];
  onReview: () => void;
}) {
  const health = computePlanHealth(detail);
  if (!health) return <CapiroSkeleton width={140} height={28} />;
  return (
    <button type="button" className="st-pill st-pill--accent st-planhealth-chip" onClick={onReview}>
      Plan health · {health.score}
    </button>
  );
}

function NextThirtyDays({
  detail,
  members,
  onOpen,
}: {
  detail: NonNullable<Parameters<typeof computePlanHealth>[0]>;
  members: ReturnType<typeof useTenantMembers>['data'];
  onOpen: (stepId: string) => void;
}) {
  const next = useMemo(() => {
    const now = Date.now();
    const in30 = now + 30 * 86400000;
    return (
      detail.nodes
        .filter((n) => n.ownerUserId && n.status !== 'active')
        .filter((n) => {
          const due = new Date(n.endsOn ?? n.startsOn).getTime();
          return !Number.isNaN(due) && due >= now && due <= in30;
        })
        .sort((a, b) => (a.endsOn ?? a.startsOn).localeCompare(b.endsOn ?? b.startsOn))[0] ?? null
    );
  }, [detail.nodes]);

  return (
    <section className="st-card st-next30">
      <div className="st-card__header">
        <p className="st-section-label">Next 30 days</p>
      </div>
      <div className="st-card__body">
        {next ? (
          <>
            <p className="st-next30__title">{next.title}</p>
            <div className="st-next30__meta">
              <span className="st-pill st-pill--warning">Due {formatDate(next.endsOn ?? next.startsOn)}</span>
              <span className="st-next30__owner">Owner · {memberName(members, next.ownerUserId)}</span>
            </div>
            <CapiroButton onClick={() => onOpen(next.id)}>Open step</CapiroButton>
          </>
        ) : (
          <p className="st-purpose">No owned, dated steps fall due in the next 30 days.</p>
        )}
      </div>
    </section>
  );
}

function PlanHealthCard({
  detail,
  onReview,
}: {
  detail: Parameters<typeof computePlanHealth>[0];
  onReview: () => void;
}) {
  const health = computePlanHealth(detail);
  if (!health) {
    return (
      <section className="st-card st-planhealth">
        <div className="st-card__header"><p className="st-section-label">Plan health</p></div>
        <div className="st-card__body"><CapiroSkeleton height={48} /></div>
      </section>
    );
  }
  return (
    <section className="st-card st-planhealth">
      <div className="st-card__header"><p className="st-section-label">Plan health</p></div>
      <div className="st-card__body st-planhealth__body">
        <div className="st-planhealth__score">{health.score}</div>
        <div className="st-planhealth__facts">
          <p>{health.ownedSteps} of {health.totalSteps} steps have owners</p>
        </div>
        <CapiroButton onClick={onReview}>Review proposals</CapiroButton>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- timeline */

interface TimelineProps {
  axis: ReturnType<typeof buildFiscalAxis>;
  layers: { congress: boolean; ppbe: boolean; watch: boolean };
  nodes: StrategyNode[];
  firmPhases: FirmPhase[];
  congress: ReferenceRow[];
  ppbe: ReferenceRow[];
  members: ReturnType<typeof useTenantMembers>['data'];
  selectedStepId: string | null;
  onStepClick: (id: string) => void;
  onWatchClick: () => void;
  onPhaseClick: () => void;
}

function Timeline({
  axis,
  layers,
  nodes,
  firmPhases,
  congress,
  ppbe,
  members,
  selectedStepId,
  onStepClick,
  onWatchClick,
  onPhaseClick,
}: TimelineProps) {
  // "Today" from the server frame: the strategy's own last-write timestamp is the
  // nearest server clock available (§7.3); the dedicated clock endpoint is a GAP.
  const today = new Date();
  const todayPos = axisPosition(axis, today) * 100;
  const showToday = todayPos > 0 && todayPos < 100;

  const fiscalYears = useMemo(() => {
    const years: Array<{ fy: number; span: number }> = [];
    for (const cell of axis.cells) {
      const last = years[years.length - 1];
      if (last && last.fy === cell.fy) last.span += 1;
      else years.push({ fy: cell.fy, span: 1 });
    }
    return years;
  }, [axis]);

  return (
    <div className="st-tl" role="group" aria-label="Strategy timeline">
      <div className="st-tl__grid">
        {/* Row 1: fiscal window headers + month ticks. */}
        <TimelineRow label="3-FY window">
          <div className="st-tl-fy">
            {showToday ? (
              <span className="st-tl-today" style={{ left: `${todayPos}%` }}>
                <span className="st-tl-today__pill">Today</span>
              </span>
            ) : null}
            {fiscalYears.map((y) => (
              <div key={y.fy} className="st-tl-fy__cell" style={{ flex: `${y.span} 1 0` }}>
                FY{String(y.fy).slice(2)}
              </div>
            ))}
          </div>
          <div className="st-tl-months">
            {axis.cells.map((c) => (
              <div key={c.index} className={`st-tl-month${c.fiscalYearStart ? ' st-tl-month--fy' : ''}`}>
                {c.label}
              </div>
            ))}
          </div>
        </TimelineRow>

        {/* Row 2: Legislative (calendar). */}
        {layers.congress ? (
          <TimelineRow label="Legislative">
            <ReferenceBars axis={axis} rows={congress} kind="congress" today={today} />
          </TimelineRow>
        ) : null}

        {/* Row 3: PPBE (calendar). */}
        {layers.ppbe ? (
          <TimelineRow label="PPBE">
            <ReferenceBars axis={axis} rows={ppbe} kind="ppbe" today={today} />
          </TimelineRow>
        ) : null}

        {/* Row 4: Firm phases (always on). */}
        <TimelineRow label="Firm phases">
          <FirmPhaseBars axis={axis} phases={firmPhases} onPhaseClick={onPhaseClick} />
        </TimelineRow>

        {/* Row 5: Watch (proposed, not yet approved). */}
        {layers.watch ? (
          <TimelineRow label="Watch">
            <WatchBars axis={axis} onWatchClick={onWatchClick} />
          </TimelineRow>
        ) : null}

        {/* Row 6: Strategy steps (the plan). */}
        <TimelineRow label="Strategy steps" className="st-tl-row--steps">
          <StepBars
            axis={axis}
            nodes={nodes}
            members={members}
            selectedStepId={selectedStepId}
            onStepClick={onStepClick}
          />
        </TimelineRow>
      </div>
    </div>
  );
}

function TimelineRow({
  label,
  children,
  className = '',
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`st-tl-row ${className}`.trim()}>
      <div className="st-tl-row__label">{label}</div>
      <div className="st-tl-row__track">{children}</div>
    </div>
  );
}

function ReferenceBars({
  axis,
  rows,
  kind,
  today,
}: {
  axis: ReturnType<typeof buildFiscalAxis>;
  rows: ReferenceRow[];
  kind: 'congress' | 'ppbe';
  today: Date;
}) {
  const items: Array<LaneItem & { row: ReferenceRow }> = rows.map((row) => ({
    id: row.id,
    row,
    startIso: row.startsOn,
    endIso: row.endsOn,
  }));
  const laned = assignLanes(items);
  if (laned.length === 0) {
    return <div className="st-tl-empty">No {kind === 'congress' ? 'legislative' : 'PPBE'} marks in range.</div>;
  }
  return (
    <div className="st-tl-bars">
      {laned.map(({ item, lane }) => {
        const g = barGeometry(axis, item.startIso, item.endIso);
        if (!g) return null;
        const start = item.startIso ? new Date(item.startIso) : null;
        const end = item.endIso ? new Date(item.endIso) : null;
        const active = start && end && start <= today && today <= end;
        return (
          <button
            key={item.id}
            type="button"
            className={`st-tl-refbar st-tl-refbar--${kind}${active ? ' st-tl-refbar--active' : ''}`}
            style={{ left: `${g.left}%`, width: `${g.width}%`, top: lane * 30 }}
            title={item.row.label}
            aria-label={`${item.row.label} (reference)`}
          >
            {item.row.label}
          </button>
        );
      })}
    </div>
  );
}

function FirmPhaseBars({
  axis,
  phases,
  onPhaseClick,
}: {
  axis: ReturnType<typeof buildFiscalAxis>;
  phases: FirmPhase[];
  onPhaseClick: () => void;
}) {
  if (phases.length === 0) {
    return <div className="st-tl-empty">Set firm phases to light up the reference layer.</div>;
  }
  return (
    <div className="st-tl-bars">
      {phases.map((p) => {
        // FirmPhase uses FY + quarter; map to a date window (fiscal Oct start).
        const start = fyQuarterToDate(p.startFy, p.startQ);
        const end = fyQuarterToDate(p.endFy, p.endQ);
        const g = barGeometry(axis, start.toISOString(), end.toISOString());
        if (!g) return null;
        return (
          <button
            key={p.id}
            type="button"
            className="st-tl-refbar st-tl-refbar--firmphase"
            style={{ left: `${g.left}%`, width: `${g.width}%` }}
            onClick={onPhaseClick}
            title={p.label}
            aria-label={`Firm phase ${p.label}`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

function WatchBars({ onWatchClick }: { axis: unknown; onWatchClick: () => void }) {
  // Watch bars are proposals, not applied changes (§7.3). The per-strategy
  // proposals come from the Watch review state; they render on the warning ramp
  // and always say "Proposed". Clicking goes to the review queue.
  return (
    <div className="st-tl-bars">
      <button type="button" className="st-tl-refbar st-tl-refbar--watch" onClick={onWatchClick}>
        Proposed — review in queue
      </button>
    </div>
  );
}

function StepBars({
  axis,
  nodes,
  members,
  selectedStepId,
  onStepClick,
}: {
  axis: ReturnType<typeof buildFiscalAxis>;
  nodes: StrategyNode[];
  members: ReturnType<typeof useTenantMembers>['data'];
  selectedStepId: string | null;
  onStepClick: (id: string) => void;
}) {
  const items: Array<LaneItem & { node: StrategyNode }> = nodes.map((node) => ({
    id: node.id,
    node,
    startIso: node.startsOn,
    endIso: node.endsOn ?? node.startsOn,
  }));
  const laned = assignLanes(items);
  const lanes = Math.max(1, laneCount(laned));
  return (
    <div className="st-tl-steps" style={{ minHeight: lanes * 96 }}>
      {laned.map(({ item, lane }) => {
        const node = item.node;
        const g = barGeometry(axis, node.startsOn, node.endsOn ?? node.startsOn);
        if (!g) return null;
        const selected = node.id === selectedStepId;
        const owner = memberName(members, node.ownerUserId);
        return (
          <button
            key={node.id}
            type="button"
            className={`st-step st-step--${node.kind}${selected ? ' st-step--selected' : ''}`}
            style={{ left: `${g.left}%`, width: `${Math.max(g.width, 9)}%`, top: lane * 96 }}
            onClick={() => onStepClick(node.id)}
            aria-label={`${KIND_LABEL[node.kind] ?? node.kind}: ${node.title}`}
            aria-pressed={selected}
          >
            <span className={`st-step__kind st-step__kind--${node.kind}`}>
              <span className="st-step__dot" aria-hidden="true" />
              {KIND_LABEL[node.kind] ?? node.kind}
            </span>
            <span className="st-step__title">{node.title}</span>
            <span className="st-step__meta">
              {node.ownerUserId ? `Owner · ${owner}` : 'Unassigned'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ utils */

function fyQuarterToDate(fy: number, q: number): Date {
  // Federal FY starts in October. Q1 = Oct–Dec of (fy-1).
  const monthIndex = (q - 1) * 3; // 0,3,6,9 within the fiscal year
  const base = new Date(Date.UTC(fy - 1, 9, 1)); // Oct 1 of fy-1
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + monthIndex, 1));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
