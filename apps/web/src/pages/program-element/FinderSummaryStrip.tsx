import { Skeleton } from 'antd';
import { Sparkline, Donut, fmtMoneyM, serviceColor } from './charts/index.js';
import { serviceLabel } from './pe-shared.js';
import type { ProgramElementSummary } from './types.js';

interface Props {
  summary: ProgramElementSummary | undefined;
  loading: boolean;
  serviceFilter: string | null;
  onServiceFilter: (code: string | null) => void;
}

function Kpi({
  label,
  fyTag,
  value,
  valueClass,
  sub,
}: {
  label: string;
  fyTag?: string | null;
  value: React.ReactNode;
  valueClass?: string;
  sub: React.ReactNode;
}) {
  return (
    <div className="pe-idx-kpi">
      <div className="pe-idx-kpi-l">
        {label}
        {fyTag ? <span className="pe-fy-tag">{fyTag}</span> : null}
      </div>
      <div className={`pe-idx-kpi-v${valueClass ? ` ${valueClass}` : ''}`}>{value}</div>
      <div className="pe-idx-kpi-d">{sub}</div>
    </div>
  );
}

export function FinderSummaryStrip({ summary, loading, serviceFilter, onServiceFilter }: Props) {
  if (loading && !summary) {
    return (
      <div className="pe-idx-summary">
        <div className="pe-idx-kpis">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="pe-idx-kpi">
              <Skeleton active paragraph={{ rows: 1 }} title={{ width: '60%' }} />
            </div>
          ))}
        </div>
        <div className="pe-idx-charts">
          <div className="pe-idx-chart-card">
            <Skeleton active paragraph={{ rows: 2 }} title={false} />
          </div>
          <div className="pe-idx-chart-card">
            <Skeleton active paragraph={{ rows: 2 }} title={false} />
          </div>
        </div>
      </div>
    );
  }

  const s = summary;
  const trend = s?.trend ?? [];
  const trendVals = trend.map((t) => t.total);
  // Show every named service (there are ~7 canonical ones) so no slice is silently
  // dropped, and label the donut center with the sum of the plotted arcs so the
  // center always equals what the arcs show (the full catalog count — which may
  // include service-less PEs — lives on the "Tracked elements" KPI).
  const byService = (s?.byService ?? []).filter((r) => r.service).slice(0, 8);
  const shownServiceTotal = byService.reduce((sum, r) => sum + r.count, 0);
  const donutData = byService.map((r) => ({
    label: serviceLabel(r.service),
    value: r.count,
    color: serviceColor(r.service),
  }));

  return (
    <div className="pe-idx-summary">
      <div className="pe-idx-kpis">
        <Kpi
          label="Tracked elements"
          value={(s?.tracked ?? 0).toLocaleString()}
          sub={`${(s?.watched ?? 0).toLocaleString()} on your watchlist`}
        />
        <Kpi
          label="Request"
          fyTag={s?.latestRequestFy ? `FY${String(s.latestRequestFy).slice(-2)} · aggregate` : 'aggregate'}
          value={fmtMoneyM(s?.totalRequest ?? null, 0)}
          sub="across all tracked PEs"
        />
        <Kpi
          label="Enacted"
          fyTag={s?.latestEnactedFy ? `FY${String(s.latestEnactedFy).slice(-2)} · aggregate` : 'aggregate'}
          value={fmtMoneyM(s?.totalEnacted ?? null, 0)}
          valueClass="accent"
          sub={
            s?.avgDeltaPct != null ? (
              <>
                <span className={s.avgDeltaPct >= 0 ? 'pe-up' : 'pe-down'}>
                  {s.avgDeltaPct >= 0 ? '▲' : '▼'} {Math.abs(s.avgDeltaPct).toFixed(1)}%
                </span>{' '}
                avg vs request
              </>
            ) : (
              'enacted appropriations'
            )
          }
        />
        <Kpi
          label="Open markups"
          value={(s?.openMarkups ?? 0).toLocaleString()}
          sub="PEs with active committee marks"
        />
      </div>

      <div className="pe-idx-charts">
        <div className="pe-idx-chart-card">
          <div className="pe-mini-head">
            <span className="pe-mini-t">Tracked funding trend</span>
            <span className="pe-mini-s">
              {trend.length ? `FY${String(trend[0]!.fy).slice(-2)}–FY${String(trend[trend.length - 1]!.fy).slice(-2)} · $M` : '$M'}
            </span>
          </div>
          <div className="pe-idx-trend">
            {trendVals.length > 1 ? (
              <Sparkline data={trendVals} width={236} height={54} strokeWidth={2} />
            ) : (
              <span className="pe-dash">Not enough history</span>
            )}
            {trend.length ? (
              <div className="pe-idx-trend-foot">
                <span>FY{String(trend[0]!.fy).slice(-2)}</span>
                <span>FY{String(trend[trend.length - 1]!.fy).slice(-2)}</span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="pe-idx-chart-card">
          <div className="pe-mini-head">
            <span className="pe-mini-t">By service</span>
          </div>
          <div className="pe-idx-donut-wrap">
            <Donut
              data={donutData}
              size={104}
              thickness={17}
              centerLabel={String(shownServiceTotal)}
              centerSub="PEs"
            />
            <div className="pe-idx-legend">
              {byService.map((r) => {
                const code = (r.service ?? '').toUpperCase();
                const active = serviceFilter?.toUpperCase() === code;
                return (
                  <button
                    key={code}
                    type="button"
                    className={`pe-idx-legend-row${active ? ' on' : ''}`}
                    onClick={() => onServiceFilter(active ? null : code)}
                  >
                    <span className="pe-legend-sw" style={{ background: serviceColor(r.service) }} />
                    <span className="pe-legend-l">{serviceLabel(r.service)}</span>
                    <span className="pe-legend-v">{r.count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
