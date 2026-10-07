import { PLANNER_DEFAULT_REPORT_CHART, type PlannerReportChart } from '@capiro/strategy-verifier';
import {
  plannerBuildReport,
  plannerReportDateBucket,
  type PlannerReportRecord,
} from './planner-reporting.js';
import {
  validatePlannerReportChart,
  validatePlannerReportWidgets,
} from './planner-reporting.validation.js';
const project = '30000000-0000-4000-8000-000000000001';
const field = '30000000-0000-4000-8000-000000000002';
const chart = (patch: Partial<PlannerReportChart> = {}): PlannerReportChart => ({
  ...structuredClone(PLANNER_DEFAULT_REPORT_CHART),
  ...patch,
});
const record = (id: string, patch: Partial<PlannerReportRecord> = {}): PlannerReportRecord => ({
  id,
  entity: 'tasks',
  name: id,
  status: 'todo',
  personId: 'me',
  personName: 'Me',
  priority: 'high',
  type: 'task',
  projectIds: [project],
  tags: [],
  parentId: null,
  dates: { created: '2026-10-01', start: null, due: '2026-10-07', completed: null },
  custom: {},
  metrics: { estimated_minutes: 60, actual_minutes: 15 },
  groups: { status: [{ key: 'todo', label: 'To do' }] },
  ...patch,
});
describe('Planner reporting aggregation and contracts', () => {
  it('counts shared task time once across project records and inside each chart bucket', () => {
    const config = chart({ entity: 'projects', metric: 'actual_minutes' });
    const rows = [
      record('first', {
        entity: 'projects',
        metrics: { actual_minutes: 60 },
        contributions: {
          actual_minutes: [
            { id: 'shared-task', value: 40 },
            { id: 'first-task', value: 20 },
          ],
        },
      }),
      record('second', {
        entity: 'projects',
        metrics: { actual_minutes: 70 },
        contributions: {
          actual_minutes: [
            { id: 'shared-task', value: 40 },
            { id: 'second-task', value: 30 },
          ],
        },
      }),
    ];
    expect(plannerBuildReport(rows, config, new Set())).toMatchObject({
      total: 90,
      matched: 2,
      overlapping: true,
      buckets: [{ value: 90, count: 2 }],
    });
  });
  it('aggregates work beyond a task page and never widens an explicitly empty resolved source', () => {
    const records = Array.from({ length: 127 }, (_, i) => record(String(i)));
    const all = plannerBuildReport(
      records,
      chart({ metric: 'actual_minutes', group: 'none' }),
      new Set(),
    );
    expect(all).toMatchObject({ matched: 127, total: 1905, unit: 'minutes' });
    const scoped = chart();
    scoped.filters.source = { kind: 'projects', ids: [project] };
    expect(plannerBuildReport(records, scoped, new Set(), true)).toMatchObject({
      matched: 0,
      total: 0,
      unavailableSources: true,
    });
    expect(plannerBuildReport(records, scoped, new Set([project])).matched).toBe(127);
  });
  it('combines date, assignee, status, subtype, custom and subtask filters before summing', () => {
    const config = chart({ metric: 'custom_number', metricFieldId: field, group: 'none' });
    config.filters = {
      ...config.filters,
      from: '2026-10-07',
      through: '2026-10-07',
      personIds: ['me'],
      statuses: ['todo'],
      types: ['task'],
      includeSubtasks: false,
      custom: [{ fieldId: project, values: ['chosen'] }],
    };
    const selected = record('selected', {
      custom: { [field]: 120, [project]: ['chosen', 'other'] },
    });
    const ignored = [
      record('missing-custom'),
      record('other-assignee', { ...selected, personId: 'other' }),
      record('child', { ...selected, parentId: 'parent' }),
      record('late', { ...selected, dates: { ...selected.dates, due: '2026-10-08' } }),
      record('undated', { ...selected, dates: { ...selected.dates, due: null } }),
    ];
    expect(plannerBuildReport([selected, ...ignored], config, new Set())).toMatchObject({
      matched: 1,
      total: 120,
      unit: 'number',
    });
  });
  it('deduplicates repeated category values but records overlapping multi-select groups without inflating the distinct total', () => {
    const config = chart({ group: 'custom', groupFieldId: field });
    const result = plannerBuildReport(
      [
        record('a', { custom: { [field]: ['red', 'red', 'blue'] } }),
        record('b', { custom: { [field]: ['blue'] } }),
      ],
      config,
      new Set(),
    );
    expect(result).toMatchObject({ matched: 2, total: 2, overlapping: true });
    expect(result.buckets.map((b) => [b.label, b.value])).toEqual([
      ['blue', 2],
      ['red', 1],
    ]);
  });
  it('averages progress from individual matching records and separately from each group', () => {
    const config = chart({ entity: 'goals', metric: 'progress' });
    const records = [
      record('a', { entity: 'goals', metrics: { progress: 20 } }),
      record('b', { entity: 'goals', metrics: { progress: 80 } }),
      record('c', {
        entity: 'goals',
        metrics: { progress: 50 },
        groups: { status: [{ key: 'achieved', label: 'Achieved' }] },
      }),
    ];
    const result = plannerBuildReport(records, config, new Set());
    expect(result.total).toBe(50);
    expect(result.buckets.every((b) => b.value === 50)).toBe(true);
  });
  it('uses Monday weeks and stable calendar quarters at year boundaries', () => {
    expect(plannerReportDateBucket('2027-01-01', 'week')).toEqual({
      key: '2026-12-28',
      label: 'Week of 2026-12-28',
    });
    expect(plannerReportDateBucket('2026-12-31', 'quarter')).toEqual({
      key: '2026-Q4',
      label: 'Q4 2026',
    });
  });
  it('rejects unsupported entity metrics, unknown fields, reversed dates and implicit source broadening', () => {
    expect(validatePlannerReportChart(chart()).entity).toBe('tasks');
    expect(() =>
      validatePlannerReportChart(chart({ entity: 'goals', metric: 'actual_minutes' })),
    ).toThrow();
    expect(() => validatePlannerReportChart({ ...chart(), sql: 'SELECT secrets' })).toThrow();
    const invalid = chart();
    invalid.filters.source = { kind: 'projects', ids: [] };
    expect(() => validatePlannerReportChart(invalid)).toThrow();
    invalid.filters.source = { kind: 'all', ids: [] };
    invalid.filters.from = '2026-10-08';
    invalid.filters.through = '2026-10-07';
    expect(() => validatePlannerReportChart(invalid)).toThrow();
    expect(() =>
      validatePlannerReportWidgets([
        { id: project, kind: 'chart', title: 'Dates', style: 'line', labels: true, chart: chart() },
      ]),
    ).toThrow();
  });
});
