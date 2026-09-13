import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { persistVoteRevision } from './legiscan-vote-revisions.js';
import type { LegiscanRollCall } from '../external/legiscan/legiscan.client.js';
describe('vote revision owner/projection PostgreSQL', () => {
  const p = new PrismaClient(),
    billKey = `fl-2098-hb${Math.floor(Math.random() * 1e6)}`;
  const providerId = Math.floor(Math.random() * 1e8) + 500_000_000;
  const rc: LegiscanRollCall = {
    roll_call_id: providerId,
    bill_id: providerId,
    date: '2098-01-02',
    chamber: 'H',
    desc: 'Favorable recommendation',
    passed: 1,
    yea: 1,
    nay: 1,
    nv: 0,
    absent: 0,
    votes: [
      { people_id: providerId, vote_text: 'Yea' },
      { people_id: providerId + 1, vote_text: 'Nay' },
    ],
  };
  const voteId = `fl-rc-${providerId}`;
  beforeAll(async () => {
    if (
      process.env.LEGIWATCH_PHASE5_TEST_DATABASE !== 'disposable' ||
      !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname)
    )
      throw Error('Disposable database required');
    await p.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,legiscan_bill_id)
      VALUES(${billKey},'FL','2098','2098','HB 1','hb1','Synthetic revision',${providerId})`;
  });
  afterAll(async () => {
    // Retain immutable source/observation fixtures in the disposable database.
    await p.$disconnect();
  });
  it('atomically repairs same-total positions, retains IDs and both cited versions', async () => {
    await persistVoteRevision(p, 'FL', billKey, rc, {
      providerBillHash: 'a',
      stub: { roll_call_id: providerId, state_link: 'https://example.gov/vote.pdf' },
    });
    const before = await p.stateMemberVote.findMany({
      where: { voteId },
      orderBy: { legiscanPeopleId: 'asc' },
    });
    const first = await p.stateBillPublishedRecord.findFirstOrThrow({
      where: { billKey, kind: 'vote' },
    });
    const corrected = {
      ...rc,
      desc: 'Corrected recommendation',
      passed: 0,
      votes: [
        { people_id: providerId, vote_text: 'Nay' },
        { people_id: providerId + 1, vote_text: 'Yea' },
      ],
    };
    await persistVoteRevision(p, 'FL', billKey, corrected, { providerBillHash: 'b' });
    const after = await p.stateMemberVote.findMany({
      where: { voteId },
      orderBy: { legiscanPeopleId: 'asc' },
    });
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.voteCast)).toEqual(['Nay', 'Yea']);
    expect(await p.stateBillPublishedRecord.findUnique({ where: { id: first.id } })).toEqual(first);
    expect(await p.stateBillPublishedRecord.count({ where: { billKey } })).toBe(2);
    await persistVoteRevision(p, 'FL', billKey, corrected, { providerBillHash: 'c' });
    expect(await p.stateBillPublishedRecord.count({ where: { billKey } })).toBe(2);
    expect(await p.stateRollCallVote.findUnique({ where: { id: voteId } })).toMatchObject({
      passed: false,
      motion: corrected.desc,
    });
    await persistVoteRevision(p,'FL',billKey,rc,{providerBillHash:'d',stub:{roll_call_id:providerId,state_link:'https://example.gov/vote.pdf'}});
    expect(await p.stateBillPublishedRecord.count({where:{billKey}})).toBe(2);
    const trail=await p.$queryRaw<Array<{state_record_id:string}>>`SELECT state_record_id FROM published_record_source_observation WHERE source_key=${`state:${billKey}:vote:${voteId}`} ORDER BY id`;
    expect(trail).toHaveLength(3);expect(trail[0]!.state_record_id).toBe(first.id);expect(trail[2]!.state_record_id).toBe(first.id);
    expect((await p.stateRollCallVote.findUniqueOrThrow({where:{id:voteId}})).currentRevisionHash).toBe(first.revisionHash);
  });
  it('rejects partial detail without modifying the current projection', async () => {
    const before = await p.stateRollCallVote.findUnique({ where: { id: voteId } });
    await expect(persistVoteRevision(p, 'FL', billKey, { ...rc, votes: [] })).rejects.toThrow(
      'INCOMPLETE',
    );
    expect(await p.stateRollCallVote.findUnique({ where: { id: voteId } })).toEqual(before);
  });
  it('prevents application history rewrite/erasure under broad owner default ACLs', async () => {
    const permissions = await p.$queryRaw<
      Array<{ update: boolean; delete: boolean; truncate: boolean }>
    >`
      SELECT has_table_privilege('capiro_app','state_bill_published_record','UPDATE') AS update,
      has_table_privilege('capiro_app','state_bill_published_record','DELETE') AS delete,
      has_table_privilege('capiro_app','state_bill_published_record','TRUNCATE') AS truncate`;
    expect(permissions).toEqual([{ update: false, delete: false, truncate: false }]);
    await expect(
      p.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
        await tx.$executeRaw`UPDATE state_bill_published_record SET evidence='{}'::jsonb WHERE bill_key=${billKey}`;
      }),
    ).rejects.toThrow();
  });
});
