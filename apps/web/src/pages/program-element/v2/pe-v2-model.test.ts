import { describe, expect, it } from 'vitest';
import {
  ladderCells,
  money,
  railGeometry,
  recommendedAction,
  sgn,
  sparkGeometry,
  spct,
  toLineRow,
  currentStageId,
} from './pe-v2-model.js';
import { buildFundingSeries } from '../funding-model.js';
import type { ProgramElementYearPoint } from '../types.js';

describe('pe-v2-model formatting', () => {
  it('formats money in $M with one decimal and $B above 1000', () => {
    expect(money(156.9)).toBe('$156.9M');
    expect(money(1796.1)).toBe('$1.80B');
    expect(money(null)).toBe('—');
  });
  it('formats signed deltas with a true minus', () => {
    expect(sgn(-22.7)).toBe('−$22.7M');
    expect(sgn(8)).toBe('+$8.0M');
    expect(spct(-11.8)).toBe('−11.8%');
  });
});

describe('ladderCells', () => {
  const years: ProgramElementYearPoint[] = [
    {
      id: 'y1',
      fy: 2027,
      request: 192.2,
      hascMark: 192.2,
      sascMark: null,
      hacDMark: 169.5,
      sacDMark: null,
      conference: null,
      ndaaConference: null,
      enacted: null,
    },
  ];
  const fp = buildFundingSeries(years)[0]!;

  it('authorization ladder carries request/hasc and absent words for unfiled stages', () => {
    const cells = ladderCells(fp, 'auth');
    expect(cells.map((c) => c.stage)).toEqual(['request', 'hasc', 'sasc', 'ndaaConf']);
    expect(cells[0]!.value).toBe(192.2);
    expect(cells[1]!.value).toBe(192.2);
    expect(cells[2]!.value).toBeNull();
    expect(cells[2]!.stateWord).toBe('NOT FILED');
    expect(cells[2]!.ev).toBe('ABSENT');
  });

  it('appropriations ladder computes delta vs request only for filed stages', () => {
    const cells = ladderCells(fp, 'appr');
    const hacd = cells.find((c) => c.stage === 'hacd')!;
    expect(hacd.value).toBe(169.5);
    expect(hacd.delta).toBeCloseTo(-22.7, 5);
    const enacted = cells.find((c) => c.stage === 'enacted')!;
    expect(enacted.stateWord).toBe('NOT ENACTED');
  });

  it('request stage never carries a delta', () => {
    const cells = ladderCells(fp, 'appr');
    expect(cells[0]!.delta).toBeNull();
  });
});

describe('currentStageId', () => {
  it('maps the canonical precedence pick onto v2 ladder ids', () => {
    const years: ProgramElementYearPoint[] = [
      {
        id: 'y1',
        fy: 2027,
        request: 100,
        hascMark: null,
        sascMark: null,
        hacDMark: 92,
        sacDMark: null,
        conference: null,
        enacted: null,
      },
    ];
    const fp = buildFundingSeries(years)[0]!;
    expect(currentStageId(fp)).toBe('hacd');
  });
  it('returns null for an empty series', () => {
    expect(currentStageId(undefined)).toBeNull();
  });
});

describe('railGeometry', () => {
  it('is a dashed noposition box when pct is null', () => {
    expect(railGeometry(null).kind).toBe('nopos');
  });
  it('renders nothing for zero', () => {
    expect(railGeometry(0).kind).toBe('none');
  });
  it('bars left for decrease, right for increase, clamped at 58px', () => {
    const down = railGeometry(-11.8);
    expect(down.kind).toBe('bar');
    expect(down.style).toMatchObject({ right: '50%', background: '#131A24' });
    const up = railGeometry(45);
    expect(up.style).toMatchObject({ left: '50%', background: '#2F6B4F', width: 58 });
  });
});

describe('sparkGeometry', () => {
  it('needs at least two points', () => {
    expect(sparkGeometry([])).toBeNull();
    expect(sparkGeometry([5])).toBeNull();
  });
  it('produces a polyline inside the 72×18 box with an end square', () => {
    const g = sparkGeometry([10, 12, 9, 14])!;
    expect(g.points.split(' ')).toHaveLength(4);
    expect(g.endX).toBeGreaterThan(0);
    expect(g.endY).toBeGreaterThanOrEqual(0);
  });
});

describe('toLineRow + recommendedAction', () => {
  const base = {
    peCode: '0603270A',
    title: 'EW Payloads',
    service: 'ARMY',
    budgetActivity: 'BA 5',
    appropriationType: 'RDTE',
    status: 'active',
    lastSyncedAt: '2026-08-07T00:00:00Z',
  };

  it('pairs delta only when current and request share an FY', () => {
    const paired = toLineRow({
      ...base,
      latestRequest: 192.2,
      latestRequestFy: 2027,
      latestCurrent: 169.5,
      latestCurrentFy: 2027,
    });
    expect(paired.delta).toBeCloseTo(-22.7, 5);
    expect(paired.pct).toBeCloseTo(-11.8, 1);

    const crossFy = toLineRow({
      ...base,
      latestRequest: 192.2,
      latestRequestFy: 2026,
      latestCurrent: 169.5,
      latestCurrentFy: 2027,
      deltaPct: null,
    });
    expect(crossFy.delta).toBeNull();
    expect(crossFy.pct).toBeNull();
  });

  it('recommends Protect funding on a cut signal, Monitor enactment otherwise', () => {
    expect(recommendedAction(toLineRow({ ...base, actionSignalType: 'cut' }))).toBe('Protect funding');
    expect(recommendedAction(toLineRow({ ...base }))).toBe('Monitor enactment');
  });
});
