import {
  plannerCalendarDate,
  PLANNER_REPORT_OPTIONS as options,
  plannerTimeZone,
  type PlannerReportChart,
  type PlannerReportWidget,
} from '@capiro/strategy-verifier';
import { fail, keys, object, uuid } from './planner.validation.js';

function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    fail('Invalid report text');
  return value;
}
function choice(value: unknown, allowed: readonly string[]) {
  if (typeof value !== 'string' || !allowed.includes(value)) fail('Invalid report option');
}
function list(value: unknown, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('Invalid report list');
  return value;
}
function distinct(values: unknown[]) {
  if (new Set(values).size !== values.length) fail('Duplicate report values');
}
export function validatePlannerReportChart(raw: unknown): PlannerReportChart {
  const data = object(raw);
  keys(data, [
    'entity',
    'metric',
    'group',
    'groupFieldId',
    'metricFieldId',
    'granularity',
    'filters',
  ]);
  choice(data.entity, Object.keys(options));
  const supported = options[data.entity as keyof typeof options];
  choice(data.metric, supported.metrics);
  choice(data.group, supported.groups);
  choice(data.granularity, ['day', 'week', 'month', 'quarter', 'year']);
  for (const field of ['groupFieldId', 'metricFieldId'])
    if (data[field] !== null) uuid(data[field]);
  if ((data.group === 'custom') !== (data.groupFieldId !== null))
    fail('A custom grouping requires its field, and other groupings cannot use one');
  if ((data.metric === 'custom_number') !== (data.metricFieldId !== null))
    fail('A custom sum requires its numeric field, and other metrics cannot use one');
  const f = object(data.filters);
  keys(f, [
    'source',
    'statuses',
    'personIds',
    'priorities',
    'types',
    'tags',
    'includeSubtasks',
    'dateField',
    'from',
    'through',
    'timeZone',
    'custom',
  ]);
  const source = object(f.source);
  keys(source, ['kind', 'ids']);
  choice(source.kind, ['all', 'projects', 'portfolios']);
  const ids = list(source.ids);
  ids.forEach(uuid);
  distinct(ids);
  if (source.kind === 'all' ? ids.length !== 0 : ids.length === 0)
    fail('Choose report sources explicitly');
  for (const field of ['statuses', 'personIds', 'priorities', 'types', 'tags']) {
    const values = list(f[field]);
    values.forEach((v) => text(v, 200, true));
    distinct(values);
  }
  (f.statuses as unknown[]).forEach((v) => choice(v, supported.statuses));
  (f.types as unknown[]).forEach((v) => choice(v, supported.types));
  (f.priorities as unknown[]).forEach((v) => choice(v, ['none', 'low', 'medium', 'high']));
  if (typeof f.includeSubtasks !== 'boolean') fail('Choose whether to include subtasks');
  choice(f.dateField, ['created', 'start', 'due', 'completed']);
  if (f.dateField === 'completed' && data.entity !== 'tasks')
    fail('Completed dates are available for task reports');
  if (
    data.entity === 'portfolios' &&
    f.dateField !== 'created' &&
    (f.from !== null || f.through !== null)
  )
    fail('Portfolio date filters use creation dates');
  for (const value of [f.from, f.through])
    if (value !== null && !plannerCalendarDate(value)) fail('Invalid report date');
  if (f.from && f.through && String(f.from) > String(f.through))
    fail('Report date range is reversed');
  if (!plannerTimeZone(f.timeZone)) fail('Invalid report time zone');
  const custom = list(f.custom, 20);
  for (const raw of custom) {
    const filter = object(raw);
    keys(filter, ['fieldId', 'values']);
    uuid(filter.fieldId);
    const values = list(filter.values);
    if (!values.length) fail('Choose custom filter values');
    for (const value of values) {
      if (typeof value === 'number') {
        if (!Number.isFinite(value) || Math.abs(value) > 1_000_000)
          fail('Invalid report numeric filter');
      } else text(value, 200, true);
    }
    distinct(values);
  }
  distinct(custom.map((f) => object(f).fieldId));
  if (
    data.entity !== 'tasks' &&
    ((f.priorities as unknown[]).length ||
      (f.tags as unknown[]).length ||
      custom.length ||
      f.includeSubtasks === false)
  )
    fail('Task filters are only available for task reports');
  return data as unknown as PlannerReportChart;
}

export function validatePlannerReportWidgets(raw: unknown): PlannerReportWidget[] {
  const widgets = list(raw, 40);
  let textSize = 0;
  for (const raw of widgets) {
    const widget = object(raw);
    choice(widget.kind, ['text', 'chart']);
    keys(
      widget,
      widget.kind === 'text'
        ? ['id', 'kind', 'title', 'text']
        : ['id', 'kind', 'title', 'style', 'labels', 'chart'],
    );
    uuid(widget.id);
    textSize += text(widget.title, 500, true).length;
    if (widget.kind === 'text') textSize += text(widget.text, 20000).length;
    else {
      choice(widget.style, ['bar', 'donut', 'line', 'number']);
      if (typeof widget.labels !== 'boolean') fail('Invalid report label option');
      const chart = validatePlannerReportChart(widget.chart);
      if (widget.style === 'line' && !['created', 'due', 'completed'].includes(chart.group))
        fail('Line charts require a date grouping');
      if (widget.style === 'number' && chart.group !== 'none')
        fail('Number charts have no grouping');
    }
  }
  distinct(widgets.map((w) => object(w).id));
  if (textSize > 100000) fail('Dashboard text is too long');
  return widgets as PlannerReportWidget[];
}
