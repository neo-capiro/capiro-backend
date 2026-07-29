import { describe, expect, it } from '@jest/globals';
import { resolveAssuranceReleaseMode } from './risk-gate';

/**
 * The property under test is safety, not parsing: `classifyAssuranceRisk` buffers
 * every external/strategy artifact and any high-risk factual category, so if this
 * switch ever defaulted to armed, deploying the code alone would start replacing
 * ordinary Meri answers with verification refusals.
 */
describe('resolveAssuranceReleaseMode', () => {
  it('is off when unset — deploying must never arm the hold by itself', () => {
    expect(resolveAssuranceReleaseMode(undefined)).toBe('off');
    expect(resolveAssuranceReleaseMode('')).toBe('off');
    expect(resolveAssuranceReleaseMode('   ')).toBe('off');
  });

  it('arms only on an explicit enforce value', () => {
    expect(resolveAssuranceReleaseMode('enforce')).toBe('enforce');
    expect(resolveAssuranceReleaseMode(' ENFORCE ')).toBe('enforce');
    expect(resolveAssuranceReleaseMode('Enforce')).toBe('enforce');
  });

  it('fails safe on truthy-looking or near-miss values rather than guessing', () => {
    for (const raw of ['on', 'true', '1', 'yes', 'annotate', 'enforced', 'hold']) {
      expect(resolveAssuranceReleaseMode(raw)).toBe('off');
    }
  });
});
