import { describe, expect, it } from '@jest/globals';
import {
  applyRecallScoreFloor,
  pickMemoryRecallSource,
  pickRecallRerank,
} from './memory-recall-source.helpers.js';

describe('pickRecallRerank (Phase 5)', () => {
  it('falls back to the env value when there is no override', () => {
    expect(pickRecallRerank(false, null)).toBe(false);
    expect(pickRecallRerank(true, undefined)).toBe(true);
    expect(pickRecallRerank(false, { clioFeatureFlags: {} })).toBe(false);
  });
  it('a per-tenant on/off override wins over env', () => {
    expect(pickRecallRerank(false, { clioFeatureFlags: { meriRecallRerank: 'on' } })).toBe(true);
    expect(pickRecallRerank(true, { clioFeatureFlags: { meriRecallRerank: 'off' } })).toBe(false);
    expect(pickRecallRerank(false, { clioFeatureFlags: { meriRecallRerank: true } })).toBe(true);
    expect(pickRecallRerank(true, { clioFeatureFlags: { meriRecallRerank: false } })).toBe(false);
  });
  it('an unrecognized override is ignored (env wins)', () => {
    expect(pickRecallRerank(true, { clioFeatureFlags: { meriRecallRerank: 'maybe' } })).toBe(true);
    expect(pickRecallRerank(false, { clioFeatureFlags: { meriRecallRerank: 1 } })).toBe(false);
  });
});

describe('pickMemoryRecallSource', () => {
  it('falls back to the env mode when there is no override', () => {
    expect(pickMemoryRecallSource('clio', null)).toBe('clio');
    expect(pickMemoryRecallSource('union', undefined)).toBe('union');
    expect(pickMemoryRecallSource('clio', {})).toBe('clio');
    expect(pickMemoryRecallSource('clio', { clioFeatureFlags: {} })).toBe('clio');
  });

  it('honors a valid per-tenant override over the env mode (the canary lever)', () => {
    expect(
      pickMemoryRecallSource('clio', { clioFeatureFlags: { meriMemoryRecallSource: 'union' } }),
    ).toBe('union');
    expect(
      pickMemoryRecallSource('clio', {
        clioFeatureFlags: { meriMemoryRecallSource: 'projection' },
      }),
    ).toBe('projection');
    // a tenant can also opt BACK to clio while the fleet is on union
    expect(
      pickMemoryRecallSource('union', { clioFeatureFlags: { meriMemoryRecallSource: 'clio' } }),
    ).toBe('clio');
  });

  it('ignores an invalid override and uses the env mode', () => {
    expect(
      pickMemoryRecallSource('clio', { clioFeatureFlags: { meriMemoryRecallSource: 'openai' } }),
    ).toBe('clio');
    expect(
      pickMemoryRecallSource('union', { clioFeatureFlags: { meriMemoryRecallSource: 42 } }),
    ).toBe('union');
    expect(pickMemoryRecallSource('clio', { clioFeatureFlags: null })).toBe('clio');
  });
});

describe('applyRecallScoreFloor', () => {
  const rows = [
    { key: 'strong', score: 0.86 },
    { key: 'borderline', score: 0.4 },
    { key: 'noise', score: 0.18 },
  ];

  it('drops rows below the floor and keeps rows at/above it', () => {
    expect(applyRecallScoreFloor(rows, 0.4).map((r) => r.key)).toEqual(['strong', 'borderline']);
  });

  it('never reorders — it only suppresses the weak tail', () => {
    expect(applyRecallScoreFloor(rows, 0.1).map((r) => r.key)).toEqual([
      'strong',
      'borderline',
      'noise',
    ]);
  });

  it('a floor of 0 (or non-finite) disables filtering entirely', () => {
    expect(applyRecallScoreFloor(rows, 0)).toEqual(rows);
    expect(applyRecallScoreFloor(rows, Number.NaN)).toEqual(rows);
    expect(applyRecallScoreFloor(rows, -1)).toEqual(rows);
  });

  it('drops rows whose score is missing or non-numeric (defensive on raw SQL rows)', () => {
    const dirty = [
      { key: 'ok', score: 0.9 },
      { key: 'null-score', score: null as unknown as number },
    ];
    expect(applyRecallScoreFloor(dirty, 0.4).map((r) => r.key)).toEqual(['ok']);
  });

  it('can return an empty result when nothing clears the floor (junk never fills context)', () => {
    expect(applyRecallScoreFloor(rows, 0.95)).toEqual([]);
  });
});
