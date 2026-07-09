import { MeriToolsService } from './meri-tools.service.js';

/**
 * LegiWatch A5 — get_bill_status + search_floor_votes. Prototype-call with a
 * fake prisma (resolveBillId etc. resolve via the prototype). The flagship case
 * is the H.R. 8800 regression at the TOOL layer: a bill whose latest action is
 * only "Rules Committee Resolution ... Reported" but whose status is rule_failed
 * must report stalled + no-floor-vote honesty, never "advancing".
 */

type Fake = Record<string, unknown>;
function svc(prisma: Fake): MeriToolsService {
  const s = Object.create(MeriToolsService.prototype) as MeriToolsService;
  (s as unknown as { prisma: Fake }).prisma = prisma;
  return s;
}
const call = (s: MeriToolsService, method: 'getBillStatus' | 'searchFloorVotes', input: Fake) => {
  const fn = (
    s as unknown as Record<string, ((i: Fake) => Promise<Record<string, unknown>>) | undefined>
  )[method];
  if (!fn) throw new Error(`no method ${method}`);
  return fn.call(s, input);
};

describe('get_bill_status (LegiWatch A5, H.R. 8800 regression)', () => {
  const HR8800 = {
    id: '119-hr-8800',
    title: 'National Defense Authorization Act for Fiscal Year 2027',
    congress: 119,
    status: 'rule_failed',
    statusAt: new Date('2026-06-30'),
    latestActionText: 'Rules Committee Resolution H. Res. 1398 Reported to House.',
    latestActionDate: new Date('2026-06-30'),
    sponsorName: 'Rogers, Mike D.',
    sponsorBioguideId: 'R000575',
    cosponsorsCount: 0,
    policyArea: 'Armed Forces and National Security',
  };

  const prisma = (): Fake => ({
    congressBill: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === '119-hr-8800'
          ? HR8800
          : where.id === '119-hres-1398'
            ? {
                status: 'failed',
                latestActionText: 'Rule failed passage of House.',
                title: 'Rule for H.R. 8800',
              }
            : null,
    },
    congressBillAction: {
      findMany: async () => [
        {
          date: new Date('2026-06-30'),
          text: 'Rules Committee Resolution H. Res. 1398 Reported to House.',
          type: 'Floor',
          chamber: null,
        },
      ],
    },
    rollCallVote: {
      findMany: async ({ where }: { where: { billId?: string } }) =>
        where.billId === '119-hres-1398'
          ? [
              {
                rollNumber: 232,
                result: 'Failed',
                yeas: 198,
                nays: 224,
                voteDate: new Date('2026-06-30'),
                question: 'On agreeing to the resolution',
                sourceUrl: 'https://clerk.house.gov/…',
              },
            ]
          : [], // NO roll-call vote on H.R. 8800 itself
    },
    billRuleLink: {
      findMany: async () => [{ ruleBillId: '119-hres-1398', source: 'title-parse' }],
    },
  });

  it('reports rule_failed / stalled + surfaces the failed rule vote + no-floor-vote honesty', async () => {
    const out = (await call(svc(prisma()), 'getBillStatus', { billId: '119-hr-8800' })) as {
      found: boolean;
      status: string;
      statusLabel: string;
      governingRules: Array<{
        ruleBillId: string;
        ruleStatus: string;
        ruleVotes: Array<{ yeas: number; nays: number }>;
      }>;
      floorVotes: unknown[];
      note: string;
    };
    expect(out.found).toBe(true);
    expect(out.status).toBe('rule_failed');
    expect(out.statusLabel).toMatch(/stalled/i);
    expect(out.governingRules[0]?.ruleBillId).toBe('119-hres-1398');
    expect(out.governingRules[0]?.ruleVotes[0]).toMatchObject({ yeas: 198, nays: 224 });
    expect(out.floorVotes).toHaveLength(0);
    expect(out.note).toMatch(/rule.*failed/i);
    expect(out.note).toMatch(/no recorded roll-call vote/i);
  });

  it('resolves a human designation ("H.R. 8800")', async () => {
    const out = (await call(svc(prisma()), 'getBillStatus', { billId: 'H.R. 8800' })) as {
      billId: string;
      found: boolean;
    };
    expect(out.billId).toBe('119-hr-8800');
    expect(out.found).toBe(true);
  });

  it('says NO BILL explicitly (never from memory) when absent', async () => {
    const out = (await call(svc(prisma()), 'getBillStatus', { billId: '119-hr-99999' })) as {
      found: boolean;
      note: string;
    };
    expect(out.found).toBe(false);
    expect(out.note).toMatch(/do not describe its status from memory/i);
  });
});

describe('search_floor_votes (LegiWatch A5)', () => {
  it('returns matching votes, else an explicit no-match note', async () => {
    const withVotes: Fake = {
      rollCallVote: {
        findMany: async () => [
          {
            id: 'house-119-2-232',
            chamber: 'house',
            rollNumber: 232,
            result: 'Failed',
            yeas: 198,
            nays: 224,
          },
        ],
      },
    };
    const hit = (await call(svc(withVotes), 'searchFloorVotes', { billId: '119-hres-1398' })) as {
      votesFound: number;
    };
    expect(hit.votesFound).toBe(1);

    const empty: Fake = { rollCallVote: { findMany: async () => [] } };
    const miss = (await call(svc(empty), 'searchFloorVotes', { query: 'nonexistent' })) as {
      votesFound: number;
      note: string;
    };
    expect(miss.votesFound).toBe(0);
    expect(miss.note).toMatch(/do not infer a vote outcome/i);
  });

  it('an UNRESOLVABLE member name never returns unscoped votes — explicit not-scoped note', async () => {
    const p: Fake = {
      congressMember: { findMany: async () => [] },
      // rollCallVote would return recent votes, but we must short-circuit first.
      rollCallVote: { findMany: async () => [{ id: 'x', chamber: 'house', rollNumber: 1 }] },
    };
    const out = (await call(svc(p), 'searchFloorVotes', { member: 'Nobody McNotreal' })) as {
      votesFound: number;
      note: string;
    };
    expect(out.votesFound).toBe(0);
    expect(out.note).toMatch(/not scoped to that member|could not resolve/i);
  });

  it('an AMBIGUOUS surname returns disambiguation candidates, not an arbitrary member’s votes', async () => {
    const p: Fake = {
      congressMember: {
        findMany: async () => [
          {
            bioguideId: 'S001',
            lisId: null,
            fullName: 'Scott, Austin',
            chamber: 'house',
            state: 'GA',
            party: 'R',
            isCurrent: true,
          },
          {
            bioguideId: 'S002',
            lisId: 'S999',
            fullName: 'Scott, Tim',
            chamber: 'senate',
            state: 'SC',
            party: 'R',
            isCurrent: true,
          },
        ],
      },
      rollCallVote: { findMany: async () => [{ id: 'x' }] },
    };
    const out = (await call(svc(p), 'searchFloorVotes', { member: 'Scott' })) as {
      votesFound: number;
      ambiguousMember: Array<{ bioguideId: string }>;
      note: string;
    };
    expect(out.votesFound).toBe(0);
    expect(out.ambiguousMember).toHaveLength(2);
    expect(out.note).toMatch(/matches 2 members/i);
  });

  it('a resolved member matches votes by bioguide OR lisId (Senate crosswalk-lag rows)', async () => {
    let capturedWhere: Record<string, unknown> = {};
    const p: Fake = {
      congressMember: {
        findMany: async () => [
          {
            bioguideId: 'V000128',
            lisId: 'S390',
            fullName: 'Van Hollen, Chris',
            chamber: 'senate',
            state: 'MD',
            party: 'D',
            isCurrent: true,
          },
        ],
      },
      rollCallVote: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          capturedWhere = where;
          return [{ id: 'senate-119-2-1', memberVotes: [{ voteCast: 'Yea' }] }];
        },
      },
    };
    const out = (await call(svc(p), 'searchFloorVotes', { member: 'Van Hollen' })) as {
      votesFound: number;
      member: { bioguideId: string; fullName: string };
    };
    expect(out.member).toMatchObject({ bioguideId: 'V000128', fullName: 'Van Hollen, Chris' });
    // The vote filter must OR bioguide + lisId so null-bioguide Senate rows still match.
    const some = (capturedWhere.memberVotes as { some: { OR: unknown[] } }).some;
    expect(some.OR).toEqual([{ bioguideId: 'V000128' }, { lisId: 'S390' }]);
  });
});
