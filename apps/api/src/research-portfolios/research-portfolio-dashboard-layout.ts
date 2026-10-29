import { BadRequestException } from '@nestjs/common';
import type {
  ResearchPortfolioDashboardLayoutDto,
  ResearchPortfolioDashboardWidgetDto,
  ResearchPortfolioDashboardWidgetKind,
} from '@capiro/shared';

const GRID_COLUMNS = 12;
const MAX_WIDGETS = 40;
const WIDGET_KINDS: ReadonlySet<ResearchPortfolioDashboardWidgetKind> = new Set([
  'header',
  'key_totals',
  'funding_table',
  'client_fit',
  'changes',
  'subjects',
  'sources',
  'snapshot_comparison',
  'commentary',
  'image',
]);

export function validateLayout(input: unknown): ResearchPortfolioDashboardLayoutDto {
  const layout = input as Partial<ResearchPortfolioDashboardLayoutDto> | null;
  if (
    !layout ||
    typeof layout !== 'object' ||
    layout.columns !== GRID_COLUMNS ||
    !Array.isArray(layout.widgets)
  )
    throw new BadRequestException('Dashboard layout must have 12 columns and a widgets array');
  if (layout.widgets.length > MAX_WIDGETS)
    throw new BadRequestException(`A dashboard holds at most ${MAX_WIDGETS} widgets`);
  const ids = new Set<string>();
  const widgets: ResearchPortfolioDashboardWidgetDto[] = layout.widgets.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new BadRequestException('Each widget must be an object');
    const widget = raw as Partial<ResearchPortfolioDashboardWidgetDto>;
    if (
      typeof widget.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(widget.id) ||
      ids.has(widget.id)
    )
      throw new BadRequestException('Each widget needs a unique id');
    ids.add(widget.id);
    if (!WIDGET_KINDS.has(widget.kind as ResearchPortfolioDashboardWidgetKind))
      throw new BadRequestException(`Unknown widget kind: ${String(widget.kind)}`);
    const { x, y, w, h } = widget;
    if (
      ![x, y, w, h].every((value) => Number.isInteger(value)) ||
      x! < 0 ||
      y! < 0 ||
      w! < 1 ||
      h! < 1 ||
      x! + w! > GRID_COLUMNS
    )
      throw new BadRequestException(`Widget ${widget.id} must fit the 12-column grid`);
    const settings =
      widget.settings && typeof widget.settings === 'object' && !Array.isArray(widget.settings)
        ? widget.settings
        : {};
    if (JSON.stringify(settings).length > 4000)
      throw new BadRequestException(`Widget ${widget.id} settings are too large`);
    return {
      id: widget.id,
      kind: widget.kind as ResearchPortfolioDashboardWidgetKind,
      x: x!,
      y: y!,
      w: w!,
      h: h!,
      settings,
    };
  });
  // Widgets may not overlap: the editor refuses an invalid drop, and the server refuses an invalid save.
  for (let i = 0; i < widgets.length; i += 1) {
    for (let j = i + 1; j < widgets.length; j += 1) {
      const a = widgets[i]!,
        b = widgets[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        throw new BadRequestException(`Widgets ${a.id} and ${b.id} overlap`);
    }
  }
  const phoneOrder = Array.isArray(layout.phoneOrder)
    ? [
        ...new Set(
          layout.phoneOrder.filter((id): id is string => typeof id === 'string' && ids.has(id)),
        ),
      ]
    : [];
  const ordered = [
    ...phoneOrder,
    ...widgets.map((w) => w.id).filter((id) => !phoneOrder.includes(id)),
  ];
  return { columns: GRID_COLUMNS, widgets, phoneOrder: ordered };
}
