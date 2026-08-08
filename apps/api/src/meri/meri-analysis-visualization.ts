export const ANALYSIS_VISUALIZATION_VERSION = 1 as const;

export const ANALYSIS_CHART_TYPES = [
  'line',
  'area',
  'bar',
  'stacked_bar',
  'scatter',
  'pie',
  'waterfall',
  'heatmap',
  'timeline',
] as const;

export type AnalysisChartType = (typeof ANALYSIS_CHART_TYPES)[number];
export type AnalysisValueFormat = 'raw' | 'integer' | 'compact' | 'currency' | 'percent';

export interface AnalysisSeriesSpec {
  dataKey: string;
  label?: string;
  valueFormat?: AnalysisValueFormat;
  valuePrefix?: string;
  valueSuffix?: string;
  stackId?: string;
}

export interface AnalysisVisualizationSpec {
  version: typeof ANALYSIS_VISUALIZATION_VERSION;
  chartType: AnalysisChartType;
  /** Design-system rule: this is a decision-useful claim, not “Chart of …”. */
  title: string;
  /** Optional one-line takeaway shown as a restrained INSIGHT treatment. */
  insight?: string;
  description?: string;
  footer?: string;
  xKey?: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  layout?: 'horizontal' | 'vertical';
  series?: AnalysisSeriesSpec[];
  nameKey?: string;
  valueKey?: string;
  heatmap?: { rowKey: string; columnKey: string; valueKey: string };
  timeline?: { labelKey: string; startKey: string; endKey?: string; groupKey?: string };
  data: Array<Record<string, string | number | null>>;
}

const MAX_VISUALS = 6;
const MAX_ROWS = 500;
const MAX_KEYS_PER_ROW = 18;
const MAX_SERIES = 6;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-][0-2]\d:[0-5]\d)?)?$/;
const VALUE_FORMATS = new Set<AnalysisValueFormat>([
  'raw',
  'integer',
  'compact',
  'currency',
  'percent',
]);
const CHART_TYPES = new Set<AnalysisChartType>(ANALYSIS_CHART_TYPES);

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function key(value: unknown): string | undefined {
  const candidate = text(value, 64);
  return candidate && KEY_RE.test(candidate) ? candidate : undefined;
}

function rowValue(value: unknown): string | number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 240);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return undefined;
}

function rows(value: unknown): Array<Record<string, string | number | null>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, string | number | null>> = [];
  for (const raw of value.slice(0, MAX_ROWS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const normalized: Record<string, string | number | null> = {};
    for (const [rawKey, rawValue] of Object.entries(raw).slice(0, MAX_KEYS_PER_ROW)) {
      if (!KEY_RE.test(rawKey)) continue;
      const value = rowValue(rawValue);
      if (value !== undefined) normalized[rawKey] = value;
    }
    if (Object.keys(normalized).length) out.push(normalized);
  }
  return out;
}

function series(value: unknown): AnalysisSeriesSpec[] {
  if (!Array.isArray(value)) return [];
  const out: AnalysisSeriesSpec[] = [];
  for (const raw of value.slice(0, MAX_SERIES)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const dataKey = key(item.dataKey);
    if (!dataKey) continue;
    const spec: AnalysisSeriesSpec = { dataKey };
    const label = text(item.label, 100);
    const valuePrefix = text(item.valuePrefix, 12);
    const valueSuffix = text(item.valueSuffix, 12);
    const stackId = key(item.stackId);
    if (label) spec.label = label;
    if (VALUE_FORMATS.has(item.valueFormat as AnalysisValueFormat)) {
      spec.valueFormat = item.valueFormat as AnalysisValueFormat;
    }
    if (valuePrefix) spec.valuePrefix = valuePrefix;
    if (valueSuffix) spec.valueSuffix = valueSuffix;
    if (stackId) spec.stackId = stackId;
    out.push(spec);
  }
  return out;
}

function requiredKeysPresent(
  data: Array<Record<string, string | number | null>>,
  keys: string[],
): boolean {
  if (!data.length) return false;
  return keys.every((required) => data.some((row) => Object.hasOwn(row, required)));
}

/**
 * Missing/null observations are allowed. Any present, non-null observation in
 * a quantitative column must be a finite number. This prevents one valid row
 * from legitimizing prose values such as "$10M" elsewhere in the same series.
 */
function numericColumnValid(
  data: Array<Record<string, string | number | null>>,
  dataKey: string,
): boolean {
  let foundNumber = false;
  for (const row of data) {
    if (!Object.hasOwn(row, dataKey) || row[dataKey] === null) continue;
    const value = row[dataKey];
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    foundNumber = true;
  }
  return foundNumber;
}

function numericSeriesValid(
  data: Array<Record<string, string | number | null>>,
  chartSeries: AnalysisSeriesSpec[],
): boolean {
  return chartSeries.every((item) => numericColumnValid(data, item.dataKey));
}

function nonnegativeColumnWithPositiveTotal(
  data: Array<Record<string, string | number | null>>,
  dataKey: string,
): boolean {
  if (!numericColumnValid(data, dataKey)) return false;
  let total = 0;
  for (const row of data) {
    const value = row[dataKey];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'number' || value < 0) return false;
    total += value;
  }
  return total > 0;
}

function validTimelineDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return ISO_DATE_RE.test(normalized) && Number.isFinite(Date.parse(normalized));
}

function timelineColumnValid(
  data: Array<Record<string, string | number | null>>,
  dataKey: string,
  required: boolean,
): boolean {
  let found = false;
  for (const row of data) {
    if (!Object.hasOwn(row, dataKey) || row[dataKey] === null || row[dataKey] === '') {
      if (required) return false;
      continue;
    }
    if (!validTimelineDate(row[dataKey])) return false;
    found = true;
  }
  return required ? found : true;
}

export function sanitizeAnalysisVisualization(value: unknown): AnalysisVisualizationSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const chartType = raw.chartType as AnalysisChartType;
  if (!CHART_TYPES.has(chartType)) return null;
  const title = text(raw.title, 140);
  const data = rows(raw.data);
  if (!title || !data.length) return null;

  const base: AnalysisVisualizationSpec = {
    version: ANALYSIS_VISUALIZATION_VERSION,
    chartType,
    title,
    data,
  };
  const insight = text(raw.insight, 280);
  const description = text(raw.description, 500);
  const footer = text(raw.footer, 320);
  const xAxisLabel = text(raw.xAxisLabel, 80);
  const yAxisLabel = text(raw.yAxisLabel, 80);
  if (insight) base.insight = insight;
  if (description) base.description = description;
  if (footer) base.footer = footer;
  if (xAxisLabel) base.xAxisLabel = xAxisLabel;
  if (yAxisLabel) base.yAxisLabel = yAxisLabel;
  if (raw.layout === 'horizontal' || raw.layout === 'vertical') base.layout = raw.layout;

  if (chartType === 'pie') {
    const nameKey = key(raw.nameKey);
    const valueKey = key(raw.valueKey);
    if (
      !nameKey ||
      !valueKey ||
      !requiredKeysPresent(data, [nameKey, valueKey]) ||
      !nonnegativeColumnWithPositiveTotal(data, valueKey)
    ) {
      return null;
    }
    base.nameKey = nameKey;
    base.valueKey = valueKey;
    return base;
  }

  if (chartType === 'heatmap') {
    const h = raw.heatmap;
    if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
    const map = h as Record<string, unknown>;
    const rowKey = key(map.rowKey);
    const columnKey = key(map.columnKey);
    const valueKey = key(map.valueKey);
    if (
      !rowKey ||
      !columnKey ||
      !valueKey ||
      !requiredKeysPresent(data, [rowKey, columnKey, valueKey]) ||
      !numericColumnValid(data, valueKey)
    ) {
      return null;
    }
    base.heatmap = { rowKey, columnKey, valueKey };
    return base;
  }

  if (chartType === 'timeline') {
    const t = raw.timeline;
    if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
    const map = t as Record<string, unknown>;
    const labelKey = key(map.labelKey);
    const startKey = key(map.startKey);
    const endKey = key(map.endKey);
    const groupKey = key(map.groupKey);
    if (
      !labelKey ||
      !startKey ||
      !requiredKeysPresent(data, [labelKey, startKey]) ||
      !timelineColumnValid(data, startKey, true) ||
      (endKey && !timelineColumnValid(data, endKey, false))
    ) {
      return null;
    }
    base.timeline = {
      labelKey,
      startKey,
      ...(endKey ? { endKey } : {}),
      ...(groupKey ? { groupKey } : {}),
    };
    return base;
  }

  const xKey = key(raw.xKey);
  const chartSeries = series(raw.series);
  if (!xKey || !chartSeries.length) return null;
  if (!requiredKeysPresent(data, [xKey, ...chartSeries.map((item) => item.dataKey)])) return null;
  if (!numericSeriesValid(data, chartSeries)) return null;
  if (chartType === 'scatter' && !numericColumnValid(data, xKey)) return null;
  if (chartType === 'waterfall' && chartSeries.length !== 1) return null;
  base.xKey = xKey;
  base.series = chartSeries;
  return base;
}

export function sanitizeAnalysisVisualizations(value: unknown): AnalysisVisualizationSpec[] {
  return analysisVisualizationCandidates(value)
    .map(sanitizeAnalysisVisualization)
    .filter((spec): spec is AnalysisVisualizationSpec => spec !== null);
}

/** Keep raw candidate indexes stable so fig_n.png can never pair with visual m. */
export function analysisVisualizationCandidates(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_VISUALS) : [];
}

export function analysisVisualizationCandidatesFromResults(value: unknown): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const raw = value as Record<string, unknown>;
  return analysisVisualizationCandidates(raw.visuals ?? raw.__visuals);
}

export function visualizationsFromAnalysisResults(value: unknown): AnalysisVisualizationSpec[] {
  return analysisVisualizationCandidatesFromResults(value)
    .map(sanitizeAnalysisVisualization)
    .filter((spec): spec is AnalysisVisualizationSpec => spec !== null);
}

/**
 * The model authored the visual spec already. Remove its potentially large row
 * payload before feeding the tool result back into the next model step.
 */
export function analysisResultsWithoutVisualizations(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  const { visuals: _visuals, __visuals: _legacyVisuals, ...rest } = raw;
  return rest;
}
