/**
 * Budget Lines chart primitives (BL-2): MaturityLadder (F19), ScoreDial +
 * FactorBars (F27), StageFlow (appropriations ladder), GraphView (F12 radial
 * relationship graph). Hand-rolled SVG/CSS, design-token driven — same
 * conventions as the existing charts in this folder.
 */

export interface LadderRung {
  n: number;
  label: string;
  reached: boolean;
  evidence: string;
}

export function MaturityLadderChart({
  rungs,
  current,
  compact,
}: {
  rungs: LadderRung[];
  current: number;
  compact?: boolean;
}) {
  return (
    <div className={`bl-ladder${compact ? ' compact' : ''}`}>
      {rungs.map((r) => (
        <div key={r.n} className={`bl-rung${r.reached ? ' reached' : ''}${r.n === current ? ' current' : ''}`}>
          <div className="bl-rung-track">
            <span className="bl-rung-dot" />
            {r.n < rungs.length - 1 ? <span className="bl-rung-line" /> : null}
          </div>
          <div className="bl-rung-body">
            <div className="bl-rung-label">
              <span className="bl-rung-n">{r.n}</span>
              {r.label}
            </div>
            {!compact ? <div className="bl-rung-evidence">{r.evidence}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

const TIER_COLOR: Record<string, string> = {
  high: '#2E6B43',
  med: '#A26913',
  low: '#B5301B',
};

export function ScoreDial({
  score,
  tier,
  size = 128,
  label = 'Appropriability',
}: {
  score: number | null;
  tier: string | null;
  size?: number;
  label?: string;
}) {
  const color = tier ? (TIER_COLOR[tier] ?? 'var(--ink-3)') : 'var(--ink-4)';
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  const frac = score == null ? 0 : Math.max(0, Math.min(1, score / 100));
  return (
    <div className="bl-dial" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`${label}: ${score ?? 'not scored'}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-1)" strokeWidth={10} />
        {score != null ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={`${c * frac} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </svg>
      <div className="bl-dial-center">
        <div className="bl-dial-v" style={{ color }}>
          {score ?? '—'}
        </div>
        <div className="bl-dial-l">{label}</div>
      </div>
    </div>
  );
}

export interface FactorBar {
  key: string;
  label: string;
  value: number;
  evidence: string;
}

export function FactorBars({ factors }: { factors: FactorBar[] }) {
  return (
    <div className="bl-factors">
      {factors.map((f) => {
        const color = f.value >= 70 ? '#2E6B43' : f.value >= 45 ? '#A26913' : '#B5301B';
        return (
          <div key={f.key} className="bl-factor" title={f.evidence}>
            <div className="bl-factor-head">
              <span className="bl-factor-l">{f.label}</span>
              <span className="bl-factor-v" style={{ color }}>
                {f.value}
              </span>
            </div>
            <div className="bl-factor-track">
              <span className="bl-factor-fill" style={{ width: `${f.value}%`, background: color }} />
            </div>
            <div className="bl-factor-evidence">{f.evidence}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── StageFlow: the same-FY appropriations ladder (PB → marks → conference) ──
export interface StageStep {
  stage: string;
  label: string;
  /** $M; null = pending/future. */
  amount: number | null;
  /** Delta vs request, $M; null when not applicable. */
  delta: number | null;
  note: string | null;
  pending?: boolean;
}

export function StageFlow({ steps, fmt }: { steps: StageStep[]; fmt: (v: number) => string }) {
  const stated = steps.filter((s) => s.amount != null) as Array<StageStep & { amount: number }>;
  const max = stated.length ? Math.max(...stated.map((s) => s.amount)) : 0;
  const min = stated.length ? Math.min(...stated.map((s) => s.amount)) : 0;
  const span = max - min || 1;
  return (
    <div className="bl-stageflow">
      {steps.map((s, i) => (
        <div key={i} className={`bl-stage${s.pending || s.amount == null ? ' pending' : ''}`}>
          <div className="bl-stage-bar-wrap">
            {s.amount != null ? (
              <div
                className="bl-stage-bar"
                style={{ height: `${28 + ((s.amount - min) / span) * 52}%` }}
                title={fmt(s.amount)}
              />
            ) : (
              <div className="bl-stage-bar ghost" />
            )}
          </div>
          <div className="bl-stage-amt">{s.amount != null ? fmt(s.amount) : '—'}</div>
          {s.delta != null && s.delta !== 0 ? (
            <div className={`bl-stage-delta ${s.delta > 0 ? 'up' : 'down'}`}>
              {s.delta > 0 ? '+' : '−'}
              {fmt(Math.abs(s.delta))}
            </div>
          ) : (
            <div className="bl-stage-delta none">·</div>
          )}
          <div className="bl-stage-label">{s.label}</div>
          {s.note ? <div className="bl-stage-note">{s.note}</div> : null}
        </div>
      ))}
    </div>
  );
}

// ── Heatmap: $M moved by color-of-money × appropriations stage (F7) ─────────
export interface HeatmapRow {
  label: string;
  color: string;
  vals: number[];
}

export function Heatmap({ cols, rows, fmt }: { cols: string[]; rows: HeatmapRow[]; fmt: (v: number) => string }) {
  const maxAbs = Math.max(1, ...rows.flatMap((r) => r.vals.map((v) => Math.abs(v))));
  return (
    <div className="bl-heatmap" role="table" aria-label="Movement heatmap">
      <div className="bl-hm-row bl-hm-head" role="row" style={{ gridTemplateColumns: `86px repeat(${cols.length}, 1fr)` }}>
        <div />
        {cols.map((c) => (
          <div key={c} className="bl-hm-col" role="columnheader">
            {c.replace('_', '-')}
          </div>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.label} className="bl-hm-row" role="row" style={{ gridTemplateColumns: `86px repeat(${cols.length}, 1fr)` }}>
          <div className="bl-hm-label" role="rowheader">
            <span className="bl-hm-sw" style={{ background: r.color }} />
            {r.label}
          </div>
          {r.vals.map((v, i) => {
            const intensity = Math.abs(v) / maxAbs;
            const bg =
              v === 0
                ? 'transparent'
                : v > 0
                  ? `rgba(46, 107, 67, ${0.12 + intensity * 0.55})`
                  : `rgba(181, 48, 27, ${0.12 + intensity * 0.55})`;
            return (
              <div key={i} className="bl-hm-cell" role="cell" style={{ background: bg }} title={v === 0 ? '—' : fmt(v)}>
                {v === 0 ? '' : fmt(v)}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── DivergenceRow: House ◂ request ▸ Senate conference scale (F3/F13) ───────
export interface DivergenceDatum {
  title: string;
  house: number;
  senate: number;
  request: number;
}

export function DivergenceRow({ row, fmt }: { row: DivergenceDatum; fmt: (v: number) => string }) {
  const lo = Math.min(row.house, row.senate, row.request) * 0.96;
  const hi = Math.max(row.house, row.senate, row.request) * 1.04;
  const span = hi - lo || 1;
  const pos = (v: number) => `${((v - lo) / span) * 100}%`;
  return (
    <div className="bl-div-scale">
      <span className="bl-div-track" />
      <span className="bl-div-mark req" style={{ left: pos(row.request) }} title={`Request ${fmt(row.request)}`} />
      <span className="bl-div-mark house" style={{ left: pos(row.house) }} title={`House ${fmt(row.house)}`}>
        H
      </span>
      <span className="bl-div-mark senate" style={{ left: pos(row.senate) }} title={`Senate ${fmt(row.senate)}`}>
        S
      </span>
    </div>
  );
}

// ── GraphView: radial relationship graph (F12) ──────────────────────────────
export interface GraphNode {
  id: string;
  code: string;
  label: string;
  nx: number; // 0..1 normalized
  ny: number;
  color: string;
  size?: number;
  candidate?: boolean;
}
export interface GraphEdge {
  from: string;
  to: string;
  color: string;
  confidence: string; // high|med|low
}

export function GraphView({
  nodes,
  edges,
  w = 720,
  h = 400,
  padding = 64,
  activeId,
  onNode,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  w?: number;
  h?: number;
  padding?: number;
  activeId?: string;
  onNode?: (id: string) => void;
}) {
  const X = (nx: number) => padding + nx * (w - padding * 2);
  const Y = (ny: number) => padding + ny * (h - padding * 2);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const dash = (conf: string) => (conf === 'high' ? undefined : conf === 'med' ? '6 5' : '2 6');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="bl-graphview" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Relationship graph">
      {edges.map((e, i) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) return null;
        return (
          <line
            key={i}
            x1={X(a.nx)}
            y1={Y(a.ny)}
            x2={X(b.nx)}
            y2={Y(b.ny)}
            stroke={e.color}
            strokeWidth={1.6}
            strokeDasharray={dash(e.confidence)}
            opacity={0.75}
          />
        );
      })}
      {nodes.map((n) => {
        const size = n.size ?? 26;
        return (
          <g
            key={n.id}
            transform={`translate(${X(n.nx)}, ${Y(n.ny)})`}
            className={`bl-gnode${onNode && n.id !== activeId ? ' clickable' : ''}${n.candidate ? ' cand' : ''}`}
            onClick={() => onNode && n.id !== activeId && onNode(n.id)}
          >
            <circle
              r={size / 2}
              fill={n.id === activeId ? n.color : 'var(--bg-surface)'}
              stroke={n.color}
              strokeWidth={n.id === activeId ? 0 : 2}
              strokeDasharray={n.candidate ? '4 3' : undefined}
            />
            <text
              y={size / 2 + 13}
              textAnchor="middle"
              className="bl-gnode-code"
              fill="var(--ink-2)"
            >
              {n.code}
            </text>
            <text y={size / 2 + 25} textAnchor="middle" className="bl-gnode-label" fill="var(--ink-4)">
              {n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
