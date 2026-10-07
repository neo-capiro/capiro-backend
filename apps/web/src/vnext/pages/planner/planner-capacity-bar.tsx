import {
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { MoreHorizontal } from 'lucide-react';
import {
  plannerCapacityDateShift,
  plannerCapacityWorkdays,
  type PlannerCapacityAllocation,
  type PlannerCapacityAllocationChange,
} from '@capiro/strategy-verifier';

type Boundary = 'startOn' | 'endOn';
export type CapacityColumnBounds = { start: string; end: string; left: number; width: number };
const ordinal = (date: string) => Date.parse(`${date}T12:00:00Z`) / 86400000;

/** Calendar position, including partial weeks/months and horizontal scrolling. */
export function capacityCalendarPosition(x: number, columns: CapacityColumnBounds[]) {
  const column = columns.find((c) => x < c.left + c.width) ?? columns.at(-1);
  if (!column || !Number.isFinite(x) || !Number.isFinite(column.width) || column.width <= 0)
    throw new Error('The timeline changed. Try resizing again.');
  return (
    ordinal(column.start) +
    ((x - column.left) / column.width) * (ordinal(column.end) - ordinal(column.start) + 1)
  );
}

export function capacityResizeDates(
  allocation: PlannerCapacityAllocation,
  boundary: Boundary,
  delta: number,
) {
  if (!Number.isInteger(delta) || Math.abs(delta) > 3660)
    throw new Error('Choose dates within ten years of this allocation.');
  const date = plannerCapacityDateShift(allocation.data[boundary], delta);
  const startOn = boundary === 'startOn' ? date : allocation.data.startOn;
  const endOn = boundary === 'endOn' ? date : allocation.data.endOn;
  if (startOn > endOn) throw new Error('The start date must be on or before the end date.');
  if (!plannerCapacityWorkdays(startOn, endOn).length)
    throw new Error('Allocation dates must include at least one working day.');
  return { [boundary]: date };
}

function columnBounds(handle: HTMLElement): CapacityColumnBounds[] {
  const row = handle.closest('.planner-capacity-row');
  return Array.from(row?.querySelectorAll<HTMLElement>('[data-capacity-start]') ?? []).map(
    (cell) => {
      const rect = cell.getBoundingClientRect();
      return {
        start: cell.dataset.capacityStart!,
        end: cell.dataset.capacityEnd!,
        left: rect.left,
        width: rect.width,
      };
    },
  );
}

export function PlannerAllocationBar({
  allocation: a,
  column,
  label,
  description,
  color,
  selected,
  canEdit,
  onSelect,
  onEdit,
  onChange,
  onError,
}: {
  allocation: PlannerCapacityAllocation;
  column: { start: string; end: string };
  label: string;
  description: string;
  color: string;
  selected: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onChange: (change: PlannerCapacityAllocationChange) => void;
  onError: (error: Error) => void;
}) {
  const editable = canEdit && a.access === 'admin';
  const [menuOpen, setMenuOpen] = useState(false);
  const [preview, setPreview] = useState('');
  const drag = useRef<{ pointerId: number; boundary: Boundary; origin: number } | null>(null);
  const resize = (boundary: Boundary, delta: number) => {
    if (!editable || a.archived || !delta) return;
    try {
      onChange({ id: a.id, version: a.version, data: capacityResizeDates(a, boundary, delta) });
    } catch (error) {
      onError(error instanceof Error ? error : new Error('Unable to resize allocation'));
    }
  };
  const deltaAt = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    return current
      ? Math.round(
          capacityCalendarPosition(event.clientX, columnBounds(event.currentTarget)) -
            current.origin,
        )
      : 0;
  };
  const cancel = () => {
    drag.current = null;
    setPreview('');
  };
  const handle = (boundary: Boundary) => (
    <button
      type="button"
      className={`planner-capacity-resize is-${boundary}`}
      aria-label={`Resize ${boundary === 'startOn' ? 'start' : 'end'} of ${description}`}
      title="Drag to resize. Arrow keys move one day; Shift moves seven days. Escape cancels."
      onPointerDown={(event) => {
        if (!editable || a.archived || event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.stopPropagation();
        try {
          drag.current = {
            pointerId: event.pointerId,
            boundary,
            origin: capacityCalendarPosition(event.clientX, columnBounds(event.currentTarget)),
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setPreview(`${boundary === 'startOn' ? 'Start' : 'End'}: ${a.data[boundary]}`);
        } catch (error) {
          cancel();
          onError(error instanceof Error ? error : new Error('Unable to resize allocation'));
        }
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        try {
          const date = capacityResizeDates(a, boundary, deltaAt(event))[boundary];
          setPreview(`${boundary === 'startOn' ? 'Start' : 'End'}: ${date}`);
        } catch (error) {
          setPreview(error instanceof Error ? error.message : 'Invalid date range');
        }
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        try {
          resize(boundary, deltaAt(event));
        } catch (error) {
          onError(error instanceof Error ? error : new Error('Unable to resize allocation'));
        } finally {
          cancel();
        }
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        resize(boundary, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 7 : 1));
      }}
    >
      <span aria-hidden="true">⋮</span>
    </button>
  );
  return (
    <div
      className="planner-capacity-allocation"
      data-capacity-allocation={a.id}
      style={{ '--capacity-color': color } as CSSProperties}
      onContextMenu={(event) => {
        if (editable) {
          event.preventDefault();
          setMenuOpen(true);
        }
      }}
    >
      <button
        type="button"
        className="planner-capacity-bar"
        title={description}
        draggable={editable && !a.archived}
        aria-pressed={selected}
        onDragStart={(event) => event.dataTransfer.setData('text/plain', a.id)}
        onClick={(event) => {
          if (editable) {
            if (event.ctrlKey || event.metaKey) onSelect();
            else onEdit();
          }
        }}
        onKeyDown={(event) => {
          if (
            editable &&
            (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
          ) {
            event.preventDefault();
            event.stopPropagation();
            setMenuOpen(true);
          }
        }}
      >
        {label}
      </button>
      {editable &&
        !a.archived &&
        a.data.startOn >= column.start &&
        a.data.startOn <= column.end &&
        handle('startOn')}
      {editable &&
        !a.archived &&
        a.data.endOn >= column.start &&
        a.data.endOn <= column.end &&
        handle('endOn')}
      {editable && (
        <MenuTrigger isOpen={menuOpen} onOpenChange={setMenuOpen}>
          <Button
            className="planner-capacity-allocation-menu"
            aria-label={`Actions for ${description}`}
          >
            <MoreHorizontal size={13} />
          </Button>
          <Popover className="planner-capacity-menu-popover" placement="bottom end">
            <Menu
              aria-label="Allocation actions"
              onAction={(action) => {
                if (!editable) return;
                if (action === 'edit') onEdit();
                else if (action === 'select') onSelect();
                else
                  onChange({
                    id: a.id,
                    version: a.version,
                    ...(action === 'duplicate'
                      ? { duplicateId: crypto.randomUUID() }
                      : { archived: !a.archived }),
                  });
              }}
            >
              <MenuItem id="edit">Edit allocation</MenuItem>
              <MenuItem id="select">
                {selected ? 'Deselect allocation' : 'Select for bulk actions'}
              </MenuItem>
              {!a.archived && <MenuItem id="duplicate">Duplicate allocation</MenuItem>}
              <MenuItem id="archive">
                {a.archived ? 'Restore allocation' : 'Archive allocation'}
              </MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
      )}
      {preview && (
        <span className="planner-capacity-resize-preview" role="status">
          {preview}
        </span>
      )}
    </div>
  );
}
