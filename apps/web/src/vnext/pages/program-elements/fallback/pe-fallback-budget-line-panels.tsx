/**
 * Budget Line 360 panels — native vNext port of
 * `pages/program-element/BudgetLinePanels.tsx` (BL-2): relationship graph
 * (F12/§1.3), budget-action feed (§1.2), incumbent map (F20), appropriability
 * (F27), maturity ladder (F19). All render honest empty states and nothing
 * fake — every value traces to a derive verb or a source exhibit. The SVG
 * chart primitives (`GraphView`, `ScoreDial`, `FactorBars`,
 * `MaturityLadderChart`) are the canonical antd-free modules, imported as-is.
 */
import {
  FactorBars,
  GraphView,
  MaturityLadderChart,
  ScoreDial,
  fmtMoneyM,
  type GraphEdge,
  type GraphNode,
} from '../../../../pages/program-element/charts/index.js';
import { LINE_TYPES } from '../../../../pages/program-element/pe-shared-model.js';
import type {
  AppropriabilityData,
  BudgetActionItem,
  IncumbentItem,
  MaturityLadderData,
  RelationshipItem,
} from '../../../../pages/program-element/types.js';
import {
  PeFbClockIcon,
  PeFbExclamationCircleIcon,
  PeFbFlagIcon,
  PeFbLockIcon,
  PeFbSwapIcon,
  PeFbTrendDownIcon,
  PeFbTrendUpIcon,
} from './pe-fallback-icons.js';
import {
  MaturityMiniVNext,
  PeCodeBadgeVNext,
  PeFbEmpty,
  PeFbPanel,
  PeFbSecondaryFailed,
  PeFbSkeleton,
  TierBadgeVNext,
} from './pe-fallback-ui.js';

const REL_META: Record<string, { label: string; color: string }> = {
  rdte_to_procurement: { label: 'RDT&E → Procurement', color: '#1A6E78' },
  procurement_to_om: { label: 'Procurement → O&M', color: '#A26913' },
  predecessor_successor: { label: 'Predecessor', color: '#B5301B' },
  same_program: { label: 'Same program', color: '#4E5A86' },
  same_capability: { label: 'Same capability', color: '#2A57CE' },
  related_pe_exhibit: { label: 'Related PEs (P-40)', color: '#2A57CE' },
};

const CONF_LABEL: Record<string, string> = { high: 'High', med: 'Medium', low: 'Low' };

function ConfBadge({ conf }: { conf: string }) {
  return <span className={`pe-fb-conf-badge conf-${conf}`}>{CONF_LABEL[conf] ?? conf} confidence</span>;
}

// ── Relationship graph panel ─────────────────────────────────────────────────
export function PeRelationshipGraphPanelVNext({
  peCode,
  relationships,
  loading,
  onOpen,
  errored = false,
  onRetry,
}: {
  peCode: string;
  relationships: RelationshipItem[] | undefined;
  loading: boolean;
  onOpen: (peCode: string) => void;
  errored?: boolean;
  onRetry?: () => void;
}) {
  if (loading) return <PeFbSkeleton rows={5} />;
  if (errored) {
    return (
      <PeFbSecondaryFailed
        label="relationship graph"
        testId="pe-secondary-failed-relationships"
        onRetry={onRetry}
      />
    );
  }
  const links = relationships ?? [];
  if (links.length === 0) {
    return (
      <PeFbEmpty description="No relationships mapped yet. Edges are seeded from P-40 'Related PEs', shared acquisition programs, and consolidation detection — accumulating as derivations run." />
    );
  }
  const nodes: GraphNode[] = [
    {
      id: peCode,
      code: peCode,
      label: 'this line',
      nx: 0.5,
      ny: 0.5,
      color: 'var(--capiro-color-action-accent-default)',
      size: 34,
    },
    ...links.map((lk, i) => {
      const ang = (Math.PI * 2 * i) / links.length - Math.PI / 2;
      return {
        id: lk.line.peCode,
        code: lk.line.peCode,
        label: lk.line.title.split(' ').slice(0, 2).join(' '),
        nx: 0.5 + Math.cos(ang) * 0.4,
        ny: 0.5 + Math.sin(ang) * 0.42,
        color: (lk.line.lineType && LINE_TYPES[lk.line.lineType]?.color) || 'var(--capiro-color-text-muted)',
        size: 26,
        candidate: lk.status === 'candidate',
      };
    }),
  ];
  const edges: GraphEdge[] = links.map((lk) => ({
    from: peCode,
    to: lk.line.peCode,
    color: (REL_META[lk.relType] ?? { color: 'var(--capiro-color-text-muted)' }).color,
    confidence: lk.confidence,
  }));
  const usedRels = [...new Set(links.map((l) => l.relType))];
  return (
    <>
      <GraphView nodes={nodes} edges={edges} h={400} activeId={peCode} onNode={onOpen} />
      <div className="pe-fb-graph-legend">
        {usedRels.map((t) => (
          <span key={t} className="pe-fb-gl-item">
            <span className="pe-fb-gl-ln" style={{ background: (REL_META[t] ?? { color: 'var(--capiro-color-text-muted)' }).color }} />
            {(REL_META[t] ?? { label: t }).label}
          </span>
        ))}
        <span className="pe-fb-gl-item muted">
          <span className="pe-fb-gl-ln dashed" />
          dashed = lower confidence / candidate
        </span>
      </div>
      <div className="pe-fb-edge-evidence">
        {links.map((lk) => (
          <div key={lk.id} className="pe-fb-ee-row">
            <PeCodeBadgeVNext code={lk.line.peCode} size="sm" />
            <span className="pe-fb-ee-type" style={{ color: (REL_META[lk.relType] ?? { color: 'var(--capiro-color-text-secondary)' }).color }}>
              {(REL_META[lk.relType] ?? { label: lk.relType }).label}
            </span>
            <span className="pe-fb-ee-text">{lk.evidence}</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Budget actions feed (§1.2) ───────────────────────────────────────────────
const ACTION_ICON: Record<string, React.ReactNode> = {
  add: <PeFbTrendUpIcon />,
  cut: <PeFbTrendDownIcon />,
  new_start: <PeFbFlagIcon />,
  termination: <PeFbTrendDownIcon />,
  hold: <PeFbLockIcon />,
  transfer: <PeFbSwapIcon />,
};
const ACTION_TONE: Record<string, string> = {
  add: 'notable',
  cut: 'critical',
  new_start: 'info',
  termination: 'critical',
  hold: 'notable',
  transfer: 'info',
};

export function PeBudgetActionsFeedVNext({
  actions,
  loading,
  limit,
  errored = false,
  onRetry,
}: {
  actions: BudgetActionItem[] | undefined;
  loading: boolean;
  limit?: number;
  errored?: boolean;
  onRetry?: () => void;
}) {
  if (loading) return <PeFbSkeleton rows={3} />;
  if (errored) {
    return <PeFbSecondaryFailed label="budget actions" testId="pe-secondary-failed-actions" onRetry={onRetry} />;
  }
  const rows = (actions ?? []).slice(0, limit ?? actions?.length ?? 0);
  if (rows.length === 0) {
    return (
      <PeFbEmpty description="No recorded budget actions — no committee marks diverging from the request on this line yet." />
    );
  }
  return (
    <div className="pe-fb-act-feed">
      {rows.map((a) => (
        <div key={a.id} className="pe-fb-act-row">
          <span className={`pe-fb-act-ico tone-${ACTION_TONE[a.action] ?? 'info'}`}>
            {ACTION_ICON[a.action] ?? <PeFbTrendUpIcon />}
          </span>
          <div className="pe-fb-act-main">
            <div className="pe-fb-act-t">{a.note ?? `${a.stage} ${a.action}`}</div>
            <div className="pe-fb-act-m">
              <span className="pe-fb-stage-chip">{a.stage.replace('_', '-')}</span>
              <span>FY{a.fy}</span>
              <span className="pe-fb-dot-sep">·</span>
              <span>vs {a.baseline.replace('_', ' ')}</span>
            </div>
          </div>
          <div className={`pe-fb-act-delta tone-${ACTION_TONE[a.action] ?? 'info'}`}>
            {a.amount != null ? `${a.amount >= 0 ? '+' : '−'}${fmtMoneyM(Math.abs(a.amount))}` : '—'}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Incumbent map (F20) ──────────────────────────────────────────────────────
const INC_TIER: Record<string, { color: string; label: string }> = {
  incumbent: { color: '#1A6E78', label: 'Incumbent' },
  performer: { color: '#A26913', label: 'Budget-justification performer' },
  candidate: { color: '#8A8780', label: 'Candidate — needs review' },
};

export function PeIncumbentMapPanelVNext({
  incumbents,
  loading,
  errored = false,
  onRetry,
}: {
  incumbents: IncumbentItem[] | undefined;
  loading: boolean;
  errored?: boolean;
  onRetry?: () => void;
}) {
  if (loading) return <PeFbSkeleton rows={4} />;
  if (errored) {
    return (
      <PeFbSecondaryFailed label="incumbent map" testId="pe-secondary-failed-incumbents" onRetry={onRetry} />
    );
  }
  const rows = incumbents ?? [];
  return (
    <>
      <div className="pe-fb-honest-note">
        <PeFbExclamationCircleIcon /> &quot;Incumbent&quot; is shown only with matched award
        evidence. Budget-justification (R-3) performers are labeled as such — not incumbents.
      </div>
      {rows.length === 0 ? (
        <PeFbEmpty description="No matched performers yet. Award→line enrichment accumulates top-dollar first; R-3 performers appear as budget-justification performers until award evidence links them." />
      ) : (
        <div className="pe-fb-inc-table" role="table" aria-label="Incumbent map">
          <div className="pe-fb-inc-tr pe-fb-inc-thead" role="row">
            <div>Company</div>
            <div>Classification</div>
            <div className="c">Confidence</div>
            <div className="r">Matched awards</div>
            <div>Evidence</div>
          </div>
          {rows.map((c, i) => {
            const tier = INC_TIER[c.tier] ?? INC_TIER.candidate!;
            return (
              <div key={i} className="pe-fb-inc-tr pe-fb-inc-row" role="row">
                <div className="pe-fb-inc-co">
                  <span className="pe-fb-inc-ava" style={{ background: tier.color }}>
                    {c.company
                      .split(' ')
                      .map((w) => w[0])
                      .slice(0, 2)
                      .join('')}
                  </span>
                  <div>
                    <div className="pe-fb-inc-name">{c.company}</div>
                    {c.role ? <div className="pe-fb-inc-role">{c.role}</div> : null}
                  </div>
                </div>
                <div>
                  <span className="pe-fb-inc-tier" style={{ color: tier.color, background: `${tier.color}18` }}>
                    {tier.label}
                  </span>
                </div>
                <div className="c">
                  <ConfBadge conf={c.confidence} />
                </div>
                <div className="r pe-fb-inc-awards">
                  {c.awardsTotal != null ? fmtMoneyM(c.awardsTotal / 1_000_000) : <span className="pe-fb-dash">none</span>}
                </div>
                <div className="pe-fb-inc-ev">
                  {c.sourceUrl ? (
                    <a href={c.sourceUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                      {c.evidence}
                    </a>
                  ) : (
                    c.evidence
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── Maturity ladder (F19) ────────────────────────────────────────────────────
export function PeMaturityLadderPanelVNext({
  ladder,
  compact,
  errored = false,
  onRetry,
}: {
  ladder: MaturityLadderData | null | undefined;
  compact?: boolean;
  /** Phase 5 B14 — intelligence request failed; never show derivation-pending Empty. */
  errored?: boolean;
  onRetry?: () => void;
}) {
  if (errored) {
    return (
      <PeFbSecondaryFailed
        label="transition maturity"
        testId="pe-secondary-failed-intelligence-maturity"
        onRetry={onRetry}
      />
    );
  }
  if (!ladder || !Array.isArray(ladder.rungs) || ladder.rungs.length === 0) {
    return (
      <PeFbEmpty description="Transition maturity not yet computed for this line — runs with the nightly intelligence derivation." />
    );
  }
  return (
    <>
      <div className="pe-fb-mat-headline">
        <span className="pe-fb-mat-big">{ladder.current}</span>
        <span className="pe-fb-mat-of">/5</span>
        <span className="pe-fb-mat-cur">{ladder.rungs[ladder.current]?.label ?? ''}</span>
        <MaturityMiniVNext value={ladder.current} />
      </div>
      <MaturityLadderChart rungs={ladder.rungs} current={ladder.current} compact={compact} />
    </>
  );
}

// ── Appropriability (F27) ────────────────────────────────────────────────────
export function PeAppropriabilityPanelVNext({
  approp,
  errored = false,
  onRetry,
}: {
  approp: AppropriabilityData | null | undefined;
  /** Phase 5 B14 — intelligence request failed; never show derivation-pending Empty. */
  errored?: boolean;
  onRetry?: () => void;
}) {
  if (errored) {
    return (
      <PeFbSecondaryFailed
        label="appropriability"
        testId="pe-secondary-failed-intelligence-appropriability"
        onRetry={onRetry}
      />
    );
  }
  if (!approp || (!approp.factors?.length && !approp.unscored?.length)) {
    return (
      <PeFbEmpty description="Appropriability not yet scored — runs with the nightly intelligence derivation once the line has enough evidence." />
    );
  }
  return (
    <div className="pe-fb-approp">
      <div className="pe-fb-approp-hero">
        <ScoreDial score={approp.score} tier={approp.tier} size={156} label="Appropriability" />
        <div className="pe-fb-approp-hero-r">
          <div className="pe-fb-approp-eyebrow">How actionable is this line for a seller?</div>
          {approp.tier ? <TierBadgeVNext tier={approp.tier} /> : null}
          <div className="pe-fb-approp-reason">{approp.reason}</div>
          <div
            className="pe-fb-approp-formula"
            title="The composite reweights over the factors that can actually be scored from evidence — an unknown factor is listed below, never faked as a middling number."
          >
            weighted composite over {approp.factors.length} evidence-scored factor
            {approp.factors.length === 1 ? '' : 's'}
            {approp.unscored.length ? ` · ${approp.unscored.length} not yet scorable` : ''}
          </div>
        </div>
      </div>
      {approp.factors.length ? (
        <PeFbPanel title="Factor breakdown" className="pe-fb-approp-factors">
          <FactorBars factors={approp.factors} />
        </PeFbPanel>
      ) : null}
      {approp.unscored.length ? (
        <PeFbPanel title="Not yet scorable" className="pe-fb-approp-unscored">
          {approp.unscored.map((u) => (
            <div key={u.key} className="pe-fb-unscored-row">
              <span className="pe-fb-unscored-l">
                <PeFbClockIcon /> {u.label}
              </span>
              <span className="pe-fb-unscored-r">{u.reason}</span>
            </div>
          ))}
        </PeFbPanel>
      ) : null}
    </div>
  );
}
