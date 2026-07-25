import { describe, expect, test } from '@jest/globals';
import {
  buildClientNexusResponse,
  districtKeyFor,
  evidenceForDistrict,
  foldDistricts,
  isStatewide,
  type ClientNexusInputs,
} from './district-nexus.aggregate.js';

const GENERATED_AT = '2026-07-25T12:00:00.000Z';

function inputs(partial: Partial<ClientNexusInputs> = {}): ClientNexusInputs {
  return {
    clientId: 'client-1',
    contracts: [],
    assistance: [],
    opportunities: [],
    facilities: [],
    freshness: [],
    generatedAt: GENERATED_AT,
    ...partial,
  };
}

describe('districtKeyFor', () => {
  test('resolves an ordinary numbered district', () => {
    expect(districtKeyFor('TX', '23')).toBe('TX-23');
  });

  test.each([
    ['90', 'multi-district'],
    ['98', 'non-voting delegate'],
    ['ZZ', 'undefined'],
  ])('refuses the %s sentinel (%s) rather than inventing a district', (sentinel) => {
    expect(districtKeyFor('CA', sentinel)).toBeNull();
  });

  test('returns null without a state, whatever the district says', () => {
    expect(districtKeyFor(null, '23')).toBeNull();
  });

  test('a sentinel with a state is statewide, not simply missing', () => {
    expect(isStatewide('CA', '90')).toBe(true);
    expect(isStatewide('CA', '23')).toBe(false);
  });
});

describe('unmapped money is reported, never smeared', () => {
  test('statewide contract money lands in unmapped rather than any district', () => {
    const { districts, unmapped, warnings } = foldDistricts(
      inputs({
        contracts: [
          { state: 'CA', district: '90', awardCount: 1, totalAmount: 5_000_000 },
          { state: 'CA', district: '12', awardCount: 1, totalAmount: 1_000_000 },
        ],
      }),
    );
    expect(districts).toHaveLength(1);
    expect(districts[0]?.districtKey).toBe('CA-12');
    expect(districts[0]?.contractObligations).toBe(1_000_000);
    expect(unmapped.unmappedContractAmount).toBe(5_000_000);
    expect(warnings.some((w) => w.code === 'statewide_attribution')).toBe(true);
  });

  test('statewide grant money is unmapped too', () => {
    const { unmapped } = foldDistricts(
      inputs({
        assistance: [
          {
            state: 'NY',
            district: 'ZZ',
            basis: 'place_of_performance',
            awardCount: 1,
            totalObligated: 250_000,
            totalOutlayed: 100_000,
          },
        ],
      }),
    );
    expect(unmapped.unmappedGrantAmount).toBe(250_000);
  });
});

describe('null is not zero', () => {
  test('a district with only contracts reports null grants, not 0', () => {
    const { districts } = foldDistricts(
      inputs({ contracts: [{ state: 'TX', district: '23', awardCount: 1, totalAmount: 100 }] }),
    );
    expect(districts[0]?.contractObligations).toBe(100);
    // Rendering these as $0 would claim we checked and found nothing.
    expect(districts[0]?.grantObligations).toBeNull();
    expect(districts[0]?.grantOutlays).toBeNull();
  });

  test('no rows at all yields null unmapped totals, not zeros', () => {
    const { unmapped } = foldDistricts(inputs());
    expect(unmapped.unmappedContractAmount).toBeNull();
    expect(unmapped.unmappedGrantAmount).toBeNull();
  });
});

describe('geography basis precedence', () => {
  test('a single recipient-location row downgrades the whole district', () => {
    // §5.3: recipient location ranks below place of performance. Mixing them
    // means the district total is no longer purely place-of-performance.
    const { districts } = foldDistricts(
      inputs({
        assistance: [
          {
            state: 'TX',
            district: '23',
            basis: 'place_of_performance',
            awardCount: 1,
            totalObligated: 900,
            totalOutlayed: 0,
          },
          {
            state: 'TX',
            district: '23',
            basis: 'recipient_location',
            awardCount: 1,
            totalObligated: 100,
            totalOutlayed: 0,
          },
        ],
      }),
    );
    expect(districts[0]?.grantObligations).toBe(1000);
    expect(districts[0]?.assistanceBasis).toBe('recipient_location');

    const evidence = evidenceForDistrict(districts[0]!);
    expect(evidence.grantPlaceOfPerformance?.strength).toBe('recipientLocation');
  });

  test('pure place-of-performance keeps full authority', () => {
    const { districts } = foldDistricts(
      inputs({
        assistance: [
          {
            state: 'TX',
            district: '23',
            basis: 'place_of_performance',
            awardCount: 1,
            totalObligated: 900,
            totalOutlayed: 0,
          },
        ],
      }),
    );
    expect(evidenceForDistrict(districts[0]!).grantPlaceOfPerformance?.strength).toBe(
      'sourceAuthoritative',
    );
  });
});

describe('opportunities never manufacture awarded funding', () => {
  test('a district with only opportunities earns zero grant credit', () => {
    const { districts } = foldDistricts(
      inputs({
        opportunities: [
          { state: 'TX', district: '23', estimatedFunding: 2_000_000, awardCeiling: 3_000_000 },
        ],
      }),
    );
    const evidence = evidenceForDistrict(districts[0]!);
    expect(evidence.grantPlaceOfPerformance?.opportunityOnly).toBe(true);

    const response = buildClientNexusResponse(
      inputs({
        opportunities: [
          { state: 'TX', district: '23', estimatedFunding: 2_000_000, awardCeiling: 3_000_000 },
        ],
      }),
    );
    // The forecast is reported, but contributes no awarded credit.
    expect(response.opportunities.opportunityEstimatedFunding).toBe(2_000_000);
    expect(response.awarded.grantObligations).toBeNull();
    expect(response.districts[0]?.breakdown.find((b) => b.component === 'grantPlaceOfPerformance')?.credit).toBe(0);
  });
});

describe('buildClientNexusResponse', () => {
  const rich: ClientNexusInputs = inputs({
    contracts: [
      { state: 'TX', district: '23', awardCount: 2, totalAmount: 30_000_000 },
      { state: 'VA', district: '11', awardCount: 1, totalAmount: 1_000_000 },
    ],
    assistance: [
      {
        state: 'TX',
        district: '23',
        basis: 'place_of_performance',
        awardCount: 1,
        totalObligated: 8_700_000,
        totalOutlayed: 4_200_000,
      },
    ],
    facilities: [{ state: 'TX', districtCode: '23', employeeCount: 420 }],
  });

  test('rolls up awarded funding without ever blending instruments', () => {
    const response = buildClientNexusResponse(rich);
    expect(response.awarded.contractObligations).toBe(31_000_000);
    expect(response.awarded.grantObligations).toBe(8_700_000);
    expect(response.awarded.grantOutlays).toBe(4_200_000);
    // The contract that proves it: there is no combined total to read.
    expect(response.awarded).not.toHaveProperty('totalAmount');
  });

  test('orders districts strongest-first, not database order', () => {
    const response = buildClientNexusResponse(rich);
    expect(response.districts[0]?.districtKey).toBe('TX-23');
  });

  test('every district carries a breakdown that explains its score', () => {
    const response = buildClientNexusResponse(rich);
    for (const district of response.districts) {
      const declared = district.breakdown.reduce((s, b) => s + b.weight, 0);
      expect(declared).toBe(100);
    }
  });

  test('an empty client scores null rather than zero', () => {
    const response = buildClientNexusResponse(inputs());
    expect(response.districts).toEqual([]);
    expect(response.score).toBeNull();
    expect(response.coveragePercent).toBe(0);
  });

  test('generatedAt is passed through for ETag / freshness semantics', () => {
    expect(buildClientNexusResponse(rich).generatedAt).toBe(GENERATED_AT);
  });
});
