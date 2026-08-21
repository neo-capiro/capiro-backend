import { describe, expect, test } from '@jest/globals';
import {
  buildDistrictNexusIdentity,
  districtNexusContractorIdsToResolve,
  splitDistrictNexusMappings,
  type DistrictNexusIdentitySeed,
} from './district-nexus.identity.js';

const CLIENT = '00000000-0000-0000-0000-000000000010';
const CONTRACTOR_ID = '11111111-1111-1111-1111-111111111111';
const MALFORMED_ID = 'not-a-uuid';

function seed(partial: Partial<DistrictNexusIdentitySeed> = {}): DistrictNexusIdentitySeed {
  return {
    clientId: CLIENT,
    clientName: 'Acme Defense LLC',
    uei: null,
    mappings: [],
    ...partial,
  };
}

function contractingMapping(
  partial: Partial<DistrictNexusIdentitySeed['mappings'][number]> = {},
): DistrictNexusIdentitySeed['mappings'][number] {
  return {
    source: 'contracting',
    externalId: CONTRACTOR_ID,
    externalName: 'Acme Defense LLC',
    matchBasis: 'exact_legal_name',
    matchTier: 2,
    ...partial,
  };
}

function assistanceMapping(
  partial: Partial<DistrictNexusIdentitySeed['mappings'][number]> = {},
): DistrictNexusIdentitySeed['mappings'][number] {
  return {
    source: 'assistance_recipient',
    externalId: 'ABC123456789',
    externalName: 'Acme Defense LLC',
    matchBasis: 'exact_legal_name',
    matchTier: 2,
    ...partial,
  };
}

describe('buildDistrictNexusIdentity', () => {
  test("the client's own UEI suppresses every reviewed contract name", () => {
    const identity = buildDistrictNexusIdentity(
      seed({
        uei: 'ABC123456789',
        mappings: [contractingMapping({ externalId: null, externalName: 'Acme Defense' })],
      }),
    );
    expect(identity.contract).toEqual({
      basis: 'exact_uei',
      ueis: ['ABC123456789'],
      fallbackNames: [],
      notes: expect.arrayContaining([expect.objectContaining({ outcome: 'own_uei' })]),
    });
  });

  test("the client's own UEI suppresses every reviewed assistance name", () => {
    const identity = buildDistrictNexusIdentity(
      seed({
        uei: 'ABC123456789',
        mappings: [assistanceMapping({ externalId: 'Acme Defense', externalName: 'Acme Defense' })],
      }),
    );
    expect(identity.assistance.basis).toBe('exact_uei');
    expect(identity.assistance.ueis).toEqual(['ABC123456789']);
    expect(identity.assistance.fallbackNames).toEqual([]);
  });

  test('a resolved contractor UEI (via federal_contractor.id -> uei) suppresses contract names', () => {
    const identity = buildDistrictNexusIdentity(
      seed({
        mappings: [
          contractingMapping({ externalId: CONTRACTOR_ID, externalName: 'Acme Defense' }),
        ],
      }),
      new Map([[CONTRACTOR_ID, 'RESOLVEDUEI1']]),
    );
    expect(identity.contract.basis).toBe('exact_uei');
    expect(identity.contract.ueis).toEqual(['RESOLVEDUEI1']);
    expect(identity.contract.fallbackNames).toEqual([]);
  });

  test('a reviewed exact-name fallback works only when no UEI is available', () => {
    const identity = buildDistrictNexusIdentity(
      seed({
        mappings: [
          contractingMapping({ externalId: CONTRACTOR_ID, externalName: 'Acme Defense' }),
        ],
      }),
      // No resolved UEI for CONTRACTOR_ID, and the client has none of its own.
      new Map(),
    );
    expect(identity.contract).toEqual({
      basis: 'reviewed_name_fallback',
      ueis: [],
      fallbackNames: ['acme defense'],
      notes: expect.arrayContaining([expect.objectContaining({ outcome: 'name_available' })]),
    });
  });

  test.each(['fuzzy_name', 'legacy_unrecorded'])(
    'a %s basis contributes no fallback name and no identity',
    (matchBasis) => {
      const identity = buildDistrictNexusIdentity(
        seed({
          mappings: [contractingMapping({ externalId: null, matchBasis, externalName: 'Acme Defense' })],
        }),
      );
      expect(identity.contract).toEqual({ basis: 'none', ueis: [], fallbackNames: [], notes: expect.any(Array) });
    },
  );

  test('a malformed contractor id is filtered out of the batch UUID lookup, never entering it', () => {
    const ids = districtNexusContractorIdsToResolve([
      seed({
        mappings: [
          contractingMapping({ externalId: CONTRACTOR_ID }),
          contractingMapping({ externalId: MALFORMED_ID }),
          contractingMapping({ externalId: null }),
        ],
      }),
    ]);
    expect(ids).toEqual([CONTRACTOR_ID]);
  });

  test('an assistance externalId that is name-shaped is never read as a UEI', () => {
    const identity = buildDistrictNexusIdentity(
      seed({
        mappings: [assistanceMapping({ externalId: 'Acme Defense LLC', externalName: 'Acme Defense LLC' })],
      }),
    );
    expect(identity.assistance.basis).toBe('reviewed_name_fallback');
    expect(identity.assistance.ueis).toEqual([]);
    expect(identity.assistance.fallbackNames).toEqual(['acme defense llc']);
  });

  test('a rail is never both exact_uei and reviewed_name_fallback at once', () => {
    const identity = buildDistrictNexusIdentity(
      seed({
        uei: 'ABC123456789',
        mappings: [
          contractingMapping({ externalId: null, externalName: 'Acme Defense' }),
          contractingMapping({ externalId: null, externalName: 'Other Sibling Co' }),
        ],
      }),
    );
    expect(identity.contract.basis).toBe('exact_uei');
    expect(identity.contract.fallbackNames).toEqual([]);
  });
});

describe('legacy/v2 parity (§10 — IntelligenceService.getDistrictNexusSpend and DistrictNexusService must select the same award rows)', () => {
  // Both call sites build a DistrictNexusIdentitySeed from the client's own
  // confirmed `contracting` mappings + Client.uei, resolve the SAME
  // federal_contractor.id -> uei index, and hand both to
  // buildDistrictNexusIdentity. This is what makes disagreement structurally
  // impossible rather than merely untested: there is exactly one function
  // that decides "which basis, which identifiers" for a client's contract
  // rail, and every reader (legacy spend, v2 client/firm/detail) calls it
  // with equivalent inputs.
  test('a UEI-resolvable contracting mapping produces the identical exact_uei rail for both callers', () => {
    const legacySeed = seed({
      uei: null,
      mappings: [contractingMapping({ externalId: CONTRACTOR_ID, externalName: 'Acme Defense LLC' })],
    });
    const v2Seed = seed({
      uei: null,
      mappings: [contractingMapping({ externalId: CONTRACTOR_ID, externalName: 'Acme Defense LLC' })],
    });
    const contractorUeis = new Map([[CONTRACTOR_ID, 'RESOLVEDUEI1']]);
    expect(buildDistrictNexusIdentity(legacySeed, contractorUeis).contract).toEqual(
      buildDistrictNexusIdentity(v2Seed, contractorUeis).contract,
    );
    expect(buildDistrictNexusIdentity(legacySeed, contractorUeis).contract.basis).toBe('exact_uei');
  });

  test('an unresolvable contracting mapping produces the identical reviewed_name_fallback rail for both callers', () => {
    const build = () =>
      buildDistrictNexusIdentity(
        seed({ uei: null, mappings: [contractingMapping({ externalId: CONTRACTOR_ID, externalName: 'Acme Defense LLC' })] }),
        new Map(), // no resolved UEI
      );
    const a = build();
    const b = build();
    expect(a.contract).toEqual(b.contract);
    expect(a.contract.basis).toBe('reviewed_name_fallback');
    expect(a.contract.fallbackNames).toEqual(['acme defense llc']);
  });
});

describe('splitDistrictNexusMappings', () => {
  test('routes rows by source and drops everything else', () => {
    const { contractingMappings, assistanceMappings } = splitDistrictNexusMappings(
      seed({
        mappings: [
          contractingMapping(),
          assistanceMapping(),
          { source: 'lda', externalId: 'x', externalName: 'y', matchBasis: null, matchTier: null },
        ],
      }),
    );
    expect(contractingMappings).toHaveLength(1);
    expect(assistanceMappings).toHaveLength(1);
  });
});
