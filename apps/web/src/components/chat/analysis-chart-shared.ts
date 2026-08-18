/**
 * analysis-chart-shared — UI-free contract + pure helpers behind the Meri
 * analysis chart cards on BOTH surfaces.
 *
 * The legacy card (AnalysisChartCard.tsx, analysis-chart-card.css) and the
 * vNext card (vnext/meri/MeriAnalysisChartCard.tsx, vNext tokens) render the
 * SAME artifact contract — GET /api/clio/analysis-artifacts/:id (+ /image) —
 * with the same value formatting and the same CSV escaping. Everything here is
 * pure data logic (no react, no recharts, no CSS) so the vNext surface can
 * share it without pulling the legacy stylesheet into its runtime graph.
 * AnalysisChartCard re-exports the CSV helpers so its existing consumers and
 * tests are unchanged.
 *
 * The CSV neutralization in particular is security-relevant (spreadsheet
 * formula injection) and must never fork between surfaces.
 */

export type ChartType =
  | 'line'
  | 'area'
  | 'bar'
  | 'stacked_bar'
  | 'scatter'
  | 'pie'
  | 'waterfall'
  | 'heatmap'
  | 'timeline';

export type ValueFormat = 'raw' | 'integer' | 'compact' | 'currency' | 'percent';
export type Row = Record<string, string | number | null>;

export interface SeriesSpec {
  dataKey: string;
  label?: string;
  valueFormat?: ValueFormat;
  valuePrefix?: string;
  valueSuffix?: string;
  stackId?: string;
}

export interface VisualizationSpec {
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

export interface DatasetSummary {
  name: string;
  rowCount: number;
}

export interface ArtifactProvenance {
  evidence: 'derived';
  generatedAt: string;
  datasetCount: number;
  rowCount: number;
  datasets: DatasetSummary[];
}

export interface ArtifactResponse {
  id: string;
  title: string;
  visualization: VisualizationSpec | null;
  imageAvailable: boolean;
  provenance: ArtifactProvenance;
}

export function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function formatValue(value: unknown, series?: SeriesSpec): string {
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

export function downloadAnalysisBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function analysisSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'analysis'
  );
}

export function chartTypeLabel(type: ChartType): string {
  return type.replace(/_/g, ' ').toUpperCase();
}

export function axisTick(value: unknown, spec: VisualizationSpec): string {
  const first = spec.series?.[0];
  return typeof value === 'number' ? formatValue(value, first) : String(value ?? '');
}

export function formatGeneratedAt(value: string): string {
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

export function provenanceInputs(provenance: ArtifactProvenance | undefined): string {
  const names = provenance?.datasets.map((dataset) => dataset.name).filter(Boolean) ?? [];
  if (!names.length) return 'AUTHORIZED RETRIEVAL';
  if (names.length <= 2) return names.join(' · ').toUpperCase();
  return `${names.slice(0, 2).join(' · ').toUpperCase()} · +${names.length - 2}`;
}
