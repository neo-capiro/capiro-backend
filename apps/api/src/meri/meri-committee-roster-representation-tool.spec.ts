import { MeriToolsService } from './meri-tools.service.js';

/**
 * 50-state analyst (Phase 1 M4.1/M4.2) — get_committee_roster,
 * get_representation, get_state_rule_status. Same prototype-call +
 * fake-prisma pattern as meri-state-bill-status-tool.spec.ts. The success
 * criterion under test is "returns the DB chair/rule fact, not a guess" —
 * every roster/representation/rule fact must trace to a fake row, and an
 * unresolved/ambiguous case must produce an honest note rather than
 * fabricating an answer.
 */

type Fake = Record<string, unknown>;
type Ctx = { tenantId: string; userId: string };
const ctx: Ctx = { tenantId: 'tenant-1', userId: 'user-1' };

function svc(deps: { prisma?: Fake; representation?: Fake }): MeriToolsService {
  const s = Object.create(MeriToolsService.prototype) as MeriToolsService;
  (s as unknown as { prisma: Fake }).prisma = deps.prisma ?? {};
  (s as unknown as { representation: Fake }).representation = deps.representation ?? {};
  return s;
}
const call = (
  s: MeriToolsService,
  method: 'getCommitteeRoster' | 'getRepresentation' | 'getStateRuleStatus',
  input: Fake,
  useCtx = false,
) => {
  const fn = (
    s as unknown as Record<
      string,
      ((a: Ctx | Fake, b?: Fake) => Promise<Record<string, unknown>>) | undefined
    >
  )[method];
  if (!fn) throw new Error(`no method ${method}`);
  return useCtx ? fn.call(s, ctx, input) : fn.call(s, input);
};

describe('get_committee_roster (M4.1)', () => {
  const ARMED_SERVICES = {
    systemCode: 'hsas00',
    name: 'Committee on Armed Services',
    chamber: 'house',
    parentSystemCode: null,
  };
  const MEMBERSHIPS = [
    { bioguideId: 'chair-1', side: 'majority', rank: 1, title: 'Chair' },
    { bioguideId: 'vc-1', side: 'majority', rank: 2, title: 'Vice Chair' },
    { bioguideId: 'rm-1', side: 'minority', rank: 1, title: 'Ranking Member' },
    { bioguideId: 'mem-1', side: 'majority', rank: 3, title: null },
  ];
  const MEMBERS = [
    { bioguideId: 'chair-1', fullName: 'Rep. Chair Person', party: 'R', state: 'TX' },
    { bioguideId: 'vc-1', fullName: 'Rep. Vice Person', party: 'R', state: 'GA' },
    { bioguideId: 'rm-1', fullName: 'Rep. Ranking Person', party: 'D', state: 'CA' },
    { bioguideId: 'mem-1', fullName: 'Rep. Plain Member', party: 'R', state: 'FL' },
  ];

  function federalPrisma(): Fake {
    return {
      congressCommittee: { findMany: async () => [ARMED_SERVICES] },
      congressCommitteeMembership: {
        findMany: async ({ where }: { where: { systemCode: string } }) =>
          where.systemCode === ARMED_SERVICES.systemCode ? MEMBERSHIPS : [],
      },
      congressMember: {
        findMany: async ({ where }: { where: { bioguideId: { in: string[] } } }) =>
          MEMBERS.filter((m) => where.bioguideId.in.includes(m.bioguideId)),
      },
    };
  }

  it('PINNED: federal — exact systemCode match returns the DB chair/viceChair/rankingMember, not a guess', async () => {
    const out = (await call(svc({ prisma: federalPrisma() }), 'getCommitteeRoster', {
      committee: 'hsas00',
      jurisdiction: 'federal',
    })) as {
      committee: { id: string; matchedBy: string } | null;
      chair: { id: string; name: string } | null;
      viceChair: { id: string } | null;
      rankingMember: { id: string } | null;
      members: unknown[];
    };
    expect(out.committee?.id).toBe('hsas00');
    expect(out.committee?.matchedBy).toBe('code');
    expect(out.chair?.id).toBe('chair-1');
    expect(out.chair?.name).toBe('Rep. Chair Person');
    expect(out.viceChair?.id).toBe('vc-1');
    expect(out.rankingMember?.id).toBe('rm-1');
    expect(out.members).toHaveLength(4);
  });

  it('federal — resolves by free-text name when no code matches', async () => {
    const out = (await call(svc({ prisma: federalPrisma() }), 'getCommitteeRoster', {
      committee: 'House Armed Services Committee',
      jurisdiction: 'federal',
    })) as { committee: { id: string; matchedBy: string } | null };
    expect(out.committee?.id).toBe('hsas00');
    expect(out.committee?.matchedBy).toBe('name');
  });

  it('federal — a name matching zero committees returns a not-found note, never a guess', async () => {
    const out = (await call(svc({ prisma: federalPrisma() }), 'getCommitteeRoster', {
      committee: 'Committee on Interstellar Affairs',
      jurisdiction: 'federal',
    })) as { committee: unknown; chair: unknown; note: string };
    expect(out.committee).toBeNull();
    expect(out.chair).toBeNull();
    expect(out.note).toMatch(/no federal committee matched/i);
  });

  it('federal — a name matching MORE THAN ONE committee (ambiguous) is not silently picked', async () => {
    const prisma: Fake = {
      congressCommittee: {
        findMany: async () => [
          {
            systemCode: 'a1',
            name: 'Committee on Rules',
            chamber: 'house',
            parentSystemCode: null,
          },
          {
            systemCode: 'a2',
            name: 'Committee on Rules',
            chamber: 'senate',
            parentSystemCode: null,
          },
        ],
      },
      congressCommitteeMembership: { findMany: async () => [] },
      congressMember: { findMany: async () => [] },
    };
    const out = (await call(svc({ prisma }), 'getCommitteeRoster', {
      committee: 'Rules',
      jurisdiction: 'federal',
    })) as { committee: unknown; note: string };
    expect(out.committee).toBeNull();
    expect(out.note).toMatch(/no federal committee matched/i);
  });

  const HOUSE_APPROPS = {
    id: 'FL-lower-appropriations',
    state: 'FL',
    chamber: 'lower',
    name: 'Appropriations',
  };
  const FL_ROSTER = [
    {
      role: 'Chair',
      legislator: {
        id: 'leg-1',
        name: 'Rep. FL Chair',
        chamber: 'lower',
        party: 'R',
        district: '10',
      },
    },
    {
      role: 'Vice Chair',
      legislator: {
        id: 'leg-2',
        name: 'Rep. FL Vice',
        chamber: 'lower',
        party: 'R',
        district: '11',
      },
    },
    {
      role: 'Member',
      legislator: {
        id: 'leg-3',
        name: 'Rep. FL Member',
        chamber: 'lower',
        party: 'D',
        district: '12',
      },
    },
  ];

  it('PINNED: state — resolves by id and returns the DB chair; rankingMember is always null (no shared vocabulary)', async () => {
    const prisma: Fake = {
      stateCommittee: { findMany: async () => [HOUSE_APPROPS] },
      stateCommitteeMembership: {
        findMany: async ({ where }: { where: { committeeId: string } }) =>
          where.committeeId === HOUSE_APPROPS.id ? FL_ROSTER : [],
      },
    };
    const out = (await call(svc({ prisma }), 'getCommitteeRoster', {
      committee: 'FL-lower-appropriations',
      jurisdiction: 'state',
      state: 'fl',
    })) as {
      committee: { id: string; matchedBy: string } | null;
      chair: { id: string; name: string } | null;
      viceChair: { id: string } | null;
      rankingMember: unknown;
      members: unknown[];
    };
    expect(out.committee?.id).toBe(HOUSE_APPROPS.id);
    expect(out.committee?.matchedBy).toBe('id');
    expect(out.chair?.id).toBe('leg-1');
    expect(out.chair?.name).toBe('Rep. FL Chair');
    expect(out.viceChair?.id).toBe('leg-2');
    expect(out.rankingMember).toBeNull();
    expect(out.members).toHaveLength(3);
  });

  it('state — resolves by unambiguous free-text name', async () => {
    const prisma: Fake = {
      stateCommittee: { findMany: async () => [HOUSE_APPROPS] },
      stateCommitteeMembership: { findMany: async () => FL_ROSTER },
    };
    const out = (await call(svc({ prisma }), 'getCommitteeRoster', {
      committee: 'Appropriations',
      jurisdiction: 'state',
      state: 'FL',
    })) as { committee: { id: string; matchedBy: string } | null };
    expect(out.committee?.id).toBe(HOUSE_APPROPS.id);
    expect(out.committee?.matchedBy).toBe('name');
  });

  it('state — no committee matched returns a not-found note, never a guess', async () => {
    const prisma: Fake = {
      stateCommittee: { findMany: async () => [] },
      stateCommitteeMembership: { findMany: async () => [] },
    };
    const out = (await call(svc({ prisma }), 'getCommitteeRoster', {
      committee: 'Nonexistent Committee',
      jurisdiction: 'state',
      state: 'FL',
    })) as { committee: unknown; note: string };
    expect(out.committee).toBeNull();
    expect(out.note).toMatch(/no fl committee matched/i);
  });

  it('jurisdiction=state without a state returns a specify-the-state note, never guesses a state', async () => {
    const out = (await call(svc({ prisma: {} }), 'getCommitteeRoster', {
      committee: 'Appropriations',
      jurisdiction: 'state',
    })) as { committee: unknown; note: string };
    expect(out.committee).toBeNull();
    expect(out.note).toMatch(/state is required/i);
  });

  it('missing committee/jurisdiction returns a provide-both note', async () => {
    const out = (await call(svc({ prisma: {} }), 'getCommitteeRoster', {
      jurisdiction: 'federal',
    })) as { committee: unknown; note: string };
    expect(out.committee).toBeNull();
    expect(out.note).toMatch(/separate namespaces/i);
  });
});

describe('get_representation (M4.2)', () => {
  it('PINNED: returns the District Impact Engine join verbatim — federal + state reps per facility', async () => {
    const representation: Fake = {
      representationForClient: async () => [
        {
          facility: { id: 'fac-1', name: 'Plant A', city: 'Orlando', state: 'FL' },
          representation: {
            unresolved: false,
            federal: {
              house: {
                bioguideId: 'h-1',
                fullName: 'Rep. House Member',
                party: 'R',
                state: 'FL',
                district: 10,
                chamber: 'house',
              },
              senate: [
                {
                  bioguideId: 's-1',
                  fullName: 'Sen. One',
                  party: 'R',
                  state: 'FL',
                  district: null,
                  chamber: 'senate',
                },
                {
                  bioguideId: 's-2',
                  fullName: 'Sen. Two',
                  party: 'D',
                  state: 'FL',
                  district: null,
                  chamber: 'senate',
                },
              ],
            },
            state: {
              lower: {
                id: 'leg-1',
                name: 'Rep. State Lower',
                state: 'FL',
                chamber: 'lower',
                district: '10',
                party: 'R',
                url: null,
              },
              upper: {
                id: 'leg-2',
                name: 'Sen. State Upper',
                state: 'FL',
                chamber: 'upper',
                district: '5',
                party: 'D',
                url: null,
              },
            },
          },
        },
      ],
    };
    const out = (await call(
      svc({ representation }),
      'getRepresentation',
      { clientId: 'client-1' },
      true,
    )) as {
      facilities: Array<{
        facilityId: string;
        representation: {
          unresolved?: boolean;
          federal?: { house: { fullName: string } | null };
          state?: { lower: { name: string } | null };
        };
      }>;
    };
    expect(out.facilities).toHaveLength(1);
    expect(out.facilities[0]?.facilityId).toBe('fac-1');
    expect(out.facilities[0]?.representation.federal?.house?.fullName).toBe('Rep. House Member');
    expect(out.facilities[0]?.representation.state?.lower?.name).toBe('Rep. State Lower');
  });

  it('an ungeocoded facility explicitly reports unresolved — never a guessed representative', async () => {
    const representation: Fake = {
      representationForClient: async () => [
        {
          facility: { id: 'fac-2', name: 'Plant B', city: null, state: null },
          representation: { unresolved: true, reason: 'no_state' },
        },
      ],
    };
    const out = (await call(
      svc({ representation }),
      'getRepresentation',
      { clientId: 'client-1' },
      true,
    )) as {
      facilities: Array<{ representation: { unresolved: boolean; reason: string } }>;
    };
    expect(out.facilities[0]?.representation.unresolved).toBe(true);
    expect(out.facilities[0]?.representation.reason).toBe('no_state');
  });

  it('a state filter narrows the facility list to that state only', async () => {
    const representation: Fake = {
      representationForClient: async () => [
        {
          facility: { id: 'fac-fl', name: 'FL Plant', city: null, state: 'FL' },
          representation: { unresolved: true, reason: 'no_geocode' },
        },
        {
          facility: { id: 'fac-tx', name: 'TX Plant', city: null, state: 'TX' },
          representation: { unresolved: true, reason: 'no_geocode' },
        },
      ],
    };
    const out = (await call(
      svc({ representation }),
      'getRepresentation',
      { clientId: 'client-1', state: 'tx' },
      true,
    )) as { facilities: Array<{ facilityId: string }> };
    expect(out.facilities).toHaveLength(1);
    expect(out.facilities[0]?.facilityId).toBe('fac-tx');
  });

  it('missing clientId returns a provide-a-client note, never fabricates facilities', async () => {
    const out = (await call(svc({}), 'getRepresentation', {}, true)) as {
      facilities: unknown[];
      note: string;
    };
    expect(out.facilities).toHaveLength(0);
    expect(out.note).toMatch(/provide a client uuid/i);
  });

  it('a client with no facilities in the given state returns an explicit empty note', async () => {
    const representation: Fake = { representationForClient: async () => [] };
    const out = (await call(
      svc({ representation }),
      'getRepresentation',
      { clientId: 'client-1' },
      true,
    )) as {
      facilities: unknown[];
      note: string;
    };
    expect(out.facilities).toHaveLength(0);
    expect(out.note).toMatch(/no facilities found/i);
  });
});

describe('get_state_rule_status (M4.2)', () => {
  const FL_RULE = {
    id: 'FL-31100933',
    state: 'FL',
    agency: 'Department of Environmental Protection',
    title: 'PFAS discharge limits',
    abstract: 'Proposed limits on PFAS in industrial discharge.',
    ruleType: 'proposed',
    docketId: 'DEP-2026-01',
    registerCitation: null,
    publicationDate: new Date(),
    commentStartDate: new Date(),
    // Comfortably in the future relative to any real test-run time, so the
    // derived stage is deterministically 'nprm' — the stage derivation
    // ITSELF is pinned exhaustively in rule-lifecycle-stage.spec.ts; this
    // test only proves the id lookup + field passthrough, not the math.
    commentEndDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    effectiveDate: null,
    sourceUrl: 'https://flrules.org/x',
    linkedBillKeys: ['fl-2026-hb100'],
  };
  const FR_RULE = {
    id: 'uuid-1',
    documentNumber: '2026-01234',
    type: 'RULE',
    title: 'PFAS effluent limitation guidelines',
    abstract: 'Final rule on PFAS effluent limits.',
    agencyNames: ['Environmental Protection Agency'],
    publicationDate: new Date('2026-04-01'),
    commentEndDate: new Date('2026-03-01'),
    effectiveDate: new Date('2026-06-01'),
    docketIds: ['EPA-HQ-OW-2026-0001'],
    htmlUrl: 'https://federalregister.gov/x',
    pdfUrl: null,
  };

  function prismaWith(opts: {
    stateFindUnique?: unknown;
    frFindUnique?: unknown;
    stateFindMany?: unknown[];
    frFindMany?: unknown[];
  }): Fake {
    return {
      stateRule: {
        findUnique: async () => opts.stateFindUnique ?? null,
        findMany: async () => opts.stateFindMany ?? [],
      },
      federalRegisterDocument: {
        findUnique: async () => opts.frFindUnique ?? null,
        findMany: async () => opts.frFindMany ?? [],
      },
    };
  }

  it('PINNED: exact state_rule id — derives comment_open (nprm) stage from ruleType + open comment window, not a guess', async () => {
    const out = (await call(
      svc({ prisma: prismaWith({ stateFindUnique: FL_RULE }) }),
      'getStateRuleStatus',
      { query: 'FL-31100933' },
    )) as {
      found: boolean;
      jurisdiction: string;
      id: string;
      stage: string;
      commentPeriod: { isOpen: boolean; end: Date | null };
      linkedBillKeys: string[];
    };
    expect(out.found).toBe(true);
    expect(out.jurisdiction).toBe('state');
    expect(out.id).toBe('FL-31100933');
    expect(out.stage).toBe('nprm');
    expect(out.commentPeriod.isOpen).toBe(true);
    expect(out.linkedBillKeys).toEqual(['fl-2026-hb100']);
  });

  it('PINNED: exact Federal Register document number — returns the FR row, not a guess', async () => {
    const out = (await call(
      svc({ prisma: prismaWith({ frFindUnique: FR_RULE }) }),
      'getStateRuleStatus',
      { query: '2026-01234' },
    )) as {
      found: boolean;
      jurisdiction: string;
      id: string;
      agencyNames: string[];
      docketIds: string[];
    };
    expect(out.found).toBe(true);
    expect(out.jurisdiction).toBe('federal');
    expect(out.id).toBe('2026-01234');
    expect(out.agencyNames).toEqual(['Environmental Protection Agency']);
    expect(out.docketIds).toEqual(['EPA-HQ-OW-2026-0001']);
  });

  it('a `state` filter skips the federal id fast-path and searches state only', async () => {
    const out = (await call(
      svc({ prisma: prismaWith({ frFindUnique: FR_RULE, stateFindMany: [] }) }),
      'getStateRuleStatus',
      { query: '2026-01234', state: 'FL' },
    )) as { found: boolean; note: string };
    expect(out.found).toBe(false);
    expect(out.note).toMatch(/no rule or notice matched/i);
  });

  it('a title keyword matching exactly ONE rule (across both tables) resolves it', async () => {
    const out = (await call(
      svc({ prisma: prismaWith({ stateFindMany: [FL_RULE], frFindMany: [] }) }),
      'getStateRuleStatus',
      { query: 'PFAS discharge' },
    )) as { found: boolean; jurisdiction: string; id: string };
    expect(out.found).toBe(true);
    expect(out.jurisdiction).toBe('state');
    expect(out.id).toBe('FL-31100933');
  });

  it('a title keyword matching MULTIPLE rules across both rails returns disambiguation candidates, not an arbitrary pick', async () => {
    const out = (await call(
      svc({ prisma: prismaWith({ stateFindMany: [FL_RULE], frFindMany: [FR_RULE] }) }),
      'getStateRuleStatus',
      { query: 'PFAS' },
    )) as {
      found: boolean;
      ambiguousMatches: Array<{ id: string; jurisdiction: string }>;
      note: string;
    };
    expect(out.found).toBe(false);
    expect(out.ambiguousMatches).toHaveLength(2);
    expect(out.ambiguousMatches.map((m) => m.jurisdiction).sort()).toEqual(['federal', 'state']);
    expect(out.note).toMatch(/matches 2 rules\/notices/i);
  });

  it('says NO MATCH explicitly (never fabricates a status) when absent', async () => {
    const out = (await call(svc({ prisma: prismaWith({}) }), 'getStateRuleStatus', {
      query: 'Nonexistent Rule',
    })) as { found: boolean; note: string };
    expect(out.found).toBe(false);
    expect(out.note).toMatch(/do not describe a rule's status from memory/i);
  });

  it('missing query returns a provide-an-id-or-keyword note', async () => {
    const out = (await call(svc({ prisma: prismaWith({}) }), 'getStateRuleStatus', {})) as {
      found: boolean;
      note: string;
    };
    expect(out.found).toBe(false);
    expect(out.note).toMatch(/provide a rule\/notice id/i);
  });
});
