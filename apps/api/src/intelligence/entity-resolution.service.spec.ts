import { describe, expect, test } from '@jest/globals';
import { candidateDecision } from './entity-resolution.service.js';

describe('candidateDecision', () => {
  test('a clear-winner, high-confidence "contracting" candidate auto-confirms', () => {
    expect(
      candidateDecision({ source: 'contracting', confidence: 0.9, isTopForSource: true, runnerUpConfidence: null }),
    ).toBe('auto_confirm');
  });

  test('fec_committee never auto-confirms, even with a clear high-confidence winner (regression)', () => {
    expect(
      candidateDecision({ source: 'fec_committee', confidence: 0.99, isTopForSource: true, runnerUpConfidence: null }),
    ).toBe('review');
  });

  test('assistance_recipient never auto-confirms, even with a clear high-confidence winner', () => {
    expect(
      candidateDecision({
        source: 'assistance_recipient',
        confidence: 0.99,
        isTopForSource: true,
        runnerUpConfidence: null,
      }),
    ).toBe('review');
  });

  test('assistance_recipient still writes a below-threshold candidate as review, not skip, when it clears the write floor', () => {
    expect(
      candidateDecision({ source: 'assistance_recipient', confidence: 0.5, isTopForSource: true, runnerUpConfidence: null }),
    ).toBe('review');
  });

  test('assistance_recipient below the write floor is skipped, same as any other source', () => {
    expect(
      candidateDecision({ source: 'assistance_recipient', confidence: 0.2, isTopForSource: true, runnerUpConfidence: null }),
    ).toBe('skip');
  });
});
