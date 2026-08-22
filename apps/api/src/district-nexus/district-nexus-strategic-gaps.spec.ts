/**
 * District Nexus Release 2 — gap analysis pure tests.
 */

import { describe, expect, test } from '@jest/globals';
import {
  buildGapsResponse,
  classifyDistrictGaps,
  STRATEGIC_GAP_RULE_VERSION,
  STRATEGIC_GAP_THRESHOLDS,
} from './district-nexus-strategic-gaps.js';
import { scoreStrategicRelevance } from './district-nexus-strategic-scoring.js';

function strategicWith(components: Parameters<typeof scoreStrategicRelevance>[0]['components']) {
  return scoreStrategicRelevance({ components, minCoveragePercent: 0 });
}

describe('district-nexus-strategic-gaps', () => {
  test('distinguishes incomplete/missing from low strategic', () => {
    const incomplete = strategicWith({});
    // force null score via default coverage floor
    const unscored = scoreStrategicRelevance({ components: {} });
    expect(unscored.score).toBeNull();

    const findings = classifyDistrictGaps({
      districtKey: 'TX-01',
      state: 'TX',
      district: '01',
      strategic: unscored,
      nexusScore: 80,
      nexusCoveragePercent: 70,
    });
    expect(findings.some((f) => f.gapType === 'incomplete_strategic_evidence')).toBe(true);
    // Must NOT claim "low strategic" as a gap type — incomplete is the label.
    expect(findings.every((f) => f.gapType !== ('low_strategic' as never))).toBe(true);
    void incomplete;
  });

  test('high strategic + low nexus', () => {
    const strategic = strategicWith({
      committeeJurisdiction: { strength: 'verified', evidenceCount: 1 },
      programElementBudget: { strength: 'verified', evidenceCount: 1 },
      activeLegislation: { strength: 'verified', evidenceCount: 1 },
      activeStrategyTarget: { strength: 'verified', evidenceCount: 1 },
      relationshipEngagement: { strength: 'verified', evidenceCount: 1 },
    });
    expect(strategic.score).not.toBeNull();
    expect(strategic.score!).toBeGreaterThanOrEqual(STRATEGIC_GAP_THRESHOLDS.highStrategic);

    const findings = classifyDistrictGaps({
      districtKey: 'VA-08',
      state: 'VA',
      district: '08',
      strategic,
      nexusScore: 10,
      nexusCoveragePercent: 40,
    });
    expect(findings.some((f) => f.gapType === 'high_strategic_low_nexus')).toBe(true);
  });

  test('high nexus + low engagement (engagement missing ≠ low is still classified with honest evidence)', () => {
    const strategic = strategicWith({
      committeeJurisdiction: { strength: 'verified', evidenceCount: 1 },
      // engagement absent
    });
    const findings = classifyDistrictGaps({
      districtKey: 'CA-12',
      state: 'CA',
      district: '12',
      strategic,
      nexusScore: 75,
      nexusCoveragePercent: 80,
    });
    const gap = findings.find((f) => f.gapType === 'high_nexus_low_engagement');
    expect(gap).toBeDefined();
    expect(gap!.evidence.some((e) => /unmeasured|missing|≤/i.test(e))).toBe(true);
  });

  test('strong footprint + no active strategy', () => {
    const strategic = strategicWith({
      relationshipEngagement: { strength: 'verified', evidenceCount: 1 },
    });
    const findings = classifyDistrictGaps({
      districtKey: 'AL-01',
      state: 'AL',
      district: '01',
      strategic,
      nexusScore: 90,
      nexusCoveragePercent: 85,
    });
    expect(findings.some((f) => f.gapType === 'strong_footprint_no_active_strategy')).toBe(true);
  });

  test('committee relevance + weak relationship', () => {
    const strategic = strategicWith({
      committeeJurisdiction: { strength: 'verified', evidenceCount: 1 },
      relationshipEngagement: { strength: 'partial', evidenceCount: 1 }, // credit 5 > 2? weight 10 * 0.5 = 5
    });
    // partial engagement credit = 5, threshold is 2 — should NOT fire weak relationship
    const strongRel = classifyDistrictGaps({
      districtKey: 'NY-12',
      state: 'NY',
      district: '12',
      strategic,
      nexusScore: 20,
      nexusCoveragePercent: 30,
    });
    expect(strongRel.some((f) => f.gapType === 'committee_appropriations_weak_relationship')).toBe(
      false,
    );

    const weak = strategicWith({
      committeeJurisdiction: { strength: 'verified', evidenceCount: 1 },
      // engagement missing
    });
    const weakFindings = classifyDistrictGaps({
      districtKey: 'NY-12',
      state: 'NY',
      district: '12',
      strategic: weak,
      nexusScore: 20,
      nexusCoveragePercent: 30,
    });
    expect(
      weakFindings.some((f) => f.gapType === 'committee_appropriations_weak_relationship'),
    ).toBe(true);
  });

  test('relevant PE + no target/engagement', () => {
    const strategic = strategicWith({
      programElementBudget: { strength: 'verified', evidenceCount: 1 },
    });
    const findings = classifyDistrictGaps({
      districtKey: 'MD-05',
      state: 'MD',
      district: '05',
      strategic,
      nexusScore: 15,
      nexusCoveragePercent: 20,
    });
    expect(findings.some((f) => f.gapType === 'relevant_pe_no_target_engagement')).toBe(true);
  });

  test('geography vintage conflict is its own gap type', () => {
    const strategic = strategicWith({
      committeeJurisdiction: { strength: 'verified', evidenceCount: 1 },
    });
    const findings = classifyDistrictGaps({
      districtKey: 'TX-23',
      state: 'TX',
      district: '23',
      strategic,
      nexusScore: 40,
      nexusCoveragePercent: 50,
      geographyVintageConflict: true,
    });
    expect(findings.some((f) => f.gapType === 'geography_vintage_conflict')).toBe(true);
  });

  test('buildGapsResponse aggregates counts and carries rule version', () => {
    const res = buildGapsResponse({
      clientId: 'c1',
      clientName: 'Acme',
      districts: [
        {
          districtKey: 'TX-01',
          state: 'TX',
          district: '01',
          strategic: scoreStrategicRelevance({ components: {} }),
          nexusScore: null,
          nexusCoveragePercent: null,
        },
      ],
    });
    expect(res.ruleVersion).toBe(STRATEGIC_GAP_RULE_VERSION);
    expect(res.counts.incomplete_strategic_evidence).toBeGreaterThanOrEqual(1);
    expect(res.gaps[0]?.ruleVersion).toBe(STRATEGIC_GAP_RULE_VERSION);
  });
});
