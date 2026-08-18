import { describe, expect, test } from '@jest/globals';
import {
  candidateDecision,
  AUTO_CONFIRM_THRESHOLD,
  AUTO_CONFIRM_AMBIGUITY_MARGIN,
  MIN_WRITE_CONFIDENCE,
} from './entity-resolution.service.js';

/**
 * Pins the entity-resolution write / auto-confirm decision — the single source of
 * truth used by resolveClient + resolveAllForTenant. The matching SQL casts a wide
 * net (similarity > 0.3); these rules (a) keep generic-string noise out of the
 * review queue, (b) auto-confirm ONLY the single best candidate per source, and
 * (c) refuse to auto-confirm an ambiguous near-tie. Pinned so a refactor can't
 * silently weaken any of those guarantees.
 */
describe('entity-resolution candidateDecision', () => {
  const top = (confidence: number, source = 'lda', runnerUpConfidence: number | null = null) =>
    candidateDecision({ source, confidence, isTopForSource: true, runnerUpConfidence });

  test('drops sub-floor noise candidates', () => {
    expect(top(0.35)).toBe('skip');
    expect(top(0.39)).toBe('skip');
    expect(MIN_WRITE_CONFIDENCE).toBe(0.4);
  });

  test('keeps mid-confidence candidates for human review', () => {
    expect(top(0.4)).toBe('review');
    expect(top(0.7)).toBe('review');
  });

  test('auto-confirms a clear single best non-PAC candidate', () => {
    expect(top(0.9)).toBe('auto_confirm');
    expect(top(AUTO_CONFIRM_THRESHOLD)).toBe('auto_confirm');
  });

  test('only the single best per source can auto-confirm', () => {
    expect(
      candidateDecision({
        source: 'lda',
        confidence: 0.95,
        isTopForSource: false,
        runnerUpConfidence: null,
      }),
    ).toBe('review');
  });

  test('an ambiguous near-tie routes to review instead of auto-confirm', () => {
    // Runner-up within half the margin → ambiguous → review.
    expect(top(0.9, 'lda', 0.9 - AUTO_CONFIRM_AMBIGUITY_MARGIN / 2)).toBe('review');
    // Runner-up a clear margin behind → auto-confirm.
    expect(top(0.9, 'lda', 0.9 - AUTO_CONFIRM_AMBIGUITY_MARGIN)).toBe('auto_confirm');
  });

  test('PAC committee auto-confirms a clear high-scoring single best', () => {
    expect(top(0.95, 'fec_committee')).toBe('auto_confirm');
    expect(top(0.86, 'fec_committee')).toBe('auto_confirm');
    // At the threshold edge.
    expect(top(AUTO_CONFIRM_THRESHOLD, 'fec_committee')).toBe('auto_confirm');
  });

  test('PAC committee still routes near-ties and sub-threshold scores correctly', () => {
    expect(top(0.9, 'fec_committee', 0.88)).toBe('review'); // ambiguous near-tie
    expect(top(0.8, 'fec_committee')).toBe('review'); // below auto-confirm, above write floor
  });

  test('PAC committee below floor is still dropped', () => {
    expect(top(0.3, 'fec_committee')).toBe('skip');
  });
});
