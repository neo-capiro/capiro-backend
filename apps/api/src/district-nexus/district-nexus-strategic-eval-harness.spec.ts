/**
 * Evaluation harness structural tests — counts and outstanding human labeling.
 */

import { describe, expect, test } from '@jest/globals';
import {
  buildStrategicEvalHarnessReport,
  STRATEGIC_EVAL_FIXTURES,
} from './district-nexus-strategic-eval-harness.js';

describe('district-nexus-strategic-eval-harness', () => {
  test('provides 50 examples: 25 defense + 25 non-defense', () => {
    const report = buildStrategicEvalHarnessReport();
    expect(report.totalExamples).toBe(50);
    expect(report.defenseCount).toBe(25);
    expect(report.nonDefenseCount).toBe(25);
  });

  test('covers required scenario families', () => {
    const report = buildStrategicEvalHarnessReport();
    for (const key of [
      'high_nexus_low_strategic',
      'low_nexus_high_strategic',
      'false_positive_committee',
      'irrelevant_pe',
      'ambiguous_member_jurisdiction',
      'no_data',
      'stale_data',
    ]) {
      expect(report.scenarioCoverage[key] ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  test('explicitly reports that human labeling / empirical validation is outstanding', () => {
    const report = buildStrategicEvalHarnessReport();
    expect(report.empiricallyValidated).toBe(false);
    expect(report.humanLabelsPending).toBe(STRATEGIC_EVAL_FIXTURES.length);
    expect(report.notes.toLowerCase()).toMatch(/outstanding|pending|not claim empirical/);
  });

  test('every fixture marks CPF/historical priorities unavailable or omits a false verified claim', () => {
    for (const f of STRATEGIC_EVAL_FIXTURES) {
      const hist = f.expectedComponents.memberHistoricalPriorities;
      if (hist != null) {
        expect(hist === 'unavailable' || hist === 'absent').toBe(true);
      }
    }
  });
});
