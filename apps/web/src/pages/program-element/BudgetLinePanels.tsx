/**
 * Budget Line 360 panels (BL-2): LinkedLinesRail + relationship graph (F12/§1.3),
 * budget-action feed (§1.2), incumbent map (F20), appropriability (F27),
 * maturity ladder (F19). All render honest empty states and nothing fake —
 * every value traces to a derive verb or a source exhibit.
 */
import { Card, Empty, Skeleton, Tooltip } from 'antd';
import {
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  FallOutlined,
  FlagOutlined,
  LockOutlined,
  RiseOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import {
  FactorBars,
  GraphView,
  MaturityLadderChart,
  ScoreDial,
  fmtMoneyM,
  type GraphEdge,
  type GraphNode,
} from './charts/index.js';
import { LINE_TYPES, LineTypeBadge, MaturityMini, PeCodeBadge, TierBadge } from './pe-shared.js';
import type {
  AppropriabilityData,
  BudgetActionItem,
  IncumbentItem,
  MaturityLadderData,
  RelationshipItem,
} from './types.js';
import { PeSecondaryFailed } from './PeSecondaryFailed.js';

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
  return <span className={`bl-conf-badge conf-${conf}`}>{CONF_LABEL[conf] ?? conf} confidence</span>;
}

// ── Linked lines rail (Overview) ─────────────────────────────────────────────
export function LinkedLinesRail({
  relationships,
  loading,
  onOpen,
  errored = false,
  onRetry,
}: {
  relationships: RelationshipItem[] | undefined;
  loading: boolean;
  onOpen: (peCode: string) => void;
  errored?: boolean;
  onRetry?: () => void;
}) {
  if (loading) return <Skeleton active paragraph={{ rows: 2 }} />;
  if (errored) {
    return (
      <PeSecondaryFailed
        label="linked lines"
        testId="pe-secondary-failed-linked-lines"
        onRetry={onRetry}
      />
    );
  }
  const links = relationships ?? [];
  if (links.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No linked lines yet — relationship enrichment is accumulating (P-40 related PEs, shared programs, consolidation candidates)."
      />
    );
  }
  return (
    <div className="bl-linked-rail">
      {links.map((lk) => {
        const meta = REL_META[lk.relType] ?? { label: lk.relType, color: 'var(--ink-3)' };
        return (
          <button
                      key={lk.id}
                      type="button"
                      className={`bl-linked-card${lk.status === 'candidate' ? ' cand' : ''}`}
                      style={{ ['--rel' as string]: meta.color }}
                      onClick={() => onOpen(lk.line.peCode)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onOpen(lk.line.peCode);
                        }
                      }}
                      title={lk.evidence}
                      aria-label={`Open related line ${lk.line.peCode}: ${lk.line.title}`}
                      data-testid={`pe-linked-line-${lk.line.peCode}`}
                    >
            <div className="bl-lc-rel">
              <span className="bl-lc-dir">{lk.direction === 'in' ? '←' : '→'}</span>
              {meta.label}
              {lk.status === 'candidate' ? <span className="bl-lc-cand">candidate</span> : null}
            </div>
            <div className="bl-lc-line">
              <PeCodeBadge code={lk.line.peCode} size="sm" />
            </div>
            <div className="bl-lc-name">{lk.line.title}</div>
            <div className="bl-lc-foot">
              <LineTypeBadge lineType={lk.line.lineType} small />
              <ConfBadge conf={lk.confidence} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Relationship graph panel (Relationships tab) ────────────────────────────
export function RelationshipGraphPanel({
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
  if (loading) return <Skeleton active paragraph={{ rows: 5 }} />;
  if (errored) {
    return (
      <PeSecondaryFailed
        label="relationship graph"
        testId="pe-secondary-failed-relationships"
        onRetry={onRetry}
      />
    );
  }
  const links = relationships ?? [];
  if (links.length === 0) {
    return (
      <Empty description="No relationships mapped yet. Edges are seeded from P-40 'Related PEs', shared acquisition programs, and consolidation detection — accumulating as derivations run." />
    );
  }
  const nodes: GraphNode[] = [
    {
      id: peCode,
      code: peCode,
      label: 'this line',
      nx: 0.5,
      ny: 0.5,
      color: 'var(--accent)',
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
        color: (lk.line.lineType && LINE_TYPES[lk.line.lineType]?.color) || 'var(--ink-3)',
        size: 26,
        candidate: lk.status === 'candidate',
      };
    }),
  ];
  const edges: GraphEdge[] = links.map((lk) => ({
    from: peCode,
    to: lk.line.peCode,
    color: (REL_META[lk.relType] ?? { color: 'var(--ink-3)' }).color,
    confidence: lk.confidence,
  }));
  const usedRels = [...new Set(links.map((l) => l.relType))];
  return (
    <>
      <GraphView nodes={nodes} edges={edges} h={400} activeId={peCode} onNode={onOpen} />
      <div className="bl-graph-legend">
        {usedRels.map((t) => (
          <span key={t} className="bl-gl-item">
            <span className="bl-gl-ln" style={{ background: (REL_META[t] ?? { color: 'var(--ink-3)' }).color }} />
            {(REL_META[t] ?? { label: t }).label}
          </span>
        ))}
        <span className="bl-gl-item muted">
          <span className="bl-gl-ln dashed" />
          dashed = lower confidence / candidate
        </span>
      </div>
      <div className="bl-edge-evidence">
        {links.map((lk) => (
          <div key={lk.id} className="bl-ee-row">
            <PeCodeBadge code={lk.line.peCode} size="sm" />
            <span className="bl-ee-type" style={{ color: (REL_META[lk.relType] ?? { color: 'var(--ink-2)' }).color }}>
              {(REL_META[lk.relType] ?? { label: lk.relType }).label}
            </span>
            <span className="bl-ee-text">{lk.evidence}</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Budget actions feed (§1.2) ───────────────────────────────────────────────
const ACTION_ICON: Record<string, React.ReactNode> = {
  add: <RiseOutlined />,
  cut: <FallOutlined />,
  new_start: <FlagOutlined />,
  termination: <FallOutlined />,
  hold: <LockOutlined />,
  transfer: <SwapOutlined />,
};
const ACTION_TONE: Record<string, string> = {
  add: 'notable',
  cut: 'critical',
  new_start: 'info',
  termination: 'critical',
  hold: 'notable',
  transfer: 'info',
};

export function BudgetActionsFeed({
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
  if (loading) return <Skeleton active paragraph={{ rows: 3 }} />;
  if (errored) {
    return <PeSecondaryFailed label="budget actions" testId="pe-secondary-failed-actions" onRetry={onRetry} />;
  }
  const rows = (actions ?? []).slice(0, limit ?? actions?.length ?? 0);
  if (rows.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No recorded budget actions — no committee marks diverging from the request on this line yet."
      />
    );
  }
  return (
    <div className="bl-action-feed">
      {rows.map((a) => (
        <div key={a.id} className="bl-act-row">
          <span className={`bl-act-ico tone-${ACTION_TONE[a.action] ?? 'info'}`}>
            {ACTION_ICON[a.action] ?? <RiseOutlined />}
          </span>
          <div className="bl-act-main">
            <div className="bl-act-t">{a.note ?? `${a.stage} ${a.action}`}</div>
            <div className="bl-act-m">
              <span className="bl-stage-chip">{a.stage.replace('_', '-')}</span>
              <span>FY{a.fy}</span>
              <span className="pe-dot-sep">·</span>
              <span>vs {a.baseline.replace('_', ' ')}</span>
            </div>
          </div>
          <div className={`bl-act-delta tone-${ACTION_TONE[a.action] ?? 'info'}`}>
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

export function IncumbentMapPanel({
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
  if (loading) return <Skeleton active paragraph={{ rows: 4 }} />;
  if (errored) {
    return (
      <PeSecondaryFailed label="incumbent map" testId="pe-secondary-failed-incumbents" onRetry={onRetry} />
    );
  }
  const rows = incumbents ?? [];
  return (
    <>
      <div className="bl-honest-note">
        <ExclamationCircleOutlined /> &quot;Incumbent&quot; is shown only with matched award
        evidence. Budget-justification (R-3) performers are labeled as such — not incumbents.
      </div>
      {rows.length === 0 ? (
        <Empty description="No matched performers yet. Award→line enrichment accumulates top-dollar first; R-3 performers appear as budget-justification performers until award evidence links them." />
      ) : (
        <div className="bl-inc-table" role="table" aria-label="Incumbent map">
          <div className="bl-inc-tr bl-inc-thead" role="row">
            <div>Company</div>
            <div>Classification</div>
            <div className="c">Confidence</div>
            <div className="r">Matched awards</div>
            <div>Evidence</div>
          </div>
          {rows.map((c, i) => {
            const tier = INC_TIER[c.tier] ?? INC_TIER.candidate!;
            return (
              <div key={i} className="bl-inc-tr bl-inc-row" role="row">
                <div className="bl-inc-co">
                  <span className="bl-inc-ava" style={{ background: tier.color }}>
                    {c.company
                      .split(' ')
                      .map((w) => w[0])
                      .slice(0, 2)
                      .join('')}
                  </span>
                  <div>
                    <div className="bl-inc-name">{c.company}</div>
                    {c.role ? <div className="bl-inc-role">{c.role}</div> : null}
                  </div>
                </div>
                <div>
                  <span className="bl-inc-tier" style={{ color: tier.color, background: `${tier.color}18` }}>
                    {tier.label}
                  </span>
                </div>
                <div className="c">
                  <ConfBadge conf={c.confidence} />
                </div>
                <div className="r bl-inc-awards">
                  {c.awardsTotal != null ? fmtMoneyM(c.awardsTotal / 1_000_000) : <span className="pe-dash">none</span>}
                </div>
                <div className="bl-inc-ev">
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
export function MaturityLadderPanel({
  ladder,
  compact,
}: {
  ladder: MaturityLadderData | null | undefined;
  compact?: boolean;
}) {
  if (!ladder || !Array.isArray(ladder.rungs) || ladder.rungs.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Transition maturity not yet computed for this line — runs with the nightly intelligence derivation."
      />
    );
  }
  return (
    <>
      <div className="bl-mat-headline">
        <span className="bl-mat-big">{ladder.current}</span>
        <span className="bl-mat-of">/5</span>
        <span className="bl-mat-cur">{ladder.rungs[ladder.current]?.label ?? ''}</span>
        <MaturityMini value={ladder.current} />
      </div>
      <MaturityLadderChart rungs={ladder.rungs} current={ladder.current} compact={compact} />
    </>
  );
}

// ── Appropriability (F27) ────────────────────────────────────────────────────
export function AppropriabilityPanel({
  approp,
}: {
  approp: AppropriabilityData | null | undefined;
}) {
  if (!approp || (!approp.factors?.length && !approp.unscored?.length)) {
    return (
      <Empty description="Appropriability not yet scored — runs with the nightly intelligence derivation once the line has enough evidence." />
    );
  }
  return (
    <div className="bl-approp">
      <div className="bl-approp-hero">
        <ScoreDial score={approp.score} tier={approp.tier} size={156} label="Appropriability" />
        <div className="bl-approp-hero-r">
          <div className="bl-approp-eyebrow">How actionable is this line for a seller?</div>
          {approp.tier ? <TierBadge tier={approp.tier} /> : null}
          <div className="bl-approp-reason">{approp.reason}</div>
          <Tooltip title="The composite reweights over the factors that can actually be scored from evidence — an unknown factor is listed below, never faked as a middling number.">
            <div className="bl-approp-formula">
              weighted composite over {approp.factors.length} evidence-scored factor
              {approp.factors.length === 1 ? '' : 's'}
              {approp.unscored.length ? ` · ${approp.unscored.length} not yet scorable` : ''}
            </div>
          </Tooltip>
        </div>
      </div>
      {approp.factors.length ? (
        <Card title="Factor breakdown" className="bl-approp-factors">
          <FactorBars factors={approp.factors} />
        </Card>
      ) : null}
      {approp.unscored.length ? (
        <Card title="Not yet scorable" className="bl-approp-unscored">
          {approp.unscored.map((u) => (
            <div key={u.key} className="bl-unscored-row">
              <span className="bl-unscored-l">
                <ClockCircleOutlined /> {u.label}
              </span>
              <span className="bl-unscored-r">{u.reason}</span>
            </div>
          ))}
        </Card>
      ) : null}
    </div>
  );
}
