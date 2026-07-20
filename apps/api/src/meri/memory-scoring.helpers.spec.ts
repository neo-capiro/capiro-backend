import { describe, expect, test } from '@jest/globals';
import {
  DEFAULT_HALF_LIFE_DAYS,
  fuseRecallScore,
  normalizeWeights,
  recencyFactor,
  reciprocalRankFusion,
  rerankByFusion,
  type RecalledRow,
} from './memory-scoring.helpers.js';

const row = (over: Partial<RecalledRow> = {}): RecalledRow => ({
  key: 'k',
  value: 'v',
  similarity: 0.8,
  ...over,
});

describe('recencyFactor', () => {
  test('1 at age 0; 0.5 at one half-life; monotone decreasing', () => {
    expect(recencyFactor(0)).toBeCloseTo(1, 10);
    expect(recencyFactor(DEFAULT_HALF_LIFE_DAYS)).toBeCloseTo(0.5, 10);
    expect(recencyFactor(2 * DEFAULT_HALF_LIFE_DAYS)).toBeCloseTo(0.25, 10);
    expect(recencyFactor(30)).toBeGreaterThan(recencyFactor(400));
  });
  test('missing/NaN age ⇒ 1 (fail-open, never wrongly demote)', () => {
    expect(recencyFactor(null)).toBe(1);
    expect(recencyFactor(undefined)).toBe(1);
    expect(recencyFactor(NaN)).toBe(1);
  });
});

describe('fuseRecallScore', () => {
  test('THE Phase-5 criterion: equal similarity, fresher row scores higher', () => {
    const fresh = fuseRecallScore(row({ similarity: 0.8, ageDays: 5 }));
    const stale = fuseRecallScore(row({ similarity: 0.8, ageDays: 400 }));
    expect(fresh).toBeGreaterThan(stale);
  });
  test('fused never exceeds similarity; ≈similarity when fresh + confident', () => {
    for (const s of [0.2, 0.5, 0.9]) {
      expect(fuseRecallScore(row({ similarity: s, ageDays: 900, confidence: 0.1 }))).toBeLessThanOrEqual(
        s + 1e-12,
      );
    }
    const ideal = fuseRecallScore(row({ similarity: 0.9, ageDays: 0, confidence: 1 }));
    expect(ideal).toBeCloseTo(0.9, 10);
  });
  test('missing timestamp ⇒ recency does not demote', () => {
    const noTs = fuseRecallScore(row({ similarity: 0.8, ageDays: null, confidence: 1 }));
    const fresh = fuseRecallScore(row({ similarity: 0.8, ageDays: 0, confidence: 1 }));
    expect(noTs).toBeCloseTo(fresh, 10);
  });
  test('missing confidence uses the neutral prior (unscored ranks like today)', () => {
    const a = fuseRecallScore(row({ similarity: 0.8, ageDays: 0, confidence: undefined }));
    const b = fuseRecallScore(row({ similarity: 0.8, ageDays: 0, confidence: 0.75 }));
    expect(a).toBeCloseTo(b, 10);
  });
  test('low confidence (Phase 4) demotes vs neutral', () => {
    const low = fuseRecallScore(row({ similarity: 0.8, ageDays: 0, confidence: 0.1 }));
    const neutral = fuseRecallScore(row({ similarity: 0.8, ageDays: 0 }));
    expect(low).toBeLessThan(neutral);
  });
});

describe('normalizeWeights', () => {
  test('normalizes to sum 1 and falls back to defaults on degenerate input', () => {
    const w = normalizeWeights({ sim: 2, rec: 1, conf: 1 });
    expect(w.sim + w.rec + w.conf).toBeCloseTo(1, 10);
    expect(w.sim).toBeCloseTo(0.5, 10);
    const d = normalizeWeights({ sim: 0, rec: 0, conf: 0 });
    expect(d.sim).toBeCloseTo(0.6, 10);
  });
});

describe('rerankByFusion', () => {
  test('puts a fresh row ahead of a slightly-more-similar stale row', () => {
    const rows = [
      row({ key: 'stale', similarity: 0.82, ageDays: 500 }),
      row({ key: 'fresh', similarity: 0.78, ageDays: 2 }),
    ];
    const out = rerankByFusion(rows);
    expect(out[0]?.key).toBe('fresh');
  });
  test('stable tie-break preserves input order', () => {
    const rows = [
      row({ key: 'a', similarity: 0.7, ageDays: 0 }),
      row({ key: 'b', similarity: 0.7, ageDays: 0 }),
    ];
    expect(rerankByFusion(rows).map((r) => r.key)).toEqual(['a', 'b']);
  });
});

describe('reciprocalRankFusion (union path)', () => {
  test('dedupes by key keeping the combined score; a row in both lists wins', () => {
    const clio = [row({ key: 'shared' }), row({ key: 'clio-only' })];
    const proj = [row({ key: 'shared' }), row({ key: 'proj-only' })];
    const out = reciprocalRankFusion([clio, proj]);
    expect(out[0]?.key).toBe('shared'); // appears in both ⇒ highest combined
    expect(out.map((r) => r.key).sort()).toEqual(['clio-only', 'proj-only', 'shared']);
  });
  test('fresher row outranks staler at the same rank', () => {
    const listA = [row({ key: 'stale', ageDays: 500 })];
    const listB = [row({ key: 'fresh', ageDays: 1 })];
    const out = reciprocalRankFusion([listA, listB]);
    expect(out[0]?.key).toBe('fresh');
  });
});
