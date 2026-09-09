import { Prisma } from '@prisma/client';
import { buildClientAwardScope, clientAwardScopeSql } from './client-award-scope.js';
import type { ProfileMapping } from './client-opportunity-profile.types.js';

const CONTRACTOR = '11111111-1111-1111-1111-111111111111';
const SUBSIDIARY = '22222222-2222-2222-2222-222222222222';

function mapping(overrides: Partial<ProfileMapping> = {}): ProfileMapping {
  return {
    externalId: CONTRACTOR,
    externalName: 'L3HARRIS TECHNOLOGIES, INC.',
    matchBasis: 'exact_legal_name',
    matchTier: 2,
    ...overrides,
  };
}

describe('client award row scope', () => {
  it('recovers reviewed L3 names for historical rows missing a UEI without discarding its own UEI', () => {
    const { contract } = buildClientAwardScope(
      {
        uei: 'QM4EZDV15JL8',
        contractingMappings: [mapping()],
        assistanceMappings: [],
      },
      new Map([[CONTRACTOR, null]]),
    );

    expect(contract).toEqual({
      ueis: ['QM4EZDV15JL8'],
      missingUeiNames: ['l3harris technologies, inc.'],
    });
    const predicate = clientAwardScopeSql(contract)!;
    // The exact-name arm cannot admit a known conflicting UEI, or a malformed
    // nonblank identifier. It recovers only NULL/blank source identifiers.
    expect(predicate.text).toBe(
      "(recipient_uei = ANY($1::text[]) OR (NULLIF(BTRIM(recipient_uei), '') IS NULL AND lower(contractor_name) = ANY($2::text[])))",
    );
    expect(predicate.values).toEqual([['QM4EZDV15JL8'], ['l3harris technologies, inc.']]);
  });

  it('retains each approved subsidiary UEI and reviewed historical name', () => {
    const { contract } = buildClientAwardScope(
      {
        uei: 'QM4EZDV15JL8',
        contractingMappings: [
          mapping(),
          mapping({ externalId: SUBSIDIARY, externalName: 'Reviewed Subsidiary' }),
        ],
        assistanceMappings: [],
      },
      new Map([
        [CONTRACTOR, 'QM4EZDV15JL8'],
        [SUBSIDIARY, 'SUB123456789'],
      ]),
    );

    expect(contract.ueis).toEqual(['QM4EZDV15JL8', 'SUB123456789']);
    expect(contract.missingUeiNames).toEqual([
      'l3harris technologies, inc.',
      'reviewed subsidiary',
    ]);
  });

  it.each([
    [null, 2],
    ['legacy_unrecorded', 2],
    ['fuzzy_name', 4],
    ['exact_legal_name', 4],
    ['unrecognized_basis', 1],
  ])('rejects a name with basis %s and tier %s', (matchBasis, matchTier) => {
    const { contract } = buildClientAwardScope({
      uei: null,
      contractingMappings: [mapping({ matchBasis, matchTier })],
      assistanceMappings: [],
    });
    expect(clientAwardScopeSql(contract)).toBeNull();
  });

  it('requires missing UEI even when only a manually reviewed name is available', () => {
    const { contract } = buildClientAwardScope({
      uei: null,
      contractingMappings: [mapping({ matchBasis: 'manual_pin', matchTier: 1 })],
      assistanceMappings: [],
    });
    expect(clientAwardScopeSql(contract)?.text).toBe(
      "((NULLIF(BTRIM(recipient_uei), '') IS NULL AND lower(contractor_name) = ANY($1::text[])))",
    );
  });

  it('keeps a reviewed mapping resolved UEI authoritative without promoting its fuzzy name', () => {
    const { contract } = buildClientAwardScope(
      {
        uei: null,
        contractingMappings: [mapping({ matchBasis: 'fuzzy_name', matchTier: 4 })],
        assistanceMappings: [],
      },
      new Map([[CONTRACTOR, 'QM4EZDV15JL8']]),
    );
    expect(contract).toEqual({ ueis: ['QM4EZDV15JL8'], missingUeiNames: [] });
    expect(clientAwardScopeSql(contract)?.text).toBe('(recipient_uei = ANY($1::text[]))');
  });

  it('does not use assistance mappings to identify contract awards', () => {
    const scope = buildClientAwardScope({
      uei: null,
      contractingMappings: [],
      assistanceMappings: [mapping({ externalId: 'ABC123456789' })],
    });
    expect(clientAwardScopeSql(scope.contract)).toBeNull();
    expect(scope.assistance.ueis).toEqual(['ABC123456789']);
  });

  it('guards a subaward participant name using that same participant UEI', () => {
    const predicate = clientAwardScopeSql(
      { ueis: [], missingUeiNames: ['reviewed subsidiary'] },
      Prisma.sql`subawardee_uei`,
      Prisma.sql`subawardee_name`,
    );
    expect(predicate?.text).toBe(
      "((NULLIF(BTRIM(subawardee_uei), '') IS NULL AND lower(subawardee_name) = ANY($1::text[])))",
    );
  });
});
