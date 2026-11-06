import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service.js';
import { reviewDatabase } from '../clients/client-profile-fill-review.postgres-fixture.js';
import { EntityResolutionService } from './entity-resolution.service.js';

const url = process.env.FILL_REVIEW_TEST_DATABASE_URL;
(url ? describe : describe.skip)('concurrent identity candidate persistence', () => {
  let store: Awaited<ReturnType<typeof reviewDatabase>>;
  let tenantId: string, clientId: string, userId: string;
  let persist: (exact: boolean) => Promise<{ created: number }>;
  const externalId = 'synthetic-contractor';
  beforeAll(async () => {
    store = await reviewDatabase(url!);
  }, 60_000);
  afterAll(async () => {
    await store?.db.$disconnect();
  });
  beforeEach(async () => {
    tenantId = randomUUID();
    clientId = randomUUID();
    userId = randomUUID();
    await store.db.tenant.create({
      data: { id: tenantId, slug: 'synthetic-' + tenantId, name: 'Synthetic', status: 'active' },
    });
    await store.db.user.create({
      data: { id: userId, clerkUserId: 'synthetic-' + userId, email: userId + '@example.invalid' },
    });
    await store.db.client.create({
      data: { id: clientId, tenantId, name: 'Synthetic', status: 'active' },
    });
    const prisma = {
      withTenant: (tenant: string, action: Parameters<typeof store.scoped.withTenantUser>[2]) =>
        store.scoped.withTenantUser(tenant, userId, action),
    } as unknown as PrismaService;
    const service = new EntityResolutionService(prisma) as unknown as {
      persistSourceCandidates(
        client: string,
        tenant: string,
        source: string,
        rows: unknown[],
        fingerprint: string,
      ): Promise<{ created: number }>;
    };
    persist = (exact) =>
      service.persistSourceCandidates(
        clientId,
        tenantId,
        'contracting',
        [
          {
            external_id: externalId,
            external_name: exact ? 'Exact identity' : 'Name candidate',
            similarity: 1,
            preScored: exact ? 1 : 0.8,
            matchTier: exact ? 1 : 4,
            matchBasis: exact ? 'exact_uei' : 'fuzzy_name',
            autoConfirmEligible: exact,
          },
        ],
        'synthetic',
      );
  });
  const mapping = () =>
    store.db.clientIntelMapping.findUniqueOrThrow({
      where: { clientId_source_externalId: { clientId, source: 'contracting', externalId } },
    });

  test('create and post-SAM resolution share one key and retain exact evidence in either ordering', async () => {
    const results = await Promise.all([
      persist(false),
      persist(true),
      persist(false),
      persist(true),
    ]);
    expect(results.reduce((count, row) => count + row.created, 0)).toBe(1);
    expect(await store.db.clientIntelMapping.count({ where: { tenantId, clientId } })).toBe(1);
    expect(await mapping()).toMatchObject({
      confirmed: true,
      reviewStatus: 'confirmed',
      matchBasis: 'exact_uei',
      matchTier: 1,
      relationshipType: 'self',
      rollUpAwards: true,
      externalName: 'Exact identity',
      confidence: 1,
    });
    await persist(false);
    expect(await mapping()).toMatchObject({
      matchBasis: 'exact_uei',
      confidence: 1,
      externalName: 'Exact identity',
    });
  });

  test.each(['confirmed', 'rejected', 'superseded'] as const)(
    'preserves a current human %s decision during concurrent callbacks',
    async (reviewStatus) => {
      await store.db.clientIntelMapping.create({
        data: {
          tenantId,
          clientId,
          source: 'contracting',
          externalId,
          externalName: 'Human decision',
          confidence: 0.7,
          confirmed: reviewStatus === 'confirmed',
          reviewStatus,
          reviewedBy: userId,
          reviewedAt: new Date('2026-01-01T00:00:00Z'),
          matchBasis: reviewStatus === 'rejected' ? 'exact_uei' : 'manual_pin',
          relationshipType: 'subsidiary',
          rollUpAwards: false,
        },
      });
      const before = await mapping();
      await Promise.all([persist(false), persist(true)]);
      expect(await mapping()).toEqual(before);
    },
  );

  test('preserves the existing exact-UEI exception for a formerly name-based rejection', async () => {
    await store.db.clientIntelMapping.create({
      data: {
        tenantId,
        clientId,
        source: 'contracting',
        externalId,
        externalName: 'Rejected name',
        confidence: 0.7,
        confirmed: false,
        reviewStatus: 'rejected',
        reviewedBy: userId,
        matchBasis: 'fuzzy_name',
        matchTier: 4,
        rejectionReason: 'Name alone is insufficient',
      },
    });
    await persist(false);
    expect(await mapping()).toMatchObject({
      reviewStatus: 'rejected',
      rejectionReason: 'Name alone is insufficient',
    });
    await persist(true);
    expect(await mapping()).toMatchObject({
      reviewStatus: 'confirmed',
      matchBasis: 'exact_uei',
      reviewedBy: null,
      rejectionReason: null,
      relationshipType: 'self',
      rollUpAwards: true,
    });
  });
});
