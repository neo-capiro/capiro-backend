/*
 * Timeline editor — /strategies/:strategyId (STRATEGIES-HANDOFF §7.2, §7.3).
 *
 * Five row groups, top to bottom; rows 1–4 are READ-ONLY reference layers
 * (firm- or calendar-owned, never editable here); row 5 is the plan.
 *
 *   1  Fiscal window   derived FY headers + month ticks
 *   2  Legislative     calendar service          (toggle: "Congress", state key `congress`)
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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  useWatchReviewState,
} from './strategies-api.js';
// Friendly StrategyType labels ("Regulatory / Policy", not the raw "regulatory"
// slug) — shared with the library table's identical Type column so both views
// agree on wording for the same field. Owned by StrategyLibraryVNext.tsx;
// both are already statically imported side-by-side by
// VNextStrategiesRoutes.tsx, so this adds no new circular-import risk.
import { TYPE_LABEL } from './StrategyLibraryVNext.js';
import { computePlanHealth } from './lib/plan-health.js';
import {
  buildCalendar,
  fyQuarterToQ,
  monthRangeLabel,
  nodeRangeLabel,
  packSpans,
  parseDbDate,
  qOfDate,
  type FiscalCalendar,
} from './lib/timeline.js';
import type { FirmPhase, ReferenceRow, StrategyNode, WatchProposalCard } from '../../../pages/strategy/types.js';
import { StepInspector } from './StepInspector.js';
import { ScopeBar } from './ScopeBar.js';
import './strategies.css';
import './strategy-editor.css';

/**
 * Fixed month-column width in px — NOT horizon-responsive.
 *
 * The previous version shrank this as the visible range widened (36 months
 * compressed to 46px each) to force the whole 3-FY window onto one screen.
 * That is not what `app.capiro.ai/strategies/:id` does: the legacy planner
 * holds every column at a constant 100px and scrolls horizontally instead —
 * confirmed by measuring its live DOM (`scrollWidth` 3600px over a 1689px
 * viewport for the same 36-month window). Compressing the columns is exactly
 * what made every multi-word legislative-milestone label read as truncated
 * garbage next to the legacy planner's same event: at 46px/month a short
 * event's box came out ~86px wide; at the legacy's fixed 100px it is ~149px —
 * not a cosmetic difference, nearly double. Matching the constant is what
 * "replicate the same exact functionality" requires here.
 */
const COLW = 100;

/** Stable identity so the memoized band models don't rebuild on every render. */
const EMPTY_REFERENCE_ROWS: ReferenceRow[] = [];

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

  const [layers, setLayers] = useState({ congress: true, ppbe: true, watch: true });

  const watchState = useWatchReviewState(validId, layers.watch);

  const detail = strategy.data ?? null;
  const openStepId = searchParams.get('step');
  const inspectorTab = searchParams.get('tab') === 'meri' ? 'meri' : 'step';

  /*
   * The rolling 3-FY window [current FY, +1, +2] — no user-narrowable horizon.
   *
   * This used to be a selectable 1FY/2FY/3FY control anchored on a computed
   * `startFy`. Per Neo (2026-08-19): drop the filter entirely and match
   * `app.capiro.ai/strategies/:id`, which never offers one — its `fiscal.ts`
   * `buildCalendar()` always shows exactly this window, full stop. One
   * calendar per STRATEGY (not per render, and not just per mount): `now`
   * must not drift while the screen is open or a node edit would re-derive
   * "today", but navigating from one strategy straight to another re-uses
   * this same component instance (the route has no per-id `key`), so keying
   * only on mount would freeze the calendar — and the scroll-to-today reset
   * below it, which depends on this identity changing — at whichever
   * strategy happened to be opened first.
   */
  const calendar = useMemo(() => buildCalendar(), [validId]);

  const watchCount = Number((validId && watchCounts.data?.[validId]) ?? 0);
  const watchProposals = watchState.data?.proposals ?? [];
  const referenceLayerCount =
    1 + (layers.congress ? 1 : 0) + (layers.ppbe ? 1 : 0) + (layers.watch ? 1 : 0);

  // Malformed id (not a UUID): not-found, not a retryable load error.
  if (strategyId && !validId) {
    // TEMPORARY (remove once root cause is found — see SCRUM-181 follow-up):
    // capture what actually reached the router so the next occurrence carries
    // forensic detail instead of relying on catching it live. Best-effort —
    // must never throw or block the recovery UI below.
    try {
      const diag = {
        rawId: strategyId,
        rawIdLength: strategyId.length,
        rawIdCodePoints: Array.from(strategyId).map((c) => c.codePointAt(0)),
        pathname: window.location.pathname,
        search: window.location.search,
        referrer: document.referrer,
        capturedAt: new Date().toISOString(),
      };
      window.localStorage.setItem('capiro:strategy-invalid-link-diag', JSON.stringify(diag));
      console.warn('[strategies] invalid link guard fired', diag);
    } catch {
      /* diagnostics only — never let this block the error UI */
    }
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

  const objective = TYPE_LABEL[detail.type] ?? detail.type;
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
    <>
      {/* Scope bar (design handoff "Layout"/"Scope bar"): sticky above the hero,
          mounted once per editor view. Client is fixed here (the strategy's own
          client, not a scope the editor can change). No horizon chip: the
          timeline always shows the rolling 3-FY window, matching
          app.capiro.ai/strategies/:id, which has never offered one. Status
          reflects this query's own last-fetch time — never a fabricated "Live". */}
      <ScopeBar
        clientLabel="CLIENT"
        fixedClientName={clientName(clients.data, detail.clientId)}
        status={{ tone: 'success', label: `Live · refreshed ${formatRelativeTime(strategy.dataUpdatedAt)}` }}
      />
      <div className="st-editor">
      <div className="st-editor__col">
        {/* Header (§7.2) — a full-bleed white hero band, distinct from the
            gray canvas body below it (design handoff: every view draws these
            as two separate bands, not one flat page — see `.st-hero` in
            strategies.css). */}
        <header className="st-hero st-hero--editor">
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
            {/* Row 1: reference-layer toggles (horizon moved to the ScopeBar above). */}
            <div className="st-editor-header__row">
              <span className="st-editor-layers-label">Layers</span>
              <div className="st-segmented" role="group" aria-label="Reference layers">
                <button
                  aria-pressed={layers.ppbe}
                  onClick={() => setLayers((l) => ({ ...l, ppbe: !l.ppbe }))}
                >
                  <span className="st-layer-dot" aria-hidden="true" />
                  PPBE
                </button>
                <button
                  aria-pressed={layers.congress}
                  onClick={() => setLayers((l) => ({ ...l, congress: !l.congress }))}
                >
                  <span className="st-layer-dot" aria-hidden="true" />
                  {/* Literal reference (`.dc.html` layerToggles) uses "Congress"
                      for THIS toggle button specifically, distinct from the
                      timeline row label below it ("Legislative", `.dc.html`
                      row config) — the same underlying `congress` layer gets
                      two different display names in two different places in
                      the original design. Do not unify them. */}
                  Congress
                </button>
                <button
                  aria-pressed={layers.watch}
                  onClick={() => setLayers((l) => ({ ...l, watch: !l.watch }))}
                >
                  <span className="st-layer-dot" aria-hidden="true" />
                  Watch{watchProposals.length > 0 ? ` · ${watchProposals.length}` : watchCount > 0 ? ` · ${watchCount}` : ''}
                </button>
              </div>
            </div>
            {/* Row 2: export / history / saved stamp / Ask Meri. */}
            <div className="st-editor-header__row">
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
          </div>
        </header>

        <div className="st-editor__main">
        {/* Working timeline (§7.3). */}
        <section className="st-card st-timeline">
          <div className="st-timeline__head">
            <div>
              <p className="st-card__title">Working timeline</p>
              <p className="st-timeline__meta">
                {detail.nodes.length} steps · {referenceLayerCount} reference layers · centered on today
              </p>
            </div>
            <div className="st-actions">
              <PlanHealthChip detail={detail} onReview={() => navigate('/strategies/agents/proposals')} />
              <CapiroButton variant="secondary" onClick={() => navigate('/strategies/phases')}>Firm phases</CapiroButton>
              <CapiroButton variant="primary" onClick={() => openInspector('__new__')}>Add step</CapiroButton>
            </div>
          </div>

          <Timeline
            calendar={calendar}
            layers={layers}
            nodes={detail.nodes}
            firmPhases={firmPhases.data ?? []}
            congress={calendars.data?.congress ?? EMPTY_REFERENCE_ROWS}
            ppbeLanes={calendars.data?.ppbeLanes ?? EMPTY_REFERENCE_ROWS}
            ppbeCurrentPhases={calendars.data?.ppbeCurrentPhases ?? EMPTY_REFERENCE_ROWS}
            members={members.data}
            selectedStepId={openStepId}
            watchProposals={watchProposals}
            onStepClick={(id) => openInspector(id)}
            onWatchClick={() => navigate('/strategies/agents/proposals')}
            onPhaseClick={() => navigate('/strategies/phases')}
            onEditCongress={() => navigate(`/strategies/${strategyId}/legislative-calendar`)}
          />
        </section>

        {/* Bottom cards: Next 30 days + Plan health (§7.2). */}
        <div className="st-editor-cards">
          <NextThirtyDays detail={detail} members={members.data} onOpen={(id) => openInspector(id)} />
          <PlanHealthCard detail={detail} onReview={() => navigate('/strategies/agents/proposals')} />
        </div>
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
    </>
  );
}

/* ------------------------------------------------------------------ pieces */

/**
 * "Live · refreshed N min ago" (ScopeBar status, design handoff "Scope bar"):
 * grounded in this query's own `dataUpdatedAt` (react-query's last-successful-
 * fetch timestamp) — real client-observed freshness, not a fabricated pulse.
 */
function formatRelativeTime(updatedAtMs: number): string {
  const mins = Math.max(0, Math.round((Date.now() - updatedAtMs) / 60000));
  if (mins < 1) return 'just now';
  return `${mins} min ago`;
}

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

/*
 * The working timeline PORTS the legacy planner's own timeline component's
 * model rather than approximating it — per Neo (2026-08-19): "replicate the
 * same exact functionality" as `app.capiro.ai/strategies/:id`, in vNext's own
 * visual language. (The vNext no-legacy-UI contract only allows THIS module
 * to reach `pages/strategy` for pure data/type modules — fiscal.ts, types.ts
 * — never a legacy UI component; nothing here imports one.)
 *
 * That means, concretely:
 *
 *  - CONTINUOUS date-accurate positions (`qOfDate` → month-unit floats × a
 *    FIXED COLW), not integer month-grid columns. A bar's box reflects when
 *    the thing it represents actually starts and ends.
 *  - `packSpans` (ported to lib/timeline.ts) — real interval packing by time,
 *    not by which month COLUMN a bar happens to fall in. Two bars adjacent in
 *    time never share a lane; two bars far apart in time DO share one.
 *  - A frozen, always-visible label column outside the one horizontal
 *    scroller (never a sticky overlay), built from ONE row-descriptor list
 *    so the label side and the grid side can never drift apart — the same
 *    "anti-drift guarantee" the legacy component documents and relies on.
 *  - The step-card row is the one FLEXIBLE, auto-height row: titles WRAP
 *    (never single-line-ellipsis-truncated), and the row grows to fit
 *    whatever its tallest lane needs. A fixed 72px card with `overflow:
 *    hidden` is what turned "Draft and submit white papers justifying the
 *    plus-up" into "Draft and subm…" — illegible, and indistinguishable at a
 *    glance from a genuinely broken layout.
 *  - The legislative calendar's "editable" affordance is an always-visible
 *    "Edit calendar" link (not a hover-revealed micro-button on the bar
 *    itself) that opens a real modal — see EditLegislativeCalendarOverlay.tsx.
 *
 * No horizon control, no compressed column width: see the COLW comment above
 * and the calendar comment on `StrategyEditorVNext` itself.
 */

const RULER_H = 64; // 32px quarter row + 32px month row, matching the legacy ruler.
const LEG_LANE_PITCH = 50;
const LEG_LANE_H = 44;
const PPBE_SUMMARY_H = 46;
const PPBE_LANE_PITCH = 32;
const PPBE_LANE_H = 24;
const FIRM_H = 58;
const WATCH_LANE_PITCH = 40;

const MONTHS = ['OCT', 'NOV', 'DEC', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP'];

interface TimelineProps {
  calendar: FiscalCalendar;
  layers: { congress: boolean; ppbe: boolean; watch: boolean };
  nodes: StrategyNode[];
  firmPhases: FirmPhase[];
  congress: ReferenceRow[];
  ppbeLanes: ReferenceRow[];
  ppbeCurrentPhases: ReferenceRow[];
  members: ReturnType<typeof useTenantMembers>['data'];
  selectedStepId: string | null;
  watchProposals: WatchProposalCard[];
  onStepClick: (id: string) => void;
  onWatchClick: () => void;
  onPhaseClick: () => void;
  onEditCongress: () => void;
}

/** One rendered row: the label column and the grid column both read from this. */
interface RowSpec {
  key: string;
  /** `null` marks the ONE flexible row (the step cards) — auto height. */
  height: number | null;
  minHeight?: string;
  className: string;
  label: React.ReactNode;
  grid: React.ReactNode;
}

function Timeline({
  calendar,
  layers,
  nodes,
  firmPhases,
  congress,
  ppbeLanes,
  ppbeCurrentPhases,
  members,
  selectedStepId,
  watchProposals,
  onStepClick,
  onWatchClick,
  onPhaseClick,
  onEditCongress,
}: TimelineProps) {
  const months = calendar.months;
  const NM = months.length;
  const W = NM * COLW;
  const mLeft = (m: number) => m * COLW;
  const qToMonth = (q: number) => q * 3;
  const TODAY_M = calendar.todayQ * 3;
  const TODAY_MI = Math.floor(TODAY_M);
  const showToday = TODAY_M >= 0 && TODAY_M < NM;

  const [ppbeExpanded, setPpbeExpanded] = useState(false);

  /*
   * Center the horizontal scroller on today, once per strategy (`calendar`
   * changes identity per strategy — see its own comment on
   * `StrategyEditorVNext`). This is NEW relative to the grid-column version:
   * that model's width was compressed to fit the whole window on screen, so
   * there was nothing to scroll. A fixed 100px/month canvas (matching the
   * legacy planner's own constant — see COLW's comment) is ~3600px wide and
   * opens scrolled to its start (Oct of the FIRST shown FY) without this —
   * for a plan whose steps begin ten months in, that is everything scrolled
   * off-screen to the right, today included. A single post-paint
   * `requestAnimationFrame` is enough (unlike the legacy effect this mirrors,
   * this canvas's width has no async horizon-driven remeasurement to wait
   * for — COLW is a constant, so the width is exactly known the instant
   * `calendar` exists).
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    /*
     * `setTimeout(fn, 0)`, not `requestAnimationFrame`: measured directly
     * (2026-08-19) — in a backgrounded/non-visible-to-Chrome preview tab
     * (this screen's own visual-QA harness runs exactly that way), rAF
     * callbacks are silently throttled and can simply never fire, while a
     * same-tick `setTimeout` still does. A macrotask still runs after the
     * current commit's DOM writes are painted, which is all this needs —
     * COLW is a constant, so, unlike the legacy effect this is adapted from,
     * there is no async width remeasurement to specifically wait a real
     * animation frame for.
     */
    const t = setTimeout(() => {
      const viewportWidth = el.clientWidth;
      const contentWidth = el.scrollWidth;
      if (viewportWidth <= 0 || contentWidth <= 0) return;
      const todayX = calendar.todayQ * 3 * COLW;
      const maxScroll = Math.max(0, contentWidth - viewportWidth);
      el.scrollLeft = Math.min(maxScroll, Math.max(0, todayX - viewportWidth / 2));
    }, 0);
    return () => clearTimeout(t);
  }, [calendar]);

  const nodeQ = (n: StrategyNode) => qOfDate(parseDbDate(n.startsOn), calendar);
  const nodeDur = (n: StrategyNode) =>
    n.endsOn ? Math.max(0, qOfDate(parseDbDate(n.endsOn), calendar) - nodeQ(n)) : 0;
  const refQ = (iso: string | null) => (iso ? qOfDate(parseDbDate(iso), calendar) : 0);

  const gridStyle = useMemo(() => ({ '--st-tl-col-w': `${COLW}px` }) as React.CSSProperties, []);

  const rows: RowSpec[] = [];

  /* ---- Legislative (editable via a modal, not drag-on-timeline) ---- */
  if (layers.congress) {
    const legItems = congress.map((c) => ({ row: c, s: qToMonth(refQ(c.startsOn)), e: qToMonth(refQ(c.endsOn)) }));
    const leg = packSpans(legItems, 1.9);
    const legH = leg.rows * LEG_LANE_PITCH + 12;
    rows.push({
      key: 'legislative',
      height: legH,
      className: 'st-tl__row--legislative',
      label: (
        <>
          <span className="st-tl__row-title st-tl__row-title--dark">
            <span className="st-tl__row-dot" aria-hidden="true" />
            Legislative calendar
          </span>
          <button type="button" className="st-tl__edit-link" onClick={onEditCongress}>
            <EditGlyph size={11} />
            Edit calendar
          </button>
        </>
      ),
      grid: (
        <>
          {leg.items.map((b, i) => {
            const tone = legislativeTone(b.row.label);
            return (
              <button
                key={i}
                type="button"
                className={`st-tl__bar st-tl__bar--${tone}`}
                title={b.row.label}
                onClick={onEditCongress}
                style={{
                  left: mLeft(b.s) + 4,
                  width: (b._packEnd - b.s) * COLW - 8,
                  top: b._row * LEG_LANE_PITCH + 7,
                  height: LEG_LANE_H,
                }}
              >
                <span className="st-tl__bar-eyebrow">{monthRangeLabel(b.s, b.e, calendar)}</span>
                <span className="st-tl__bar-label">{b.row.label}</span>
              </button>
            );
          })}
          {showToday ? <TodayMarker left={mLeft(TODAY_M)} label={`Today · ${calendar.now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`} /> : null}
        </>
      ),
    });
  }

  /* ---- Ruler: quarter row + month row ---- */
  rows.push({
    key: 'ruler',
    height: RULER_H,
    className: 'st-tl__row--ruler',
    label: <span className="st-tl__row-title st-tl__row-title--muted">Quarter · month</span>,
    grid: (
      <>
        <div className="st-tl__quarter-row">
          {calendar.quarters.map((q, qi) => {
            const s = qi * 3;
            const current = TODAY_M >= s && TODAY_M < s + 3;
            return (
              <div key={qi} className={`st-tl__quarter-cell${current ? ' is-current' : ''}`} style={{ width: COLW * 3 }}>
                <span className="st-tl__quarter-q">{q.q}</span>
                <span className="st-tl__quarter-fy">{q.fy}</span>
                {current ? <span className="st-tl__quarter-tag">Current</span> : null}
              </div>
            );
          })}
        </div>
        <div className="st-tl__month-row">
          {months.map((mo, i) => {
            const past = i < TODAY_MI;
            const current = i === TODAY_MI;
            return (
              <div key={i} className={`st-tl__month-cell${mo.fyStart ? ' is-fy-start' : ''}`} style={{ width: COLW }}>
                <span className={`st-tl__month-name${past ? ' is-past' : ''}${current ? ' is-current' : ''}`}>{mo.m}</span>
                <span className="st-tl__month-year">{mo.cal.slice(2)}</span>
              </div>
            );
          })}
        </div>
      </>
    ),
  });

  /* ---- PPBE: compact current-phase chips, expandable to per-FY lanes (read-only:
     the fork route writes ppbe_current_phase, but this band draws ppbe_lane_bar —
     no endpoint can persist an edit to what's actually shown here). ---- */
  if (layers.ppbe) {
    rows.push({
      key: 'ppbe-summary',
      height: PPBE_SUMMARY_H,
      className: 'st-tl__row--ppbe',
      label: (
        <>
          <button
            type="button"
            className="st-tl__row-title st-tl__row-title--toggle"
            onClick={() => setPpbeExpanded((v) => !v)}
            aria-expanded={ppbeExpanded}
          >
            <ChevronGlyph expanded={ppbeExpanded} />
            PPBE
          </button>
          <button type="button" className="st-tl__edit-link" onClick={() => setPpbeExpanded((v) => !v)}>
            {ppbeExpanded ? 'Collapse' : 'Expand cycles'}
          </button>
        </>
      ),
      grid: (
        <div className="st-tl__ppbe-chips">
          {ppbeCurrentPhases.map((r) => (
            <div key={r.id} className="st-tl__ppbe-chip">
              <span className="st-mono">FY{String(r.fy ?? '').slice(2)}</span>
              <span>{r.label}</span>
            </div>
          ))}
          {showToday ? <TodayMarker left={mLeft(TODAY_M)} /> : null}
        </div>
      ),
    });

    if (ppbeExpanded) {
      const byFy = new Map<number, ReferenceRow[]>();
      for (const b of ppbeLanes) {
        const fy = b.fy ?? 0;
        byFy.set(fy, [...(byFy.get(fy) ?? []), b]);
      }
      for (const [fy, bars] of byFy.entries()) {
        const its = packSpans(
          bars.map((b) => ({ row: b, s: qToMonth(refQ(b.startsOn)), e: qToMonth(refQ(b.endsOn)) })),
          1.5,
        );
        rows.push({
          key: `ppbe-lane-${fy}`,
          height: its.rows * PPBE_LANE_PITCH + 8,
          className: 'st-tl__row--ppbe-lane',
          label: <span className="st-mono st-tl__row-title--muted">FY{String(fy).slice(2)}</span>,
          grid: (
            <>
              {its.items.map((b, i) => (
                <span
                  key={i}
                  title={b.row.label}
                  className="st-tl__ppbe-bar"
                  style={{ left: mLeft(b.s) + 4, width: (b._packEnd - b.s) * COLW - 8, top: b._row * PPBE_LANE_PITCH + 4, height: PPBE_LANE_H }}
                >
                  {b.row.label}
                </span>
              ))}
              {showToday ? <TodayMarker left={mLeft(TODAY_M)} /> : null}
            </>
          ),
        });
      }
    }
  }

  /* ---- Firm phases (read-only here; "Configure" routes to the firm-phases overlay). ---- */
  {
    const firmItems = firmPhases.map((p) => ({
      row: p,
      s: qToMonth(fyQuarterToQ(p.startFy, p.startQ, calendar)),
      e: qToMonth(fyQuarterToQ(p.endFy, p.endQ, calendar)),
    }));
    rows.push({
      key: 'firm',
      height: FIRM_H,
      className: 'st-tl__row--firm',
      label: (
        <>
          <span className="st-tl__row-title">Firm phase</span>
          <button type="button" className="st-tl__edit-link" onClick={onPhaseClick}>Configure</button>
        </>
      ),
      grid: (
        <>
          {firmItems.map((p) => {
            const isCur = TODAY_M >= p.s && TODAY_M < p.e;
            return (
              <button
                key={p.row.id}
                type="button"
                title={p.row.label}
                className={`st-tl__firm-bar${isCur ? ' is-current' : ''}`}
                onClick={onPhaseClick}
                style={{ left: mLeft(p.s) + 5, width: Math.max(20, (p.e - p.s) * COLW - 10) }}
              >
                {p.row.label}
              </button>
            );
          })}
          {showToday ? <TodayMarker left={mLeft(TODAY_M)} /> : null}
          {firmItems.length === 0 ? <span className="st-tl__empty">Firm phases not configured yet.</span> : null}
        </>
      ),
    });
  }

  /* ---- Watch: agent proposals awaiting review. No real dates of their own,
     so they stack as full-width chips rather than being date-positioned. ---- */
  if (layers.watch) {
    const watchH = Math.max(1, watchProposals.length) * WATCH_LANE_PITCH + 8;
    rows.push({
      key: 'watch',
      height: watchH,
      className: 'st-tl__row--watch',
      label: <span className="st-tl__row-title">Watch</span>,
      grid:
        watchProposals.length === 0 ? (
          <button type="button" className="st-tl__watch-chip" onClick={onWatchClick}>
            No pending proposals — review queue
          </button>
        ) : (
          <>
            {watchProposals.map((p, i) => (
              <button
                key={p.id}
                type="button"
                className="st-tl__watch-chip st-tl__watch-chip--proposed"
                title={`${p.title}: ${p.proposal}`}
                onClick={onWatchClick}
                style={{ top: i * WATCH_LANE_PITCH + 4 }}
              >
                <span className="st-pill st-pill--warning">Proposed</span>
                {p.title}
              </button>
            ))}
          </>
        ),
    });
  }

  /* ---- Strategy steps — the one flexible, auto-height row. Titles WRAP. ---- */
  {
    const nodeItems = nodes.map((n) => {
      const s = qToMonth(nodeQ(n));
      const span = Math.max(2, Math.round(nodeDur(n) * 3));
      return { node: n, s: Math.round(s), e: Math.round(s) + span };
    });
    const packed = packSpans(nodeItems);
    rows.push({
      key: 'steps',
      height: null,
      minHeight: `${packed.rows * 96 + 40}px`,
      className: 'st-tl__row--steps',
      label: <span className="st-tl__row-title">This strategy</span>,
      grid: (
        <div className="st-tl__steps-grid" style={{ gridTemplateColumns: `repeat(${NM}, ${COLW}px)` }}>
          {showToday ? <TodayMarker left={mLeft(TODAY_M)} /> : null}
          {packed.items.map(({ node: n, s, e, _row }) => {
            const sel = selectedStepId === n.id;
            const owner = memberName(members, n.ownerUserId);
            const eyebrow = `${n.meriAuthored ? 'MERI · ' : ''}${KIND_LABEL[n.kind] ?? n.kind} · ${nodeRangeLabel(nodeQ(n), nodeQ(n) + nodeDur(n), calendar)}`;
            return (
              <button
                key={n.id}
                type="button"
                className={`st-step st-step--${n.kind}${sel ? ' st-step--selected' : ''}`}
                style={{ gridColumn: `${s + 1} / ${e + 1}`, gridRow: _row + 1 }}
                onClick={() => onStepClick(n.id)}
                aria-pressed={sel}
              >
                <span className={`st-step__kind st-step__kind--${n.kind}`}>
                  <span className="st-step__dot" aria-hidden="true" />
                  {eyebrow}
                </span>
                <span className="st-step__title">{n.title}</span>
                <span className="st-step__meta">{n.ownerUserId ? `Owner · ${owner}` : 'Unassigned'}</span>
                {n.provenance?.contextNeeds && n.provenance.contextNeeds.length > 0 ? (
                  <span
                    className="st-step__context-needs"
                    role="status"
                    title={`Needs context: ${n.provenance.contextNeeds.map((c) => c.label).join(', ')}`}
                  >
                    Needs context
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ),
    });
  }

  return (
    <div className="st-tl" role="group" aria-label="Strategy timeline">
      <div className="st-tl__frame">
        <div className="st-tl__gutter">
          {rows.map((r) => (
            <div
              key={r.key}
              className={`st-tl__gutter-row ${r.className}${r.height === null ? ' st-tl__gutter-row--auto' : ''}`}
              style={{ height: r.height ?? undefined, minHeight: r.minHeight, flex: r.height === null ? '1 1 auto' : '0 0 auto' }}
            >
              {r.label}
            </div>
          ))}
        </div>
        <div className="st-tl__scroll" ref={scrollRef}>
          <div className="st-tl__canvas" style={{ ...gridStyle, width: W }}>
            {rows.map((r) => (
              <div
                key={r.key}
                className={`st-tl__band ${r.className}`}
                style={{ height: r.height ?? undefined, minHeight: r.minHeight, flex: r.height === null ? '1 1 auto' : '0 0 auto' }}
              >
                {r.grid}
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="st-tl__footnote">
        Nodes sit in the window where they act. The legislative band is shared; the firm-phase band is this
        firm's own cycle. Everything left of <b className="st-tl__footnote-today">today</b> is due-or-done.
      </p>
    </div>
  );
}

/**
 * Today marker — a full-height red line + optional pill, matching the legacy
 * planner's treatment (a cut line, not the brand accent, since it marks "now"
 * rather than a selection or an active state). Plain absolute inset inside a
 * `position: relative` band; `.st-tl__band` (steps included) is always that,
 * and an absolutely-positioned child is removed from grid flow, so this works
 * identically in the CSS-grid steps row and every plain band. z-index in CSS
 * keeps it painted above the bars/cards it crosses regardless of DOM order.
 */
function TodayMarker({ left, label }: { left: number; label?: string }) {
  return (
    <div className="st-tl__today" style={{ left }}>
      <span className="st-tl__today-line" aria-hidden="true" />
      {label ? (
        <span className="st-tl__today-pill">
          <span className="st-tl__today-dot" aria-hidden="true" />
          {label}
        </span>
      ) : null}
    </div>
  );
}

function legislativeTone(label: string): 'success' | 'critical' | 'neutral' {
  if (/markup|final bills/i.test(label)) return 'success';
  if (/continuing resolution/i.test(label)) return 'critical';
  return 'neutral';
}

function EditGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z" />
    </svg>
  );
}

function ChevronGlyph({ expanded }: { expanded: boolean }) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: expanded ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/* ------------------------------------------------------------------ utils */

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
