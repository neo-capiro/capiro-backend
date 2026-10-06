import type { PrismaClient } from '@prisma/client';
import { DiscoveryJobsService } from './discovery-jobs.service.js';
import { CanonicalHearingRepository } from './canonical-hearing.repository.js';

describe('canonical-only discovery after reviewed reconciliation', () => {
  it('reuses a legacy NoChamber row for the same official joint event', async () => {
    const db = {
      committeeHearing: {
        findUnique: jest.fn(async () => ({
          id: 'cm-119-338796',
          chamber: 'NoChamber',
          geographicJurisdiction: 'US',
          canonicalHearingId: null,
        })),
      },
    } as unknown as PrismaClient;
    await expect(
      new CanonicalHearingRepository(db).resolveHearingId(
        { chamber: 'joint', congress: 119, externalEventId: '338796' },
        'congress-gov',
      ),
    ).resolves.toEqual({ kind: 'id', hearingId: 'cm-119-338796' });
  });
  it('does not select retained aliases for enrichment or archive mutation', async () => {
    const findMany = jest.fn(async () => []);
    const db = { committeeHearing: { findMany } } as unknown as PrismaClient;
    const jobs = new DiscoveryJobsService(db);
    await jobs.enrichCommitteeHearings({ dryRun: true, now: new Date('2026-09-14') });
    await jobs.reconcileArchives({ dryRun: true, now: new Date('2026-09-14') });
    expect(findMany).toHaveBeenCalledTimes(2);
    for (const [query] of findMany.mock.calls as unknown as Array<
      [{ where: Record<string, unknown>; take: number }]
    >) {
      expect(query.where).toMatchObject({ geographicJurisdiction: 'US', canonicalHearingId: null });
      expect(query.take).toBeGreaterThan(0);
    }
  });
  it('fails closed if discovery finds an exact event ID occupied by the wrong scope', async () => {
    const db = {
      committeeHearing: {
        findUnique: jest.fn(async () => ({
          id: 'sen-119-338740',
          chamber: 'House',
          geographicJurisdiction: 'US',
        })),
      },
    } as unknown as PrismaClient;
    await expect(
      new CanonicalHearingRepository(db).resolveHearingId(
        {
          chamber: 'senate',
          congress: 119,
          externalEventId: '338740',
        },
        'senate-schedule',
      ),
    ).rejects.toThrow('different scope');
  });
});
