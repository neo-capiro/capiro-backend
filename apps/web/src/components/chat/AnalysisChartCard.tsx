import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useApi } from '../../lib/use-api.js';
import './analysis-chart-card.css';

interface AnalysisChartCardProps {
  artifactId: string;
  title: string;
}

type ChartType =
  | 'line'
  | 'area'
  | 'bar'
  | 'stacked_bar'
  | 'scatter'
  | 'pie'
  | 'waterfall'
  | 'heatmap'
  | 'timeline';

type ValueFormat = 'raw' | 'integer' | 'compact' | 'currency' | 'percent';
type Row = Record<string, string | number | null>;

interface SeriesSpec {
  dataKey: string;
  label?: string;
  valueFormat?: ValueFormat;
  valuePrefix?: string;
  valueSuffix?: string;
  stackId?: string;
}

interface VisualizationSpec {
  version: 1;
  chartType: ChartType;
  title: string;
  insight?: string;
  description?: string;
  footer?: string;
  xKey?: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  layout?: 'horizontal' | 'vertical';
  series?: SeriesSpec[];
  nameKey?: string;
  valueKey?: string;
  heatmap?: { rowKey: string; columnKey: string; valueKey: string };
  timeline?: { labelKey: string; startKey: string; endKey?: string; groupKey?: string };
  data: Row[];
}

interface DatasetSummary {
  name: string;
  rowCount: number;
}

interface ArtifactProvenance {
  evidence: 'derived';
  generatedAt: string;
  datasetCount: number;
  rowCount: number;
  datasets: DatasetSummary[];
}

interface ArtifactResponse {
  id: string;
  title: string;
  visualization: VisualizationSpec | null;
  imageAvailable: boolean;
  provenance: ArtifactProvenance;
}

type ViewMode = 'chart' | 'data' | 'image';

// Capiro Design System v2 chart palette: ink is primary, graphite/slate are
// supporting series, rust is an accent rather than the default control colour.
const COLORS = ['#131A24', '#263243', '#96A1B4', '#B6BFCC', '#A85F42', '#C3CBD7'];
const POSITIVE = '#2F6B4F';
const NEGATIVE = '#A32B23';
const GRID = '#EAEDF1';
const MUTED = '#636C7A';
const BODY = '#48525F';
const INK = '#131A24';
const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Consolas, monospace';

const tooltipStyle = {
  border: '1px solid #C3CBD7',
  borderRadius: 0,
  boxShadow: '0 8px 24px rgba(19, 26, 36, 0.10)',
  color: INK,
  background: '#FFFFFF',
  fontFamily: '"Hanken Grotesk", ui-sans-serif, system-ui, sans-serif',
  fontSize: 12,
};

const monoTick = { fill: MUTED, fontFamily: MONO, fontSize: 11 };

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatValue(value: unknown, series?: SeriesSpec): string {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return String(value);
  const format = series?.valueFormat ?? 'raw';
  let formatted: string;
  if (format === 'integer') {
    formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  } else if (format === 'compact') {
    formatted = new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  } else if (format === 'currency') {
    formatted = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: Math.abs(value) < 1000 ? 1 : 0,
    }).format(value);
  } else if (format === 'percent') {
    formatted = `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
  } else {
    formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  }
  return `${series?.valuePrefix ?? ''}${formatted}${series?.valueSuffix ?? ''}`;
}

/**
 * Spreadsheet programs may interpret a CSV string beginning with =, +, -, @,
 * tab or CR/LF as a formula. Numeric values remain numeric; only string cells
 * are neutralized with the conventional leading apostrophe before CSV quoting.
 */
export function neutralizeAnalysisCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (typeof value !== 'string') return text;
  return /^(?:[\t\r\n ]*[=+\-@]|[\t\r\n])/.test(text) ? `'${text}` : text;
}

export function escapeAnalysisCsvCell(value: unknown): string {
  const text = neutralizeAnalysisCsvCell(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildAnalysisCsv(data: Row[]): string {
  const columns = [...new Set(data.flatMap((row) => Object.keys(row)))];
  return [
    columns.map(escapeAnalysisCsvCell).join(','),
    ...data.map((row) => columns.map((column) => escapeAnalysisCsvCell(row[column])).join(',')),
  ].join('\n');
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'analysis'
  );
}

function chartTypeLabel(type: ChartType): string {
  return type.replace(/_/g, ' ').toUpperCase();
}

function axisTick(value: unknown, spec: VisualizationSpec): string {
  const first = spec.series?.[0];
  return typeof value === 'number' ? formatValue(value, first) : String(value ?? '');
}

function formatGeneratedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(date)
    .toUpperCase();
}

function provenanceInputs(provenance: ArtifactProvenance | undefined): string {
  const names = provenance?.datasets.map((dataset) => dataset.name).filter(Boolean) ?? [];
  if (!names.length) return 'AUTHORIZED RETRIEVAL';
  if (names.length <= 2) return names.join(' · ').toUpperCase();
  return `${names.slice(0, 2).join(' · ').toUpperCase()} · +${names.length - 2}`;
}

function StandardTooltip({ spec }: { spec: VisualizationSpec }) {
  return (
    <Tooltip
      contentStyle={tooltipStyle}
      labelStyle={{ color: INK, fontWeight: 700 }}
      formatter={(value: unknown, name: unknown) => {
        const series = spec.series?.find(
          (candidate) => candidate.dataKey === String(name) || candidate.label === String(name),
        );
        return [formatValue(value, series), series?.label ?? String(name)];
      }}
    />
  );
}

function CartesianAxes({
  spec,
  vertical = false,
}: {
  spec: VisualizationSpec;
  vertical?: boolean;
}) {
  if (vertical) {
    return (
      <>
        <XAxis
          type="number"
          tick={monoTick}
          axisLine={{ stroke: '#C3CBD7' }}
          tickLine={false}
          tickFormatter={(value) => axisTick(value, spec)}
          label={
            spec.yAxisLabel
              ? {
                  value: spec.yAxisLabel,
                  position: 'insideBottom',
                  offset: -4,
                  fill: MUTED,
                  fontFamily: MONO,
                  fontSize: 11,
                }
              : undefined
          }
        />
        <YAxis
          type="category"
          dataKey={spec.xKey}
          width={126}
          tick={monoTick}
          axisLine={false}
          tickLine={false}
        />
      </>
    );
  }
  return (
    <>
      <XAxis
        dataKey={spec.xKey}
        tick={monoTick}
        axisLine={{ stroke: '#C3CBD7' }}
        tickLine={false}
        minTickGap={16}
        label={
          spec.xAxisLabel
            ? {
                value: spec.xAxisLabel,
                position: 'insideBottom',
                offset: -4,
                fill: MUTED,
                fontFamily: MONO,
                fontSize: 11,
              }
            : undefined
        }
      />
      <YAxis
        tick={monoTick}
        axisLine={false}
        tickLine={false}
        width={72}
        tickFormatter={(value) => axisTick(value, spec)}
        label={
          spec.yAxisLabel
            ? {
                value: spec.yAxisLabel,
                angle: -90,
                position: 'insideLeft',
                fill: MUTED,
                fontFamily: MONO,
                fontSize: 11,
              }
            : undefined
        }
      />
    </>
  );
}

function InteractiveCartesian({
  spec,
  visibleSeries,
}: {
  spec: VisualizationSpec;
  visibleSeries: Set<string>;
}) {
  const series = (spec.series ?? []).filter((item) => visibleSeries.has(item.dataKey));
  const common = {
    data: spec.data,
    margin: { top: 12, right: 20, bottom: 22, left: 4 },
  };

  if (spec.chartType === 'line') {
    return (
      <ResponsiveContainer width="100%" height={330}>
        <LineChart {...common}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <CartesianAxes spec={spec} />
          <StandardTooltip spec={spec} />
          {series.map((item, index) => (
            <Line
              key={item.dataKey}
              type="linear"
              dataKey={item.dataKey}
              name={item.label ?? item.dataKey}
              stroke={COLORS[index % COLORS.length]}
              strokeWidth={2}
              dot={{ r: 3, strokeWidth: 0 }}
              activeDot={{ r: 5 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (spec.chartType === 'area') {
    return (
      <ResponsiveContainer width="100%" height={330}>
        <AreaChart {...common}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <CartesianAxes spec={spec} />
          <StandardTooltip spec={spec} />
          {series.map((item, index) => (
            <Area
              key={item.dataKey}
              type="linear"
              dataKey={item.dataKey}
              name={item.label ?? item.dataKey}
              stroke={COLORS[index % COLORS.length]}
              fill={COLORS[index % COLORS.length]}
              fillOpacity={0.12}
              strokeWidth={2}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  const vertical = spec.layout === 'vertical';
  return (
    <ResponsiveContainer
      width="100%"
      height={Math.max(330, vertical ? spec.data.length * 34 : 330)}
    >
      <BarChart {...common} layout={vertical ? 'vertical' : 'horizontal'}>
        <CartesianGrid stroke={GRID} vertical={!vertical} horizontal={vertical} />
        <CartesianAxes spec={spec} vertical={vertical} />
        <StandardTooltip spec={spec} />
        <ReferenceLine {...(vertical ? { x: 0 } : { y: 0 })} stroke="#48525F" />
        {series.map((item, index) => (
          <Bar
            key={item.dataKey}
            dataKey={item.dataKey}
            name={item.label ?? item.dataKey}
            stackId={spec.chartType === 'stacked_bar' ? (item.stackId ?? 'stack') : undefined}
            fill={COLORS[index % COLORS.length]}
            radius={0}
            maxBarSize={42}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

function ScatterVisual({
  spec,
  visibleSeries,
}: {
  spec: VisualizationSpec;
  visibleSeries: Set<string>;
}) {
  const series = (spec.series ?? []).filter((item) => visibleSeries.has(item.dataKey));
  return (
    <ResponsiveContainer width="100%" height={340}>
      <ScatterChart margin={{ top: 12, right: 20, bottom: 24, left: 8 }}>
        <CartesianGrid stroke={GRID} />
        <XAxis
          type="number"
          dataKey="x"
          name={spec.xAxisLabel ?? spec.xKey}
          tick={monoTick}
          axisLine={{ stroke: '#C3CBD7' }}
          tickLine={false}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={spec.yAxisLabel ?? 'Value'}
          tick={monoTick}
          axisLine={false}
          tickLine={false}
          width={72}
        />
        <Tooltip
          cursor={{ stroke: '#96A1B4', strokeDasharray: '3 3' }}
          contentStyle={tooltipStyle}
          formatter={(value: unknown, name: unknown) => [formatValue(value), String(name)]}
        />
        {series.map((item, index) => (
          <Scatter
            key={item.dataKey}
            name={item.label ?? item.dataKey}
            fill={COLORS[index % COLORS.length]}
            isAnimationActive={false}
            data={spec.data
              .map((row) => ({
                x: safeNumber(row[spec.xKey ?? '']),
                y: safeNumber(row[item.dataKey]),
                label: row.label ?? row.name ?? row[spec.xKey ?? ''],
              }))
              .filter((row) => row.x !== null && row.y !== null)}
          />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  );
}

function PieVisual({ spec }: { spec: VisualizationSpec }) {
  const nameKey = spec.nameKey ?? '';
  const valueKey = spec.valueKey ?? '';
  const data = spec.data.filter((row) => typeof row[valueKey] === 'number').slice(0, 6);
  return (
    <div className="analysis-pie-layout">
      <div className="analysis-pie-chart">
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value: unknown) => formatValue(value)}
            />
            <Pie
              data={data}
              dataKey={valueKey}
              nameKey={nameKey}
              cx="50%"
              cy="50%"
              outerRadius={104}
              innerRadius={54}
              paddingAngle={0}
              isAnimationActive={false}
            >
              {data.map((row, index) => (
                <Cell
                  key={`${String(row[nameKey])}-${index}`}
                  fill={COLORS[index % COLORS.length]}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="analysis-pie-legend" aria-label="Chart legend">
        {data.map((row, index) => (
          <div key={`${String(row[nameKey])}-${index}`}>
            <span style={{ backgroundColor: COLORS[index % COLORS.length] }} aria-hidden="true" />
            <strong>{String(row[nameKey])}</strong>
            <em>{formatValue(row[valueKey])}</em>
            <b title="Derived analysis">◆</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function WaterfallVisual({ spec }: { spec: VisualizationSpec }) {
  const item = spec.series?.[0];
  if (!item || !spec.xKey) return null;
  let running = 0;
  const data = spec.data.flatMap((row) => {
    const delta = safeNumber(row[item.dataKey]);
    if (delta === null) return [];
    const next = running + delta;
    const start = Math.min(running, next);
    const result = {
      ...row,
      __base: start,
      __height: Math.abs(delta),
      __delta: delta,
      __total: next,
    };
    running = next;
    return [result];
  });
  return (
    <ResponsiveContainer width="100%" height={340}>
      <BarChart data={data} margin={{ top: 12, right: 20, bottom: 24, left: 8 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={spec.xKey} tick={monoTick} axisLine={{ stroke: BODY }} tickLine={false} />
        <YAxis
          tick={monoTick}
          axisLine={false}
          tickLine={false}
          width={72}
          tickFormatter={(value) => formatValue(value, item)}
        />
        <ReferenceLine y={0} stroke={BODY} />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(_value: unknown, name: unknown, tooltipItem: unknown) => {
            const payload = (tooltipItem as { payload?: Row } | undefined)?.payload;
            if (String(name) === '__height') {
              return [formatValue(payload?.__delta, item), item.label ?? 'Change'];
            }
            return [formatValue(payload?.__total, item), 'Running total'];
          }}
        />
        <Bar dataKey="__base" stackId="waterfall" fill="transparent" isAnimationActive={false} />
        <Bar
          dataKey="__height"
          stackId="waterfall"
          name={item.label ?? 'Change'}
          radius={0}
          isAnimationActive={false}
        >
          {data.map((row, index) => (
            <Cell
              key={`${String((row as Row)[spec.xKey ?? ''])}-${index}`}
              fill={Number(row.__delta) >= 0 ? POSITIVE : NEGATIVE}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function HeatmapVisual({ spec }: { spec: VisualizationSpec }) {
  const mapping = spec.heatmap;
  if (!mapping) return null;
  const rows = [...new Set(spec.data.map((item) => String(item[mapping.rowKey] ?? '')))].filter(
    Boolean,
  );
  const columns = [
    ...new Set(spec.data.map((item) => String(item[mapping.columnKey] ?? ''))),
  ].filter(Boolean);
  const values = spec.data
    .map((item) => safeNumber(item[mapping.valueKey]))
    .filter((value): value is number => value !== null);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const byCell = new Map(
    spec.data.map((item) => [
      `${String(item[mapping.rowKey])}\u0000${String(item[mapping.columnKey])}`,
      safeNumber(item[mapping.valueKey]),
    ]),
  );
  return (
    <div
      className="analysis-heatmap"
      style={{
        gridTemplateColumns: `minmax(130px, 1.2fr) repeat(${columns.length}, minmax(78px, 1fr))`,
      }}
      role="table"
      aria-label={spec.title}
    >
      <div className="analysis-heatmap-corner" role="columnheader" />
      {columns.map((column) => (
        <div className="analysis-heatmap-column" role="columnheader" key={column}>
          {column}
        </div>
      ))}
      {rows.flatMap((row) => [
        <div className="analysis-heatmap-row" role="rowheader" key={`${row}-label`}>
          {row}
        </div>,
        ...columns.map((column) => {
          const value = byCell.get(`${row}\u0000${column}`) ?? null;
          const ratio = value === null || max === min ? 0 : (value - min) / (max - min);
          return (
            <div
              className={`analysis-heatmap-cell${value === null ? ' is-missing' : ''}`}
              role="cell"
              key={`${row}-${column}`}
              title={
                value === null
                  ? `${row} · ${column}: no value available`
                  : `${row} · ${column}: ${formatValue(value)}`
              }
              style={
                value === null
                  ? undefined
                  : {
                      backgroundColor: `rgba(168, 95, 66, ${0.1 + ratio * 0.78})`,
                      color: ratio > 0.58 ? '#FFFFFF' : INK,
                    }
              }
            >
              {value === null ? '—' : formatValue(value)}
            </div>
          );
        }),
      ])}
    </div>
  );
}

function TimelineVisual({ spec }: { spec: VisualizationSpec }) {
  const mapping = spec.timeline;
  if (!mapping) return null;
  const items = [...spec.data].sort((a, b) =>
    String(a[mapping.startKey] ?? '').localeCompare(String(b[mapping.startKey] ?? '')),
  );
  return (
    <ol className="analysis-timeline" aria-label={spec.title}>
      {items.map((item, index) => {
        const label = String(item[mapping.labelKey] ?? `Event ${index + 1}`);
        const start = String(item[mapping.startKey] ?? '');
        const end = mapping.endKey ? String(item[mapping.endKey] ?? '') : '';
        const group = mapping.groupKey ? String(item[mapping.groupKey] ?? '') : '';
        return (
          <li key={`${label}-${start}-${index}`}>
            <span className="analysis-timeline-marker" aria-hidden="true" />
            <div>
              {group ? <small>{group}</small> : null}
              <strong>{label}</strong>
              <span>{end && end !== start ? `${start} → ${end}` : start}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function InteractiveVisual({
  spec,
  visibleSeries,
}: {
  spec: VisualizationSpec;
  visibleSeries: Set<string>;
}) {
  switch (spec.chartType) {
    case 'line':
    case 'area':
    case 'bar':
    case 'stacked_bar':
      return <InteractiveCartesian spec={spec} visibleSeries={visibleSeries} />;
    case 'scatter':
      return <ScatterVisual spec={spec} visibleSeries={visibleSeries} />;
    case 'pie':
      return <PieVisual spec={spec} />;
    case 'waterfall':
      return <WaterfallVisual spec={spec} />;
    case 'heatmap':
      return <HeatmapVisual spec={spec} />;
    case 'timeline':
      return <TimelineVisual spec={spec} />;
  }
}

function DataTable({ spec }: { spec: VisualizationSpec }) {
  const columns = useMemo(
    () => [...new Set(spec.data.flatMap((row) => Object.keys(row)))].slice(0, 18),
    [spec.data],
  );
  const displayed = spec.data.slice(0, 100);
  const seriesByDataKey = useMemo(() => {
    const map = new Map<string, SeriesSpec>();
    for (const item of spec.series ?? []) {
      map.set(item.dataKey, item);
    }
    return map;
  }, [spec.series]);
  return (
    <div className="analysis-data-wrap">
      <table className="analysis-data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column.replace(/_/g, ' ')}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayed.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column}>{formatValue(row[column], seriesByDataKey.get(column))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {spec.data.length > displayed.length ? (
        <div className="analysis-data-note">
          Showing the first {displayed.length} of {spec.data.length} rows. Download CSV for all
          rows.
        </div>
      ) : null}
    </div>
  );
}

function ProvenanceStrip({ provenance }: { provenance: ArtifactProvenance | undefined }) {
  const when = provenance ? formatGeneratedAt(provenance.generatedAt) : '';
  return (
    <div className="analysis-provenance" aria-label="Analysis provenance">
      <span className="analysis-evidence">◆ DERIVED</span>
      <span>SOURCE DATA · {provenanceInputs(provenance)}</span>
      {provenance?.rowCount ? <span>{provenance.rowCount} ROWS</span> : null}
      {when ? <span>{when}</span> : null}
      <span className="analysis-provenance-citations">SOURCES · SEE MERI CITATIONS</span>
    </div>
  );
}

/**
 * Interactive MeriV3 analysis card. The visual language follows Capiro Design
 * System v2: Hanken Grotesk body, IBM Plex Mono metadata, square geometry,
 * persistent surfaces without elevation, ink-first controls, tabular values,
 * derived evidence marking, and a source line on every chart.
 */
export function AnalysisChartCard({ artifactId, title }: AnalysisChartCardProps) {
  const api = useApi();
  const [artifact, setArtifact] = useState<ArtifactResponse | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [metadataDone, setMetadataDone] = useState(false);
  const [imageDone, setImageDone] = useState(false);
  const [view, setView] = useState<ViewMode>('chart');
  const [expanded, setExpanded] = useState(false);
  const [visibleSeries, setVisibleSeries] = useState<Set<string>>(new Set());

  const spec = artifact?.visualization ?? null;
  const displayTitle = artifact?.title || title;
  const seriesKey = (spec?.series ?? []).map((item) => item.dataKey).join('|');

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setArtifact(null);
    setImageSrc(null);
    setImageBlob(null);
    setMetadataDone(false);
    setImageDone(false);

    void api
      .get<ArtifactResponse>(`/api/clio/analysis-artifacts/${artifactId}`)
      .then(({ data }) => {
        if (!cancelled) setArtifact(data);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setMetadataDone(true);
      });

    void api
      .get<Blob>(`/api/clio/analysis-artifacts/${artifactId}/image`, { responseType: 'blob' })
      .then(({ data }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(data);
        setImageBlob(data);
        setImageSrc(objectUrl);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setImageDone(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, artifactId]);

  useEffect(() => {
    setVisibleSeries(new Set((spec?.series ?? []).map((item) => item.dataKey)));
  }, [artifactId, seriesKey]);

  useEffect(() => {
    if (spec) setView('chart');
    else if (imageDone && imageSrc) setView('image');
  }, [spec, imageDone, imageSrc]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  const toggleSeries = (dataKey: string) => {
    setVisibleSeries((current) => {
      const next = new Set(current);
      if (next.has(dataKey)) {
        if (next.size > 1) next.delete(dataKey);
      } else {
        next.add(dataKey);
      }
      return next;
    });
  };

  const downloadCsv = () => {
    if (!spec?.data.length) return;
    const csv = buildAnalysisCsv(spec.data);
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${slug(displayTitle)}.csv`);
  };

  const downloadPng = () => {
    if (imageBlob) downloadBlob(imageBlob, `${slug(displayTitle)}.png`);
  };

  const loading = !metadataDone || !imageDone;
  const failed = metadataDone && imageDone && !spec && !imageSrc;
  const staticFallback = metadataDone && !spec && Boolean(imageSrc);

  const content = (
    <figure className="analysis-card" aria-label={displayTitle}>
      <header className="analysis-card-header">
        <div className="analysis-card-heading">
          <span className="analysis-card-eyebrow">
            ANALYSIS{spec ? ` · ${chartTypeLabel(spec.chartType)}` : ' · SAVED CHART'}
          </span>
          <h3>{displayTitle}</h3>
          {spec?.description ? <p>{spec.description}</p> : null}
        </div>
        <div className="analysis-card-actions">
          {spec ? (
            <>
              <button
                type="button"
                className={view === 'chart' ? 'is-active' : ''}
                onClick={() => setView('chart')}
              >
                CHART
              </button>
              <button
                type="button"
                className={view === 'data' ? 'is-active' : ''}
                onClick={() => setView('data')}
              >
                DATA
              </button>
            </>
          ) : null}
          {imageSrc ? (
            <button
              type="button"
              className={view === 'image' ? 'is-active' : ''}
              onClick={() => setView('image')}
            >
              IMAGE
            </button>
          ) : null}
          {spec ? (
            <button type="button" onClick={downloadCsv} title="Download data as CSV">
              CSV
            </button>
          ) : null}
          {imageBlob ? (
            <button type="button" onClick={downloadPng} title="Download canonical PNG">
              PNG
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            aria-label={expanded ? 'Close expanded chart' : 'Expand chart'}
          >
            {expanded ? 'CLOSE' : 'EXPAND'}
          </button>
        </div>
      </header>

      {spec?.insight ? (
        <div className="analysis-insight">
          <span>INSIGHT</span>
          <p>{spec.insight}</p>
        </div>
      ) : null}

      {spec?.series && spec.series.length > 1 && view === 'chart' ? (
        <div className="analysis-series-toggles" aria-label="Chart series">
          {spec.series.map((item, index) => (
            <button
              type="button"
              key={item.dataKey}
              aria-pressed={visibleSeries.has(item.dataKey)}
              onClick={() => toggleSeries(item.dataKey)}
            >
              <span
                className="analysis-series-marker"
                style={{ background: COLORS[index % COLORS.length] }}
                aria-hidden="true"
              />
              {item.label ?? item.dataKey}
              <b title="Derived analysis">◆</b>
            </button>
          ))}
        </div>
      ) : null}

      {staticFallback ? (
        <div className="analysis-fallback-note">
          INTERACTIVE VIEW UNAVAILABLE · SHOWING SAVED ANALYSIS IMAGE
        </div>
      ) : null}

      <div className="analysis-card-body">
        {loading && !spec && !imageSrc ? (
          <div className="analysis-card-loading" role="status" aria-label="Loading analysis visual">
            <span />
            LOADING ANALYSIS
          </div>
        ) : failed ? (
          <div className="analysis-card-error" role="status">
            ANALYSIS VISUAL UNAVAILABLE
          </div>
        ) : view === 'data' && spec ? (
          <DataTable spec={spec} />
        ) : view === 'image' && imageSrc ? (
          <img className="analysis-card-image" src={imageSrc} alt={displayTitle} />
        ) : spec ? (
          <InteractiveVisual spec={spec} visibleSeries={visibleSeries} />
        ) : imageSrc ? (
          <img className="analysis-card-image" src={imageSrc} alt={displayTitle} />
        ) : null}
      </div>

      <ProvenanceStrip provenance={artifact?.provenance} />
      {spec?.footer ? <figcaption>{spec.footer}</figcaption> : null}
    </figure>
  );

  return expanded ? (
    <div
      className="analysis-card-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={displayTitle}
    >
      {content}
    </div>
  ) : (
    content
  );
}
