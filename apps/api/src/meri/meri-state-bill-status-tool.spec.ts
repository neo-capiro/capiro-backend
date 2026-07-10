import { MeriToolsService } from './meri-tools.service.js';

/**
 * State Legislation Platform (Phase 0 S6) — get_state_bill_status,
 * search_state_floor_votes, get_state_legislator. Same prototype-call +
 * fake-prisma pattern as meri-bill-status-tool.spec.ts. The flagship case
 * (S6-B / S6-C, the state twin of the H.R. 8800 pin) is a TX bill that died
 * at crossover with a misleading committee-ish final action text: it must
 * report dead_by_deadline, never "in committee".
 */

type Fake = Record<string, unknown>;
function svc(prisma: Fake): MeriToolsService {
  const s = Object.create(MeriToolsService.prototype) as MeriToolsService;
  (s as unknown as { prisma: Fake }).prisma = prisma;
  return s;
}
const call = (
  s: MeriToolsService,
  method: 'getStateBillStatus' | 'searchStateFloorVotes' | 'getStateLegislator',
  input: Fake,
) => {
  const fn = (
    s as unknown as Record<string, ((i: Fake) => Promise<Record<string, unknown>>) | undefined>
  )[method];
  if (!fn) throw new Error(`no method ${method}`);
  return fn.call(s, input);
};

const TX_DEAD_BILL = {
  id: 'tx-2025-hb1234',
  state: 'TX',
  sessionKey: '2025',
  identifier: 'HB 1234',
  title: 'Relating to a study on state legislative data.',
  status: 'dead_by_deadline',
  statusAt: new Date('2025-06-01'),
  latestActionText: 'Referred to Committee on State Affairs', // misleading — reads like it's still alive
  latestActionDate: new Date('2025-03-15'),
  sponsorName: 'Rep. Jane Doe',
  sponsorParty: 'D',
  sponsorCount: 1,
  stateUrl: 'https://capitol.texas.gov/x',
  url: 'https://legiscan.com/x',
};

function withSystemFake(tx: Fake): Fake {
  return { withSystem: async (fn: (tx: Fake) => unknown) => fn(tx) };
}

describe('get_state_bill_status (S6.1, the state twin of the H.R. 8800 pin)', () => {
  const prisma = (): Fake => ({
    ...withSystemFake({
      stateBill: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === 'tx-2025-hb1234' ? TX_DEAD_BILL : null,
        findMany: async () => [{ id: 'tx-2025-hb1234' }],
      },
      stateBillAction: {
        findMany: async () => [
          {
            date: new Date('2025-03-15'),
            text: 'Referred to Committee on State Affairs',
            chamber: 'H',
            importance: 0,
          },
        ],
      },
      stateRollCallVote: { findMany: async () => [] }, // NO recorded vote — died in committee before any floor action
      stateBillLink: { findMany: async () => [] },
    }),
  });

  it('PINNED: reports dead_by_deadline (never "committee") + no-vote honesty + sine-die note', async () => {
    const out = (await call(svc(prisma()), 'getStateBillStatus', { billId: 'tx-2025-hb1234' })) as {
      found: boolean;
      status: string;
      statusLabel: string;
      votes: unknown[];
      note: string;
    };
    expect(out.found).toBe(true);
    expect(out.status).toBe('dead_by_deadline');
    expect(out.status).not.toBe('committee');
    expect(out.statusLabel).toMatch(/dead|sine die/i);
    expect(out.votes).toHaveLength(0);
    expect(out.note).toMatch(/no recorded roll-call vote/i);
    expect(out.note).toMatch(/sine die/i);
  });

  it('resolves a designation WITH a state hint ("HB 1234" + state=TX)', async () => {
    const out = (await call(svc(prisma()), 'getStateBillStatus', {
      billId: 'HB 1234',
      state: 'TX',
    })) as {
      billId: string;
      found: boolean;
    };
    expect(out.billId).toBe('tx-2025-hb1234');
    expect(out.found).toBe(true);
  });

  it('resolves a designation with the state embedded ("TX HB 1234")', async () => {
    const out = (await call(svc(prisma()), 'getStateBillStatus', { billId: 'TX HB 1234' })) as {
      billId: string;
      found: boolean;
    };
    expect(out.billId).toBe('tx-2025-hb1234');
    expect(out.found).toBe(true);
  });

  it('a designation with NO state (embedded or hinted) returns a specify-the-state note, never guesses', async () => {
    const out = (await call(svc(prisma()), 'getStateBillStatus', { billId: 'HB 1234' })) as {
      found: boolean;
      note: string;
    };
    expect(out.found).toBe(false);
    expect(out.note).toMatch(/specify the state/i);
  });

  it('says NO BILL explicitly (never from memory) when the resolved key is absent', async () => {
    const out = (await call(svc(prisma()), 'getStateBillStatus', { billId: 'tx-2025-hb9999' })) as {
      found: boolean;
      note: string;
    };
    expect(out.found).toBe(false);
    expect(out.note).toMatch(/do not describe its status from memory/i);
  });
});

describe('search_state_floor_votes (S6.1)', () => {
  it('returns matching votes, else an explicit no-match + member-filter-unavailable note', async () => {
    const withVotes: Fake = withSystemFake({
      stateRollCallVote: {
        findMany: async () => [
          {
            id: 'tx-rc-1',
            billKey: 'tx-2025-hb1234',
            chamber: 'H',
            motion: 'Third Reading',
            yeas: 90,
            nays: 50,
            nv: 0,
            absent: 0,
            passed: true,
            sourceUrl: null,
          },
        ],
      },
    });
    const hit = (await call(svc(withVotes), 'searchStateFloorVotes', {
      billId: 'tx-2025-hb1234',
    })) as {
      votesFound: number;
    };
    expect(hit.votesFound).toBe(1);

    const empty: Fake = withSystemFake({ stateRollCallVote: { findMany: async () => [] } });
    const miss = (await call(svc(empty), 'searchStateFloorVotes', { query: 'nonexistent' })) as {
      votesFound: number;
      note: string;
    };
    expect(miss.votesFound).toBe(0);
    expect(miss.note).toMatch(/do not infer a vote outcome/i);
    expect(miss.note).toMatch(/member-level filtering is not available/i);
  });
});

describe('get_state_legislator (S6.1/S6.2)', () => {
  it('resolves by an external id via entity_crosswalk', async () => {
    const p: Fake = {
      entityCrosswalk: {
        findMany: async () => [
          {
            idType: 'legiscan_people',
            idValue: '12345',
            entityType: 'state_legislator',
            entityKey: 'ocd-person/abc',
          },
        ],
      },
      ...withSystemFake({
        stateLegislator: {
          findUnique: async ({ where }: { where: { id: string } }) =>
            where.id === 'ocd-person/abc'
              ? {
                  id: 'ocd-person/abc',
                  name: 'Rep. Jane Doe',
                  state: 'TX',
                  chamber: 'lower',
                  district: '12',
                  party: 'D',
                  committees: [],
                  active: true,
                }
              : null,
        },
      }),
    };
    const out = (await call(svc(p), 'getStateLegislator', { query: '12345' })) as {
      matchesFound: number;
      matches: Array<{ name: string; matchedBy: string }>;
    };
    expect(out.matchesFound).toBe(1);
    expect(out.matches[0]?.name).toBe('Rep. Jane Doe');
    expect(out.matches[0]?.matchedBy).toBe('legiscan_people-crosswalk');
  });

  it('an AMBIGUOUS name returns disambiguation candidates, not an arbitrary legislator', async () => {
    const p: Fake = {
      entityCrosswalk: { findMany: async () => [] },
      ...withSystemFake({
        stateLegislator: {
          findMany: async () => [
            {
              id: 'a',
              name: 'Rep. John Smith',
              state: 'TX',
              chamber: 'lower',
              district: '1',
              party: 'R',
              active: true,
            },
            {
              id: 'b',
              name: 'Rep. John Smith',
              state: 'TX',
              chamber: 'upper',
              district: '5',
              party: 'D',
              active: true,
            },
          ],
        },
      }),
    };
    const out = (await call(svc(p), 'getStateLegislator', {
      query: 'John Smith',
      state: 'TX',
    })) as {
      matchesFound: number;
      ambiguousLegislator: Array<{ id: string }>;
      note: string;
    };
    expect(out.matchesFound).toBe(0);
    expect(out.ambiguousLegislator).toHaveLength(2);
    expect(out.note).toMatch(/matches 2 state legislators/i);
  });

  it('says NO MATCH explicitly (never fabricates) when absent', async () => {
    const p: Fake = {
      entityCrosswalk: { findMany: async () => [] },
      ...withSystemFake({ stateLegislator: { findMany: async () => [] } }),
    };
    const out = (await call(svc(p), 'getStateLegislator', { query: 'Nobody Real' })) as {
      matchesFound: number;
      note: string;
    };
    expect(out.matchesFound).toBe(0);
    expect(out.note).toMatch(/do not fabricate a legislator/i);
  });
});
