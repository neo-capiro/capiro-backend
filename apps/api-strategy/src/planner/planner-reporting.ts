import type {
  PlannerReportChart,
  PlannerReportEntity,
  PlannerReportGroup,
  PlannerReportMetric,
  PlannerReportResult,
} from '@capiro/strategy-verifier';
import { createHash } from 'node:crypto';

/** Prepared from currently authorized records only. The report endpoint supplies
 * metadata, never task descriptions, attachment contents or hidden custom fields. */
export interface PlannerReportRecord {
  id: string;
  entity: PlannerReportEntity;
  name: string;
  status: string | null;
  personId: string | null;
  personName: string | null;
  priority: string | null;
  type: string | null;
  projectIds: string[];
  tags: string[];
  parentId: string | null;
  dates: { created: string; start: string | null; due: string | null; completed: string | null };
  custom: Record<string, string | number | string[] | null>;
  metrics: Partial<Record<PlannerReportMetric, number>>;
  contributions?: Partial<Record<PlannerReportMetric, { id: string; value: number }[]>>;
  groups: Partial<Record<PlannerReportGroup, { key: string; label: string }[]>>;
}

export function plannerReportMatches(
  record: PlannerReportRecord,
  chart: PlannerReportChart,
  sourceProjects: Set<string>,
) {
  const f = chart.filters;
  if (record.entity !== chart.entity) return false;
  if (f.source.kind !== 'all') {
    if (record.entity === 'portfolios' && f.source.kind === 'portfolios') {
      if (!f.source.ids.includes(record.id)) return false;
    } else if (!record.projectIds.some((id) => sourceProjects.has(id))) return false;
  }
  if (f.statuses.length && (!record.status || !f.statuses.includes(record.status))) return false;
  if (f.personIds.length && !f.personIds.includes(record.personId ?? 'unassigned')) return false;
  if (f.priorities.length && (!record.priority || !f.priorities.includes(record.priority)))
    return false;
  if (f.types.length && (!record.type || !f.types.includes(record.type))) return false;
  if (f.tags.length && !f.tags.some((tag) => record.tags.includes(tag))) return false;
  if (!f.includeSubtasks && record.parentId) return false;
  const date = record.dates[f.dateField];
  if (
    (f.from || f.through) &&
    (!date || (f.from && date < f.from) || (f.through && date > f.through))
  )
    return false;
  return f.custom.every((filter) => {
    const value = record.custom[filter.fieldId];
    const values = Array.isArray(value) ? value : value == null ? [] : [value];
    return filter.values.some((choice) => values.some((value) => value === choice));
  });
}

export function plannerReportValue(record: PlannerReportRecord, chart: PlannerReportChart) {
  if (chart.metric === 'count') return 1;
  if (chart.metric === 'custom_number') {
    const value = record.custom[chart.metricFieldId!];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
  return record.metrics[chart.metric] ?? 0;
}

export function plannerReportDateBucket(
  date: string,
  granularity: PlannerReportChart['granularity'],
) {
  if (granularity === 'day') return { key: date, label: date };
  if (granularity === 'month') return { key: date.slice(0, 7), label: date.slice(0, 7) };
  if (granularity === 'year') return { key: date.slice(0, 4), label: date.slice(0, 4) };
  if (granularity === 'quarter') {
    const quarter = Math.ceil(Number(date.slice(5, 7)) / 3);
    return { key: `${date.slice(0, 4)}-Q${quarter}`, label: `Q${quarter} ${date.slice(0, 4)}` };
  }
  const monday = new Date(`${date}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const value = monday.toISOString().slice(0, 10);
  return { key: value, label: `Week of ${value}` };
}

export function plannerReportGroups(record: PlannerReportRecord, chart: PlannerReportChart) {
  if (chart.group === 'none') return [{ key: 'all', label: 'All matching work' }];
  if (['created', 'due', 'completed'].includes(chart.group)) {
    const date = record.dates[chart.group as 'created' | 'due' | 'completed'];
    return date
      ? [plannerReportDateBucket(date, chart.granularity)]
      : [{ key: 'undated', label: 'Undated' }];
  }
  if (chart.group === 'custom') {
    const value = record.custom[chart.groupFieldId!];
    const values = Array.isArray(value) ? value : value == null ? [] : [value];
    return values.length
      ? [...new Set(values)].map((value) => ({
          key: `custom:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`,
          label: String(value),
        }))
      : [{ key: 'unset', label: 'Not set' }];
  }
  const groups = record.groups[chart.group] ?? [];
  return groups.length
    ? [...new Map(groups.map((g) => [g.key, g])).values()]
    : [{ key: 'unset', label: 'Not set' }];
}

export function plannerBuildReport(
  records: PlannerReportRecord[],
  chart: PlannerReportChart,
  sourceProjects: Set<string>,
  unavailableSources = false,
): PlannerReportResult {
  const matching = records.filter((record) => plannerReportMatches(record, chart, sourceProjects));
  const buckets = new Map<string, { key: string; label: string; value: number; count: number }>();
  let total = 0,
    overlapping = false;
  const counted = new Set<string>();
  const bucketContributions = new Map<string, Set<string>>();
  for (const record of matching) {
    const value = plannerReportValue(record, chart);
    const contributions = record.contributions?.[chart.metric];
    if (contributions) {
      for (const item of contributions) {
        if (counted.has(item.id)) overlapping = true;
        else {
          total += item.value;
          counted.add(item.id);
        }
      }
    } else total += value;
    const groups = plannerReportGroups(record, chart);
    overlapping ||= groups.length > 1;
    for (const group of groups) {
      const bucket = buckets.get(group.key) ?? { ...group, value: 0, count: 0 };
      if (contributions) {
        const seen = bucketContributions.get(group.key) ?? new Set<string>();
        for (const item of contributions)
          if (!seen.has(item.id)) {
            bucket.value += item.value;
            seen.add(item.id);
          }
        bucketContributions.set(group.key, seen);
      } else bucket.value += value;
      bucket.count++;
      buckets.set(group.key, bucket);
    }
  }
  if (chart.metric === 'progress') {
    total = matching.length ? total / matching.length : 0;
    for (const bucket of buckets.values()) bucket.value /= bucket.count;
  }
  return {
    total,
    matched: matching.length,
    buckets: [...buckets.values()].sort((a, b) =>
      ['created', 'due', 'completed'].includes(chart.group)
        ? a.key.localeCompare(b.key)
        : b.value - a.value || a.label.localeCompare(b.label),
    ),
    unit: chart.metric.endsWith('_minutes')
      ? 'minutes'
      : chart.metric === 'progress'
        ? 'percent'
        : chart.metric === 'custom_number'
          ? 'number'
          : 'items',
    overlapping,
    unavailableSources,
    unavailableFields: false,
  };
}
