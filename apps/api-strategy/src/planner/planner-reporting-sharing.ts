import type { PlannerReportWidget } from '@capiro/strategy-verifier';
import { fail, object } from './planner.validation.js';
export type PlannerReportVisibility = {
  projects: Set<string>;
  portfolios: Set<string>;
  fields: Set<string>;
};
export function plannerReportWidgetView(
  widgets: PlannerReportWidget[],
  visible: PlannerReportVisibility,
) {
  const warnings: { widgetId: string; unavailableSources: boolean; unavailableFields: boolean }[] =
    [];
  const viewed = structuredClone(widgets);
  for (const widget of viewed) {
    if (widget.kind !== 'chart') continue;
    const chart = widget.chart,
      f = chart.filters;
    const source = f.source.kind === 'all' ? null : visible[f.source.kind];
    const hiddenSources = source ? f.source.ids.some((id) => !source.has(id)) : false;
    if (source) f.source.ids = f.source.ids.filter((id) => source.has(id));
    let hiddenFields = false;
    for (const key of ['groupFieldId', 'metricFieldId'] as const) {
      if (chart[key] && !visible.fields.has(chart[key]!)) {
        chart[key] = null;
        hiddenFields = true;
      }
    }
    hiddenFields ||= f.custom.some((filter) => !visible.fields.has(filter.fieldId));
    f.custom = f.custom.filter((filter) => visible.fields.has(filter.fieldId));
    if (hiddenSources || hiddenFields)
      warnings.push({
        widgetId: widget.id,
        unavailableSources: hiddenSources,
        unavailableFields: hiddenFields,
      });
  }
  return { widgets: viewed, warnings };
}

/** Ordinary visible edits retain inaccessible stored criteria. Removing a widget
 * or explicitly changing its source/group/metric remains an ordinary edit. */
export function preparePlannerReportWidgets(
  previous: PlannerReportWidget[],
  requested: unknown,
  visible: PlannerReportVisibility,
) {
  if (!Array.isArray(requested) || requested.length > 40) fail('Invalid report widgets');
  const widgets = structuredClone(requested) as PlannerReportWidget[];
  const prior = new Map(previous.map((widget) => [widget.id, widget]));
  for (const raw of widgets) {
    const widget = object(raw);
    if (widget.kind !== 'chart') continue;
    const chart = object(widget.chart),
      f = object(chart.filters),
      source = object(f.source);
    const original = prior.get(String(widget.id));
    const before =
      original?.kind === 'chart' && original.chart.entity === chart.entity ? original.chart : null;
    if (
      source.kind !== 'all' &&
      (source.kind === 'projects' || source.kind === 'portfolios') &&
      Array.isArray(source.ids)
    ) {
      const readable = visible[source.kind];
      if (new Set(source.ids).size !== source.ids.length) fail('Duplicate report sources');
      if (before?.filters.source.kind === source.kind)
        source.ids = [
          ...new Set([
            ...source.ids,
            ...before.filters.source.ids.filter((id) => !readable.has(id)),
          ]),
        ];
      for (const id of source.ids as unknown[])
        if (
          !readable.has(String(id)) &&
          !(
            before?.filters.source.kind === source.kind &&
            before.filters.source.ids.includes(String(id))
          )
        )
          fail('Report source is unavailable');
    }
    for (const key of ['groupFieldId', 'metricFieldId'] as const) {
      const mode = key === 'groupFieldId' ? 'group' : 'metric';
      const custom = key === 'groupFieldId' ? 'custom' : 'custom_number';
      if (
        chart[mode] === custom &&
        chart[key] === null &&
        before &&
        before[mode] === chart[mode] &&
        before[key] &&
        !visible.fields.has(before[key]!)
      )
        chart[key] = before[key];
      if (
        chart[key] != null &&
        !visible.fields.has(String(chart[key])) &&
        !(before && before[mode] === chart[mode] && before[key] === chart[key])
      )
        fail('Report field is unavailable');
    }
    if (Array.isArray(f.custom)) {
      const oldHidden = (before?.filters.custom ?? []).filter(
        (filter) => !visible.fields.has(filter.fieldId),
      );
      const selected = new Map(
        f.custom.map((raw) => {
          const filter = object(raw);
          return [String(filter.fieldId), filter];
        }),
      );
      if (selected.size !== f.custom.length) fail('Duplicate report filters');
      for (const filter of oldHidden)
        if (!selected.has(filter.fieldId))
          selected.set(filter.fieldId, filter as unknown as Record<string, unknown>);
      for (const [id, filter] of selected)
        if (
          !visible.fields.has(id) &&
          !oldHidden.some(
            (old) =>
              old.fieldId === id && JSON.stringify(old.values) === JSON.stringify(filter.values),
          )
        )
          fail('Report filter is unavailable');
      f.custom = [...selected.values()];
    }
  }
  return widgets;
}
