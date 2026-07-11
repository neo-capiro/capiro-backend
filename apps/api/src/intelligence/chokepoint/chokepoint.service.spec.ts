import { NotFoundException } from '@nestjs/common';
import { ChokepointService } from './chokepoint.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { RepresentationResolverService } from '../../clients/representation-resolver.service.js';

interface FakeData {
  congressBill?: Array<{ id: string; status: string | null; sponsorBioguideId: string | null }>;
  congressBillCommittee?: Array<{
    committeeName: string;
    committeeCode: string | null;
    chamber: string | null;
    billId: string;
  }>;
  congressCommittee?: Array<{
    systemCode: string;
    name: string;
    chamber: string;
    parentSystemCode: string | null;
    isCurrent: boolean;
  }>;
  billRuleLink?: Array<{ ruleBillId: string; targetBillId: string }>;
  congressBillCosponsor?: Array<{ billId: string; bioguideId: string; withdrawnDate: Date | null }>;
  congressCommitteeMembership?: Array<{
    systemCode: string;
    bioguideId: string;
    title: string | null;
  }>;
  congressMember?: Array<{
    bioguideId: string;
    fullName: string;
    chamber: string;
    party: string | null;
    state: string | null;
    district: number | null;
    isCurrent: boolean;
  }>;
  stateBill?: Array<{
    id: string;
    state: string;
    sessionKey: string;
    chamber: string | null;
    status: string | null;
    currentCommitteeId: string | null;
    identifier?: string;
  }>;
  stateCommittee?: Array<{ id: string; state: string; chamber: string | null; name: string }>;
  stateCommitteeMembership?: Array<{
    committeeId: string;
    legislatorId: string;
    role: string | null;
  }>;
  stateLegislator?: Array<{
    id: string;
    name: string;
    chamber: string | null;
    party: string | null;
    district: string | null;
  }>;
  stateBillSponsor?: Array<{
    billKey: string;
    legislatorId: string | null;
    name: string;
    party: string | null;
    sponsorType: string;
  }>;
  stateBillLink?: Array<{ billKey: string; relatedBillKey: string | null; linkType: string }>;
  stateSession?: Array<{
    state: string;
    sessionKey: string;
    committeeCutoffDate: Date | null;
    crossoverDate: Date | null;
    secondCommitteeCutoffDate: Date | null;
    sineDie: Date | null;
  }>;
}

function fakePrisma(data: FakeData) {
  const legislatorById = new Map((data.stateLegislator ?? []).map((l) => [l.id, l]));
  return {
    congressBill: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          (data.congressBill ?? []).find((b) => b.id === where.id) ?? null,
      ),
    },
    congressBillCommittee: {
      findMany: jest.fn(async ({ where }: { where: { billId: string } }) =>
        (data.congressBillCommittee ?? []).filter((c) => c.billId === where.billId),
      ),
    },
    congressCommittee: {
      findMany: jest.fn(async () => (data.congressCommittee ?? []).filter((c) => c.isCurrent)),
    },
    billRuleLink: {
      findFirst: jest.fn(
        async ({ where }: { where: { targetBillId: string } }) =>
          (data.billRuleLink ?? []).find((l) => l.targetBillId === where.targetBillId) ?? null,
      ),
    },
    congressBillCosponsor: {
      findMany: jest.fn(async ({ where }: { where: { billId: string } }) =>
        (data.congressBillCosponsor ?? []).filter(
          (c) => c.billId === where.billId && c.withdrawnDate === null,
        ),
      ),
    },
    congressCommitteeMembership: {
      // W4.1: two call shapes now — the referred/leadership committee lookup
      // (where.systemCode.in) AND the sponsor's own memberships lookup
      // (where.bioguideId), which replaced the old title-`in` findFirst so the
      // shared matchesRole can recognize Chairwoman/Co-Chair.
      findMany: jest.fn(
        async ({ where }: { where: { systemCode?: { in: string[] }; bioguideId?: string } }) =>
          (data.congressCommitteeMembership ?? []).filter((m) => {
            if (where.systemCode) return where.systemCode.in.includes(m.systemCode);
            if (where.bioguideId) return m.bioguideId === where.bioguideId;
            return false;
          }),
      ),
      findFirst: jest.fn(
        async ({ where }: { where: { bioguideId: string; title?: { in: string[] } } }) =>
          (data.congressCommitteeMembership ?? []).find(
            (m) =>
              m.bioguideId === where.bioguideId &&
              (!where.title || where.title.in.includes(m.title ?? '')),
          ) ?? null,
      ),
    },
    congressMember: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: { bioguideId?: { in: string[] }; chamber?: string; isCurrent?: boolean };
        }) => {
          let rows = data.congressMember ?? [];
          if (where.bioguideId)
            rows = rows.filter((m) => where.bioguideId!.in.includes(m.bioguideId));
          if (where.chamber) rows = rows.filter((m) => m.chamber === where.chamber);
          if (where.isCurrent) rows = rows.filter((m) => m.isCurrent);
          return rows;
        },
      ),
    },
    stateBill: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          (data.stateBill ?? []).find((b) => b.id === where.id) ?? null,
      ),
      findFirst: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          (data.stateBill ?? []).find((b) => b.id === where.id) ?? null,
      ),
    },
    stateCommittee: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          (data.stateCommittee ?? []).find((c) => c.id === where.id) ?? null,
      ),
      findMany: jest.fn(
        async ({ where }: { where: { state: string; chamber?: string; OR?: unknown } }) =>
          (data.stateCommittee ?? []).filter((c) => {
            if (c.state !== where.state) return false;
            // W4.1: honor the own-chamber filter the leadership query now applies.
            if (where.chamber && c.chamber !== where.chamber) return false;
            if (!where.OR) return true;
            return /rules|calendar/i.test(c.name);
          }),
      ),
    },
    stateCommitteeMembership: {
      findMany: jest.fn(async ({ where }: { where: { committeeId: string; role?: unknown } }) =>
        (data.stateCommitteeMembership ?? [])
          .filter((m) => m.committeeId === where.committeeId)
          .filter((m) => (where.role ? /chair/i.test(m.role ?? '') : true))
          .map((m) => ({ role: m.role, legislator: legislatorById.get(m.legislatorId) ?? null })),
      ),
    },
    stateLegislator: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => legislatorById.get(where.id) ?? null,
      ),
    },
    stateBillSponsor: {
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { billKey: string; sponsorType?: string; legislatorId?: string };
        }) =>
          (data.stateBillSponsor ?? []).find(
            (s) =>
              s.billKey === where.billKey &&
              (where.sponsorType ? s.sponsorType === where.sponsorType : true) &&
              (where.legislatorId ? s.legislatorId === where.legislatorId : true),
          ) ?? null,
      ),
    },
    stateBillLink: {
      findMany: jest.fn(async ({ where }: { where: { billKey: string } }) =>
        (data.stateBillLink ?? []).filter((l) => l.billKey === where.billKey),
      ),
    },
    stateSession: {
      findFirst: jest.fn(
        async ({ where }: { where: { state: string; sessionKey: string } }) =>
          (data.stateSession ?? []).find(
            (s) => s.state === where.state && s.sessionKey === where.sessionKey,
          ) ?? null,
      ),
    },
  } as unknown as PrismaService;
}

function fakeRepresentation(
  impl?: (member: Record<string, unknown>) => Array<{ id: string; name: string }>,
) {
  return {
    facilitiesForMember: jest.fn(async (_t: string, _c: string, member: Record<string, unknown>) =>
      impl ? impl(member) : [],
    ),
  } as unknown as RepresentationResolverService;
}

describe('ChokepointService.forBill — federal', () => {
  it('resolves the referred committee, chair/viceChair/rankingMember, sponsor, and rulesGate=pending', async () => {
    const prisma = fakePrisma({
      congressBill: [{ id: '119-hr-8800', status: 'rule_pending', sponsorBioguideId: 'D000001' }],
      congressBillCommittee: [
        {
          billId: '119-hr-8800',
          committeeName: 'Committee on Armed Services',
          committeeCode: 'hsas00',
          chamber: 'house',
        },
      ],
      congressCommittee: [
        {
          systemCode: 'hsas00',
          name: 'Committee on Armed Services',
          chamber: 'house',
          parentSystemCode: null,
          isCurrent: true,
        },
      ],
      billRuleLink: [{ ruleBillId: '119-hres-1398', targetBillId: '119-hr-8800' }],
      congressCommitteeMembership: [
        { systemCode: 'hsas00', bioguideId: 'D000001', title: 'Chair' },
        { systemCode: 'hsas00', bioguideId: 'R000002', title: 'Ranking Member' },
        { systemCode: 'hsas00', bioguideId: 'D000003', title: 'Vice Chair' },
      ],
      congressMember: [
        {
          bioguideId: 'D000001',
          fullName: 'Chair Person',
          chamber: 'house',
          party: 'D',
          state: 'FL',
          district: 2,
          isCurrent: true,
        },
        {
          bioguideId: 'R000002',
          fullName: 'Ranking Person',
          chamber: 'house',
          party: 'R',
          state: 'TX',
          district: 1,
          isCurrent: true,
        },
        {
          bioguideId: 'D000003',
          fullName: 'Vice Person',
          chamber: 'house',
          party: 'D',
          state: 'CA',
          district: 5,
          isCurrent: true,
        },
      ],
    });
    const svc = new ChokepointService(prisma, fakeRepresentation());
    const out = await svc.forBill('119-hr-8800');

    expect(out.jurisdiction).toBe('federal');
    expect(out.referredCommittee).toEqual({
      id: 'hsas00',
      name: 'Committee on Armed Services',
      isSubcommittee: false,
    });
    expect(out.chair?.id).toBe('D000001');
    expect(out.viceChair?.id).toBe('D000003');
    expect(out.rankingMember?.id).toBe('R000002');
    expect(out.sponsor?.id).toBe('D000001');
    expect(out.rulesGate).toBe('pending');
    // sponsor IS the chair -> chairIsSponsorOrCosponsor true
    expect(out.survivalScore).toBeGreaterThan(0);
  });

  it('rulesGate is "failed" for rule_failed and "adopted" once the bill is on/past the floor', async () => {
    const base = {
      congressBillCommittee: [],
      congressCommittee: [],
      congressCommitteeMembership: [],
      congressMember: [],
      billRuleLink: [{ ruleBillId: '119-hres-1', targetBillId: '119-hr-1' }],
    };
    const failedPrisma = fakePrisma({
      ...base,
      congressBill: [{ id: '119-hr-1', status: 'rule_failed', sponsorBioguideId: null }],
    });
    const failed = await new ChokepointService(failedPrisma, fakeRepresentation()).forBill(
      '119-hr-1',
    );
    expect(failed.rulesGate).toBe('failed');

    const adoptedPrisma = fakePrisma({
      ...base,
      congressBill: [{ id: '119-hr-1', status: 'floor', sponsorBioguideId: null }],
    });
    const adopted = await new ChokepointService(adoptedPrisma, fakeRepresentation()).forBill(
      '119-hr-1',
    );
    expect(adopted.rulesGate).toBe('adopted');
  });

  it('rulesGate is null when no BillRuleLink exists at all', async () => {
    const prisma = fakePrisma({
      congressBill: [{ id: '119-s-1', status: 'committee', sponsorBioguideId: null }],
    });
    const out = await new ChokepointService(prisma, fakeRepresentation()).forBill('119-s-1');
    expect(out.rulesGate).toBeNull();
  });

  it('never guesses a committee referral: an unresolvable committee name yields referredCommittee=null, chair=null', async () => {
    const prisma = fakePrisma({
      congressBill: [{ id: '119-hr-2', status: 'committee', sponsorBioguideId: null }],
      congressBillCommittee: [
        {
          billId: '119-hr-2',
          committeeName: 'Some Renamed Committee',
          committeeCode: null,
          chamber: 'house',
        },
      ],
      congressCommittee: [
        {
          systemCode: 'hsas00',
          name: 'Committee on Armed Services',
          chamber: 'house',
          parentSystemCode: null,
          isCurrent: true,
        },
      ],
    });
    const out = await new ChokepointService(prisma, fakeRepresentation()).forBill('119-hr-2');
    expect(out.referredCommittee).toBeNull();
    expect(out.chair).toBeNull();
  });

  it('throws NotFoundException for an unknown federal bill', async () => {
    const prisma = fakePrisma({});
    await expect(
      new ChokepointService(prisma, fakeRepresentation()).forBill('119-hr-99999'),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('ChokepointService.forBill — state', () => {
  const SESSION = {
    state: 'TX',
    sessionKey: '2025',
    committeeCutoffDate: null,
    crossoverDate: null,
    secondCommitteeCutoffDate: null,
    sineDie: new Date(Date.now() + 10 * 86_400_000),
  };

  it('resolves committee chair/viceChair from state_committee_membership and computes deadlineRisk from state_session', async () => {
    const prisma = fakePrisma({
      stateBill: [
        {
          id: 'tx-2025-hb1234',
          state: 'TX',
          sessionKey: '2025',
          chamber: 'lower',
          status: 'committee',
          currentCommitteeId: 'tx-lower-state-affairs',
        },
      ],
      stateCommittee: [
        { id: 'tx-lower-state-affairs', state: 'TX', chamber: 'lower', name: 'State Affairs' },
      ],
      stateLegislator: [
        { id: 'leg-chair', name: 'Chair Leg', chamber: 'lower', party: 'D', district: '9' },
        { id: 'leg-vice', name: 'Vice Leg', chamber: 'lower', party: 'R', district: '10' },
      ],
      stateCommitteeMembership: [
        { committeeId: 'tx-lower-state-affairs', legislatorId: 'leg-chair', role: 'Chair' },
        { committeeId: 'tx-lower-state-affairs', legislatorId: 'leg-vice', role: 'Vice Chair' },
      ],
      stateSession: [SESSION],
    });
    const out = await new ChokepointService(prisma, fakeRepresentation()).forBill('tx-2025-hb1234');

    expect(out.jurisdiction).toBe('state');
    expect(out.referredCommittee).toEqual({ id: 'tx-lower-state-affairs', name: 'State Affairs' });
    expect(out.chair?.id).toBe('leg-chair');
    expect(out.viceChair?.id).toBe('leg-vice');
    expect(out.rankingMember).toBeNull(); // state chambers don't share this title
    expect(out.rulesGate).toBeNull(); // federal-only
    expect(out.deadlineRisk?.cutoffType).toBe('sineDie');
  });

  it('resolves the sponsor via the legislatorId crosswalk when present', async () => {
    const prisma = fakePrisma({
      stateBill: [
        {
          id: 'tx-2025-hb1',
          state: 'TX',
          sessionKey: '2025',
          chamber: 'lower',
          status: 'introduced',
          currentCommitteeId: null,
        },
      ],
      stateLegislator: [
        { id: 'leg-sponsor', name: 'Sponsor Leg', chamber: 'lower', party: 'D', district: '3' },
      ],
      stateBillSponsor: [
        {
          billKey: 'tx-2025-hb1',
          legislatorId: 'leg-sponsor',
          name: 'Sponsor Leg',
          party: 'D',
          sponsorType: 'primary',
        },
      ],
    });
    const out = await new ChokepointService(prisma, fakeRepresentation()).forBill('tx-2025-hb1');
    expect(out.sponsor).toEqual(
      expect.objectContaining({ id: 'leg-sponsor', name: 'Sponsor Leg' }),
    );
  });

  it('falls back to the sponsor row name/party (no footprint id) when the legislator crosswalk is unresolved', async () => {
    const prisma = fakePrisma({
      stateBill: [
        {
          id: 'tx-2025-hb2',
          state: 'TX',
          sessionKey: '2025',
          chamber: 'lower',
          status: 'introduced',
          currentCommitteeId: null,
        },
      ],
      stateBillSponsor: [
        {
          billKey: 'tx-2025-hb2',
          legislatorId: null,
          name: 'Unresolved Sponsor',
          party: 'D',
          sponsorType: 'primary',
        },
      ],
    });
    const out = await new ChokepointService(prisma, fakeRepresentation()).forBill('tx-2025-hb2');
    expect(out.sponsor).toEqual({ id: '', name: 'Unresolved Sponsor', chamber: null, party: 'D' });
  });

  it('reports companionStatus + feeds companionAdvancing into the survival heuristic when the companion has advanced', async () => {
    const prisma = fakePrisma({
      stateBill: [
        {
          id: 'tx-2025-hb3',
          state: 'TX',
          sessionKey: '2025',
          chamber: 'lower',
          status: 'introduced',
          currentCommitteeId: null,
        },
        {
          id: 'tx-2025-sb3',
          state: 'TX',
          sessionKey: '2025',
          chamber: 'upper',
          status: 'reported',
          currentCommitteeId: null,
          identifier: 'SB 3',
        },
      ],
      stateBillLink: [
        { billKey: 'tx-2025-hb3', relatedBillKey: 'tx-2025-sb3', linkType: 'same_as' },
      ],
    });
    const out = await new ChokepointService(prisma, fakeRepresentation()).forBill('tx-2025-hb3');
    expect(out.companionStatus).toEqual({
      relatedBillKey: 'tx-2025-sb3',
      relatedDisplay: 'SB 3',
      status: 'reported',
      linkType: 'same_as',
    });
  });

  it('resolves chamberLeadership only when exactly one Rules/Calendar-named committee exists for the state', async () => {
    // W4.1: the bill's chamber is LegiScan's raw current_body ('H' → lower);
    // the leadership filter is now scoped to the bill's OWN chamber. To stay a
    // genuine ambiguity, BOTH Rules/Calendar committees must be in that same
    // (lower) chamber — a cross-chamber pair would be disambiguated by the
    // filter instead. Two same-chamber matches → never guess → null.
    const ambiguousPrisma = fakePrisma({
      stateBill: [
        {
          id: 'tx-2025-hb4',
          state: 'TX',
          sessionKey: '2025',
          chamber: 'H',
          status: 'introduced',
          currentCommitteeId: null,
        },
      ],
      stateCommittee: [
        {
          id: 'tx-lower-rules',
          state: 'TX',
          chamber: 'lower',
          name: 'Rules and Legislative Procedure',
        },
        { id: 'tx-lower-calendars', state: 'TX', chamber: 'lower', name: 'Calendars' },
      ],
    });
    const ambiguous = await new ChokepointService(ambiguousPrisma, fakeRepresentation()).forBill(
      'tx-2025-hb4',
    );
    expect(ambiguous.chamberLeadership).toBeNull(); // 2 matches in-chamber -> never guess

    const uniquePrisma = fakePrisma({
      stateBill: [
        {
          id: 'fl-2025-hb4',
          state: 'FL',
          sessionKey: '2025',
          chamber: 'H', // raw LegiScan house body → normalizes to 'lower'
          status: 'introduced',
          currentCommitteeId: null,
        },
      ],
      stateCommittee: [
        { id: 'fl-lower-rules', state: 'FL', chamber: 'lower', name: 'Rules Committee' },
        // An upper-chamber Rules committee that must NOT be attributed to a
        // lower-chamber bill (W4.1 own-chamber filter — the regression guard).
        { id: 'fl-upper-rules', state: 'FL', chamber: 'upper', name: 'Senate Rules' },
      ],
      stateLegislator: [
        {
          id: 'leg-fl-rules-chair',
          name: 'FL Rules Chair',
          chamber: 'lower',
          party: 'R',
          district: '1',
        },
      ],
      stateCommitteeMembership: [
        { committeeId: 'fl-lower-rules', legislatorId: 'leg-fl-rules-chair', role: 'Chair' },
      ],
    });
    const unique = await new ChokepointService(uniquePrisma, fakeRepresentation()).forBill(
      'fl-2025-hb4',
    );
    expect(unique.chamberLeadership?.id).toBe('leg-fl-rules-chair');
  });

  it('throws NotFoundException for an unknown state bill', async () => {
    const prisma = fakePrisma({});
    await expect(
      new ChokepointService(prisma, fakeRepresentation()).forBill('tx-2025-hb99999'),
    ).rejects.toThrow(NotFoundException);
  });

  it('never fabricates a deadlineRisk when the session has nothing curated', async () => {
    const prisma = fakePrisma({
      stateBill: [
        {
          id: 'tx-2025-hb5',
          state: 'TX',
          sessionKey: '2025',
          chamber: 'lower',
          status: 'introduced',
          currentCommitteeId: null,
        },
      ],
      stateSession: [
        {
          state: 'TX',
          sessionKey: '2025',
          committeeCutoffDate: null,
          crossoverDate: null,
          secondCommitteeCutoffDate: null,
          sineDie: null,
        },
      ],
    });
    const out = await new ChokepointService(prisma, fakeRepresentation()).forBill('tx-2025-hb5');
    expect(out.deadlineRisk).toBeNull();
  });

  it('populates footprintOverlap for resolvable members ONLY when a client footprint is supplied', async () => {
    const prisma = fakePrisma({
      stateBill: [
        {
          id: 'tx-2025-hb6',
          state: 'TX',
          sessionKey: '2025',
          chamber: 'lower',
          status: 'committee',
          currentCommitteeId: 'tx-lower-state-affairs',
        },
      ],
      stateCommittee: [
        { id: 'tx-lower-state-affairs', state: 'TX', chamber: 'lower', name: 'State Affairs' },
      ],
      stateLegislator: [
        { id: 'leg-chair', name: 'Chair Leg', chamber: 'lower', party: 'D', district: '9' },
      ],
      stateCommitteeMembership: [
        { committeeId: 'tx-lower-state-affairs', legislatorId: 'leg-chair', role: 'Chair' },
      ],
    });
    const representation = fakeRepresentation((member) =>
      member.type === 'state' && member.state === 'TX' && member.chamber === 'lower'
        ? [{ id: 'fac-1', name: 'Acme Plant' }]
        : [],
    );
    const svc = new ChokepointService(prisma, representation);

    const withoutFootprint = await svc.forBill('tx-2025-hb6');
    expect(withoutFootprint.footprintOverlap).toEqual([]);
    expect(representation.facilitiesForMember).not.toHaveBeenCalled();

    const withFootprint = await svc.forBill('tx-2025-hb6', { tenantId: 't1', clientId: 'c1' });
    expect(withFootprint.footprintOverlap).toEqual([
      {
        memberId: 'leg-chair',
        memberName: 'Chair Leg',
        memberRole: 'Chair',
        facilityId: 'fac-1',
        facilityName: 'Acme Plant',
      },
    ]);
  });

  it('a companion that has NOT advanced yields companionAdvancing=false, contributing no bonus to the survival score', async () => {
    const prisma = fakePrisma({
      stateBill: [
        {
          id: 'tx-2025-hb7',
          state: 'TX',
          sessionKey: '2025',
          chamber: 'lower',
          status: 'introduced',
          currentCommitteeId: null,
        },
        {
          id: 'tx-2025-sb7',
          state: 'TX',
          sessionKey: '2025',
          chamber: 'upper',
          status: 'introduced',
          currentCommitteeId: null,
          identifier: 'SB 7',
        },
      ],
      stateBillLink: [
        { billKey: 'tx-2025-hb7', relatedBillKey: 'tx-2025-sb7', linkType: 'same_as' },
      ],
    });
    const out = await new ChokepointService(prisma, fakeRepresentation()).forBill('tx-2025-hb7');
    expect(out.companionStatus?.status).toBe('introduced');
    expect(out.survivalScore).toBe(0);
  });
});
