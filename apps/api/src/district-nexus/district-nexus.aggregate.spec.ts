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

/**
 * The client roll-up pools evidence across districts and scores it once.
 *
 * These are the only automated protection this behaviour has — CI runs no
 * apps/api jest at all (ci-pr.yml is typecheck plus four unrelated package
 * suites), so a regression here reaches capiro-dev unchallenged.
 */
describe('client roll-up pools evidence rather than averaging district scores', () => {
  /** One well-evidenced district plus several thin contract-only ones. */
  const lopsided = inputs({
    contracts: [
      { state: 'TX', district: '23', awardCount: 2, totalAmount: 30_000_000 },
      { state: 'VA', district: '11', awardCount: 1, totalAmount: 400_000 },
      { state: 'CA', district: '12', awardCount: 1, totalAmount: 300_000 },
      { state: 'NY', district: '10', awardCount: 1, totalAmount: 200_000 },
      { state: 'OH', district: '03', awardCount: 1, totalAmount: 100_000 },
    ],
    facilities: [{ state: 'TX', districtCode: '23', employeeCount: 420 }],
  });

  test('a strong district is not diluted by six incidental ones', () => {
    const response = buildClientNexusResponse(lopsided);
    // Facility 25 + employees 20 + contract 10 = 55, all pooled at full strength.
    expect(response.score).toBe(55);
    // The mean of the per-district scores would be far lower, and most of those
    // districts do not even have a score to average.
    const scored = response.districts.filter((d) => d.score != null);
    expect(scored.length).toBeLessThan(response.districts.length);
  });

  test('award-only districts still pool to null, never to zero', () => {
    const awardOnly = inputs({
      contracts: [
        { state: 'TX', district: '23', awardCount: 1, totalAmount: 5_000_000 },
        { state: 'VA', district: '11', awardCount: 1, totalAmount: 4_000_000 },
        { state: 'CA', district: '12', awardCount: 1, totalAmount: 3_000_000 },
      ],
    });
    const response = buildClientNexusResponse(awardOnly);
    // Contract place-of-performance alone is 10 of 100 weight — below the 15%
    // coverage floor, so the honest answer is "unknown", not a low number.
    expect(response.coveragePercent).toBe(10);
    expect(response.score).toBeNull();
    expect(response.score).not.toBe(0);
  });

  test('adding evidence never lowers the client score (monotonicity)', () => {
    const before = buildClientNexusResponse(lopsided).score;
    const after = buildClientNexusResponse(
      inputs({
        ...lopsided,
        // A second facility in a previously contract-only district: strictly more
        // verified evidence than `lopsided` had.
        facilities: [
          { state: 'TX', districtCode: '23', employeeCount: 420 },
          { state: 'VA', districtCode: '11', employeeCount: 12 },
        ],
      }),
    ).score;
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after as number).toBeGreaterThanOrEqual(before as number);
  });

  test('a degraded basis in one district is not laundered by a stronger one', () => {
    const mixed = inputs({
      assistance: [
        {
          state: 'TX',
          district: '23',
          basis: 'place_of_performance',
          awardCount: 1,
          totalObligated: 5_000_000,
          totalOutlayed: 1_000_000,
        },
        {
          state: 'VA',
          district: '11',
          basis: 'recipient_location',
          awardCount: 1,
          totalObligated: 2_000_000,
          totalOutlayed: 500_000,
        },
      ],
      facilities: [{ state: 'TX', districtCode: '23', employeeCount: 100 }],
    });
    const response = buildClientNexusResponse(mixed);
    const grant = response.breakdown.find((b) => b.component === 'grantPlaceOfPerformance');
    // Weakest-basis-wins: half of the 10-point weight, not the full 10 the
    // place-of-performance district alone would have earned.
    expect(grant?.credit).toBe(5);
    expect(response.warnings.some((w) => w.code === 'recipient_location_fallback')).toBe(true);
  });

  test('the client breakdown explains the client score, not one district', () => {
    const response = buildClientNexusResponse(lopsided);
    const credited = response.breakdown.reduce((s, b) => s + b.credit, 0);
    expect(Math.round(credited)).toBe(response.score);
    expect(response.breakdown.reduce((s, b) => s + b.weight, 0)).toBe(100);
  });

  test('bestDistrictKey keeps the strongest-district signal as a fact', () => {
    expect(buildClientNexusResponse(lopsided).bestDistrictKey).toBe('TX-23');
    // Null when nothing cleared the coverage floor — not an arbitrary district.
    expect(buildClientNexusResponse(inputs()).bestDistrictKey).toBeNull();
  });

  test('strongestDrivers is surfaced instead of being computed and discarded', () => {
    const response = buildClientNexusResponse(lopsided);
    expect(response.strongestDrivers.length).toBeGreaterThan(0);
    expect(response.strongestDrivers.every((d) => d.credit > 0)).toBe(true);
    const credits = response.strongestDrivers.map((d) => d.credit);
    expect([...credits].sort((a, b) => b - a)).toEqual(credits);
  });
});

/**
 * WS-E4: evidenceByDistrict is the only way a per-district `evidence[]` gets
 * populated. foldDistricts has no per-record identity to build evidence from
 * (it works in SUM/GROUP BY), so the caller fetches record-level rows
 * separately, maps them (district-nexus.evidence.ts) and hands the grouped
 * result in here.
 */
describe('evidenceByDistrict flows into the right district, and only there', () => {
  const twoDistrictInputs = inputs({
    contracts: [
      { state: 'TX', district: '23', awardCount: 1, totalAmount: 1_000 },
      { state: 'VA', district: '11', awardCount: 1, totalAmount: 1_000 },
    ],
  });

  const fakeEvidence = (label: string) => ({
    component: 'contractPlaceOfPerformance',
    sourceType: 'federal_award',
    label,
    sourceRecordId: 'row-1',
    sourceUpdatedAt: null,
    observedAt: null,
    geographyBasis: 'place_of_performance' as const,
    verificationStatus: 'inferred' as const,
    confidence: null,
    externalUseApproved: true,
    boundaryVintage: 'unknown' as const,
    amount: 1_000,
  });

  test('a district with evidence gets it; a district without gets none', () => {
    const evidenceByDistrict = new Map([['TX-23', [fakeEvidence('Acme Defense')]]]);
    const response = buildClientNexusResponse({ ...twoDistrictInputs, evidenceByDistrict });
    const tx = response.districts.find((d) => d.districtKey === 'TX-23');
    const va = response.districts.find((d) => d.districtKey === 'VA-11');
    expect(tx?.evidence).toEqual([fakeEvidence('Acme Defense')]);
    expect(va?.evidence).toEqual([]);
  });

  test('omitting evidenceByDistrict entirely defaults every district to an empty list', () => {
    const response = buildClientNexusResponse(twoDistrictInputs);
    expect(response.districts.every((d) => d.evidence.length === 0)).toBe(true);
  });

  test('multiple evidence rows for one district all appear, in the order provided', () => {
    const rows = [fakeEvidence('Acme Defense'), fakeEvidence('Acme Research')];
    const evidenceByDistrict = new Map([['TX-23', rows]]);
    const response = buildClientNexusResponse({ ...twoDistrictInputs, evidenceByDistrict });
    expect(response.districts.find((d) => d.districtKey === 'TX-23')?.evidence).toEqual(rows);
  });
});
