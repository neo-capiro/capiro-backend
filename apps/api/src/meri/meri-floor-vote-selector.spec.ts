import { BadRequestException } from '@nestjs/common';
import { MeriFederalLegislationTools } from './meri-federal-legislation-tools.js';

// The fixture evaluates the actual producer's filters against distinct Congress
// rows, so a dropped or contradictory selector cannot pass as an empty lookup.
function fixture() {
  const rows = [1, 9, 118, 119].map((congress) => ({
    id: `synthetic-senate-${congress}-1-7`, billId: `${congress}-s-2809`, congress,
    chamber: 'senate', question: 'On passage', title: 'Synthetic vote',
    voteDate: new Date('2026-01-01T00:00:00.000Z'),
  }));
  const findMany = jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
    rows.filter((row) => (!where.billId || row.billId === where.billId) &&
      (!where.congress || row.congress === where.congress)));
  const service = new MeriFederalLegislationTools({ rollCallVote: { findMany } } as never, {} as never);
  return { service, findMany };
}

describe('floor-vote exact selector scope', () => {
  it.each([1, 9])('preserves the same exact identity after canonical replay for Congress %s', async (congress) => {
    const { service } = fixture();
    for (const billId of ['S. 2809', `${congress}-s-2809`, `S. 2809 (${congress}th)`]) {
      const page = await service.searchFloorVotes({ billId, congress });
      expect(page.votes.map((vote) => vote.billId)).toEqual([`${congress}-s-2809`]);
    }
  });
  it.each(['S. 2809', '118-s-2809', 'S. 2809 (118th)'])(
    'returns only the explicit Congress for %s', async (billId) => {
      const { service } = fixture();
      const page = await service.searchFloorVotes({ billId, congress: 118 });
      expect(page.votes.map((vote) => vote.billId)).toEqual(['118-s-2809']);
    },
  );

  it.each([
    { billId: 'not a bill' },
    { billId: '119-s-2809', congress: 118 },
    { billId: 'S. 2809 (119th)', congress: 118 },
    { billId: `S. 2809${' '.repeat(60)}suffix` },
    { billId: `S. 2809${' '.repeat(55)}` },
    { billId: ' '.repeat(61) },
    { billId: 2809 },
    { billId: 'S. 2809', congress: 'not a congress' },
    { congress: 118.5 },
    { congress: -118 },
    { congress: 1000 },
    { congress: true },
  ])('refuses invalid selected scope without reading unrelated votes: %j', async (input) => {
    const { service, findMany } = fixture();
    await expect(service.searchFloorVotes(input)).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each([null, '', ' '.repeat(60)])('preserves within-bound unselected mode for %j', async (billId) => {
    const { service, findMany } = fixture();
    const page = await service.searchFloorVotes({ billId, query: 'passage', congress: 118 });
    expect(page.votes.map((vote) => vote.billId)).toEqual(['118-s-2809']);
    expect(findMany.mock.calls[0]?.[0].where).not.toHaveProperty('billId');
  });

  it('preserves genuine exact misses and unselected topic searches', async () => {
    const { service, findMany } = fixture();
    const missing = await service.searchFloorVotes({ billId: '118-s-99999', congress: 118 });
    expect(missing.votes).toEqual([]);
    expect(missing.note).toContain('No roll-call vote');
    const topic = await service.searchFloorVotes({ billId: ' ', query: 'passage', congress: '118' });
    expect(topic.votes.map((vote) => vote.billId)).toEqual(['118-s-2809']);
    expect(findMany.mock.calls[1]?.[0].where).toMatchObject({ congress: 118, OR: expect.any(Array) });
  });
});
