// Pure-logic tests for the outreach judge-calibration harness (W1.3). The live
// ranking session is Ninja's (a hard human dependency), but the Spearman math and
// the report-flattening must be correct BEFORE that session, so a bad correlation
// is never mistaken for a bad judge. No API calls.

import { describe, expect, test } from '@jest/globals';
import { extractDraftRows, spearman } from './eval-outreach-calibrate.js';

describe('spearman rank correlation', () => {
  test('perfect agreement → 1', () => {
    const a = { x: 1, y: 2, z: 3, w: 4 };
    const b = { x: 10, y: 20, z: 30, w: 40 };
    expect(spearman(a, b)).toBeCloseTo(1, 6);
  });

  test('perfect disagreement → -1', () => {
    const a = { x: 1, y: 2, z: 3, w: 4 };
    const b = { x: 40, y: 30, z: 20, w: 10 };
    expect(spearman(a, b)).toBeCloseTo(-1, 6);
  });

  test('monotonic-but-nonlinear agreement still → 1 (rank-based)', () => {
    const a = { x: 1, y: 2, z: 3, w: 4 };
    const b = { x: 1, y: 4, z: 9, w: 16 };
    expect(spearman(a, b)).toBeCloseTo(1, 6);
  });

  test('handles ties via averaged ranks without NaN', () => {
    const a = { x: 1, y: 1, z: 3, w: 4 };
    const b = { x: 5, y: 6, z: 7, w: 8 };
    const rho = spearman(a, b);
    expect(Number.isNaN(rho)).toBe(false);
    expect(rho).toBeGreaterThan(0.7);
  });

  test('only correlates ids present in BOTH maps', () => {
    const a = { x: 1, y: 2, z: 3 };
    const b = { x: 10, y: 20, z: 30, extra: 999 };
    expect(spearman(a, b)).toBeCloseTo(1, 6);
  });

  test('a 0.7-passing case is distinguishable from a failing one', () => {
    // 5 items: judge order x<y<z<w<v; ninja mostly agrees (swaps the top two).
    const judge = { x: 1, y: 2, z: 3, w: 4, v: 5 };
    const ninjaGoodness = { x: 1, y: 2, z: 3, w: 5, v: 4 }; // swap top pair
    expect(spearman(judge, ninjaGoodness)).toBeGreaterThanOrEqual(0.7);
    // near-random ordering fails
    const ninjaBad = { x: 3, y: 1, z: 5, w: 2, v: 4 };
    expect(spearman(judge, ninjaBad)).toBeLessThan(0.7);
  });
});

describe('extractDraftRows', () => {
  test('flattens fixtures×models into id=fixture::model rows with judge averages', () => {
    const report = {
      fixtures: {
        'ind-rich': {
          'claude-haiku-4-5': {
            judge: { scores: { Grounding: 4, Tone: 5 } },
            draft: { subject: 'S1', body: 'B1' },
          },
          'claude-sonnet-4-6': {
            judge: { scores: { Grounding: 5, Tone: 5 } },
            draft: { subject: 'S2', body: 'B2' },
          },
        },
      },
    };
    const rows = extractDraftRows(report);
    expect(rows).toHaveLength(2);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['ind-rich::claude-haiku-4-5']!.judgeAvg).toBeCloseTo(4.5, 6);
    expect(byId['ind-rich::claude-sonnet-4-6']!.judgeAvg).toBeCloseTo(5, 6);
    expect(byId['ind-rich::claude-haiku-4-5']!.subject).toBe('S1');
  });

  test('empty/missing judge scores → judgeAvg 0, never NaN', () => {
    const rows = extractDraftRows({
      fixtures: { f: { m: { draft: { subject: 's', body: 'b' } } } },
    });
    expect(rows[0]!.judgeAvg).toBe(0);
  });
});
