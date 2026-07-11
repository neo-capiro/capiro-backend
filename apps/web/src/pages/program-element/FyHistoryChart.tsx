import { useMemo } from 'react';
import { Button, Card, Empty, Skeleton, Space, Typography } from 'antd';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import type {
  FyHistoryChartProps,
  ProgramElementHistoryRow,
  ProgramElementSourceField,
} from './types.js';
import { currentFunding, type FundingStage } from './funding-model.js';

const { Text } = Typography;

interface ChartPoint {
  fy: number;
  request: number;
  enacted: number;
  // Furthest-along funding figure for the year, from the SHARED funding-model
  // precedence (enacted → conference → SAC-D → HAC-D → SASC → HASC → request) so
  // the bar matches the Overview trajectory + delta bars exactly. `fundingStage`
  // is the coarse display bucket (committee marks collapse to 'Committee').
  funding: number;
  fundingStage: 'Enacted' | 'Conference' | 'Committee' | 'Requested' | 'Pending';
  projected: boolean;
  requestSource: string;
  hascMark: number | null;
  sascMark: number | null;
  hacDMark: number | null;
  sacDMark: number | null;
  conference: number | null;
  ndaaConference: number | null;
  enactedSource: string;
  hascSource: string;
  sascSource: string;
  hacDSource: string;
  sacDSource: string;
  conferenceSource: string;
  ndaaConferenceSource: string;
  rawEnacted: number | null;
}

const dollarsTick = (v: number) => `$${v}m`;
const dollars2 = (v: number | null) => (v == null ? '-' : `$${v.toFixed(2)}m`);

function sourceFor(row: ProgramElementHistoryRow, field: ProgramElementSourceField): string {
  return row.sourceAttribution[field] ?? 'n/a';
}

/** funding-model stage → the bar's coarse display bucket (committee marks merge). */
const DISPLAY_STAGE: Record<FundingStage, ChartPoint['fundingStage']> = {
  enacted: 'Enacted',
  conference: 'Conference',
  sacd: 'Committee',
  hacd: 'Committee',
  sasc: 'Committee',
  hasc: 'Committee',
  request: 'Requested',
  none: 'Pending',
};

export function toChartPoint(row: ProgramElementHistoryRow): ChartPoint {
  // Furthest-along value for the year from the shared funding-model, so the bar
  // agrees with the Overview trajectory + delta bars. The old blend was
  // enacted→conference→request only, so a line Congress marked but hadn't
  // enacted (e.g. request 0, HAC-D 1549.1) drew a misleading $0 bar.
  const pick = currentFunding({
    request: row.request,
    hascMark: row.hascMark,
    sascMark: row.sascMark,
    hacDMark: row.hacDMark,
    sacDMark: row.sacDMark,
    conference: row.conference,
    enacted: row.enacted,
  });
  const funding = pick.value ?? 0;
  const fundingStage = DISPLAY_STAGE[pick.stage];
  return {
    fy: row.fy,
    request: row.request ?? 0,
    enacted: row.enacted ?? row.request ?? 0,
    funding,
    fundingStage,
    projected: row.projectedEnacted,
    requestSource: sourceFor(row, 'request'),
    hascMark: row.hascMark,
    sascMark: row.sascMark,
    hacDMark: row.hacDMark,
    sacDMark: row.sacDMark,
    conference: row.conference,
    ndaaConference: row.ndaaConference ?? null,
    enactedSource: sourceFor(row, 'enacted'),
    hascSource: sourceFor(row, 'hascMark'),
    sascSource: sourceFor(row, 'sascMark'),
    hacDSource: sourceFor(row, 'hacDMark'),
    sacDSource: sourceFor(row, 'sacDMark'),
    conferenceSource: sourceFor(row, 'conference'),
    ndaaConferenceSource: sourceFor(row, 'ndaaConference'),
    rawEnacted: row.enacted,
  };
}

export function TooltipContent({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartPoint }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const first = payload[0];
  if (!first) return null;
  const d = first.payload;
  if (!d) return null;

  return (
    <Card size="small" styles={{ body: { padding: 10, minWidth: 250 } }}>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Text strong>FY {d.fy}</Text>
        <TooltipRow label="Request" value={d.request} source={d.requestSource} />
        <TooltipRow label="HASC" value={d.hascMark} source={d.hascSource} />
        <TooltipRow label="SASC" value={d.sascMark} source={d.sascSource} />
        <TooltipRow label="HAC-D" value={d.hacDMark} source={d.hacDSource} />
        <TooltipRow label="SAC-D" value={d.sacDMark} source={d.sacDSource} />
        <TooltipRow
          label="NDAA Conf. (auth.)"
          value={d.ndaaConference}
          source={d.ndaaConferenceSource}
        />
        <TooltipRow
          label="Conference (approps.)"
          value={d.conference}
          source={d.conferenceSource}
        />
        <TooltipRow
          label={d.projected ? 'Enacted (Projected)' : 'Enacted'}
          value={d.rawEnacted ?? d.request}
          source={d.enactedSource}
        />
      </Space>
    </Card>
  );
}

function TooltipRow({
  label,
  value,
  source,
}: {
  label: string;
  value: number | null;
  source: string;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <Text type="secondary">{label}</Text>
      <Space size={6}>
        <Text>{dollars2(value)}</Text>
        <Text type="secondary">[{source}]</Text>
      </Space>
    </div>
  );
}

function RealizationRateLabel({ rows }: { rows: ProgramElementHistoryRow[] }) {
  const pct = useMemo(() => {
    // Only compare years where BOTH a request and an enacted figure exist — those
    // are the years where "did appropriators add to / cut the request" is a real
    // question. Mixing years that have only one or the other produced a meaningless
    // number before. If no year has both, there's no realization rate to show.
    const comparable = rows.filter((r) => r.request != null && r.enacted != null);
    const baseline = comparable.reduce((acc, r) => acc + (r.request ?? 0), 0);
    const enacted = comparable.reduce((acc, r) => acc + (r.enacted ?? 0), 0);
    if (baseline === 0) return null;
    return ((enacted - baseline) / baseline) * 100;
  }, [rows]);

  if (pct == null) {
    return (
      <span className="pe-winrate" data-testid="pe-win-rate-label">
        Realization rate (5y) <b>n/a</b> over request
      </span>
    );
  }
  const sign = pct >= 0 ? '+' : '';
  return (
    <span className="pe-winrate" data-testid="pe-win-rate-label">
      Realization rate (5y){' '}
      <b className={pct >= 0 ? 'pe-pos' : 'pe-neg'}>
        {sign}
        {pct.toFixed(1)}%
      </b>{' '}
      over request
    </span>
  );
}

export function FyHistoryChart({ rows, loading = false, onFyClick }: FyHistoryChartProps) {
  const data = useMemo(() => [...rows].sort((a, b) => a.fy - b.fy).map(toChartPoint), [rows]);

  if (loading) {
    return (
      <Card title="Timeline">
        <Skeleton active paragraph={{ rows: 6 }} />
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card title="Funding timeline">
        <Empty description="No FY history yet" />
      </Card>
    );
  }

  return (
    <Card
      className="pe-chart-card"
      title="Funding timeline"
      extra={<RealizationRateLabel rows={rows} />}
    >
      <div style={{ width: '100%', height: 420, minWidth: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 20, right: 20, left: 20, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e6e1d6" vertical={false} />
            <XAxis
              dataKey="fy"
              tickFormatter={(v) => `FY ${v}`}
              tick={{ fill: '#8a8780', fontSize: 12 }}
              axisLine={{ stroke: '#d8d2c4' }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={dollarsTick}
              tick={{ fill: '#8a8780', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<TooltipContent />} cursor={{ fill: 'rgba(42,87,206,0.06)' }} />
            <Bar
              dataKey="funding"
              name="Funding"
              radius={[3, 3, 0, 0]}
              onClick={(state) => {
                const entry = state as { fy?: number } | null;
                if (entry && typeof entry.fy === 'number') {
                  onFyClick?.(entry.fy);
                }
              }}
              shape={(props: unknown) => {
                if (!props || typeof props !== 'object') return null;
                const candidate = props as {
                  x?: number;
                  y?: number;
                  width?: number;
                  height?: number;
                  payload?: ChartPoint;
                };
                if (
                  typeof candidate.x !== 'number' ||
                  typeof candidate.y !== 'number' ||
                  typeof candidate.width !== 'number' ||
                  typeof candidate.height !== 'number' ||
                  !candidate.payload
                ) {
                  return null;
                }
                const { x, y, width, height, payload } = candidate;
                // Color encodes the funding stage so a single continuous bar per FY
                // stays honest about whether the number is enacted vs requested vs
                // pending: enacted = solid blue, conference = mid blue, requested =
                // light blue, pending/projected = beige with a "Pending" caption.
                const fillByStage: Record<ChartPoint['fundingStage'], string> = {
                  Enacted: '#2a57ce',
                  Conference: '#5b7fd6',
                  Committee: '#7b9be0',
                  Requested: '#9db8ff',
                  Pending: '#d8d2c4',
                };
                const fill = fillByStage[payload.fundingStage];
                return (
                  <g>
                    <rect x={x} y={y} width={width} height={height} rx={3} ry={3} fill={fill} />
                    {payload.fundingStage === 'Pending' ? (
                      <text
                        x={x + width / 2}
                        y={Math.max(y - 6, 12)}
                        textAnchor="middle"
                        fontSize={10}
                        fill="#8a8780"
                      >
                        Pending
                      </text>
                    ) : null}
                  </g>
                );
              }}
            />
            <ReferenceLine y={0} stroke="#d8d2c4" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="pe-chart-foot">
        <div className="pe-chart-legend">
          <span className="pe-leg">
            <i style={{ background: '#9db8ff' }} />
            Request
          </span>
          <span className="pe-leg">
            <i style={{ background: '#7b9be0' }} />
            Committee mark
          </span>
          <span className="pe-leg">
            <i style={{ background: '#5b7fd6' }} />
            Conference
          </span>
          <span className="pe-leg">
            <i style={{ background: '#2a57ce' }} />
            Enacted
          </span>
          <span className="pe-leg">
            <i style={{ background: '#d8d2c4' }} />
            Pending
          </span>
        </div>
        <Button
          className="pe-latest-fy-btn"
          size="small"
          onClick={() => onFyClick?.(data[data.length - 1]?.fy ?? 0)}
        >
          Select latest FY
        </Button>
      </div>
    </Card>
  );
}
