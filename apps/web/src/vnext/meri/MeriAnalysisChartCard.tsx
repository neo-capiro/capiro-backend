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
import {
  analysisSlug,
  axisTick,
  buildAnalysisCsv,
  chartTypeLabel,
  downloadAnalysisBlob,
  formatGeneratedAt,
  formatValue,
  provenanceInputs,
  safeNumber,
  type ArtifactProvenance,
  type ArtifactResponse,
  type Row,
  type SeriesSpec,
  type VisualizationSpec,
} from '../../components/chat/analysis-chart-shared.js';
import { MeriIcon } from './meri-icons.js';
import './meri-analysis-chart-card.css';

/**
 * MeriAnalysisChartCard — the live analysis-artifact card in the vNext Meri
 * thread. Re-skin of components/chat/AnalysisChartCard.tsx: identical props,
 * endpoints (GET /api/clio/analysis-artifacts/:id and .../image), view modes,
 * series toggling, CSV/PNG downloads and fallback ladder — only the
 * presentation moves to the v4 Meri visual language (white surface with the
 * hairline chip ring, Plex Mono eyebrows, INSIGHT strip, DERIVED provenance
 * footer — the same language as the MeriAnalysisCard prototype fixture).
 * The legacy card keeps serving app.capiro.ai; this one exists so the os
 * surface stops importing analysis-chart-card.css at runtime. The artifact
 * contract and the pure helpers (value formats, CSV neutralization) are the
 * SAME module both cards import — analysis-chart-shared — so the surfaces
 * cannot drift on data handling.
 */

interface MeriAnalysisChartCardProps {
  artifactId: string;
  title: string;
}

type ViewMode = 'chart' | 'data' | 'image';

/* v4 Meri chart palette — ink-first Untitled-UI grays with the module's
   rust accent last (series colors in the v4 analysis fixture are ink and
   gray-400). Waterfall deltas reuse the module's success/error text colors. */
const COLORS = ['#101828', '#98A2B3', '#475467', '#D0D5DD', '#B54708', '#667085'];
const POSITIVE = '#027A48';
const NEGATIVE = '#B42318';
const GRID = '#EAECF0';
const MUTED = '#667085';
const BODY = '#344054';
const INK = '#101828';
const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";
const SANS = "var(--meri-font-sans, Inter, sans-serif)";

const tooltipStyle = {
  border: '1px solid #EAECF0',
  borderRadius: 8,
  boxShadow: '0 12px 16px -4px rgba(16, 24, 40, 0.08)',
  color: INK,
  background: '#FFFFFF',
  fontFamily: SANS,
  fontSize: 12,
};

const monoTick = { fill: MUTED, fontFamily: MONO, fontSize: 11 };

function StandardTooltip({ spec }: { spec: VisualizationSpec }) {
  return (
    <Tooltip
      contentStyle={tooltipStyle}
      labelStyle={{ color: INK, fontWeight: 600 }}
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
          axisLine={{ stroke: '#D0D5DD' }}
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
        axisLine={{ stroke: '#D0D5DD' }}
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
        <ReferenceLine {...(vertical ? { x: 0 } : { y: 0 })} stroke={BODY} />
        {series.map((item, index) => (
          <Bar
            key={item.dataKey}
            dataKey={item.dataKey}
            name={item.label ?? item.dataKey}
            stackId={spec.chartType === 'stacked_bar' ? (item.stackId ?? 'stack') : undefined}
            fill={COLORS[index % COLORS.length]}
            radius={vertical ? [0, 3, 3, 0] : [3, 3, 0, 0]}
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
          axisLine={{ stroke: '#D0D5DD' }}
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
          cursor={{ stroke: '#98A2B3', strokeDasharray: '3 3' }}
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
    <div className="meri-acc-pie-layout">
      <div className="meri-acc-pie-chart">
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
      <div className="meri-acc-pie-legend" aria-label="Chart legend">
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
      className="meri-acc-heatmap"
      style={{
        gridTemplateColumns: `minmax(130px, 1.2fr) repeat(${columns.length}, minmax(78px, 1fr))`,
      }}
      role="table"
      aria-label={spec.title}
    >
      <div className="meri-acc-heatmap-corner" role="columnheader" />
      {columns.map((column) => (
        <div className="meri-acc-heatmap-column" role="columnheader" key={column}>
          {column}
        </div>
      ))}
      {rows.flatMap((row) => [
        <div className="meri-acc-heatmap-row" role="rowheader" key={`${row}-label`}>
          {row}
        </div>,
        ...columns.map((column) => {
          const value = byCell.get(`${row}\u0000${column}`) ?? null;
          const ratio = value === null || max === min ? 0 : (value - min) / (max - min);
          return (
            <div
              className={`meri-acc-heatmap-cell${value === null ? ' is-missing' : ''}`}
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
                      backgroundColor: `rgba(16, 24, 40, ${0.08 + ratio * 0.72})`,
                      color: ratio > 0.55 ? '#FFFFFF' : INK,
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
    <ol className="meri-acc-timeline" aria-label={spec.title}>
      {items.map((item, index) => {
        const label = String(item[mapping.labelKey] ?? `Event ${index + 1}`);
        const start = String(item[mapping.startKey] ?? '');
        const end = mapping.endKey ? String(item[mapping.endKey] ?? '') : '';
        const group = mapping.groupKey ? String(item[mapping.groupKey] ?? '') : '';
        return (
          <li key={`${label}-${start}-${index}`}>
            <span className="meri-acc-timeline-marker" aria-hidden="true" />
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
    <div className="meri-acc-data-wrap">
      <table className="meri-acc-data-table">
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
        <div className="meri-acc-data-note">
          SHOWING THE FIRST {displayed.length} OF {spec.data.length} ROWS · DOWNLOAD CSV FOR ALL
          ROWS
        </div>
      ) : null}
    </div>
  );
}

function ProvenanceStrip({ provenance }: { provenance: ArtifactProvenance | undefined }) {
  const when = provenance ? formatGeneratedAt(provenance.generatedAt) : '';
  return (
    <div className="meri-acc-provenance" aria-label="Analysis provenance">
      <span className="meri-acc-provenance-derived">
        <MeriIcon name="Diamond01" size={10} color={INK} />
        DERIVED
      </span>
      <span>SOURCE DATA · {provenanceInputs(provenance)}</span>
      {provenance?.rowCount ? <span>{provenance.rowCount} ROWS</span> : null}
      {when ? <span>GENERATED {when}</span> : null}
      <span>SOURCES · SEE MERI CITATIONS</span>
    </div>
  );
}

export function MeriAnalysisChartCard({ artifactId, title }: MeriAnalysisChartCardProps) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    downloadAnalysisBlob(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      `${analysisSlug(displayTitle)}.csv`,
    );
  };

  const downloadPng = () => {
    if (imageBlob) downloadAnalysisBlob(imageBlob, `${analysisSlug(displayTitle)}.png`);
  };

  const loading = !metadataDone || !imageDone;
  const failed = metadataDone && imageDone && !spec && !imageSrc;
  const staticFallback = metadataDone && !spec && Boolean(imageSrc);

  const content = (
    <figure className="meri-acc-card" aria-label={displayTitle}>
      <header className="meri-acc-header">
        <div className="meri-acc-heading">
          <span className="meri-acc-eyebrow">
            ANALYSIS{spec ? ` · ${chartTypeLabel(spec.chartType)}` : ' · SAVED CHART'}
          </span>
          <h3>{displayTitle}</h3>
          {spec?.description ? <p>{spec.description}</p> : null}
        </div>
        <div className="meri-acc-actions">
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
        <div className="meri-acc-insight">
          <span>INSIGHT · </span>
          <span>{spec.insight}</span>
        </div>
      ) : null}

      {spec?.series && spec.series.length > 1 && view === 'chart' ? (
        <div className="meri-acc-series-toggles" aria-label="Chart series">
          {spec.series.map((item, index) => (
            <button
              type="button"
              key={item.dataKey}
              aria-pressed={visibleSeries.has(item.dataKey)}
              onClick={() => toggleSeries(item.dataKey)}
            >
              <span
                className="meri-acc-series-marker"
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
        <div className="meri-acc-fallback-note">
          INTERACTIVE VIEW UNAVAILABLE · SHOWING SAVED ANALYSIS IMAGE
        </div>
      ) : null}

      <div className="meri-acc-body">
        {loading && !spec && !imageSrc ? (
          <div className="meri-acc-loading" role="status" aria-label="Loading analysis visual">
            <span />
            LOADING ANALYSIS
          </div>
        ) : failed ? (
          <div className="meri-acc-error" role="status">
            ANALYSIS VISUAL UNAVAILABLE
          </div>
        ) : view === 'data' && spec ? (
          <DataTable spec={spec} />
        ) : view === 'image' && imageSrc ? (
          <img className="meri-acc-image" src={imageSrc} alt={displayTitle} />
        ) : spec ? (
          <InteractiveVisual spec={spec} visibleSeries={visibleSeries} />
        ) : imageSrc ? (
          <img className="meri-acc-image" src={imageSrc} alt={displayTitle} />
        ) : null}
      </div>

      <ProvenanceStrip provenance={artifact?.provenance} />
      {spec?.footer ? <figcaption>{spec.footer}</figcaption> : null}
    </figure>
  );

  return expanded ? (
    <div className="meri-acc-overlay" role="dialog" aria-modal="true" aria-label={displayTitle}>
      {content}
    </div>
  ) : (
    content
  );
}
