import { DistrictNexusStrategicService } from './district-nexus-strategic.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientPeRelevanceService } from '../intelligence/client-pe-relevance.service.js';
import type { DistrictNexusService } from './district-nexus.service.js';
import type { StrategicComponentInput } from './district-nexus-strategic-scoring.js';

const alice = {
  bioguideId: 'A001',
  fullName: 'Alice Able',
  firstName: 'Alice',
  lastName: 'Able',
  chamber: 'senate',
  district: null as number | null,
  isCurrent: true,
};
const bob = {
  ...alice,
  bioguideId: 'B001',
  fullName: 'Bob Baker',
  firstName: 'Bob',
  lastName: 'Baker',
};
const request = {
  id: 'request-1',
  fiscalYear: 2026,
  chamber: 'senate',
  requesterName: 'Alice Able',
  requesterState: 'CA',
  requesterDistrict: null as string | null,
  state: 'CA',
  recipientName: 'Town',
  requestedAmountUsd: '1000',
};
function harness(members = [alice, bob], requests = [request]) {
  const prisma = {
    congressMember: { findMany: jest.fn().mockResolvedValue(members) },
    communityFundingRequest: {
      findFirst: jest.fn().mockResolvedValue({ id: 'seed' }),
      findMany: jest.fn(async ({ where }: { where: { chamber: string } }) =>
        requests.filter((r) => r.chamber === where.chamber),
      ),
    },
  };
  const service = new DistrictNexusStrategicService(
    prisma as unknown as PrismaService,
    {} as ClientPeRelevanceService,
    {} as DistrictNexusService,
  );
  const load = (
    service as unknown as {
      loadMemberPriorityEvidence: (
        ids: ReadonlySet<string>,
        state: string,
        district: string,
      ) => Promise<StrategicComponentInput>;
    }
  ).loadMemberPriorityEvidence.bind(service);
  return { prisma, load: (ids = new Set(['A001', 'B001'])) => load(ids, 'CA', 'CA-47') };
}

describe('Strategic member history uses source requester identity', () => {
  test('queries the canonical full-name state and preserves historical candidates for ambiguity', async () => {
    const { prisma, load } = harness();
    await load();
    expect(prisma.congressMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { state: 'California', chamber: { in: ['house', 'senate'] } },
      }),
    );
    expect(prisma.congressMember.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.communityFundingRequest.findMany).toHaveBeenCalledTimes(2);
  });
  test('only the named senator receives evidence with a canonical source record id', async () => {
    const { load } = harness();
    const result = await load();
    expect(result.strength).toBe('sourceAuthoritative');
    expect(result.evidenceCount).toBe(1);
    expect(result.evidence).toEqual([
      expect.objectContaining({
        sourceRecordId: 'request-1',
        refs: expect.objectContaining({ requesterBioguideIds: 'A001' }),
      }),
    ]);
    expect(result.rationale).toContain('$1,000');
    expect((await load(new Set(['B001']))).strength).toBe('absent');
  });
  test('joint requester evidence and totals count one canonical request, not two members', async () => {
    const { load } = harness(
      [alice, bob],
      [
        { ...request, requesterName: 'Able; Baker' },
        { ...request, requesterName: 'Able; Baker' },
      ],
    );
    const result = await load();
    expect(result.evidenceCount).toBe(1);
    expect(result.rationale).toContain('$1,000');
    expect(result.evidence?.[0]?.refs?.requesterBioguideIds).toBe('A001,B001');
  });
  test('a former member cannot confer credit on a current member of the same state', async () => {
    const { load } = harness([{ ...alice, isCurrent: false }, bob]);
    expect((await load()).strength).toBe('absent');
  });
  test('unknown requester names stay unavailable instead of receiving geographic credit', async () => {
    const { load } = harness([alice, bob], [{ ...request, requesterName: 'Unknown person' }]);
    const result = await load();
    expect(result.strength).toBe('unavailable');
    expect(result.evidenceCount).toBe(0);
  });
  test.each(['90', '98', 'ZZ', null])(
    'House requests without a valid source district (%s) supply no evidence',
    async (district) => {
      const house = { ...alice, chamber: 'house', district: 47 };
      const { load } = harness(
        [house],
        [{ ...request, chamber: 'house', requesterDistrict: district }],
      );
      expect((await load()).evidenceCount).toBe(0);
    },
  );
  test('a valid House source district and named requester preserve positive evidence', async () => {
    const { load } = harness(
      [{ ...alice, chamber: 'house', district: 47 }],
      [{ ...request, chamber: 'house', requesterDistrict: '47' }],
    );
    expect((await load()).evidenceCount).toBe(1);
  });
  test('a directory failure still degrades to unavailable', async () => {
    const { prisma, load } = harness();
    prisma.congressMember.findMany.mockRejectedValue(new Error('directory unavailable'));
    expect((await load()).strength).toBe('unavailable');
  });
  test('a bounded scan without member matches is incomplete, not evidence of absence', async () => {
    const { load } = harness(
      [alice, bob],
      Array.from({ length: 5000 }, (_, n) => ({
        ...request,
        id: `request-${n}`,
        requesterName: 'Bob Baker',
      })),
    );
    const result = await load(new Set(['A001']));
    expect(result.strength).toBe('unavailable');
    expect(result.rationale).toContain('scan is incomplete');
  });

  test('an empty corpus is unavailable', async () => {
    const { prisma, load } = harness();
    prisma.communityFundingRequest.findFirst.mockResolvedValue(null);
    expect((await load()).strength).toBe('unavailable');
  });
});
