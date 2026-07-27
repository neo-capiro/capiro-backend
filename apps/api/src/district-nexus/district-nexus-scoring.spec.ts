import { describe, expect, test } from '@jest/globals';
import {
  NEXUS_COMPONENTS,
  NEXUS_COMPONENT_WEIGHTS,
  scoreNexus,
  weakerStrength,
  type EvidenceStrength,
  type NexusScoreInput,
} from './district-nexus-scoring.js';

function allComponents(strength: EvidenceStrength): NexusScoreInput['components'] {
  const components: NexusScoreInput['components'] = {};
  for (const key of NEXUS_COMPONENTS) components[key] = { strength };
  return components;
}

describe('weights', () => {
  test('sum to exactly 100 — the score is a percentage and must be able to reach it', () => {
    const total = Object.values(NEXUS_COMPONENT_WEIGHTS).reduce((s, w) => s + w, 0);
    expect(total).toBe(100);
  });

  test('every declared component has a weight', () => {
    for (const key of NEXUS_COMPONENTS) {
      expect(NEXUS_COMPONENT_WEIGHTS[key]).toBeGreaterThan(0);
    }
  });
});

describe('missing data is never a verified zero', () => {
  test('absent components lower coverage rather than scoring 0', () => {
    const result = scoreNexus({
      components: { verifiedFacility: { strength: 'verified' } },
    });
    // 25 of 100 possible weight is determinate.
    expect(result.coveragePercent).toBe(25);
    expect(result.score).toBe(25);
  });

  test('a subject we know nothing about scores null, not 0', () => {
    const result = scoreNexus({ components: {} });
    expect(result.score).toBeNull();
    expect(result.coveragePercent).toBe(0);
  });

  test('coverage below the floor suppresses the score entirely', () => {
    // relationshipContext alone is 5% coverage, under the 15% default floor.
    const result = scoreNexus({
      components: { relationshipContext: { strength: 'verified' } },
    });
    expect(result.score).toBeNull();
    expect(result.coveragePercent).toBe(5);
  });

  test('the breakdown still accounts for all 100 points, including unearned ones', () => {
    const result = scoreNexus({
      components: { verifiedFacility: { strength: 'verified' } },
    });
    const declared = result.breakdown.reduce((s, b) => s + b.weight, 0);
    expect(declared).toBe(100);
    expect(result.breakdown).toHaveLength(NEXUS_COMPONENTS.length);
  });
});

describe('evidence strength', () => {
  test('fully verified evidence across the board scores 100', () => {
    const result = scoreNexus({ components: allComponents('verified') });
    expect(result.score).toBe(100);
    expect(result.coveragePercent).toBe(100);
  });

  test('inferred evidence earns half weight', () => {
    const result = scoreNexus({
      components: { verifiedFacility: { strength: 'inferred' } },
    });
    expect(result.breakdown.find((b) => b.component === 'verifiedFacility')?.credit).toBe(12.5);
  });

  test('recipient location ranks below place of performance', () => {
    const viaPop = scoreNexus({
      components: { contractPlaceOfPerformance: { strength: 'verified' } },
    });
    const viaRecipient = scoreNexus({
      components: { contractPlaceOfPerformance: { strength: 'recipientLocation' } },
    });
    const popCredit = viaPop.breakdown.find((b) => b.component === 'contractPlaceOfPerformance')!.credit;
    const recipientCredit = viaRecipient.breakdown.find(
      (b) => b.component === 'contractPlaceOfPerformance',
    )!.credit;
    expect(recipientCredit).toBeLessThan(popCredit);
  });

  test('a statewide award can never produce a full-strength single-district score', () => {
    const result = scoreNexus({ components: allComponents('verified') });
    const statewide = scoreNexus({
      components: Object.fromEntries(
        NEXUS_COMPONENTS.map((k) => [k, { strength: 'statewide' as const }]),
      ),
    });
    expect(result.score).toBe(100);
    // Full coverage, but nowhere near full strength.
    expect(statewide.coveragePercent).toBe(100);
    expect(statewide.score).toBe(25);
  });

  test('statewide attribution raises a warning naming the component', () => {
    const result = scoreNexus({
      components: { contractPlaceOfPerformance: { strength: 'statewide' } },
    });
    expect(result.warnings.some((w) => w.code === 'statewide_attribution')).toBe(true);
  });

  test('userProvided earns half weight', () => {
    const result = scoreNexus({
      components: { verifiedFacility: { strength: 'userProvided' } },
    });
    expect(result.breakdown.find((b) => b.component === 'verifiedFacility')?.credit).toBe(12.5);
  });

  test('userProvided is weaker than sourceAuthoritative and stronger-or-equal to statewide', () => {
    expect(weakerStrength('userProvided', 'sourceAuthoritative')).toBe('userProvided');
    expect(weakerStrength('statewide', 'userProvided')).toBe('statewide');
  });

  test('a userProvided component emits an inferred_entity_match warning', () => {
    const result = scoreNexus({
      components: { verifiedFacility: { strength: 'userProvided' } },
    });
    expect(result.warnings.some((w) => w.code === 'inferred_entity_match')).toBe(true);
  });
});

describe('opportunities contribute nothing to awarded-funding weight', () => {
  test('an awarded-funding component backed only by opportunities earns zero', () => {
    const result = scoreNexus({
      components: {
        grantPlaceOfPerformance: { strength: 'verified', opportunityOnly: true },
      },
    });
    expect(result.breakdown.find((b) => b.component === 'grantPlaceOfPerformance')?.credit).toBe(0);
    expect(result.warnings.some((w) => w.code === 'opportunity_only')).toBe(true);
  });

  test('but it still counts as covered — we looked, and found only forecasts', () => {
    const result = scoreNexus({
      components: {
        grantPlaceOfPerformance: { strength: 'verified', opportunityOnly: true },
      },
    });
    // Determinate knowledge, worth 0 points: distinct from never having checked.
    expect(result.coveragePercent).toBe(10);
  });

  test('the suppression applies only to awarded-funding components', () => {
    const result = scoreNexus({
      components: {
        partnerBeneficiary: { strength: 'verified', opportunityOnly: true },
      },
    });
    // partnerBeneficiary is not an awarded-funding component, so it is unaffected.
    expect(result.breakdown.find((b) => b.component === 'partnerBeneficiary')?.credit).toBe(10);
  });
});

describe('rounding', () => {
  /**
   * The regression this locks down: rounding each component and then summing
   * gives a breakdown that does not add up to the score it explains.
   */
  test('component credit is exact and only the final score rounds', () => {
    const result = scoreNexus({
      components: {
        contractPlaceOfPerformance: { strength: 'statewide' }, // 10 * 0.25 = 2.5
        grantPlaceOfPerformance: { strength: 'statewide' }, // 2.5
        supplierOrLocalSpend: { strength: 'statewide' }, // 2.5
      },
    });

    // Each component keeps its exact fractional credit...
    for (const component of [
      'contractPlaceOfPerformance',
      'grantPlaceOfPerformance',
      'supplierOrLocalSpend',
    ]) {
      expect(result.breakdown.find((b) => b.component === component)?.credit).toBe(2.5);
    }

    // ...and the score is the rounded sum of the exact credits (7.5 -> 8),
    // NOT the sum of individually-rounded credits (which would be 6 or 9).
    const exactSum = result.breakdown.reduce((s, b) => s + b.credit, 0);
    expect(exactSum).toBe(7.5);
    expect(result.score).toBe(8);
  });

  test('the exact credits always reconcile to the reported score', () => {
    const result = scoreNexus({
      components: {
        verifiedFacility: { strength: 'inferred' }, // 12.5
        verifiedEmployees: { strength: 'recipientLocation' }, // 10
        policyCommitteeRelevance: { strength: 'statewide' }, // 2.5
      },
    });
    const exactSum = result.breakdown.reduce((s, b) => s + b.credit, 0);
    expect(exactSum).toBe(25);
    expect(result.score).toBe(Math.round(exactSum));
  });
});

describe('strongestDrivers', () => {
  test('are ordered by credit, capped at three, and exclude zero-credit components', () => {
    const result = scoreNexus({
      components: {
        verifiedFacility: { strength: 'verified' }, // 25
        verifiedEmployees: { strength: 'verified' }, // 20
        supplierOrLocalSpend: { strength: 'verified' }, // 10
        relationshipContext: { strength: 'verified' }, // 5
        grantPlaceOfPerformance: { strength: 'verified', opportunityOnly: true }, // 0
      },
    });
    expect(result.strongestDrivers.map((d) => d.component)).toEqual([
      'verifiedFacility',
      'verifiedEmployees',
      'supplierOrLocalSpend',
    ]);
    expect(result.strongestDrivers.every((d) => d.credit > 0)).toBe(true);
  });

  test('are empty when nothing earned credit', () => {
    const result = scoreNexus({
      components: { grantPlaceOfPerformance: { strength: 'verified', opportunityOnly: true } },
    });
    expect(result.strongestDrivers).toEqual([]);
  });
});
