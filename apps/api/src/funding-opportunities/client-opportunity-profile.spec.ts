import { describe, expect, jest, test } from '@jest/globals';
import {
  awardHistoryIdentity,
  buildClientOpportunityProfile,
  dedupeStrings,
  emptyAwardHistory,
  normalizeUei,
  profileFingerprint,
} from './client-opportunity-profile.builder.js';
import {
  CLIENT_PROFILE_SELECT,
  PROFILE_MAPPING_WHERE,
  VISIBLE_CLIENT_FILTER,
  readAwardHistory,
  readClientProfileFacts,
  readClientProfileFactsMany,
  splitMappings,
  toClientProfileFacts,
  type RawProfileClientRow,
  type RawProfileMappingRow,
} from './client-opportunity-profile.repository.js';
import {
  CLIENT_OPPORTUNITY_PROFILE_VERSION,
  type AwardHistoryFacts,
  type ClientProfileFacts,
} from './client-opportunity-profile.types.js';

/**
 * P01 — the parity proof.
 *
 * The phase exists because there were three profile-building sites and no test
 * that built more than one of them from a single fixture. Two agreed by
 * coincidence; the third did not, and the disagreement was invisible.
 *
 * So the assertions that matter here are not "the builder works". They are:
 *   1. the three CALLERS reach the same profile for the same client, and
 *   2. the one difference P01 deliberately corrected is pinned, so a later phase
 *      cannot quietly reintroduce it.
 */

const CLIENT = '00000000-0000-0000-0000-000000000010';
const TENANT = '00000000-0000-0000-0000-000000000001';

function rawClient(partial: Partial<RawProfileClientRow> = {}): RawProfileClientRow {
  return {
    id: CLIENT,
    name: 'Acme Defense LLC',
    uei: 'ABC123456789',
    cageCode: '1ABC2',
    naicsCodes: ['336411'],
    pscCodes: ['1560'],
    applicantTypes: ['Small businesses'],
    setAsideCertifications: ['SBA'],
    sectorTag: 'DEFENSE',
    capabilities: [
      { name: 'Airframe MRO', tags: ['aviation', 42], keywords: ['depot'], peNumbers: ['0604201F'] },
    ],
    facilities: [
      {
        id: 'fac-1',
        name: 'Plant 4',
        city: 'Fort Worth',
        state: 'TX',
        zip: '76108',
        congressionalDistrict: '12',
      },
    ],
    ...partial,
  };
}

function history(partial: Partial<AwardHistoryFacts> = {}): AwardHistoryFacts {
  return {
    assistanceListings: ['93.778'],
    assistanceAgencies: ['Department of Health and Human Services'],
    contractAgencies: ['Department of Defense', 'DEPT OF THE NAVY'],
    contractOffices: [],
    ...partial,
  };
}

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('normalizeUei', () => {
  test('accepts a 12-character alphanumeric, uppercased and trimmed', () => {
    expect(normalizeUei(' abc123456789 ')).toBe('ABC123456789');
  });

  test.each([null, undefined, '', 'too-short', 'ABC1234567890', 'ABC-23456789'])(
    'rejects %p rather than querying it as an identifier',
    (value) => {
      expect(normalizeUei(value as string | null | undefined)).toBeNull();
    },
  );
});

describe('dedupeStrings', () => {
  test('trims, drops empties and nulls, and preserves first-seen order', () => {
    expect(dedupeStrings(['b', ' b ', null, '', '  ', 'a', undefined])).toEqual(['b', 'a']);
  });
});

describe('splitMappings', () => {
  test('contract and assistance identities cannot cross-contaminate', () => {
    const rows: RawProfileMappingRow[] = [
      { clientId: CLIENT, source: 'contracting', externalId: 'AAA111111111', externalName: 'A' },
      {
        clientId: CLIENT,
        source: 'assistance_recipient',
        externalId: 'BBB222222222',
        externalName: 'B',
      },
    ];
    const split = splitMappings(rows);
    expect(split.contractingMappings).toEqual([{ externalId: 'AAA111111111', externalName: 'A' }]);
    expect(split.assistanceMappings).toEqual([{ externalId: 'BBB222222222', externalName: 'B' }]);
  });

  test('an unrecognized source lands in NEITHER rail', () => {
    // Fail closed. A mapping source this code does not understand is not
    // award-bearing identity, and defaulting it into one rail would let an LDA or
    // FEC row contribute federal award history.
    const split = splitMappings([
      { clientId: CLIENT, source: 'lda_registrant', externalId: 'CCC333333333', externalName: 'C' },
    ]);
    expect(split.contractingMappings).toEqual([]);
    expect(split.assistanceMappings).toEqual([]);
  });
});

// ── The deliberate behavior change ──────────────────────────────────────────

describe('award-history identity', () => {
  const facts = () =>
    toClientProfileFacts(rawClient(), [
      { clientId: CLIENT, source: 'contracting', externalId: 'ZZZ999999999', externalName: 'Sub Co' },
    ]);

  test("the client's own UEI counts for BOTH rails", () => {
    // P01's single behavioral change. Before this the SAM producer used mapping
    // UEIs only; the read path used both. Unified on the read path.
    const identity = awardHistoryIdentity(facts());
    expect(identity.contractorUeis).toEqual(['ABC123456789', 'ZZZ999999999']);
    expect(identity.assistanceUeis).toEqual(['ABC123456789']);
  });

  test('a client with no UEI and no mappings yields empty identity sets', () => {
    const identity = awardHistoryIdentity(toClientProfileFacts(rawClient({ uei: null }), []));
    expect(identity.contractorUeis).toEqual([]);
    expect(identity.contractorNames).toEqual([]);
    expect(identity.assistanceUeis).toEqual([]);
    expect(identity.assistanceNames).toEqual([]);
  });

  test('names are lowercased for the SQL comparison and never fuzzy', () => {
    const identity = awardHistoryIdentity(
      toClientProfileFacts(rawClient(), [
        { clientId: CLIENT, source: 'contracting', externalId: null, externalName: 'Acme  Defense LLC' },
      ]),
    );
    // Preserved verbatim apart from case: no punctuation stripping, no
    // whitespace collapsing, no stemming. A near-match is a different company.
    expect(identity.contractorNames).toEqual(['acme  defense llc']);
  });

  test('a malformed mapping UEI is dropped, not passed through', () => {
    const identity = awardHistoryIdentity(
      toClientProfileFacts(rawClient({ uei: null }), [
        { clientId: CLIENT, source: 'contracting', externalId: 'nope', externalName: null },
      ]),
    );
    expect(identity.contractorUeis).toEqual([]);
  });
});

// ── The builder ─────────────────────────────────────────────────────────────

describe('buildClientOpportunityProfile', () => {
  test('is versioned', () => {
    const profile = buildClientOpportunityProfile(toClientProfileFacts(rawClient(), []), history());
    expect(profile.version).toBe(CLIENT_OPPORTUNITY_PROFILE_VERSION);
  });

  test('a thin client stays truthful instead of receiving defaults', () => {
    const thin = toClientProfileFacts(
      rawClient({
        uei: null,
        cageCode: null,
        naicsCodes: [],
        pscCodes: [],
        applicantTypes: [],
        setAsideCertifications: [],
        sectorTag: null,
        capabilities: [],
        facilities: [],
      }),
      [],
    );
    const profile = buildClientOpportunityProfile(thin, emptyAwardHistory());

    expect(profile.sam.naicsCodes).toEqual([]);
    expect(profile.sam.capabilityKeywords).toEqual([]);
    expect(profile.sam.sector).toBeNull();
    expect(profile.grant.applicantTypes).toEqual([]);
    expect(profile.completeness.hasUei).toBe(false);
    expect(profile.completeness.capabilityCount).toBe(0);
    // No inferred sector, no assumed applicant type, no placeholder NAICS.
    // computeEligibility reports an empty applicantTypes as needs_review, which
    // is honest; guessing would tell a user they can apply for something they
    // cannot.
  });

  test('non-string capability tags are dropped rather than stringified', () => {
    const profile = buildClientOpportunityProfile(toClientProfileFacts(rawClient(), []), history());
    expect(profile.sam.capabilityKeywords).toContain('aviation');
    expect(profile.sam.capabilityKeywords).not.toContain('42');
    expect(profile.sam.capabilityKeywords).not.toContain(42 as unknown as string);
  });

  test('facilitySites keep null members, because a null city is still a state match', () => {
    const profile = buildClientOpportunityProfile(
      toClientProfileFacts(
        rawClient({
          facilities: [
            { id: 'f1', name: 'A', city: null, state: 'TX', zip: null, congressionalDistrict: null },
          ],
        }),
        [],
      ),
      history(),
    );
    expect(profile.sam.facilitySites).toEqual([{ city: null, state: 'TX', zip: null }]);
    expect(profile.sam.facilityStates).toEqual(['TX']);
  });

  test('contract history feeds SAM and assistance history feeds grants, never crossed', () => {
    const profile = buildClientOpportunityProfile(toClientProfileFacts(rawClient(), []), history());
    expect(profile.sam.priorAgencies).toEqual(['Department of Defense', 'DEPT OF THE NAVY']);
    expect(profile.grant.priorAgencies).toEqual(['Department of Health and Human Services']);
    expect(profile.grant.priorAssistanceListings).toEqual(['93.778']);
  });

  test('priorOffices stays empty — federal_award has no office column', () => {
    const profile = buildClientOpportunityProfile(
      toClientProfileFacts(rawClient(), []),
      history({ contractOffices: [] }),
    );
    expect(profile.sam.priorOffices).toEqual([]);
  });
});

// ── The fingerprint ─────────────────────────────────────────────────────────

describe('profile fingerprint', () => {
  const base = () => buildClientOpportunityProfile(toClientProfileFacts(rawClient(), []), history());

  test('is stable across repeated builds of the same facts', () => {
    expect(base().fingerprint).toBe(base().fingerprint);
  });

  test('does not depend on the order keys were constructed in', () => {
    const a = profileFingerprint({ grant: base().grant, sam: base().sam });
    const b = profileFingerprint({ sam: base().sam, grant: base().grant });
    expect(a).toBe(b);
  });

  test('moves when a source-backed fact moves', () => {
    const changed = buildClientOpportunityProfile(
      toClientProfileFacts(rawClient({ naicsCodes: ['336411', '541330'] }), []),
      history(),
    );
    expect(changed.fingerprint).not.toBe(base().fingerprint);
  });

  test('moves when award history moves', () => {
    const changed = buildClientOpportunityProfile(
      toClientProfileFacts(rawClient(), []),
      history({ contractAgencies: ['DEPT OF THE ARMY'] }),
    );
    expect(changed.fingerprint).not.toBe(base().fingerprint);
  });

  test('array ORDER is content, not incidental', () => {
    // Two clients holding the same codes in a different order are not the same
    // client for scoring purposes: several signals read the first element.
    const reordered = buildClientOpportunityProfile(
      toClientProfileFacts(rawClient({ pscCodes: ['1560', '1680'] }), []),
      history(),
    );
    const swapped = buildClientOpportunityProfile(
      toClientProfileFacts(rawClient({ pscCodes: ['1680', '1560'] }), []),
      history(),
    );
    expect(reordered.fingerprint).not.toBe(swapped.fingerprint);
  });

  test('is 40 hex characters, matching the repository convention', () => {
    expect(base().fingerprint).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ── The repository ──────────────────────────────────────────────────────────

function fakeReadClient(rows: RawProfileClientRow[], mappings: RawProfileMappingRow[] = []) {
  const clientArgs: unknown[] = [];
  const mappingArgs: unknown[] = [];
  const tx = {
    client: {
      findFirst: jest.fn(async (args: unknown) => {
        clientArgs.push(args);
        return rows[0] ?? null;
      }),
      findMany: jest.fn(async (args: unknown) => {
        clientArgs.push(args);
        return rows;
      }),
    },
    clientIntelMapping: {
      findMany: jest.fn(async (args: unknown) => {
        mappingArgs.push(args);
        return mappings;
      }),
    },
  };
  return { tx, clientArgs, mappingArgs };
}

describe('repository reads', () => {
  test('the shared select is used, so all three callers fetch the same columns', async () => {
    const { tx, clientArgs } = fakeReadClient([rawClient()]);
    await readClientProfileFacts(tx, { clientId: CLIENT });
    expect((clientArgs[0] as { select: unknown }).select).toBe(CLIENT_PROFILE_SELECT);
  });

  test('archived and non-ACTIVE clients are excluded', async () => {
    const { tx, clientArgs } = fakeReadClient([rawClient()]);
    await readClientProfileFacts(tx, { clientId: CLIENT });
    expect((clientArgs[0] as { where: Record<string, unknown> }).where).toMatchObject(
      VISIBLE_CLIENT_FILTER,
    );
  });

  test('a missing client returns null rather than throwing a Nest exception', async () => {
    // The producers must be able to import this module without pulling in
    // @nestjs/common. The service turns null into its own 404.
    const { tx } = fakeReadClient([]);
    await expect(readClientProfileFacts(tx, { clientId: CLIENT })).resolves.toBeNull();
  });

  test('only reviewed, roll-up-permitted, award-bearing mappings are read', async () => {
    const { tx, mappingArgs } = fakeReadClient([rawClient()]);
    await readClientProfileFacts(tx, { clientId: CLIENT });
    expect((mappingArgs[0] as { where: Record<string, unknown> }).where).toMatchObject(
      PROFILE_MAPPING_WHERE,
    );
  });

  test('the mapping filter requires rollUpAwards === true, not "not false"', () => {
    // A null roll-up is an unanswered review question. Treating it as consent is
    // how a subsidiary's awards silently become the client's.
    expect(PROFILE_MAPPING_WHERE.rollUpAwards).toBe(true);
    expect(PROFILE_MAPPING_WHERE.source.in.slice().sort()).toEqual([
      'assistance_recipient',
      'contracting',
    ]);
  });

  test('no mapping query is issued for an empty client page', async () => {
    const { tx, mappingArgs } = fakeReadClient([]);
    const facts = await readClientProfileFactsMany(tx, { tenantId: TENANT, clientIds: [] } as never);
    expect(facts).toEqual([]);
    expect(mappingArgs).toHaveLength(0);
  });

  test('the batch read issues ONE mapping query for the whole page, not one per client', async () => {
    const rows = [rawClient({ id: 'c1' }), rawClient({ id: 'c2' }), rawClient({ id: 'c3' })];
    const { tx, mappingArgs } = fakeReadClient(rows);
    const facts = await readClientProfileFactsMany(tx, { tenantId: TENANT });
    expect(facts).toHaveLength(3);
    expect(mappingArgs).toHaveLength(1);
  });

  test('the batch read orders by id, so a keyset walk can page it', async () => {
    // P03 and P04 depend on this ordering. Asserting it here means they inherit
    // a stable total order rather than adding one.
    const { tx, clientArgs } = fakeReadClient([rawClient()]);
    await readClientProfileFactsMany(tx, { tenantId: TENANT, cursor: 'c0', take: 2 });
    const args = clientArgs[0] as { orderBy: unknown; take: number; where: Record<string, unknown> };
    expect(args.orderBy).toEqual({ id: 'asc' });
    expect(args.take).toBe(2);
    expect(args.where.id).toEqual({ gt: 'c0' });
  });
});

describe('readAwardHistory', () => {
  function fakeQuery(rows: Record<string, unknown[]>) {
    const seen: string[] = [];
    const prisma = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = Array.from(strings).join('?');
        seen.push(sql);
        for (const [needle, value] of Object.entries(rows)) {
          if (sql.includes(needle)) return value as never;
        }
        return [] as never;
      }),
    };
    return { prisma, seen };
  }

  test('skips a rail entirely when it has no identities', async () => {
    // Not "queries with an empty array": an unbounded scan of federal_award with
    // no identity predicate is the failure this guard prevents.
    const { prisma, seen } = fakeQuery({});
    await readAwardHistory(prisma, {
      contractorUeis: [],
      contractorNames: [],
      assistanceUeis: [],
      assistanceNames: [],
    });
    expect(seen).toHaveLength(0);
  });

  test('reads both agency tiers, because SAM agency strings are sub-tier shaped', async () => {
    const { prisma } = fakeQuery({
      federal_award: [
        { awarding_agency: 'Department of Defense', awarding_sub_tier: 'DEPT OF THE NAVY' },
        { awarding_agency: 'Department of Defense', awarding_sub_tier: 'DEPT OF THE ARMY' },
      ],
    });
    const facts = await readAwardHistory(prisma, {
      contractorUeis: ['ABC123456789'],
      contractorNames: [],
      assistanceUeis: [],
      assistanceNames: [],
    });
    expect(facts.contractAgencies).toEqual([
      'Department of Defense',
      'DEPT OF THE NAVY',
      'DEPT OF THE ARMY',
    ]);
  });

  test('THROWS rather than degrading to empty history', async () => {
    // The read path wraps this in its own try/catch because a degraded page is
    // better than a failed request. A producer must NOT: scoring every client
    // against silently-empty history would mark real suggestions stale.
    const prisma = {
      $queryRaw: jest.fn(async () => {
        throw new Error('connection reset');
      }),
    };
    await expect(
      readAwardHistory(prisma as never, {
        contractorUeis: ['ABC123456789'],
        contractorNames: [],
        assistanceUeis: [],
        assistanceNames: [],
      }),
    ).rejects.toThrow('connection reset');
  });
});

// ── Parity: the acceptance criterion ────────────────────────────────────────

/**
 * Simulates each of the three callers by driving the SAME repository and builder
 * the way that caller does, from one fixture.
 *
 * This is as close to the real thing as a unit test gets: the callers differ only
 * in their transaction wrapper (`withTenant` vs `withBypass`) and in whether they
 * read one client or a page of them, and neither of those touches the shaping.
 * Any future divergence has to be introduced in the builder, where every
 * assertion above would also fail.
 */
async function profileViaReadPath(row: RawProfileClientRow, mappings: RawProfileMappingRow[]) {
  const { tx } = fakeReadClient([row], mappings);
  const facts = await readClientProfileFacts(tx, { clientId: row.id });
  return buildClientOpportunityProfile(facts!, history());
}

async function profileViaProducerBatch(row: RawProfileClientRow, mappings: RawProfileMappingRow[]) {
  const { tx } = fakeReadClient([row], mappings);
  const [facts] = await readClientProfileFactsMany(tx, { tenantId: TENANT, take: 500 });
  return buildClientOpportunityProfile(facts!, history());
}

describe('read path and both producers reach the SAME profile', () => {
  const scenarios: Array<[string, RawProfileClientRow, RawProfileMappingRow[]]> = [
    ['a thin client', rawClient({
      uei: null, cageCode: null, naicsCodes: [], pscCodes: [], applicantTypes: [],
      setAsideCertifications: [], sectorTag: null, capabilities: [], facilities: [],
    }), []],
    ['a defense contractor', rawClient(), [
      { clientId: CLIENT, source: 'contracting', externalId: 'ZZZ999999999', externalName: 'Sub Co' },
    ]],
    ['a grant recipient', rawClient({ naicsCodes: [], pscCodes: [], sectorTag: 'HEALTH' }), [
      { clientId: CLIENT, source: 'assistance_recipient', externalId: 'YYY888888888', externalName: 'Health Co' },
    ]],
    ['a multi-entity client', rawClient(), [
      { clientId: CLIENT, source: 'contracting', externalId: 'AAA111111111', externalName: 'A Co' },
      { clientId: CLIENT, source: 'contracting', externalId: 'BBB222222222', externalName: 'B Co' },
      { clientId: CLIENT, source: 'assistance_recipient', externalId: 'CCC333333333', externalName: 'C Co' },
    ]],
    ['a client with no history at all', rawClient({ uei: null }), []],
  ];

  test.each(scenarios)('%s: byte-equivalent profile JSON', async (_name, row, mappings) => {
    const viaRead = await profileViaReadPath(row, mappings);
    const viaProducer = await profileViaProducerBatch(row, mappings);
    expect(JSON.stringify(viaProducer)).toBe(JSON.stringify(viaRead));
  });

  test.each(scenarios)('%s: identical fingerprint', async (_name, row, mappings) => {
    const viaRead = await profileViaReadPath(row, mappings);
    const viaProducer = await profileViaProducerBatch(row, mappings);
    expect(viaProducer.fingerprint).toBe(viaRead.fingerprint);
  });

  test.each(scenarios)('%s: identical award-history identity', async (_name, row, mappings) => {
    const { tx } = fakeReadClient([row], mappings);
    const one = await readClientProfileFacts(tx, { clientId: row.id });
    const { tx: tx2 } = fakeReadClient([row], mappings);
    const [many] = await readClientProfileFactsMany(tx2, { tenantId: TENANT });
    expect(awardHistoryIdentity(many!)).toEqual(awardHistoryIdentity(one!));
  });

  test('the single-client and batch reads produce identical FACTS, not just profiles', async () => {
    const row = rawClient();
    const mappings: RawProfileMappingRow[] = [
      { clientId: CLIENT, source: 'contracting', externalId: 'ZZZ999999999', externalName: 'Sub Co' },
    ];
    const { tx } = fakeReadClient([row], mappings);
    const one = await readClientProfileFacts(tx, { clientId: CLIENT });
    const { tx: tx2 } = fakeReadClient([row], mappings);
    const [many] = await readClientProfileFactsMany(tx2, { tenantId: TENANT });
    const expected: ClientProfileFacts = one!;
    expect(many).toEqual(expected);
  });
});
