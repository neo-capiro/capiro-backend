import {
  OUTYEAR_SHIFT_ABS_M,
  deltasFromPositions,
  deltasFromProcurement,
  deltasFromYear,
  newStartFromYears,
  type ProcurementLineLike,
  type YearLike,
} from './delta-compute.js';
import type { BudgetPositionLike } from '../budget-position.js';

const year = (over: Partial<YearLike> = {}): YearLike => ({
  fy: 2027,
  request: null,
  hascMark: null,
  sascMark: null,
  hacDMark: null,
  sacDMark: null,
  conference: null,
  enacted: null,
  ...over,
});

const total = (
  positionCycle: string,
  assertedFy: number,
  amount: number | null,
): BudgetPositionLike => ({
  positionCycle,
  assertedFy,
  amount,
  valueKind: 'total',
});

describe('deltasFromYear — stage-ladder deltas (REAL data today)', () => {
  test('mark_vs_request for each present mark', () => {
    const d = deltasFromYear(year({ request: 100, hascMark: 120, sascMark: 90 }));
    const markVsReq = d.filter((x) => x.deltaType === 'mark_vs_request');
    expect(markVsReq).toHaveLength(2);
    const hasc = markVsReq.find((x) => x.toRef === 'hascMark')!;
    expect(hasc.amountFrom).toBe(100);
    expect(hasc.amountTo).toBe(120);
    expect(hasc.deltaAbs).toBe(20);
    expect(hasc.deltaPct).toBeCloseTo(0.2);
    expect(hasc.stage).toBe('marks');
  });

  test('mark_vs_mark only for diverging mark pairs', () => {
    const d = deltasFromYear(year({ request: 100, hascMark: 120, sascMark: 120 }));
    // HASC == SASC → no mark_vs_mark.
    expect(d.filter((x) => x.deltaType === 'mark_vs_mark')).toHaveLength(0);

    const d2 = deltasFromYear(year({ hascMark: 120, sascMark: 90 }));
    const mm = d2.filter((x) => x.deltaType === 'mark_vs_mark');
    expect(mm).toHaveLength(1);
    expect(mm[0]!.fromRef).toBe('hascMark');
    expect(mm[0]!.toRef).toBe('sascMark');
  });

  test('conference_vs_marks + enacted_vs_request', () => {
    const d = deltasFromYear(year({ request: 100, hascMark: 120, conference: 110, enacted: 110 }));
    expect(
      d.find((x) => x.deltaType === 'conference_vs_marks' && x.toRef === 'conference'),
    ).toBeTruthy();
    const enacted = d.find((x) => x.deltaType === 'enacted_vs_request')!;
    expect(enacted.amountTo).toBe(110);
    expect(enacted.stage).toBe('enacted');
  });

  test('mark_vs_mark is track-scoped — NEVER diffs an authorization mark against an appropriations mark', () => {
    // HASC (authorization / NDAA) vs HAC-D (appropriations / Defense Approps) are
    // different committees on different bills — this must NOT be a "divergence".
    const cross = deltasFromYear(year({ hascMark: 100, hacDMark: 200 }));
    expect(cross.filter((x) => x.deltaType === 'mark_vs_mark')).toHaveLength(0);

    // All four marks present + all diverging → exactly two within-track pairs
    // (HASC-vs-SASC and HAC-D-vs-SAC-D), never the 6 that an all-pairs loop makes.
    const all = deltasFromYear(
      year({ hascMark: 100, sascMark: 110, hacDMark: 200, sacDMark: 210 }),
    );
    const mm = all.filter((x) => x.deltaType === 'mark_vs_mark');
    expect(mm).toHaveLength(2);
    const pairs = mm.map((x) => `${x.fromRef}|${x.toRef}`).sort();
    expect(pairs).toEqual(['hacDMark|sacDMark', 'hascMark|sascMark']);
  });

  test('conference reconciles authorization marks only (it is NDAA-sourced)', () => {
    // conference = NDAA authorization conference; it must be compared to the
    // authorization marks (HASC/SASC) and NOT to the appropriations marks.
    const d = deltasFromYear(
      year({ hascMark: 100, sascMark: 110, hacDMark: 200, sacDMark: 210, conference: 105 }),
    );
    const cvm = d.filter((x) => x.deltaType === 'conference_vs_marks');
    expect(cvm.map((x) => x.fromRef).sort()).toEqual(['hascMark', 'sascMark']);
    expect(cvm.some((x) => x.fromRef === 'hacDMark' || x.fromRef === 'sacDMark')).toBe(false);
  });

  test('zeroed when conference cuts a positive request to 0', () => {
    const d = deltasFromYear(year({ request: 80, conference: 0 }));
    const z = d.find((x) => x.deltaType === 'zeroed')!;
    expect(z).toBeTruthy();
    expect(z.amountFrom).toBe(80);
    expect(z.amountTo).toBe(0);
  });

  test('no request → no mark_vs_request, but marks still compared to each other', () => {
    const d = deltasFromYear(year({ hascMark: 50, sascMark: 70 }));
    expect(d.filter((x) => x.deltaType === 'mark_vs_request')).toHaveLength(0);
    expect(d.filter((x) => x.deltaType === 'mark_vs_mark')).toHaveLength(1);
  });
});

describe('deltasFromPositions — PB / outyear deltas (dormant until ≥2 PB books)', () => {
  test('returns [] with fewer than two PB cycles', () => {
    expect(deltasFromPositions([])).toEqual([]);
    expect(deltasFromPositions([total('pb_fy2027', 2027, 100)])).toEqual([]);
  });

  test('pb_vs_prior_pb for an FY in both books', () => {
    const d = deltasFromPositions([total('pb_fy2027', 2027, 250), total('pb_fy2026', 2027, 200)]);
    const pb = d.find((x) => x.deltaType === 'pb_vs_prior_pb')!;
    expect(pb.amountFrom).toBe(200);
    expect(pb.amountTo).toBe(250);
    expect(pb.deltaAbs).toBe(50);
    expect(pb.deltaPct).toBeCloseTo(0.25);
  });

  test('new_start when present in current PB but not prior', () => {
    const d = deltasFromPositions([
      total('pb_fy2027', 2027, 100),
      total('pb_fy2027', 2028, 120),
      total('pb_fy2026', 2027, 90),
    ]);
    const ns = d.find((x) => x.deltaType === 'new_start' && x.assertedFy === 2028)!;
    expect(ns).toBeTruthy();
    expect(ns.amountTo).toBe(120);
    expect(ns.amountFrom).toBeNull();
  });

  test('termination when dropped from current PB', () => {
    const d = deltasFromPositions([
      total('pb_fy2027', 2027, 100),
      total('pb_fy2026', 2027, 90),
      total('pb_fy2026', 2028, 80),
    ]);
    const term = d.find((x) => x.deltaType === 'termination' && x.assertedFy === 2028)!;
    expect(term).toBeTruthy();
    expect(term.amountFrom).toBe(80);
    expect(term.deltaAbs).toBe(-80);
  });

  test('outyear_shift only for outyears clearing max($20M, 15%)', () => {
    const d = deltasFromPositions([
      // budget year 2027; 2028+ are outyears.
      total('pb_fy2027', 2027, 100),
      total('pb_fy2027', 2028, 200),
      total('pb_fy2027', 2029, 101), // outyear, tiny $1 move → no shift
      total('pb_fy2026', 2027, 100),
      total('pb_fy2026', 2028, 150), // +$50M outyear → shift
      total('pb_fy2026', 2029, 100),
    ]);
    const shifts = d.filter((x) => x.deltaType === 'outyear_shift');
    expect(shifts.map((s) => s.assertedFy)).toEqual([2028]);
    expect(Math.abs(shifts[0]!.deltaAbs!)).toBeGreaterThanOrEqual(OUTYEAR_SHIFT_ABS_M);
    // The budget year (2027) itself is NOT an outyear_shift even if it moved.
    expect(shifts.find((s) => s.assertedFy === 2027)).toBeUndefined();
  });
});

describe('deltasFromProcurement — quantity / unit-cost (dormant until P-1)', () => {
  test('returns [] with no lines', () => {
    expect(deltasFromProcurement([])).toEqual([]);
  });

  test('quantity_change + unit_cost_change across FYs for the same line', () => {
    const lines: ProcurementLineLike[] = [
      { lineDescription: 'F-35A', fy: 2026, quantity: 48, unitCost: 80 },
      { lineDescription: 'F-35A', fy: 2027, quantity: 42, unitCost: 85 },
    ];
    const d = deltasFromProcurement(lines);
    const q = d.find((x) => x.deltaType === 'quantity_change')!;
    expect(q.amountFrom).toBe(48);
    expect(q.amountTo).toBe(42);
    expect(q.deltaAbs).toBe(-6);
    const u = d.find((x) => x.deltaType === 'unit_cost_change')!;
    expect(u.amountTo).toBe(85);
  });

  test('no delta when a line is unchanged', () => {
    const lines: ProcurementLineLike[] = [
      { lineDescription: 'X', fy: 2026, quantity: 10, unitCost: 5 },
      { lineDescription: 'X', fy: 2027, quantity: 10, unitCost: 5 },
    ];
    expect(deltasFromProcurement(lines)).toEqual([]);
  });

  test('two recipients with the same FY transition get distinct from/to refs (no natural-key collision)', () => {
    // Army + ANG both move quantity 2026->2027. The delta natural key is
    // (peCode, assertedFy, deltaType, fromRef, toRef) and excludes the recipient,
    // so the refs MUST embed the recipient or the DB unique constraint collides.
    const lines: ProcurementLineLike[] = [
      { lineDescription: 'Army', fy: 2026, quantity: 26203, unitCost: null },
      { lineDescription: 'Army', fy: 2027, quantity: 16132, unitCost: null },
      { lineDescription: 'ANG', fy: 2026, quantity: 10094, unitCost: null },
      { lineDescription: 'ANG', fy: 2027, quantity: 22009, unitCost: null },
    ];
    const d = deltasFromProcurement(lines).filter((x) => x.deltaType === 'quantity_change');
    expect(d).toHaveLength(2);
    const keys = d.map((x) => `${x.assertedFy}|${x.deltaType}|${x.fromRef}|${x.toRef}`);
    expect(new Set(keys).size).toBe(2); // distinct natural keys
    const army = d.find((x) => (x.fromRef ?? '').includes('Army'))!;
    expect(army.fromRef).toBe('fy2026:Army');
    expect(army.toRef).toBe('fy2027:Army');
    expect(army.amountTo).toBe(16132);
  });
});

describe('newStartFromYears', () => {
  test('single brand-new FY with no prior PB → new_start', () => {
    const d = newStartFromYears([year({ fy: 2027, request: 25 })], false);
    expect(d).toHaveLength(1);
    expect(d[0]!.deltaType).toBe('new_start');
    expect(d[0]!.amountTo).toBe(25);
  });

  test('multi-FY PE is ongoing, not a new start', () => {
    expect(
      newStartFromYears([year({ fy: 2026, request: 10 }), year({ fy: 2027, request: 12 })], false),
    ).toEqual([]);
  });

  test('suppressed when a prior PB exists (the PB path owns it)', () => {
    expect(newStartFromYears([year({ fy: 2027, request: 25 })], true)).toEqual([]);
  });
});
