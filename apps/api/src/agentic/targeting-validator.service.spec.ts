import {
  TargetingValidatorService,
  type TargetingMemberClaim,
} from './targeting-validator.service.js';

/**
 * Deterministic validator gate — Phase 1 M5.0/M5-B success criterion: "a
 * targeting brief on a real bill (both rails) names ONLY members whose
 * roles/districts the deterministic validator confirms; a seeded
 * hallucinated member is dropped and logged." Same prototype-call +
 * fake-prisma pattern as this session's other Meri/chokepoint specs.
 */
function svc(opts: {
  federalMembers?: string[];
  stateMembers?: string[];
  federalMemberships?: Array<{ bioguideId: string; title: string | null }>;
  stateMemberships?: Array<{ legislatorId: string; role: string | null }>;
  footprint?: Array<{
    facility: { id: string; name: string; city: string | null; state: string | null };
    representation: unknown;
  }>;
}): TargetingValidatorService {
  const prisma = {
    congressMember: {
      findUnique: async ({ where }: { where: { bioguideId: string } }) =>
        (opts.federalMembers ?? []).includes(where.bioguideId)
          ? { bioguideId: where.bioguideId }
          : null,
    },
    stateLegislator: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        (opts.stateMembers ?? []).includes(where.id) ? { id: where.id } : null,
    },
    congressCommitteeMembership: {
      findFirst: async ({ where }: { where: { bioguideId: string; title: { in: string[] } } }) =>
        (opts.federalMemberships ?? []).find(
          (m) => m.bioguideId === where.bioguideId && where.title.in.includes(m.title ?? ''),
        ) ?? null,
    },
    stateCommitteeMembership: {
      findFirst: async ({
        where,
      }: {
        where: { legislatorId: string; role: { equals: string; mode: string } };
      }) =>
        (opts.stateMemberships ?? []).find(
          (m) =>
            m.legislatorId === where.legislatorId &&
            (m.role ?? '').toLowerCase() === where.role.equals.toLowerCase(),
        ) ?? null,
    },
  };
  const representation = {
    representationForClient: async () => opts.footprint ?? [],
  };
  return new TargetingValidatorService(prisma as never, representation as never);
}

const FED_MEMBER: TargetingMemberClaim = {
  jurisdiction: 'federal',
  memberId: 'D000001',
  memberName: 'Rep. Real Member',
};
const HALLUCINATED_MEMBER: TargetingMemberClaim = {
  jurisdiction: 'federal',
  memberId: 'Z999999',
  memberName: 'Rep. Nobody',
};

describe('TargetingValidatorService.validateMemberClaims', () => {
  it('PINNED (M5-B): a member that resolves via congress_member is kept; a seeded hallucinated member is dropped', async () => {
    const service = svc({ federalMembers: ['D000001'] });
    const out = await service.validateMemberClaims('t1', 'client-1', [
      FED_MEMBER,
      HALLUCINATED_MEMBER,
    ]);
    expect(out.valid).toEqual([FED_MEMBER]);
    expect(out.dropped).toEqual([{ claim: HALLUCINATED_MEMBER, reason: 'member_not_found' }]);
  });

  it('a state member that resolves via state_legislator is kept', async () => {
    const claim: TargetingMemberClaim = {
      jurisdiction: 'state',
      memberId: 'ocd-person/abc',
      memberName: 'Rep. State Person',
    };
    const service = svc({ stateMembers: ['ocd-person/abc'] });
    const out = await service.validateMemberClaims('t1', 'client-1', [claim]);
    expect(out.valid).toEqual([claim]);
  });

  it('a role claim confirmed by congress_committee_membership.title (with alias normalization) is kept', async () => {
    const claim: TargetingMemberClaim = { ...FED_MEMBER, claimedRole: 'Chairman' };
    const service = svc({
      federalMembers: ['D000001'],
      federalMemberships: [{ bioguideId: 'D000001', title: 'Chair' }],
    });
    const out = await service.validateMemberClaims('t1', 'client-1', [claim]);
    expect(out.valid).toEqual([claim]);
  });

  it('PINNED: a role claim with NO matching congress_committee_membership row is dropped, never guessed', async () => {
    const claim: TargetingMemberClaim = { ...FED_MEMBER, claimedRole: 'Chair' };
    const service = svc({ federalMembers: ['D000001'], federalMemberships: [] });
    const out = await service.validateMemberClaims('t1', 'client-1', [claim]);
    expect(out.valid).toHaveLength(0);
    expect(out.dropped).toEqual([{ claim, reason: 'role_not_confirmed' }]);
  });

  it('a state role claim matches state_committee_membership.role case-insensitively', async () => {
    const claim: TargetingMemberClaim = {
      jurisdiction: 'state',
      memberId: 'ocd-person/abc',
      memberName: 'Rep. State Person',
      claimedRole: 'chair',
    };
    const service = svc({
      stateMembers: ['ocd-person/abc'],
      stateMemberships: [{ legislatorId: 'ocd-person/abc', role: 'Chair' }],
    });
    const out = await service.validateMemberClaims('t1', 'client-1', [claim]);
    expect(out.valid).toEqual([claim]);
  });

  it('PINNED: a district claim confirmed against the REAL District Impact Engine join (not a guessed district number) is kept', async () => {
    const claim: TargetingMemberClaim = { ...FED_MEMBER, claimedDistrictFacilityId: 'fac-1' };
    const service = svc({
      federalMembers: ['D000001'],
      footprint: [
        {
          facility: { id: 'fac-1', name: 'Plant', city: 'Orlando', state: 'FL' },
          representation: {
            unresolved: false,
            federal: { house: { bioguideId: 'D000001' }, senate: [] },
            state: { lower: null, upper: null },
          },
        },
      ],
    });
    const out = await service.validateMemberClaims('t1', 'client-1', [claim]);
    expect(out.valid).toEqual([claim]);
  });

  it('PINNED: a district claim naming a member who does NOT actually represent that facility is dropped', async () => {
    const claim: TargetingMemberClaim = { ...FED_MEMBER, claimedDistrictFacilityId: 'fac-1' };
    const service = svc({
      federalMembers: ['D000001'],
      footprint: [
        {
          facility: { id: 'fac-1', name: 'Plant', city: 'Orlando', state: 'FL' },
          representation: {
            unresolved: false,
            federal: { house: { bioguideId: 'SOMEONE-ELSE' }, senate: [] },
            state: { lower: null, upper: null },
          },
        },
      ],
    });
    const out = await service.validateMemberClaims('t1', 'client-1', [claim]);
    expect(out.dropped).toEqual([{ claim, reason: 'district_not_confirmed' }]);
  });

  it('a district claim against an UNRESOLVED (ungeocoded) facility is dropped, never guessed', async () => {
    const claim: TargetingMemberClaim = { ...FED_MEMBER, claimedDistrictFacilityId: 'fac-1' };
    const service = svc({
      federalMembers: ['D000001'],
      footprint: [
        {
          facility: { id: 'fac-1', name: 'Plant', city: null, state: null },
          representation: { unresolved: true, reason: 'no_geocode' },
        },
      ],
    });
    const out = await service.validateMemberClaims('t1', 'client-1', [claim]);
    expect(out.dropped).toEqual([{ claim, reason: 'district_not_confirmed' }]);
  });

  it('a district claim citing a facility id that does not exist on this client is dropped', async () => {
    const claim: TargetingMemberClaim = {
      ...FED_MEMBER,
      claimedDistrictFacilityId: 'fac-nonexistent',
    };
    const service = svc({ federalMembers: ['D000001'], footprint: [] });
    const out = await service.validateMemberClaims('t1', 'client-1', [claim]);
    expect(out.dropped).toEqual([{ claim, reason: 'facility_not_found' }]);
  });

  it('a state district claim checks against state.lower/upper, not federal', async () => {
    const claim: TargetingMemberClaim = {
      jurisdiction: 'state',
      memberId: 'ocd-person/abc',
      memberName: 'Rep. State Person',
      claimedDistrictFacilityId: 'fac-1',
    };
    const service = svc({
      stateMembers: ['ocd-person/abc'],
      footprint: [
        {
          facility: { id: 'fac-1', name: 'Plant', city: 'Orlando', state: 'FL' },
          representation: {
            unresolved: false,
            federal: { house: null, senate: [] },
            state: { lower: { id: 'ocd-person/abc' }, upper: null },
          },
        },
      ],
    });
    const out = await service.validateMemberClaims('t1', 'client-1', [claim]);
    expect(out.valid).toEqual([claim]);
  });
});
