import { PLANNER_DEFAULT_REPORT_CHART, type PlannerReportWidget } from '@capiro/strategy-verifier';
import {
  plannerReportWidgetView,
  preparePlannerReportWidgets,
} from './planner-reporting-sharing.js';
import { validatePlannerReportWidgets } from './planner-reporting.validation.js';
const visibleProject = '30000000-0000-4000-8000-000000000001';
const privateProject = '30000000-0000-4000-8000-000000000002';
const privateField = '30000000-0000-4000-8000-000000000003';
const widgetId = '30000000-0000-4000-8000-000000000004';
const visible = {
  projects: new Set([visibleProject]),
  portfolios: new Set<string>(),
  fields: new Set<string>(),
};
function widget(): Extract<PlannerReportWidget, { kind: 'chart' }> {
  const chart = structuredClone(PLANNER_DEFAULT_REPORT_CHART);
  chart.filters.source = { kind: 'projects', ids: [visibleProject, privateProject] };
  chart.metric = 'custom_number';
  chart.metricFieldId = privateField;
  chart.filters.custom = [{ fieldId: privateField, values: ['confidential choice'] }];
  return { id: widgetId, kind: 'chart', title: 'Current work', style: 'bar', labels: true, chart };
}
describe('Planner saved report source protection', () => {
  it('withholds private source and field identifiers and values while retaining an explicit restricted source', () => {
    const view = plannerReportWidgetView([widget()], visible);
    expect(JSON.stringify(view)).not.toContain(privateProject);
    expect(JSON.stringify(view)).not.toContain(privateField);
    expect(JSON.stringify(view)).not.toContain('confidential choice');
    expect(view.warnings).toEqual([
      { widgetId, unavailableSources: true, unavailableFields: true },
    ]);
    const first = view.widgets[0]!;
    if (first.kind !== 'chart') throw Error('Expected chart');
    expect(first.chart.filters.source).toEqual({ kind: 'projects', ids: [visibleProject] });
  });
  it('preserves hidden saved criteria and metrics during visible edits without returning them to the editor', () => {
    const original = widget();
    const viewed = plannerReportWidgetView([original], visible).widgets;
    viewed[0]!.title = 'Renamed';
    const prepared = preparePlannerReportWidgets([original], viewed, visible);
    expect(validatePlannerReportWidgets(prepared)).toEqual([{ ...original, title: 'Renamed' }]);
    expect(JSON.stringify(plannerReportWidgetView(prepared, visible))).not.toContain(privateField);
  });
  it('rejects new inaccessible references, altered private criteria and duplicate criteria instead of silently changing them', () => {
    const old = widget(),
      viewed = plannerReportWidgetView([old], visible).widgets;
    const requested = structuredClone(viewed);
    const first = requested[0]!;
    if (first.kind !== 'chart') throw Error('Expected chart');
    first.chart.filters.custom = [{ fieldId: privateField, values: ['changed'] }];
    expect(() => preparePlannerReportWidgets([old], requested, visible)).toThrow(
      'filter is unavailable',
    );
    first.chart.filters.custom = [];
    first.chart.filters.source.ids = ['30000000-0000-4000-8000-000000000099'];
    expect(() => preparePlannerReportWidgets([old], requested, visible)).toThrow(
      'source is unavailable',
    );
    first.chart.filters.source.ids = [visibleProject, visibleProject];
    expect(() => preparePlannerReportWidgets([old], requested, visible)).toThrow(
      'Duplicate report sources',
    );
  });
  it('permits an explicit replacement widget without transferring hidden criteria from the former widget', () => {
    const old = widget();
    const replacement = {
      ...old,
      id: '30000000-0000-4000-8000-000000000005',
      chart: structuredClone(PLANNER_DEFAULT_REPORT_CHART),
    };
    expect(preparePlannerReportWidgets([old], [replacement], visible)).toEqual([replacement]);
  });
});
