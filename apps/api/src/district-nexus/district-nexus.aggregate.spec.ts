import { describe, expect, test } from '@jest/globals';
import {
  buildClientNexusResponse,
  buildDistrictClientBreakdown,
  districtKeyFor,
  evidenceForDistrict,
  foldDistricts,
  isStatewide,
  type ClientNexusInputs,
} from './district-nexus.aggregate.js';
import { scoreNexus } from './district-nexus-scoring.js';

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

  test('pure place-of-performance keeps full authority when the recipient is UEI-verified', () => {
    const { districts } = foldDistricts(
      inputs({
        assistance: [
          {
            state: 'TX',
            district: '23',
            basis: 'place_of_performance',
            matchBasis: 'uei',
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
    // None of this fixture's facilities are geocoded and none of its contracts
    // carry a verified identifier (contracts never do — see CONTRACT_TIER), so
    // pooled strength is userProvided/inferred throughout, not full strength:
    // facility 25*0.5 + employees 20*0.5 + contract 10*0.5 = 27.5, rounds to 28.
    expect(response.score).toBe(28);
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

/**
 * WS-H: the widget's honest states need three facts the money fields cannot
 * answer — is a contracting rail confirmed, is an assistance rail confirmed,
 * and how many facilities/employees exist INCLUDING the ones whose district
 * never resolved. `districts[]` necessarily omits the latter, so counting the
 * footprint from it would understate the client.
 */
describe('buildClientNexusResponse — linkage and facility footprint (WS-H)', () => {
  test('defaults linkage to nothing-linked when the caller omits it', () => {
    const response = buildClientNexusResponse(inputs());
    expect(response.linkage).toEqual({
      contractingLinked: false,
      contractorNames: [],
      assistanceLinked: false,
      recipientNames: [],
      ueiConfirmedCount: 0,
    });
  });

  test('passes linkage through verbatim when supplied', () => {
    const response = buildClientNexusResponse(
      inputs({
        linkage: {
          contractingLinked: true,
          contractorNames: ['Acme Defense'],
          assistanceLinked: true,
          recipientNames: ['Acme Research Institute'],
          ueiConfirmedCount: 2,
        },
      }),
    );
    expect(response.linkage.contractingLinked).toBe(true);
    expect(response.linkage.contractorNames).toEqual(['Acme Defense']);
    expect(response.linkage.assistanceLinked).toBe(true);
    expect(response.linkage.recipientNames).toEqual(['Acme Research Institute']);
    expect(response.linkage.ueiConfirmedCount).toBe(2);
  });

  test('counts facilities with no resolvable district in facilitiesWithoutDistrict', () => {
    const response = buildClientNexusResponse(
      inputs({
        facilities: [
          { state: 'TX', districtCode: '23', employeeCount: null },
          { state: null, districtCode: null, employeeCount: null },
        ],
      }),
    );
    expect(response.facilityFootprint.facilityCount).toBe(2);
    expect(response.facilityFootprint.facilitiesWithoutDistrict).toBe(1);
  });

  test('reports employeeCount null (not 0) when no facility reported a headcount', () => {
    const response = buildClientNexusResponse(
      inputs({
        facilities: [
          { state: 'TX', districtCode: '23', employeeCount: null },
          { state: 'VA', districtCode: '11', employeeCount: null },
        ],
      }),
    );
    // Null is "no figure", never zero employees — the widget renders '—' for it.
    expect(response.facilityFootprint.employeeCount).toBeNull();
    expect(response.facilityFootprint.facilitiesMissingEmployeeCount).toBe(2);
  });

  test('sums employees across ALL facilities including district-less ones', () => {
    const response = buildClientNexusResponse(
      inputs({
        facilities: [
          { state: 'TX', districtCode: '23', employeeCount: 100 },
          { state: null, districtCode: null, employeeCount: 20 },
        ],
      }),
    );
    expect(response.facilityFootprint.employeeCount).toBe(120);
    expect(response.facilityFootprint.facilityCount).toBe(2);
    expect(response.facilityFootprint.facilitiesWithoutDistrict).toBe(1);
    expect(response.facilityFootprint.facilitiesMissingEmployeeCount).toBe(0);
  });
});

/**
 * Audit F2: the evidence table's verification status and the score's
 * EvidenceStrength must agree — a name-matched contract that reads "inferred"
 * in the evidence panel must not silently earn full-strength score credit,
 * and a hand-typed facility address must not silently earn a geocoder's
 * credit. See district-nexus.verification.ts for the shared tier table.
 */
describe('the score carries the verification tier the evidence table shows', () => {
  function foldOne(partial: Partial<ClientNexusInputs>) {
    return foldDistricts(inputs(partial)).districts[0]!;
  }

  test('a hand-typed facility claim earns userProvided strength and half credit', () => {
    const acc = foldOne({
      facilities: [
        {
          state: 'TX',
          districtCode: '23',
          employeeCount: 50,
          districtSource: 'user',
          geocodeStatus: 'no_match',
        },
      ],
    });
    const evidence = evidenceForDistrict(acc);
    expect(evidence.verifiedFacility?.strength).toBe('userProvided');
    const scored = scoreNexus({ components: evidence });
    expect(scored.breakdown.find((b) => b.component === 'verifiedFacility')?.credit).toBe(12.5);
  });

  test('a geocoded facility claim earns full verified strength and credit', () => {
    const acc = foldOne({
      facilities: [{ state: 'TX', districtCode: '23', employeeCount: 50, districtSource: 'geocoded' }],
    });
    const evidence = evidenceForDistrict(acc);
    expect(evidence.verifiedFacility?.strength).toBe('verified');
    const scored = scoreNexus({ components: evidence });
    expect(scored.breakdown.find((b) => b.component === 'verifiedFacility')?.credit).toBe(25);
  });

  test('one geocoded facility and one user-provided one pool to the weaker strength', () => {
    const acc = foldOne({
      facilities: [
        { state: 'TX', districtCode: '23', employeeCount: 50, districtSource: 'geocoded' },
        {
          state: 'TX',
          districtCode: '23',
          employeeCount: 10,
          districtSource: 'user',
          geocodeStatus: 'no_match',
        },
      ],
    });
    expect(evidenceForDistrict(acc).verifiedFacility?.strength).toBe('userProvided');
  });

  test('a contract is always inferred — the rail joins on contractor name only', () => {
    const acc = foldOne({
      contracts: [{ state: 'TX', district: '23', awardCount: 1, totalAmount: 1_000_000 }],
    });
    const evidence = evidenceForDistrict(acc);
    expect(evidence.contractPlaceOfPerformance?.strength).toBe('inferred');
    const scored = scoreNexus({ components: evidence });
    expect(scored.breakdown.find((b) => b.component === 'contractPlaceOfPerformance')?.credit).toBe(5);
  });

  test('a UEI-matched, place-of-performance assistance row earns full credit', () => {
    const acc = foldOne({
      assistance: [
        {
          state: 'TX',
          district: '23',
          basis: 'place_of_performance',
          matchBasis: 'uei',
          awardCount: 1,
          totalObligated: 1_000_000,
          totalOutlayed: 0,
        },
      ],
    });
    const evidence = evidenceForDistrict(acc);
    expect(evidence.grantPlaceOfPerformance?.strength).toBe('sourceAuthoritative');
    const scored = scoreNexus({ components: evidence });
    expect(scored.breakdown.find((b) => b.component === 'grantPlaceOfPerformance')?.credit).toBe(10);
  });

  test('a name-matched, place-of-performance assistance row is discounted to inferred', () => {
    const acc = foldOne({
      assistance: [
        {
          state: 'TX',
          district: '23',
          basis: 'place_of_performance',
          matchBasis: 'recipient_name',
          awardCount: 1,
          totalObligated: 1_000_000,
          totalOutlayed: 0,
        },
      ],
    });
    const evidence = evidenceForDistrict(acc);
    expect(evidence.grantPlaceOfPerformance?.strength).toBe('inferred');
    const scored = scoreNexus({ components: evidence });
    expect(scored.breakdown.find((b) => b.component === 'grantPlaceOfPerformance')?.credit).toBe(5);
  });

  test('a UEI-matched but recipient-location row is discounted to recipientLocation', () => {
    const acc = foldOne({
      assistance: [
        {
          state: 'TX',
          district: '23',
          basis: 'recipient_location',
          matchBasis: 'uei',
          awardCount: 1,
          totalObligated: 1_000_000,
          totalOutlayed: 0,
        },
      ],
    });
    const evidence = evidenceForDistrict(acc);
    expect(evidence.grantPlaceOfPerformance?.strength).toBe('recipientLocation');
    const scored = scoreNexus({ components: evidence });
    expect(scored.breakdown.find((b) => b.component === 'grantPlaceOfPerformance')?.credit).toBe(5);
  });

  test('two weaknesses (name match AND recipient location) do not compound', () => {
    const acc = foldOne({
      assistance: [
        {
          state: 'TX',
          district: '23',
          basis: 'recipient_location',
          matchBasis: 'recipient_name',
          awardCount: 1,
          totalObligated: 1_000_000,
          totalOutlayed: 0,
        },
      ],
    });
    const scored = scoreNexus({ components: evidenceForDistrict(acc) });
    // Weakest-wins, not multiplied: 10 * 0.5, NOT 10 * 0.5 * 0.5.
    expect(scored.breakdown.find((b) => b.component === 'grantPlaceOfPerformance')?.credit).toBe(5);
  });

  test('matchBasis omitted defaults to the conservative recipient_name reading', () => {
    const acc = foldOne({
      assistance: [
        {
          state: 'TX',
          district: '23',
          basis: 'place_of_performance',
          awardCount: 1,
          totalObligated: 1_000_000,
          totalOutlayed: 0,
        },
      ],
    });
    expect(evidenceForDistrict(acc).grantPlaceOfPerformance?.strength).toBe('inferred');
  });
});

/**
 * Audit F4: reviewed ClientGrantNexus relationships (subrecipient, project
 * site, partner, beneficiary, etc.) reach the score exactly like every other
 * rail. district-nexus.service.ts's aggregateRelationshipNexus is what turns
 * a raw ClientGrantNexus + linked award/facility into the row shape below —
 * these fixtures represent that resolution already having happened, which is
 * the boundary this I/O-free module actually owns.
 */
describe('reviewed client↔award relationships reach the numbers (audit F4)', () => {
  test("a subrecipient row with a stated share adds exactly that amount, not the award's full amount", () => {
    const { districts } = foldDistricts(
      inputs({
        relationships: [
          {
            clientId: 'client-1',
            state: 'TX',
            district: '23',
            component: 'grantPlaceOfPerformance',
            obligatedAmount: 250_000,
            outlayedAmount: null,
            strength: 'userProvided',
            geographyBasis: 'place_of_performance',
          },
        ],
      }),
    );
    expect(districts[0]?.grantObligations).toBe(250_000);
  });

  test('a subrecipient row with no stated share adds null money but still marks presence', () => {
    const { districts } = foldDistricts(
      inputs({
        relationships: [
          {
            clientId: 'client-1',
            state: 'TX',
            district: '23',
            component: 'grantPlaceOfPerformance',
            obligatedAmount: null,
            outlayedAmount: null,
            strength: 'userProvided',
            geographyBasis: 'place_of_performance',
          },
        ],
      }),
    );
    expect(districts[0]?.grantObligations).toBeNull();
    expect(districts[0]?.grantStrength).toBe('userProvided');
  });

  test("a direct_recipient row already resolved to the award's full amount carries both obligations and outlays", () => {
    const { districts } = foldDistricts(
      inputs({
        relationships: [
          {
            clientId: 'client-1',
            state: 'TX',
            district: '23',
            component: 'grantPlaceOfPerformance',
            obligatedAmount: 5_000_000,
            outlayedAmount: 2_000_000,
            strength: 'verified',
            geographyBasis: 'place_of_performance',
          },
        ],
      }),
    );
    expect(districts[0]?.grantObligations).toBe(5_000_000);
    expect(districts[0]?.grantOutlays).toBe(2_000_000);
  });

  test('a beneficiary row populates partnerBeneficiary and raises coverage above the pre-F4 65% ceiling', () => {
    const { districts } = foldDistricts(
      inputs({
        facilities: [{ state: 'TX', districtCode: '23', employeeCount: 50, districtSource: 'geocoded' }],
        contracts: [{ state: 'TX', district: '23', awardCount: 1, totalAmount: 1_000_000 }],
        assistance: [
          {
            state: 'TX',
            district: '23',
            basis: 'place_of_performance',
            matchBasis: 'uei',
            awardCount: 1,
            totalObligated: 1_000_000,
            totalOutlayed: 0,
          },
        ],
        relationships: [
          {
            clientId: 'client-1',
            state: 'TX',
            district: '23',
            component: 'partnerBeneficiary',
            obligatedAmount: null,
            outlayedAmount: null,
            strength: 'verified',
            geographyBasis: 'place_of_performance',
          },
        ],
      }),
    );
    const evidence = evidenceForDistrict(districts[0]!);
    expect(evidence.partnerBeneficiary).toEqual({ strength: 'verified', evidenceCount: 1 });
    const scored = scoreNexus({ components: evidence });
    // facility 25 + employees 20 + contract 10 + grant 10 = 65 was the only
    // coverage reachable before F4; partnerBeneficiary's 10 pushes it to 75.
    expect(scored.coveragePercent).toBe(75);
  });

  test('an unverified relationship scores userProvided (half); an explicitly verified one scores verified (full)', () => {
    const unverified = foldDistricts(
      inputs({
        relationships: [
          {
            clientId: 'client-1',
            state: 'TX',
            district: '23',
            component: 'partnerBeneficiary',
            obligatedAmount: null,
            outlayedAmount: null,
            strength: 'userProvided',
            geographyBasis: 'place_of_performance',
          },
        ],
      }),
    ).districts[0]!;
    expect(evidenceForDistrict(unverified).partnerBeneficiary?.strength).toBe('userProvided');

    const verified = foldDistricts(
      inputs({
        relationships: [
          {
            clientId: 'client-1',
            state: 'TX',
            district: '23',
            component: 'partnerBeneficiary',
            obligatedAmount: null,
            outlayedAmount: null,
            strength: 'verified',
            geographyBasis: 'place_of_performance',
          },
        ],
      }),
    ).districts[0]!;
    expect(evidenceForDistrict(verified).partnerBeneficiary?.strength).toBe('verified');
  });

  test('a grant-shaped relationship with no resolvable district joins unmapped, never a district', () => {
    const { districts, unmapped } = foldDistricts(
      inputs({
        relationships: [
          {
            clientId: 'client-1',
            state: null,
            district: null,
            component: 'grantPlaceOfPerformance',
            obligatedAmount: 400_000,
            outlayedAmount: null,
            strength: 'verified',
            geographyBasis: 'unknown',
          },
        ],
      }),
    );
    expect(districts).toHaveLength(0);
    expect(unmapped.unmappedGrantAmount).toBe(400_000);
  });

  test('a partnerBeneficiary row with no resolvable district contributes nothing anywhere — presence alone has no unmapped bucket', () => {
    const { districts, unmapped } = foldDistricts(
      inputs({
        relationships: [
          {
            clientId: 'client-1',
            state: null,
            district: null,
            component: 'partnerBeneficiary',
            obligatedAmount: null,
            outlayedAmount: null,
            strength: 'verified',
            geographyBasis: 'unknown',
          },
        ],
      }),
    );
    expect(districts).toHaveLength(0);
    expect(unmapped.unmappedContractAmount).toBeNull();
    expect(unmapped.unmappedGrantAmount).toBeNull();
  });
});

/**
 * Audit F5: the district drawer's "Clients in this district" list must be
 * seeded from every nexus source, not just facilities. Pre-fix, a client
 * whose only presence was award geography or a reviewed relationship never
 * appeared, and the Contracts/Grants columns were permanently em-dashed for
 * the clients it did show because nothing populated them.
 */
describe('buildDistrictClientBreakdown (audit F5)', () => {
  const byClient = new Map([
    [
      'client-1',
      { clientName: 'Acme Defense', contractorNames: ['Acme Defense LLC'], recipientUeis: [], recipientNames: [] },
    ],
  ]);

  test('a client with a matched award but no facility still appears, with real awarded totals', () => {
    const clients = buildDistrictClientBreakdown({
      districtKey: 'TX-23',
      facilities: [],
      byClient,
      contractRows: [{ identifier: 'Acme Defense LLC', state: 'TX', district: '23', totalAmount: 500_000 }],
      assistanceRows: [],
      relationships: [],
    });
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({ clientId: 'client-1', clientName: 'Acme Defense', facilityCount: 0 });
    expect(clients[0]?.employeeCount).toBeNull();
    expect(clients[0]?.awarded.contractObligations).toBe(500_000);
  });

  test('a client with a facility but no matched award appears with null awarded totals, not $0', () => {
    const clients = buildDistrictClientBreakdown({
      districtKey: 'TX-23',
      facilities: [{ clientId: 'client-2', clientName: 'Beta Research', employeeCount: 40 }],
      byClient: new Map(),
      contractRows: [],
      assistanceRows: [],
      relationships: [],
    });
    expect(clients).toHaveLength(1);
    expect(clients[0]?.awarded).toEqual({
      contractObligations: null,
      grantObligations: null,
      grantOutlays: null,
    });
    expect(clients[0]?.employeeCount).toBe(40);
  });

  test('a client whose only nexus is a reviewed relationship still appears', () => {
    const clients = buildDistrictClientBreakdown({
      districtKey: 'TX-23',
      facilities: [],
      byClient: new Map(),
      contractRows: [],
      assistanceRows: [],
      relationships: [
        {
          clientId: 'client-3',
          clientName: 'Gamma Partners',
          state: 'TX',
          district: '23',
          component: 'partnerBeneficiary',
          obligatedAmount: null,
          outlayedAmount: null,
        },
      ],
    });
    expect(clients).toHaveLength(1);
    expect(clients[0]?.clientName).toBe('Gamma Partners');
    expect(clients[0]?.awarded.grantObligations).toBeNull();
  });

  test('a relationship scoped to a different district is not attributed here', () => {
    const clients = buildDistrictClientBreakdown({
      districtKey: 'TX-23',
      facilities: [],
      byClient: new Map(),
      contractRows: [],
      assistanceRows: [],
      relationships: [
        {
          clientId: 'client-4',
          clientName: 'Delta Co',
          state: 'VA',
          district: '11',
          component: 'grantPlaceOfPerformance',
          obligatedAmount: 100_000,
          outlayedAmount: null,
        },
      ],
    });
    expect(clients).toHaveLength(0);
  });

  test('a client with a confirmed mapping but zero activity in THIS district is not listed', () => {
    const clients = buildDistrictClientBreakdown({
      districtKey: 'TX-23',
      facilities: [],
      byClient: new Map([
        [
          'client-5',
          { clientName: 'Epsilon Inc', contractorNames: ['Epsilon Inc'], recipientUeis: [], recipientNames: [] },
        ],
      ]),
      contractRows: [{ identifier: 'Epsilon Inc', state: 'VA', district: '11', totalAmount: 1_000_000 }],
      assistanceRows: [],
      relationships: [],
    });
    expect(clients).toHaveLength(0);
  });

  test('facility and award nexus for the SAME client merge into one row rather than two', () => {
    const clients = buildDistrictClientBreakdown({
      districtKey: 'TX-23',
      facilities: [{ clientId: 'client-1', clientName: 'Acme Defense', employeeCount: 12 }],
      byClient,
      contractRows: [{ identifier: 'Acme Defense LLC', state: 'TX', district: '23', totalAmount: 500_000 }],
      assistanceRows: [],
      relationships: [],
    });
    expect(clients).toHaveLength(1);
    expect(clients[0]?.facilityCount).toBe(1);
    expect(clients[0]?.employeeCount).toBe(12);
    expect(clients[0]?.awarded.contractObligations).toBe(500_000);
  });

  test('assistance is matched by UEI or lowercased recipient name, same as the firm-wide rail', () => {
    const clients = buildDistrictClientBreakdown({
      districtKey: 'TX-23',
      facilities: [],
      byClient: new Map([
        [
          'client-6',
          { clientName: 'Zeta Labs', contractorNames: [], recipientUeis: ['K2QB7VNX9DM4'], recipientNames: [] },
        ],
      ]),
      contractRows: [],
      assistanceRows: [
        {
          uei: 'K2QB7VNX9DM4',
          nameLower: null,
          state: 'TX',
          district: '23',
          totalObligated: 900_000,
          totalOutlayed: 400_000,
        },
      ],
      relationships: [],
    });
    expect(clients[0]?.awarded.grantObligations).toBe(900_000);
    expect(clients[0]?.awarded.grantOutlays).toBe(400_000);
  });
});
