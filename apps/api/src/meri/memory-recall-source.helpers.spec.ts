import { describe, expect, it } from '@jest/globals';
import { pickMemoryRecallSource } from './memory-recall-source.helpers.js';

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
