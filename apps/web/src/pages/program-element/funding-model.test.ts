import { describe, it, expect } from 'vitest';
import {
  buildFundingSeries,
  currentFunding,
  congressionalPosition,
  STAGE_LABEL,
  CURRENT_PRECEDENCE,
  CONGRESSIONAL_PRECEDENCE,
  type FundingStage,
} from './funding-model.js';
import { fundingCurrentCoalesceSql } from '@capiro/shared';
import type { ProgramElementYearPoint } from './types.js';

/** Build a sparse year point; `?? null` keeps an explicit 0 (E-7 FY27 request=0). */
function yr(fy: number, f: Partial<ProgramElementYearPoint>): ProgramElementYearPoint {
  return {
    id: `y${fy}`,
    fy,
    request: f.request ?? null,
    hascMark: f.hascMark ?? null,
    sascMark: f.sascMark ?? null,
    hacDMark: f.hacDMark ?? null,
    sacDMark: f.sacDMark ?? null,
    conference: f.conference ?? null,
    enacted: f.enacted ?? null,
  };
}

/** Build the series and return its first point, asserting it exists. */
function one(years: ProgramElementYearPoint[]) {
  const series = buildFundingSeries(years);
  const p = series[0];
  if (!p) throw new Error('expected at least one funding point');
  return p;
}

describe('funding-model — precedence invariants', () => {
  it('CURRENT_PRECEDENCE is the congressional ladder plus a request fallback', () => {
    expect(CURRENT_PRECEDENCE).toEqual([...CONGRESSIONAL_PRECEDENCE, 'request']);
    expect(CONGRESSIONAL_PRECEDENCE).not.toContain('request');
  });

  it('every stage has a human label', () => {
    const stages: FundingStage[] = [
      'enacted',
      'conference',
      'sacd',
      'hacd',
      'sasc',
      'hasc',
      'request',
      'none',
    ];
    for (const s of stages) expect(STAGE_LABEL[s]).toBeTruthy();
  });
});

describe('funding-model — grounded in real prod PEs (Step 0 regression lock)', () => {
  it('Sentinel/GBSD 0605238F FY2026: conference wins over request AND over committee marks', () => {
    // Real stored row: request 2647.56, hasc 3047.56, sasc 4647.56, conf 3847.56, enacted null.
    const p = one([
      yr(2026, { request: 2647.56, hascMark: 3047.56, sascMark: 4647.56, conference: 3847.56 }),
    ]);
    expect(p.current).toEqual({ value: 3847.56, stage: 'conference' });
    expect(p.congressional).toEqual({ value: 3847.56, stage: 'conference' });
    // The $1,200M split the two tabs used to disagree on is now one number.
    expect(p.deltaVsRequest).toBeCloseTo(1200, 2);
  });

  it('E-7 0604007F FY2027: HAC-D mark drives current (fixes the $0-bar bug)', () => {
    // Real stored row: request 0, sasc 1500, hacd 1549.1 — no conference/enacted.
    const p = one([yr(2027, { request: 0, sascMark: 1500, hacDMark: 1549.1 })]);
    // Old FyHistoryChart blend (enacted→conference→request) showed $0 here.
    expect(p.current).toEqual({ value: 1549.1, stage: 'hacd' });
    expect(p.congressional).toEqual({ value: 1549.1, stage: 'hacd' });
    expect(p.deltaVsRequest).toBeCloseTo(1549.1, 2);
  });

  it('Sentinel FY2024: enacted-only historical year, delta null when request absent', () => {
    const p = one([yr(2024, { enacted: 4327.25 })]);
    expect(p.current).toEqual({ value: 4327.25, stage: 'enacted' });
    expect(p.congressional).toEqual({ value: 4327.25, stage: 'enacted' });
    expect(p.deltaVsRequest).toBeNull();
  });

  it('Sentinel FY2025: enacted below request yields a negative (cut) delta', () => {
    const p = one([
      yr(2025, { request: 3721.02, enacted: 2011.02, hascMark: 3721.02, sascMark: 3721.02 }),
    ]);
    expect(p.current).toEqual({ value: 2011.02, stage: 'enacted' });
    expect(p.deltaVsRequest).toBeCloseTo(-1710, 2);
  });

  it('CH-53K 1506N0158 FY2028: request-only year — current=request, no congressional position', () => {
    const p = one([yr(2028, { request: 3261.2 })]);
    expect(p.current).toEqual({ value: 3261.2, stage: 'request' });
    expect(p.congressional).toEqual({ value: null, stage: 'none' });
    expect(p.deltaVsRequest).toBeNull();
  });
});

describe('funding-model — stage precedence', () => {
  it('enacted outranks every other stage', () => {
    expect(
      currentFunding({
        request: 1,
        hascMark: 2,
        sascMark: 3,
        hacDMark: 4,
        sacDMark: 5,
        conference: 6,
        enacted: 7,
      }),
    ).toEqual({ value: 7, stage: 'enacted' });
  });

  it('conference outranks all committee marks when enacted is absent', () => {
    expect(
      currentFunding({
        request: 1,
        hascMark: 2,
        sascMark: 3,
        hacDMark: 4,
        sacDMark: 5,
        conference: 6,
        enacted: null,
      }),
    ).toEqual({ value: 6, stage: 'conference' });
  });

  it('SAC-D outranks HAC-D/SASC/HASC', () => {
    expect(
      currentFunding({
        request: 1,
        hascMark: 2,
        sascMark: 3,
        hacDMark: 4,
        sacDMark: 5,
        conference: null,
        enacted: null,
      }),
    ).toEqual({ value: 5, stage: 'sacd' });
  });

  it('HAC-D outranks SASC/HASC', () => {
    expect(
      currentFunding({
        request: 1,
        hascMark: 2,
        sascMark: 3,
        hacDMark: 4,
        sacDMark: null,
        conference: null,
        enacted: null,
      }),
    ).toEqual({ value: 4, stage: 'hacd' });
  });

  it('request is the fallback for current but never a congressional position', () => {
    const values = {
      request: 100,
      hascMark: null,
      sascMark: null,
      hacDMark: null,
      sacDMark: null,
      conference: null,
      enacted: null,
    };
    expect(currentFunding(values)).toEqual({ value: 100, stage: 'request' });
    expect(congressionalPosition(values)).toEqual({ value: null, stage: 'none' });
  });

  it('empty year yields none/none/null', () => {
    const p = one([yr(2030, {})]);
    expect(p.current).toEqual({ value: null, stage: 'none' });
    expect(p.congressional).toEqual({ value: null, stage: 'none' });
    expect(p.deltaVsRequest).toBeNull();
  });
});

describe('funding-model — coercion + ordering', () => {
  it('coerces string money fields and rejects blanks / non-numerics', () => {
    const p = one([
      yr(2026, {
        request: '220.00' as unknown as number,
        enacted: '' as unknown as number,
        conference: 'n/a' as unknown as number,
      }),
    ]);
    expect(p.request).toBe(220);
    expect(p.enacted).toBeNull();
    expect(p.conference).toBeNull();
    expect(p.current).toEqual({ value: 220, stage: 'request' });
  });

  it('sorts output ascending by fiscal year regardless of input order', () => {
    const out = buildFundingSeries([
      yr(2027, { request: 3 }),
      yr(2025, { request: 1 }),
      yr(2026, { request: 2 }),
    ]);
    expect(out.map((p) => p.fy)).toEqual([2025, 2026, 2027]);
  });

  it('does not mutate the input array', () => {
    const input = [yr(2027, { request: 3 }), yr(2025, { request: 1 })];
    const before = input.map((y) => y.fy);
    buildFundingSeries(input);
    expect(input.map((y) => y.fy)).toEqual(before);
  });

  it('treats an explicit request of 0 as present (not null)', () => {
    const p = one([yr(2027, { request: 0 })]);
    expect(p.request).toBe(0);
    expect(p.current).toEqual({ value: 0, stage: 'request' });
  });
});

describe('funding-model — cross-chart consistency invariants', () => {
  // The Overview trajectory plots current.value; the Funding-tab bar computes
  // currentFunding() over the same inputs; the delta bars plot deltaVsRequest.
  // These invariants lock that the three cannot disagree by construction.
  const series = buildFundingSeries([
    yr(2024, { enacted: 4327.25 }),
    yr(2025, { request: 3721.02, enacted: 2011.02, hascMark: 3721.02 }),
    yr(2026, { request: 2647.56, hascMark: 3047.56, sascMark: 4647.56, conference: 3847.56 }),
    yr(2027, { request: 0, sascMark: 1500, hacDMark: 1549.1 }),
    yr(2028, { request: 3261.2 }),
    yr(2030, {}),
  ]);

  it('current equals a fresh currentFunding() over the same inputs (bar == trajectory)', () => {
    for (const p of series) {
      expect(
        currentFunding({
          request: p.request,
          hascMark: p.hascMark,
          sascMark: p.sascMark,
          hacDMark: p.hacDMark,
          sacDMark: p.sacDMark,
          conference: p.conference,
          enacted: p.enacted,
        }),
      ).toEqual(p.current);
    }
  });

  it('request + deltaVsRequest reconstructs the congressional position (delta == trajectory)', () => {
    for (const p of series) {
      if (p.deltaVsRequest == null) continue;
      expect(p.request).not.toBeNull();
      expect(p.congressional.value).not.toBeNull();
      expect(p.request! + p.deltaVsRequest).toBeCloseTo(p.congressional.value!, 6);
      // When a congressional stage is the current one, current == congressional.
      if (p.current.stage !== 'request') {
        expect(p.current.value!).toBeCloseTo(p.congressional.value!, 6);
      }
    }
  });
});

describe('shared SQL current-coalesce generation (API↔web drift guard)', () => {
  // The API builds its server-side "current" COALESCE ladder from the SAME
  // shared precedence via fundingCurrentCoalesceSql, so it cannot drift from the
  // client model. This locks the generated column order + snake_case mapping.
  it('emits the COALESCE ladder in canonical precedence order with a table prefix', () => {
    expect(fundingCurrentCoalesceSql('y.')).toBe(
      'COALESCE(y.enacted, y.conference, y.sac_d_mark, y.hac_d_mark, y.sasc_mark, y.hasc_mark, y.request)',
    );
  });

  it('supports no prefix', () => {
    expect(fundingCurrentCoalesceSql()).toBe(
      'COALESCE(enacted, conference, sac_d_mark, hac_d_mark, sasc_mark, hasc_mark, request)',
    );
  });
});
