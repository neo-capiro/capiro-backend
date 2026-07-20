import { describe, expect, test } from '@jest/globals';
import {
  DEFAULT_MIN_WRITE_CONFIDENCE,
  confidenceFactor,
  fuseConfidenceScore,
  passesWriteConfidenceGate,
  rerankByConfidence,
} from './memory-confidence.helpers.js';

describe('confidenceFactor', () => {
  test('weight=0 is neutral (1) for every confidence, incl null/NaN', () => {
    for (const c of [0, 0.3, 1, null, undefined, NaN]) {
      expect(confidenceFactor(c as number | null, 0)).toBe(1);
    }
  });

  test('null/undefined/NaN confidence is neutral (1) at any weight', () => {
    expect(confidenceFactor(null, 0.5)).toBe(1);
    expect(confidenceFactor(undefined, 0.5)).toBe(1);
    expect(confidenceFactor(NaN, 1)).toBe(1);
  });

  test('monotone increasing in confidence for weight>0', () => {
    const w = 0.5;
    expect(confidenceFactor(0.2, w)).toBeLessThan(confidenceFactor(0.8, w));
    // 1 - w + w*c
    expect(confidenceFactor(0, w)).toBeCloseTo(0.5, 10);
    expect(confidenceFactor(1, w)).toBeCloseTo(1, 10);
  });

  test('clamps out-of-range confidence and weight defensively', () => {
    expect(confidenceFactor(2, 0.5)).toBeCloseTo(1, 10); // c clamps to 1
    expect(confidenceFactor(-1, 0.5)).toBeCloseTo(0.5, 10); // c clamps to 0
    expect(confidenceFactor(0.5, 5)).toBeCloseTo(0.5, 10); // w clamps to 1 => factor=c
  });
});

describe('fuseConfidenceScore', () => {
  test('never exceeds raw similarity', () => {
    for (const sim of [0.1, 0.5, 0.9]) {
      for (const c of [0, 0.5, 1, null]) {
        expect(fuseConfidenceScore(sim, c as number | null, 0.4)).toBeLessThanOrEqual(sim + 1e-12);
      }
    }
  });

  test('equals similarity when confidence is null (neutral)', () => {
    expect(fuseConfidenceScore(0.8, null, 0.5)).toBeCloseTo(0.8, 10);
  });
});

describe('rerankByConfidence', () => {
  test('weight=0 is strict identity (same array reference, DARK-parity guard)', () => {
    const rows = [
      { score: 0.9, confidence: 0.1 },
      { score: 0.8, confidence: 1 },
    ];
    expect(rerankByConfidence(rows, 0)).toBe(rows); // same reference: no work done
  });

  test('weight>0 demotes a low-confidence high-similarity row below a confident one', () => {
    const rows = [
      { key: 'a', score: 0.8, confidence: 0.5 },
      { key: 'b', score: 0.72, confidence: 1.0 },
    ];
    const out = rerankByConfidence(rows, 0.3);
    // fused a = 0.8*(1-0.3+0.3*0.5)=0.8*0.85=0.68; fused b = 0.72*1=0.72 => b first
    expect(out.map((r) => (r as { key: string }).key)).toEqual(['b', 'a']);
    expect(out[0]?.score).toBeCloseTo(0.72, 10);
    expect(out[1]?.score).toBeCloseTo(0.68, 10);
  });

  test('a NULL-confidence row is never demoted below a scored row of equal similarity', () => {
    const rows = [
      { key: 'scored', score: 0.7, confidence: 0.2 },
      { key: 'unscored', score: 0.7, confidence: null },
    ];
    const out = rerankByConfidence(rows, 0.5);
    // unscored factor=1 (0.7); scored factor=0.6 (0.42) => unscored ranks first
    expect((out[0] as { key: string }).key).toBe('unscored');
  });

  test('stable tie-break preserves input order when fused scores tie', () => {
    const rows = [
      { key: 'x', score: 0.6, confidence: null },
      { key: 'y', score: 0.6, confidence: null },
    ];
    const out = rerankByConfidence(rows, 0.4);
    expect(out.map((r) => (r as { key: string }).key)).toEqual(['x', 'y']);
  });
});

describe('passesWriteConfidenceGate', () => {
  test('passes at/above floor, fails below', () => {
    expect(passesWriteConfidenceGate(0.7, 0.7)).toBe(true);
    expect(passesWriteConfidenceGate(0.69, 0.7)).toBe(false);
    expect(passesWriteConfidenceGate(0.9, 0.7)).toBe(true);
  });

  test('float round-trip at the boundary is not spuriously rejected', () => {
    expect(passesWriteConfidenceGate(0.7 - 1e-12, 0.7)).toBe(true);
  });

  test('null/undefined/NaN fails (unscored machine guess is not trusted)', () => {
    expect(passesWriteConfidenceGate(null)).toBe(false);
    expect(passesWriteConfidenceGate(undefined)).toBe(false);
    expect(passesWriteConfidenceGate(NaN)).toBe(false);
  });

  test('default floor is 0.7', () => {
    expect(DEFAULT_MIN_WRITE_CONFIDENCE).toBe(0.7);
    expect(passesWriteConfidenceGate(0.7)).toBe(true);
    expect(passesWriteConfidenceGate(0.6)).toBe(false);
  });
});
