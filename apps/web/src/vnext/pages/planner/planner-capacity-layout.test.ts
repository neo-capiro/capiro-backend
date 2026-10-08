import { describe, expect, it } from 'vitest';
import type { PlannerCapacityAllocation } from '@capiro/strategy-verifier';
import { capacityAllocationLayout, capacityDateAt } from './planner-capacity-layout.js';

const row = (id: string, startOn: string, endOn: string) =>
  ({ id, data: { startOn, endOn } }) as PlannerCapacityAllocation;
describe('Calendar staffing geometry', () => {
  it('positions an inclusive partial week across column boundaries as one bar', () => {
    const columns = [
      { start: '2026-10-05', end: '2026-10-11' },
      { start: '2026-10-12', end: '2026-10-18' },
    ];
    const [bar] = capacityAllocationLayout([row('a', '2026-10-07', '2026-10-16')], columns);
    expect(bar!.left).toBeCloseTo((100 * 2) / 14);
    expect(bar!.width).toBeCloseTo((100 * 10) / 14);
  });
  it('handles unequal calendar months, leap days and visible-window clipping', () => {
    const columns = [
      { start: '2028-02-01', end: '2028-02-29' },
      { start: '2028-03-01', end: '2028-03-31' },
    ];
    const bars = capacityAllocationLayout(
      [
        row('a', '2028-02-29', '2028-03-01'),
        row('b', '2028-01-01', '2028-02-02'),
        row('c', '2028-03-30', '2028-04-20'),
        row('off', '2028-04-21', '2028-04-22'),
      ],
      columns,
    );
    const a = bars.find((b) => b.allocation.id === 'a')!;
    expect(a.left).toBeCloseTo((50 * 28) / 29);
    expect(a.width).toBeCloseTo(50 / 29 + 50 / 31);
    expect(bars.find((b) => b.allocation.id === 'b')!.left).toBe(0);
    const c = bars.find((b) => b.allocation.id === 'c')!;
    expect(c.left + c.width).toBeCloseTo(100);
    expect(bars).toHaveLength(3);
  });
  it('keeps overlapping allocations in distinct stable lanes and reuses a freed lane', () => {
    const columns = [{ start: '2026-10-01', end: '2026-10-31' }];
    const rows = [
      row('a', '2026-10-05', '2026-10-09'),
      row('b', '2026-10-07', '2026-10-14'),
      row('c', '2026-10-10', '2026-10-12'),
    ];
    const layout = capacityAllocationLayout(rows, columns);
    expect(layout.map((b) => [b.allocation.id, b.lane])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 0],
    ]);
    expect(capacityAllocationLayout([...rows].reverse(), columns)).toEqual(layout);
  });
  it('maps the pointer to exact days after horizontal scrolling, including weekends', () => {
    const columns = [
      { start: '2026-10-05', end: '2026-10-11', left: -60, width: 140 },
      { start: '2026-10-12', end: '2026-10-18', left: 80, width: 140 },
    ];
    expect(capacityDateAt(41, columns)).toBe('2026-10-10');
    expect(capacityDateAt(80, columns)).toBe('2026-10-12');
    expect(capacityDateAt(130, columns)).toBe('2026-10-14');
    expect(capacityDateAt(220, columns)).toBe('2026-10-18');
    expect(() => capacityDateAt(20, [])).toThrow('timeline changed');
    expect(() => capacityDateAt(NaN, columns)).toThrow('timeline changed');
    expect(() => capacityDateAt(20, [{ ...columns[0]!, width: 0 }])).toThrow('timeline changed');
  });
});
