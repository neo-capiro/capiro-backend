import { describe, expect, jest, test } from '@jest/globals';
import {
  AWARD_MATCH_BASES,
  FUZZY_MATCH_TIER,
  NON_IDENTIFYING_MATCH_BASES,
  buildAwardHistoryIdentity,
  contractorIdsToResolve,
} from './award-history-identity.js';
import {
  readAwardHistoryByBasis,
  resolveContractorUeis,
  toClientProfileFacts,
  type RawProfileClientRow,
  type RawProfileMappingRow,
} from './client-opportunity-profile.repository.js';

/**
 * P02 — exact identifiers dominate, and a reviewed name can never act as one.
 *
 * The three things that were wrong, each of which has a test below:
 *
 *  1. One SQL predicate OR'd UEIs with names, so a same-name entity contributed
 *     awards with the authority of a verified identifier and nothing downstream
 *     could tell which rows came by which route.
 *  2. A `contracting` mapping's `externalId` is a `federal_contractor` UUID, so
 *     no mapping ever produced a UEI for the contract rail. The verified UEI was
 *     one join away in `federal_contractor.uei` and was never read.
 *  3. `assistance_recipient` mappings store `COALESCE(recipient_uei,
 *     recipient_name)`, so the same field is sometimes a UEI and sometimes a
 *     name, and both rails were treated identically.
 */

const CLIENT = '00000000-0000-0000-0000-000000000010';
const CONTRACTOR_ID = '11111111-1111-1111-1111-111111111111';
const SUBSIDIARY_ID = '22222222-2222-2222-2222-222222222222';

function rawClient(partial: Partial<RawProfileClientRow> = {}): RawProfileClientRow {
  return {
    id: CLIENT,
    name: 'Acme Defense LLC',
    uei: 'ABC123456789',
    cageCode: '1ABC2',
    naicsCodes: ['336411'],
    pscCodes: [],
    applicantTypes: [],
    setAsideCertifications: [],
    sectorTag: 'DEFENSE',
    capabilities: [],
    facilities: [],
    ...partial,
  };
}

function mapping(partial: Partial<RawProfileMappingRow> = {}): RawProfileMappingRow {
  return {
    clientId: CLIENT,
    source: 'contracting',
    externalId: CONTRACTOR_ID,
    externalName: 'Acme Defense LLC',
    matchBasis: 'exact_legal_name',
    matchTier: 2,
    ...partial,
  };
}

function facts(client: Partial<RawProfileClientRow>, mappings: RawProfileMappingRow[]) {
  return toClientProfileFacts(rawClient(client), mappings);
}

// ── The acceptance criterion ────────────────────────────────────────────────

describe('a wrong same-name entity cannot add history when an exact UEI is present', () => {
  test("the client's own UEI suppresses every reviewed name on that rail", () => {
    // The rail-level rule, and the whole point of the phase. A per-mapping rule
    // would let a UEI-less sibling mapping reintroduce a name match for a client
    // that already holds a verified identifier.
    const identity = buildAwardHistoryIdentity(
      facts({ uei: 'ABC123456789' }, [
        mapping({ externalId: null, externalName: 'Acme Defense' }),
        mapping({ externalId: SUBSIDIARY_ID, externalName: 'Acme Subsidiary' }),
      ]),
      new Map([[SUBSIDIARY_ID, null]]),
    );
    expect(identity.contract.basis).toBe('exact_uei');
    expect(identity.contract.ueis).toEqual(['ABC123456789']);
    expect(identity.contract.fallbackNames).toEqual([]);
  });

  test('a resolved mapping UEI also suppresses names, even without a client UEI', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [
        mapping({ externalId: CONTRACTOR_ID, externalName: 'Acme Defense LLC' }),
        mapping({ externalId: null, externalName: 'Some Other Acme' }),
      ]),
      new Map([[CONTRACTOR_ID, 'DEF456789012']]),
    );
    expect(identity.contract.basis).toBe('exact_uei');
    expect(identity.contract.ueis).toEqual(['DEF456789012']);
    expect(identity.contract.fallbackNames).toEqual([]);
    expect(identity.contract.notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: 'name_suppressed_by_uei' })]),
    );
  });

  test('the basis is never both — a rail is exact_uei XOR reviewed_name_fallback', () => {
    const withUei = buildAwardHistoryIdentity(facts({ uei: 'ABC123456789' }, [mapping()]));
    const withoutUei = buildAwardHistoryIdentity(
      facts({ uei: null }, [mapping({ externalId: null })]),
    );
    for (const rail of [withUei.contract, withoutUei.contract]) {
      expect(AWARD_MATCH_BASES).toContain(rail.basis);
      const hasUeis = rail.ueis.length > 0;
      const hasNames = rail.fallbackNames.length > 0;
      expect(hasUeis && hasNames).toBe(false);
    }
  });
});

// ── The federal_contractor join P02 adds ────────────────────────────────────

describe('the contract rail resolves federal_contractor.uei', () => {
  test('a contracting externalId is a UUID and is NOT treated as a UEI', () => {
    // Before P02 this UUID went through normalizeUei, always failed, and the rail
    // silently fell through to names.
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [mapping({ externalId: CONTRACTOR_ID })]),
      new Map(),
    );
    expect(identity.contract.ueis).not.toContain(CONTRACTOR_ID);
  });

  test('a resolved UEI is used, and normalized', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [mapping({ externalId: CONTRACTOR_ID })]),
      new Map([[CONTRACTOR_ID, ' def456789012 ']]),
    );
    expect(identity.contract.basis).toBe('exact_uei');
    expect(identity.contract.ueis).toEqual(['DEF456789012']);
  });

  test('a contractor row with a NULL uei falls back to its reviewed name', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [mapping({ externalId: CONTRACTOR_ID, externalName: 'Acme Defense LLC' })]),
      new Map([[CONTRACTOR_ID, null]]),
    );
    expect(identity.contract.basis).toBe('reviewed_name_fallback');
    expect(identity.contract.fallbackNames).toEqual(['acme defense llc']);
  });

  test('a malformed uei in federal_contractor is rejected, not queried', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [mapping({ externalId: CONTRACTOR_ID, externalName: null })]),
      new Map([[CONTRACTOR_ID, 'GARBAGE']]),
    );
    expect(identity.contract.basis).toBe('none');
  });

  test('contractorIdsToResolve batches ids across clients and dedupes', () => {
    const ids = contractorIdsToResolve([
      facts({ id: 'c1' }, [mapping({ externalId: CONTRACTOR_ID })]),
      facts({ id: 'c2' }, [
        mapping({ externalId: CONTRACTOR_ID }),
        mapping({ externalId: SUBSIDIARY_ID }),
      ]),
    ]);
    expect(ids.slice().sort()).toEqual([CONTRACTOR_ID, SUBSIDIARY_ID].sort());
  });

  test('a non-UUID externalId is filtered out before the uuid[] cast', () => {
    // Not defensive padding. The lookup casts to uuid[], and Postgres rejects the
    // WHOLE statement with 22P02 on the first malformed member — so one legacy or
    // hand-pinned mapping would abort the nightly run for every tenant, not just
    // degrade that one client.
    const ids = contractorIdsToResolve([
      facts({}, [
        mapping({ externalId: 'ACME DEFENSE LLC' }),
        mapping({ externalId: 'DEF456789012' }),
        mapping({ externalId: CONTRACTOR_ID }),
      ]),
    ]);
    expect(ids).toEqual([CONTRACTOR_ID]);
  });

  test('a mapping whose id was filtered out falls back to its name, not to nothing', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [mapping({ externalId: 'NOT-A-UUID', externalName: 'Acme Defense LLC' })]),
      new Map(),
    );
    expect(identity.contract.basis).toBe('reviewed_name_fallback');
    expect(identity.contract.fallbackNames).toEqual(['acme defense llc']);
  });

  test('assistance mapping ids are NOT sent to the contractor lookup', () => {
    // They are not federal_contractor ids. Passing a UEI into a `uuid[]` cast
    // would throw 22P02 and take down the whole run.
    const ids = contractorIdsToResolve([
      facts({}, [mapping({ source: 'assistance_recipient', externalId: 'BBB222222222' })]),
    ]);
    expect(ids).toEqual([]);
  });
});

// ── The assistance rail ─────────────────────────────────────────────────────

describe('the assistance rail reads externalId as COALESCE(uei, name)', () => {
  test('a UEI-shaped externalId is a verified identifier', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [
        mapping({ source: 'assistance_recipient', externalId: 'BBB222222222', externalName: 'B Co' }),
      ]),
    );
    expect(identity.assistance.basis).toBe('exact_uei');
    expect(identity.assistance.ueis).toEqual(['BBB222222222']);
  });

  test('a name-shaped externalId is not an identifier, and the name is used instead', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [
        mapping({
          source: 'assistance_recipient',
          externalId: 'ACME HEALTH FOUNDATION',
          externalName: 'Acme Health Foundation',
        }),
      ]),
    );
    expect(identity.assistance.basis).toBe('reviewed_name_fallback');
    expect(identity.assistance.fallbackNames).toEqual(['acme health foundation']);
  });
});

// ── Names are never fuzzy ───────────────────────────────────────────────────

describe('a name fallback requires a recorded, non-fuzzy basis', () => {
  test.each([
    ['fuzzy_name', 'name_rejected_fuzzy_basis'],
    ['legacy_unrecorded', 'name_rejected_unrecorded_basis'],
  ])('basis %s may not supply a fallback name', (basis, outcome) => {
    // A reviewer confirming a fuzzy candidate confirmed a RELATIONSHIP. Using its
    // name as an award identifier is a different claim, and the exact-name query
    // would happily match an unrelated company with the same name.
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [
        mapping({ externalId: CONTRACTOR_ID, externalName: 'Acme Defense LLC', matchBasis: basis }),
      ]),
      new Map([[CONTRACTOR_ID, null]]),
    );
    expect(identity.contract.basis).toBe('none');
    expect(identity.contract.notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome })]),
    );
  });

  test('a NULL basis may not supply a fallback name', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [
        mapping({ externalId: CONTRACTOR_ID, externalName: 'Acme Defense LLC', matchBasis: null }),
      ]),
      new Map([[CONTRACTOR_ID, null]]),
    );
    expect(identity.contract.basis).toBe('none');
  });

  test('tier 4 may not supply a fallback name whatever its basis string says', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [
        mapping({
          externalId: CONTRACTOR_ID,
          externalName: 'Acme Defense LLC',
          matchBasis: 'exact_legal_name',
          matchTier: FUZZY_MATCH_TIER,
        }),
      ]),
      new Map([[CONTRACTOR_ID, null]]),
    );
    expect(identity.contract.basis).toBe('none');
  });

  test.each(['exact_uei', 'exact_cage', 'exact_legal_name', 'exact_legal_name_corroborated', 'manual_pin'])(
    'basis %s MAY supply a fallback name',
    (basis) => {
      const identity = buildAwardHistoryIdentity(
        facts({ uei: null }, [
          mapping({ externalId: CONTRACTOR_ID, externalName: 'Acme Defense LLC', matchBasis: basis, matchTier: 1 }),
        ]),
        new Map([[CONTRACTOR_ID, null]]),
      );
      expect(identity.contract.basis).toBe('reviewed_name_fallback');
    },
  );

  test('the non-identifying set is exactly the two bases that are not evidence', () => {
    expect([...NON_IDENTIFYING_MATCH_BASES].sort()).toEqual(['fuzzy_name', 'legacy_unrecorded']);
  });

  test('names are compared by exact equality, never normalized beyond case', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [
        mapping({ externalId: CONTRACTOR_ID, externalName: 'ACME  Defense, L.L.C. ' }),
      ]),
      new Map([[CONTRACTOR_ID, null]]),
    );
    // Trailing whitespace trimmed and case folded, because the SQL side does
    // lower(). Nothing else: punctuation and internal spacing are preserved,
    // because 'Acme Defense LLC' and 'Acme Defense, L.L.C.' may be two companies.
    expect(identity.contract.fallbackNames).toEqual(['acme  defense, l.l.c.']);
  });
});

// ── Parents, subsidiaries, duplicates, conflicts ────────────────────────────

describe('parents, subsidiaries, duplicates and conflicting mappings', () => {
  test('two subsidiaries with distinct resolved UEIs both contribute', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [
        mapping({ externalId: CONTRACTOR_ID, externalName: 'Parent Co' }),
        mapping({ externalId: SUBSIDIARY_ID, externalName: 'Sub Co' }),
      ]),
      new Map([
        [CONTRACTOR_ID, 'DEF456789012'],
        [SUBSIDIARY_ID, 'GHI789012345'],
      ]),
    );
    expect(identity.contract.ueis).toEqual(['DEF456789012', 'GHI789012345']);
  });

  test('a duplicate UEI across the client and a mapping appears once', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: 'ABC123456789' }, [mapping({ externalId: CONTRACTOR_ID })]),
      new Map([[CONTRACTOR_ID, 'abc123456789']]),
    );
    expect(identity.contract.ueis).toEqual(['ABC123456789']);
  });

  test('two mappings resolving to the same UEI appear once', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [
        mapping({ externalId: CONTRACTOR_ID }),
        mapping({ externalId: SUBSIDIARY_ID }),
      ]),
      new Map([
        [CONTRACTOR_ID, 'DEF456789012'],
        [SUBSIDIARY_ID, 'DEF456789012'],
      ]),
    );
    expect(identity.contract.ueis).toEqual(['DEF456789012']);
  });

  test('conflicting mappings — one identifiable, one fuzzy — keep only the identifier', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [
        mapping({ externalId: CONTRACTOR_ID, externalName: 'Real Co' }),
        mapping({ externalId: SUBSIDIARY_ID, externalName: 'Coincidence Co', matchBasis: 'fuzzy_name', matchTier: 4 }),
      ]),
      new Map([
        [CONTRACTOR_ID, 'DEF456789012'],
        [SUBSIDIARY_ID, null],
      ]),
    );
    expect(identity.contract.basis).toBe('exact_uei');
    expect(identity.contract.ueis).toEqual(['DEF456789012']);
    expect(identity.contract.fallbackNames).toEqual([]);
  });

  test('contract and assistance bases are decided independently', () => {
    // A client can be UEI-identified for contracts and name-identified for
    // assistance. Collapsing the two into one basis would misdescribe one of them.
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [
        mapping({ externalId: CONTRACTOR_ID, externalName: 'Acme Defense LLC' }),
        mapping({
          source: 'assistance_recipient',
          externalId: 'ACME HEALTH FOUNDATION',
          externalName: 'Acme Health Foundation',
        }),
      ]),
      new Map([[CONTRACTOR_ID, 'DEF456789012']]),
    );
    expect(identity.contract.basis).toBe('exact_uei');
    expect(identity.assistance.basis).toBe('reviewed_name_fallback');
  });

  test('a mapping with neither a resolvable UEI nor a name is recorded as unusable', () => {
    const identity = buildAwardHistoryIdentity(
      facts({ uei: null }, [mapping({ externalId: CONTRACTOR_ID, externalName: null })]),
      new Map([[CONTRACTOR_ID, null]]),
    );
    expect(identity.contract.basis).toBe('none');
    expect(identity.contract.notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: 'no_usable_identifier' })]),
    );
  });
});

// ── The queries ─────────────────────────────────────────────────────────────

describe('readAwardHistoryByBasis issues one query per rail, never an OR', () => {
  function fakeQuery(result: unknown[] = []) {
    const calls: string[] = [];
    const prisma = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        calls.push(Array.from(strings).join('?'));
        return result as never;
      }),
    };
    return { prisma, calls };
  }

  const rail = (over: Record<string, unknown> = {}) => ({
    basis: 'none' as const,
    ueis: [],
    fallbackNames: [],
    notes: [],
    ...over,
  });

  test('basis none issues no query at all', async () => {
    const { prisma, calls } = fakeQuery();
    const facts = await readAwardHistoryByBasis(prisma, {
      contract: rail(),
      assistance: rail(),
    } as never);
    expect(calls).toHaveLength(0);
    expect(facts.contractAgencies).toEqual([]);
    expect(facts.basis).toEqual({ contract: 'none', assistance: 'none' });
  });

  test('exact_uei queries recipient_uei and NOT the name column', async () => {
    const { prisma, calls } = fakeQuery();
    await readAwardHistoryByBasis(prisma, {
      contract: rail({ basis: 'exact_uei', ueis: ['ABC123456789'] }),
      assistance: rail(),
    } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('recipient_uei');
    expect(calls[0]).not.toContain('contractor_name');
    // The OR is gone. That is the fix.
    expect(calls[0]).not.toContain(' OR ');
  });

  test('reviewed_name_fallback queries the name column and NOT recipient_uei', async () => {
    const { prisma, calls } = fakeQuery();
    await readAwardHistoryByBasis(prisma, {
      contract: rail({ basis: 'reviewed_name_fallback', fallbackNames: ['acme defense llc'] }),
      assistance: rail(),
    } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('lower(contractor_name)');
    expect(calls[0]).not.toContain('recipient_uei');
    expect(calls[0]).not.toContain(' OR ');
  });

  test('the returned facts carry the basis, so history provenance survives', async () => {
    const { prisma } = fakeQuery([
      { awarding_agency: 'Department of Defense', awarding_sub_tier: 'DEPT OF THE NAVY' },
    ]);
    const facts = await readAwardHistoryByBasis(prisma, {
      contract: rail({ basis: 'reviewed_name_fallback', fallbackNames: ['acme'] }),
      assistance: rail(),
    } as never);
    expect(facts.basis).toEqual({ contract: 'reviewed_name_fallback', assistance: 'none' });
    // Name-derived history is still returned — it is context. What changed is
    // that a reader can now tell it apart from identifier-derived history.
    expect(facts.contractAgencies).toEqual(['Department of Defense', 'DEPT OF THE NAVY']);
  });

  test('each rail is queried independently', async () => {
    const { prisma, calls } = fakeQuery();
    await readAwardHistoryByBasis(prisma, {
      contract: rail({ basis: 'exact_uei', ueis: ['ABC123456789'] }),
      assistance: rail({ basis: 'reviewed_name_fallback', fallbackNames: ['acme health'] }),
    } as never);
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.includes('federal_award'))).toBe(true);
    expect(calls.some((c) => c.includes('federal_assistance_award'))).toBe(true);
  });

  test('THROWS rather than degrading to empty history', async () => {
    const prisma = {
      $queryRaw: jest.fn(async () => {
        throw new Error('connection reset');
      }),
    };
    await expect(
      readAwardHistoryByBasis(prisma as never, {
        contract: rail({ basis: 'exact_uei', ueis: ['ABC123456789'] }),
        assistance: rail(),
      } as never),
    ).rejects.toThrow('connection reset');
  });
});

describe('resolveContractorUeis', () => {
  test('an empty id list issues no query', async () => {
    const prisma = { $queryRaw: jest.fn(async () => [] as never) };
    await expect(resolveContractorUeis(prisma, [])).resolves.toEqual(new Map());
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  test('resolves ids to UEIs, keeping a null as a recorded null', async () => {
    // A recorded null is meaningful: it says "this contractor row exists and has
    // no UEI", which is what sends the rail to its name fallback. A missing key
    // would be indistinguishable from a row we never looked up.
    const prisma = {
      $queryRaw: jest.fn(async () => [
        { id: CONTRACTOR_ID, uei: 'DEF456789012' },
        { id: SUBSIDIARY_ID, uei: null },
      ] as never),
    };
    const index = await resolveContractorUeis(prisma, [CONTRACTOR_ID, SUBSIDIARY_ID]);
    expect(index.get(CONTRACTOR_ID)).toBe('DEF456789012');
    expect(index.get(SUBSIDIARY_ID)).toBeNull();
  });
});
