import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Empty, Skeleton } from 'antd';
import {
  FallOutlined,
  FlagOutlined,
  LockOutlined,
  RiseOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { useApi } from '../../lib/use-api.js';
import { getMovement } from './api.js';
import { DivergenceRow, Heatmap, fmtMoneyM } from './charts/index.js';
import { LINE_TYPES, PeCodeBadge, ServiceCell } from './pe-shared.js';

/**
 * Movement view (BL-3): F2 action feed + F7 heatmap + F3/F13 conference
 * divergence + F9 anomalies — everything over the normalized budget_action
 * table and the intelligence cache. All aggregates are open-cycle only
 * (same-FY pinning rule).
 */

const ACT_ICON: Record<string, React.ReactNode> = {
  add: <RiseOutlined />,
  cut: <FallOutlined />,
  new_start: <FlagOutlined />,
  termination: <FallOutlined />,
  hold: <LockOutlined />,
  transfer: <SwapOutlined />,
};
const ACT_TONE: Record<string, string> = {
  add: 'notable',
  cut: 'critical',
  new_start: 'info',
  termination: 'critical',
  hold: 'notable',
  transfer: 'info',
};

type Filter = 'all' | 'adds' | 'cuts' | 'moves';

export function MovementView({ onOpen }: { onOpen: (peCode: string) => void }) {
  const api = useApi();
  const [filter, setFilter] = useState<Filter>('all');
  const query = useQuery({
    queryKey: ['budget-lines-movement'],
    queryFn: () => getMovement(api),
    staleTime: 60 * 1000,
  });

  if (query.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (query.isError || !query.data) {
    return <Alert type="error" showIcon message="Unable to load movement data" />;
  }
  const m = query.data;
  const shown = m.feed.filter((a) =>
    filter === 'all'
      ? true
      : filter === 'adds'
        ? (a.amount ?? 0) > 0
        : filter === 'cuts'
          ? (a.amount ?? 0) < 0
          : a.action === 'transfer' || a.action === 'new_start' || a.action === 'termination',
  );

  return (
    <div className="bl-movement">
      <div className="bl-mv-kpis">
        <div className="pe-idx-kpi">
          <div className="pe-kpi-l">Actions · FY{m.openFy}</div>
          <div className="pe-kpi-v">{m.kpis.actions}</div>
          <div className="pe-kpi-d">normalized committee events</div>
        </div>
        <div className="pe-idx-kpi">
          <div className="pe-kpi-l">Adds</div>
          <div className="pe-kpi-v" style={{ color: 'var(--success)' }}>
            +{fmtMoneyM(m.kpis.addsTotal)}
          </div>
          <div className="pe-kpi-d">committee increases</div>
        </div>
        <div className="pe-idx-kpi">
          <div className="pe-kpi-l">Cuts</div>
          <div className="pe-kpi-v" style={{ color: 'var(--critical)' }}>
            −{fmtMoneyM(Math.abs(m.kpis.cutsTotal))}
          </div>
          <div className="pe-kpi-d">reductions &amp; terminations</div>
        </div>
        <div className="pe-idx-kpi">
          <div className="pe-kpi-l">Open in conference</div>
          <div className="pe-kpi-v">{m.kpis.openInConference}</div>
          <div className="pe-kpi-d">House vs. Senate divergence</div>
        </div>
      </div>

      <div className="bl-mv-grid">
        <div className="pe-idx-card">
          <div className="pe-idx-card-head">
            <h3>Movement feed</h3>
            <span className="pe-idx-count">every add · cut · new start · termination</span>
            <div className="bl-mv-filters">
              {(['all', 'adds', 'cuts', 'moves'] as Filter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`bl-mv-filter${filter === f ? ' on' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <Empty description="No budget actions match this filter yet." />
          ) : (
            <div className="bl-mv-feed">
              {shown.map((a) => (
                <div key={a.id} className="bl-mv-row" onClick={() => onOpen(a.peCode)}>
                  <span className={`bl-act-ico tone-${ACT_TONE[a.action] ?? 'info'}`}>
                    {ACT_ICON[a.action] ?? <RiseOutlined />}
                  </span>
                  <div className="bl-mv-main">
                    <div className="bl-mv-t">
                      {a.title} <span className="bl-stage-chip">{a.stage.replace('_', '-')}</span>
                    </div>
                    {a.note ? <div className="bl-mv-why">{a.note}</div> : null}
                    <div className="bl-mv-meta">
                      <PeCodeBadge code={a.peCode} size="sm" />
                      <span className="pe-dot-sep">·</span>
                      <ServiceCell service={a.service} />
                      <span className="pe-dot-sep">·</span>
                      FY{a.fy}
                    </div>
                  </div>
                  <div className={`bl-act-delta tone-${ACT_TONE[a.action] ?? 'info'}`}>
                    {a.amount != null
                      ? `${a.amount >= 0 ? '+' : '−'}${fmtMoneyM(Math.abs(a.amount))}`
                      : a.action === 'termination'
                        ? 'Zeroed'
                        : '—'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bl-mv-side">
          <div className="pe-idx-card">
            <div className="pe-idx-card-head">
              <h3>Movement heatmap</h3>
              <span className="pe-idx-count">$M by stage · FY{m.heatmap.fy}</span>
            </div>
            <div className="bl-panel-body">
              {m.heatmap.rows.some((r) => r.vals.some((v) => v !== 0)) ? (
                <Heatmap
                  cols={m.heatmap.cols}
                  rows={m.heatmap.rows.map((r) => ({
                    label: LINE_TYPES[r.lineType]?.short ?? r.lineType,
                    color: LINE_TYPES[r.lineType]?.color ?? 'var(--ink-3)',
                    vals: r.vals,
                  }))}
                  fmt={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`}
                />
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="No stage movement recorded this cycle yet."
                />
              )}
            </div>
          </div>

          <div className="pe-idx-card">
            <div className="pe-idx-card-head">
              <h3>Anomaly detector</h3>
              <span className="pe-idx-count">engine verdicts</span>
            </div>
            <div className="bl-panel-body">
              {m.anomalies.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No anomalies flagged." />
              ) : (
                <div className="bl-anom-list">
                  {m.anomalies.map((an, i) => (
                    <div key={i} className="bl-anom-row" onClick={() => onOpen(an.peCode)}>
                      <span className={`pe-sig-pill tone-${an.tone === 'critical' ? 'critical' : an.tone === 'info' ? 'info' : 'notable'}`}>
                        {an.kind.replace(/_/g, ' ')}
                      </span>
                      <div className="bl-anom-main">
                        <div className="bl-anom-line">{an.title}</div>
                        <div className="bl-anom-note">{an.note}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="pe-idx-card">
        <div className="pe-idx-card-head">
          <h3>Conference dashboard</h3>
          <span className="pe-idx-count">
            House (H) vs. Senate (S) around the request · FY{m.openFy} · widest gaps first
          </span>
        </div>
        {m.conference.length === 0 ? (
          <Empty description="No open House-vs-Senate divergence this cycle — marks agree or conference has closed." />
        ) : (
          <div className="bl-conf-list">
            {m.conference.map((row) => (
              <div key={row.peCode} className="bl-conf-row" onClick={() => onOpen(row.peCode)}>
                <div className="bl-conf-line">
                  <PeCodeBadge code={row.peCode} size="sm" />
                  <span className="bl-conf-title">{row.title}</span>
                  <span className="bl-conf-basis">{row.basis}</span>
                </div>
                {row.house != null && row.senate != null && row.request != null ? (
                  <DivergenceRow
                    row={{ title: row.title, house: row.house, senate: row.senate, request: row.request }}
                    fmt={(v) => fmtMoneyM(v)}
                  />
                ) : null}
                <div className="bl-conf-gap">
                  {row.gap != null ? (
                    <>
                      <span className="bl-conf-gap-v">{fmtMoneyM(row.gap)}</span>
                      <span className="bl-conf-lean">{row.lean === 'house' ? 'House higher' : 'Senate higher'}</span>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
