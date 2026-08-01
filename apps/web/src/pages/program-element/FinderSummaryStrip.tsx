import { Skeleton } from 'antd';
import { fmtMoneyM } from './charts/index.js';
import type { ProgramElementSummary } from './types.js';

interface Props {
  summary: ProgramElementSummary | undefined;
  loading: boolean;
  actionCount: number;
  actionsLoading: boolean;
  onOpenPortfolio: () => void;
  onOpenMovement: () => void;
  onOpenActions: () => void;
}

interface KpiProps {
  label: string;
  value: string;
  sub: string;
  tone?: 'critical' | 'accent';
  hint?: string;
  onClick?: () => void;
}

function Kpi({ label, value, sub, tone, hint, onClick }: KpiProps) {
  const content = (
    <>
      <span className="pe-rd-kpi-label">{label}</span>
      <span className={`pe-rd-kpi-value${tone ? ` is-${tone}` : ''}`}>{value}</span>
      <span className="pe-rd-kpi-sub">{sub}</span>
      {hint ? <span className="pe-rd-kpi-hint">{hint} →</span> : null}
    </>
  );

  return onClick ? (
    <button type="button" className="pe-rd-kpi" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="pe-rd-kpi">{content}</div>
  );
}

export function FinderSummaryStrip({
  summary,
  loading,
  actionCount,
  actionsLoading,
  onOpenPortfolio,
  onOpenMovement,
  onOpenActions,
}: Props) {
  if (loading && !summary) {
    return (
      <div className="pe-rd-kpi-grid">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="pe-rd-kpi">
            <Skeleton active paragraph={{ rows: 1 }} title={{ width: '58%' }} />
          </div>
        ))}
      </div>
    );
  }

  const requestFy = summary?.latestRequestFy
    ? `FY${String(summary.latestRequestFy).slice(-2)} request`
    : 'Latest request';

  return (
    <div className="pe-rd-kpi-grid">
      <Kpi
        label="Lines in catalog"
        value={(summary?.tracked ?? 0).toLocaleString()}
        sub={`${(summary?.watched ?? 0).toLocaleString()} monitored in Portfolio`}
        hint="Open Portfolio"
        onClick={onOpenPortfolio}
      />
      <Kpi
        label={requestFy}
        value={fmtMoneyM(summary?.totalRequest ?? null, 0)}
        sub="across tracked lines"
      />
      <Kpi
        label="Open markups"
        value={(summary?.openMarkups ?? 0).toLocaleString()}
        sub="lines with active committee marks"
        tone={(summary?.openMarkups ?? 0) > 0 ? 'critical' : undefined}
        hint="See movement"
        onClick={onOpenMovement}
      />
      <Kpi
        label="Open actions"
        value={actionsLoading ? '—' : actionCount.toLocaleString()}
        sub="on monitored budget lines"
        tone="accent"
        hint="Open actions"
        onClick={onOpenActions}
      />
    </div>
  );
}
