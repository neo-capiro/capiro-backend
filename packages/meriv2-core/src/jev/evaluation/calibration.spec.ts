import { describe, expect, it } from '@jest/globals';
import { evaluateThresholds, type CalibrationRow } from './calibration';

const base = { task: 'claim_support', questionVersion: 'claim_support.v1', model: 'jev-v1' };
function row(split: 'tuning' | 'heldout', confidence: number, correct: boolean): CalibrationRow {
  return {
    ...base,
    split,
    confidence,
    predicted: 'supported',
    label: correct ? 'supported' : 'contradicted',
  };
}

describe('threshold calibration', () => {
  it('builds candidates from tuning only and reports chosen held-out metrics separately', () => {
    const first = evaluateThresholds({
      rows: [row('tuning', 0.9, true), row('tuning', 0.4, false), row('heldout', 0.95, false)],
      ...base,
      thresholds: [0.8, 0.3],
      chosenThreshold: 0.8,
    });
    const changedHeldout = evaluateThresholds({
      rows: [row('tuning', 0.9, true), row('tuning', 0.4, false), row('heldout', 0.95, true)],
      ...base,
      thresholds: [0.8, 0.3],
      chosenThreshold: 0.8,
    });
    expect(first.candidates).toEqual(changedHeldout.candidates);
    expect(first.candidates.map((candidate) => candidate.threshold)).toEqual([0.3, 0.8]);
    expect(first.candidates[1]).toMatchObject({ precision: 1, recall: 1, coverage: 0.5 });
    expect(first.heldout?.precision).toBe(0);
    expect(changedHeldout.heldout?.precision).toBe(1);
    expect(first.selection).toContain('No threshold is selected');
  });
});
