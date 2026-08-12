import { describe, expect, it } from 'vitest';
import {
  assignLanes,
  axisPosition,
  barGeometry,
  buildFiscalAxis,
  laneCount,
} from './timeline.js';

describe('buildFiscalAxis', () => {
  it('spans inclusive fiscal years with 12 months each', () => {
    const axis = buildFiscalAxis(2027, 2029);
    expect(axis.cells).toHaveLength(36);
    expect(axis.startFy).toBe(2027);
    expect(axis.endFy).toBe(2029);
  });

  it('starts FY27 in October 2026 (federal fiscal convention)', () => {
    const axis = buildFiscalAxis(2027, 2027);
    expect(axis.cells[0]!.label).toBe('OCT');
    expect(axis.cells[0]!.year).toBe(2026);
    expect(axis.cells[0]!.fy).toBe(2027);
    expect(axis.cells[0]!.fiscalYearStart).toBe(true);
    // September 2027 closes FY27.
    expect(axis.cells[11]!.label).toBe('SEP');
    expect(axis.cells[11]!.fy).toBe(2027);
  });

  it('marks a fiscal-year boundary at each October', () => {
    const axis = buildFiscalAxis(2027, 2029);
    const boundaries = axis.cells.filter((c) => c.fiscalYearStart);
    expect(boundaries).toHaveLength(3);
  });
});

describe('axisPosition', () => {
  it('clamps to [0,1]', () => {
    const axis = buildFiscalAxis(2027, 2027);
    expect(axisPosition(axis, new Date(Date.UTC(2020, 0, 1)))).toBe(0);
    expect(axisPosition(axis, new Date(Date.UTC(2030, 0, 1)))).toBe(1);
  });
});

describe('barGeometry', () => {
  const axis = buildFiscalAxis(2027, 2029);
  it('clips a bar that starts before the axis', () => {
    const g = barGeometry(axis, '2026-01-01', '2027-06-01');
    expect(g).not.toBeNull();
    expect(g!.clippedStart).toBe(true);
    expect(g!.left).toBe(0);
  });
  it('returns null only when fully outside', () => {
    expect(barGeometry(axis, '2035-01-01', '2036-01-01')).toBeNull();
  });
  it('gives a point-in-time bar a minimum visible width', () => {
    const g = barGeometry(axis, '2027-03-14', '2027-03-14');
    expect(g).not.toBeNull();
    expect(g!.width).toBeGreaterThan(0);
  });
});

describe('assignLanes', () => {
  it('separates overlapping bars into distinct lanes', () => {
    const laned = assignLanes([
      { id: 'a', startIso: '2027-01-01', endIso: '2027-06-01' },
      { id: 'b', startIso: '2027-03-01', endIso: '2027-08-01' },
    ]);
    expect(laneCount(laned)).toBe(2);
  });
  it('reuses a lane for non-overlapping bars', () => {
    const laned = assignLanes([
      { id: 'a', startIso: '2027-01-01', endIso: '2027-02-01' },
      { id: 'b', startIso: '2027-03-01', endIso: '2027-04-01' },
    ]);
    expect(laneCount(laned)).toBe(1);
  });
  it('is stable across renders (same input order independence)', () => {
    const a = { id: 'a', startIso: '2027-01-01', endIso: '2027-06-01' };
    const b = { id: 'b', startIso: '2027-03-01', endIso: '2027-08-01' };
    const first = assignLanes([a, b]).map((l) => `${l.item.id}:${l.lane}`);
    const second = assignLanes([b, a]).map((l) => `${l.item.id}:${l.lane}`);
    expect(first.sort()).toEqual(second.sort());
  });
});
