import { describe, expect, jest, test } from '@jest/globals';
import { DistrictNexusService } from './district-nexus.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RepresentationResolverService } from '../clients/representation-resolver.service.js';

describe('district funding freshness after writer consolidation', () => {
  test('reports the new grant lane under the stable public grants feed ID', async () => {
    const finishedAt = new Date('2026-10-28T01:00:00Z');
    const prisma = { $queryRaw: jest.fn(async () => [{ source: 'sync-tango-funding:grants', finished_at: finishedAt }]) };
    const service = new DistrictNexusService(prisma as unknown as PrismaService, {} as RepresentationResolverService);
    const rows = await service['readFreshness']();
    expect(rows.find(row => row.source === 'sync-grants')).toEqual({ source: 'sync-grants', label: 'Grant opportunities', lastSyncedAt: finishedAt.toISOString(), neverSynced: false });
    expect(rows.find(row => row.source === 'sync-federal-award')?.neverSynced).toBe(true);
  });
  test('an old writer run cannot claim the new grant lane is fresh', async () => {
    const prisma = { $queryRaw: jest.fn(async () => [{ source: 'sync-grants', finished_at: new Date() }]) };
    const service = new DistrictNexusService(prisma as unknown as PrismaService, {} as RepresentationResolverService);
    const rows = await service['readFreshness']();
    expect(rows.find(row => row.source === 'sync-grants')).toMatchObject({ lastSyncedAt: null, neverSynced: true });
  });
});
