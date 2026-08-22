/**
 * District Nexus Release 2 — pure strategic scorer tests.
 *
 * Required invariants:
 * - missing component ≠ zero
 * - low coverage ⇒ score null
 * - component credits sum correctly
 * - Nexus Strength is not part of this module (no import / no blend)
 */

import { describe, expect, test } from '@jest/globals';
import {
  scoreStrategicRelevance,
  sumStrategicCredits,
} from './district-nexus-strategic-scoring.js';
import {
  STRATEGIC_COMPONENT_WEIGHTS,
  STRATEGIC_COMPONENTS,
  STRATEGIC_DEFAULT_MIN_COVERAGE_PERCENT,
  STRATEGIC_SCORE_VERSION,
  strategicWeightTotal,
} from './district-nexus-strategic-weights.js';

describe('district-nexus-strategic-scoring', () => {
  test('weights sum to 100 and are centrally defined', () => {
    expect(strategicWeightTotal()).toBe(100);
    expect(STRATEGIC_COMPONENTS).toHaveLength(8);
    expect(STRATEGIC_COMPONENT_WEIGHTS.committeeJurisdiction).toBe(25);
    expect(STRATEGIC_COMPONENT_WEIGHTS.programElementBudget).toBe(20);
    expect(STRATEGIC_COMPONENT_WEIGHTS.activeLegislation).toBe(15);
    expect(STRATEGIC_COMPONENT_WEIGHTS.activeStrategyTarget).toBe(15);
    expect(STRATEGIC_COMPONENT_WEIGHTS.relationshipEngagement).toBe(10);
    expect(STRATEGIC_COMPONENT_WEIGHTS.hearingTiming).toBe(5);
    expect(STRATEGIC_COMPONENT_WEIGHTS.opportunityFunding).toBe(5);
    expect(STRATEGIC_COMPONENT_WEIGHTS.memberHistoricalPriorities).toBe(5);
  });

  test('missing strategic component credit is null, not zero', () => {
    const result = scoreStrategicRelevance({
      components: {
        committeeJurisdiction: { strength: 'verified', evidenceCount: 1 },
      },
      minCoveragePercent: 0, // force a score so we can inspect credits
    });
    const missing = result.breakdown.find((b) => b.component === 'activeLegislation');
    expect(missing?.credit).toBeNull();
    expect(missing?.status).toBe('missing');
    expect(result.missingComponents).toContain('activeLegislation');
  });

  test('unavailable component is not zero and is listed separately from missing', () => {
    const result = scoreStrategicRelevance({
      components: {
        memberHistoricalPriorities: { strength: 'unavailable' },
        committeeJurisdiction: { strength: 'verified', evidenceCount: 1 },
      },
      minCoveragePercent: 0,
    });
    const row = result.breakdown.find((b) => b.component === 'memberHistoricalPriorities');
    expect(row?.credit).toBeNull();
    expect(row?.status).toBe('unavailable');
    expect(result.unavailableComponents).toContain('memberHistoricalPriorities');
    expect(result.missingComponents).not.toContain('memberHistoricalPriorities');
  });

  test('low coverage yields null strategic score (not a low number)', () => {
    const result = scoreStrategicRelevance({
      components: {
        // only 5 weight points of determinate evidence
        hearingTiming: { strength: 'verified', evidenceCount: 1 },
      },
    });
    expect(result.coveragePercent).toBeLessThan(STRATEGIC_DEFAULT_MIN_COVERAGE_PERCENT);
    expect(result.score).toBeNull();
  });

  test('component credits sum exactly to the pre-round earned total', () => {
    const result = scoreStrategicRelevance({
      components: {
        committeeJurisdiction: { strength: 'verified', evidenceCount: 2 }, // 25
        programElementBudget: { strength: 'partial', evidenceCount: 1 }, // 10
        activeLegislation: { strength: 'sourceAuthoritative', evidenceCount: 1 }, // 15
        activeStrategyTarget: { strength: 'verified', evidenceCount: 1 }, // 15
        relationshipEngagement: { strength: 'partial', evidenceCount: 1 }, // 5
        hearingTiming: { strength: 'verified', evidenceCount: 1 }, // 5
        opportunityFunding: { strength: 'absent' },
        memberHistoricalPriorities: { strength: 'unavailable' },
      },
    });
    // covered weight = 25+20+15+15+10+5 = 90 → coverage 90%
    expect(result.coveragePercent).toBe(90);
    const creditSum = sumStrategicCredits(result.breakdown);
    expect(creditSum).toBe(25 + 10 + 15 + 15 + 5 + 5);
    expect(result.score).toBe(Math.round(creditSum));
    expect(result.scoreVersion).toBe(STRATEGIC_SCORE_VERSION);
  });

  test('strongest drivers exclude zero/null credit components', () => {
    const result = scoreStrategicRelevance({
      components: {
        committeeJurisdiction: { strength: 'verified', evidenceCount: 1 },
        activeStrategyTarget: { strength: 'verified', evidenceCount: 1 },
        relationshipEngagement: { strength: 'partial', evidenceCount: 1 },
      },
      minCoveragePercent: 0,
    });
    expect(result.strongestDrivers.every((d) => (d.credit ?? 0) > 0)).toBe(true);
    expect(result.strongestDrivers[0]?.component).toBe('committeeJurisdiction');
  });

  test('scorer module does not import or reference nexus strength', () => {
    // Structural: this file's pure module has no nexus fields on the result.
    const result = scoreStrategicRelevance({ components: {} });
    expect(result).not.toHaveProperty('nexusScore');
    expect(result).not.toHaveProperty('nexusStrength');
  });
});
