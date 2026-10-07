// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PlannerAllocationBar,
  capacityCalendarPosition,
  capacityResizeDates,
} from './planner-capacity-bar.js';
import type { PlannerCapacityAllocation } from '@capiro/strategy-verifier';

const allocation: PlannerCapacityAllocation = {
  id: '80000000-0000-4000-8000-000000000004',
  name: 'Allocation',
  ownerId: 'owner',
  version: 4,
  access: 'admin',
  archived: false,
  projectId: 'project',
  projectName: 'Launch',
  personName: 'Owner',
  weeklyMinutes: 2400,
  teamId: null,
  jobTitle: '',
  data: {
    userId: 'owner',
    placeholderId: null,
    startOn: '2026-10-05',
    endOn: '2026-10-09',
    effort: { unit: 'hours', value: 20 },
  },
};
const save = vi.fn(),
  edit = vi.fn(),
  select = vi.fn(),
  error = vi.fn();
function fixture(row = allocation, column = { start: '2026-10-05', end: '2026-10-11' }) {
  render(
    <div className="planner-capacity-row">
      <div data-capacity-start={column.start} data-capacity-end={column.end}>
        <PlannerAllocationBar
          allocation={row}
          column={column}
          label="Launch"
          description="Launch · Owner · October staffing"
          color="#7565dd"
          selected={false}
          canEdit
          onChange={save}
          onEdit={edit}
          onSelect={select}
          onError={error}
        />
      </div>
      <div data-capacity-start="2026-10-12" data-capacity-end="2026-10-18" />
    </div>,
  );
  document.querySelectorAll<HTMLElement>('[data-capacity-start]').forEach((cell, index) => {
    cell.getBoundingClientRect = () => ({ left: 100 + index * 140, width: 140 }) as DOMRect;
  });
  for (const handle of screen.queryAllByRole('button', { name: /Resize/ }))
    handle.setPointerCapture = vi.fn();
}
beforeEach(() => {
  for (const fn of [save, edit, select, error]) fn.mockReset();
  class Pointer extends MouseEvent {
    pointerId: number;
    isPrimary: boolean;
    constructor(type: string, init: PointerEventInit) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  vi.stubGlobal('PointerEvent', Pointer);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Capacity direct allocation controls', () => {
  it('maps visible pixel movement to actual calendar days across unequal month lengths', () => {
    const columns = [
      { start: '2028-02-01', end: '2028-02-29', left: 20, width: 290 },
      { start: '2028-03-01', end: '2028-03-31', left: 310, width: 310 },
    ];
    expect(capacityCalendarPosition(350, columns) - capacityCalendarPosition(300, columns)).toBe(5);
    expect(capacityCalendarPosition(0, columns) - capacityCalendarPosition(20, columns)).toBe(-2);
    expect(() => capacityCalendarPosition(5, [{ ...columns[0]!, width: 0 }])).toThrow(
      'timeline changed',
    );
  });
  it('commits a pointer resize once with the original version and leaves total effort untouched', () => {
    fixture();
    const handle = screen.getByRole('button', { name: /Resize end/ });
    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 180, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 240 });
    expect(screen.getByRole('status')).toHaveTextContent('End: 2026-10-12');
    expect(save).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 240 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      id: allocation.id,
      version: 4,
      data: { endOn: '2026-10-12' },
    });
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 240 });
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('cancels pointer loss, Escape and unchanged drags without a mutation', () => {
    fixture();
    const handle = screen.getByRole('button', { name: /Resize end/ });
    fireEvent.pointerDown(handle, { clientX: 180, button: 0 });
    fireEvent.pointerMove(handle, { clientX: 240 });
    fireEvent.pointerCancel(handle);
    fireEvent.pointerUp(handle, { clientX: 240 });
    fireEvent.pointerDown(handle, { clientX: 180, button: 0 });
    fireEvent.keyDown(handle, { key: 'Escape' });
    fireEvent.pointerUp(handle, { clientX: 240 });
    fireEvent.pointerDown(handle, { clientX: 180, button: 0 });
    fireEvent.pointerUp(handle, { clientX: 180 });
    expect(save).not.toHaveBeenCalled();
  });
  it('resizes by day/week with the keyboard and rejects crossed or nonworking ranges', () => {
    fixture();
    fireEvent.keyDown(screen.getByRole('button', { name: /Resize end/ }), {
      key: 'ArrowRight',
      shiftKey: true,
    });
    expect(save).toHaveBeenCalledWith({
      id: allocation.id,
      version: 4,
      data: { endOn: '2026-10-16' },
    });
    fireEvent.keyDown(screen.getByRole('button', { name: /Resize start/ }), {
      key: 'ArrowRight',
      shiftKey: true,
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'The start date must be on or before the end date.' }),
    );
    expect(() =>
      capacityResizeDates(
        { ...allocation, data: { ...allocation.data, startOn: '2026-10-09', endOn: '2026-10-11' } },
        'startOn',
        1,
      ),
    ).toThrow('working day');
    expect(() => capacityResizeDates(allocation, 'endOn', 3661)).toThrow('ten years');
  });
  it('opens a keyboard accessible context menu and duplicates without shifting dates', async () => {
    fixture();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Launch' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate allocation' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ id: allocation.id, version: 4 });
    expect(save.mock.calls[0]![0].duplicateId).toMatch(/^[a-f0-9-]{36}$/);
    expect(save.mock.calls[0]![0]).not.toHaveProperty('shiftDays');
    expect(save.mock.calls[0]![0]).not.toHaveProperty('data');
  });
  it('offers recoverable archive/restore, bulk selection and edit from the menu', async () => {
    fixture();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Launch' }), {
      key: 'F10',
      shiftKey: true,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Select for bulk actions' }));
    expect(select).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Actions for/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive allocation' }));
    expect(save).toHaveBeenCalledWith({ id: allocation.id, version: 4, archived: true });
    cleanup();
    save.mockClear();
    fixture({ ...allocation, archived: true });
    expect(screen.queryByRole('button', { name: /Resize/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Actions for/ }));
    expect(
      screen.queryByRole('menuitem', { name: 'Duplicate allocation' }),
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Restore allocation' }));
    expect(save).toHaveBeenCalledWith({ id: allocation.id, version: 4, archived: false });
  });
  it('does not expose mutation controls to project viewers and only exposes edges in their actual columns', () => {
    fixture({ ...allocation, access: 'viewer' });
    expect(screen.queryByRole('button', { name: /Resize|Actions for/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Launch' })).toHaveAttribute('draggable', 'false');
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Launch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(edit).not.toHaveBeenCalled();
    cleanup();
    fixture({
      ...allocation,
      data: { ...allocation.data, startOn: '2026-09-28', endOn: '2026-10-16' },
    });
    expect(screen.queryByRole('button', { name: /Resize/ })).not.toBeInTheDocument();
  });
});
