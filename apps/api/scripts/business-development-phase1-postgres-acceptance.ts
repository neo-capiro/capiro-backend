import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { ClientsService } from '../src/clients/clients.service.js';
import type { ClientPrepopulationService } from '../src/intelligence/client-prepopulation.service.js';
import type { EntityResolutionService } from '../src/intelligence/entity-resolution.service.js';
import type { SamEntityEnrichmentService } from '../src/intelligence/sam-entity.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { BusinessDevelopmentService } from '../src/business-development/business-development.service.js';

const TENANT_ID = 'bc000000-0000-0000-0000-000000000001';
const USER_ID = 'bc200000-0000-0000-0000-000000000001';
const CANONICAL_CREATE_ID = 'bc500000-0000-0000-0000-000000000001';
const CANONICAL_RESOLVE_ID = 'bc500000-0000-0000-0000-000000000002';

function requireDisposableDatabase(): void {
  if (process.env.BIZDEV_PHASE1_TEST_DATABASE !== 'disposable') {
    throw new Error('BIZDEV_PHASE1_TEST_DATABASE=disposable is required');
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required');
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`refusing non-local database host: ${url.hostname}`);
  }
  if (!url.pathname.endsWith('/capiro_bizdev_phase1_test_20260924')) {
    throw new Error(`refusing unexpected database: ${url.pathname}`);
  }
}

async function main(): Promise<void> {
  requireDisposableDatabase();

  const prisma = new PrismaService();
  await prisma.$connect();
  let createClientCalls = 0;

  const clientsCore = {
    async createInTransaction(
      ctx: Pick<TenantContext, 'tenantId' | 'userId'>,
      tx: Prisma.TransactionClient,
      input: {
        name: string;
        website?: string;
        description?: string;
        canonicalEntityId?: string;
      },
    ) {
      createClientCalls += 1;
      // Widen the race so the second conversion must wait on the prospect
      // row lock rather than merely arriving after the first transaction.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { ldaRegistrantId: true },
      });
      const client = await tx.client.create({
        data: {
          tenantId: ctx.tenantId,
          name: input.name,
          website: input.website ?? null,
          description: input.description ?? null,
          canonicalEntityId: input.canonicalEntityId ?? null,
          createdByUserId: ctx.userId,
        },
      });
      return { client, ldaRegistrantId: tenant?.ldaRegistrantId ?? null };
    },
  };

  const entityResolution = { resolveClient: async () => ({}) };
  const prepopulation = { prepopulate: async () => undefined };
  const samEntity = { enrichGovIds: async () => undefined };
  const service = new BusinessDevelopmentService(
    prisma,
    clientsCore as unknown as ClientsService,
    entityResolution as unknown as EntityResolutionService,
    prepopulation as unknown as ClientPrepopulationService,
    samEntity as unknown as SamEntityEnrichmentService,
  );
  const ctx = {
    tenantId: TENANT_ID,
    userId: USER_ID,
    role: 'standard_user',
  } as unknown as TenantContext;

  try {
    await cleanup(prisma);
    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: {
          id: TENANT_ID,
          slug: 'bizdev-postgres-acceptance',
          name: 'BizDev PostgreSQL Acceptance',
          status: 'active',
          billingStatus: 'comped',
          ldaRegistrantId: 4242,
          settings: { clioFeatureFlags: { 'businessDevelopment.enabled': true } },
        },
      });
      await tx.user.create({
        data: {
          id: USER_ID,
          clerkUserId: 'bizdev-postgres-acceptance-user',
          email: 'bizdev-postgres-acceptance@example.invalid',
        },
      });
      await tx.tenantMembership.create({
        data: {
          tenantId: TENANT_ID,
          userId: USER_ID,
          role: 'standard_user',
          status: 'active',
        },
      });
      await tx.canonicalEntity.createMany({
        data: [
          {
            id: CANONICAL_CREATE_ID,
            identityScope: 'global_public',
            entityType: 'organization',
            canonicalName: 'Canonical Create Co',
            normalizedName: 'canonical create co',
            resolutionMethod: 'manual_review',
          },
          {
            id: CANONICAL_RESOLVE_ID,
            identityScope: 'global_public',
            entityType: 'organization',
            canonicalName: 'Canonical Resolve Co',
            normalizedName: 'canonical resolve co',
            resolutionMethod: 'manual_review',
          },
        ],
      });
    });

    // Actual two-key PostgreSQL advisory-lock call + serialized confirmed
    // create. Both callers must receive the same prospect.
    const confirmed = await Promise.all([
      service.create(ctx, {
        canonicalEntityId: CANONICAL_CREATE_ID,
        displayName: 'Canonical Create Co',
      }),
      service.create(ctx, {
        canonicalEntityId: CANONICAL_CREATE_ID,
        displayName: 'Do Not Overwrite Active Duplicate',
      }),
    ]);
    assert.equal(confirmed[0].id, confirmed[1].id);
    assert.equal(confirmed[0].displayName, confirmed[1].displayName);
    assert.ok(
      ['Canonical Create Co', 'Do Not Overwrite Active Duplicate'].includes(
        confirmed[0].displayName,
      ),
    );
    assert.equal(
      await prisma.businessDevelopmentProspect.count({
        where: { tenantId: TENANT_ID, canonicalEntityId: CANONICAL_CREATE_ID },
      }),
      1,
    );

    // The create form can review same-firm duplicates before its first write.
    // The preview is tenant-owned and advisory; it returns the existing exact
    // confirmed prospect without mutating or creating anything.
    const preview = await service.previewDuplicateHints(ctx, {
      displayName: 'Canonical Create Company',
      canonicalEntityId: CANONICAL_CREATE_ID,
    });
    assert.equal(preview.hints.length, 1);
    assert.equal(preview.hints[0]?.id, confirmed[0].id);
    assert.equal(preview.hints[0]?.status, 'active');

    // Linking a confirmed prospect to a reviewed existing client stamps the
    // identity onto that previously-unconfirmed client in the same transaction.
    const reviewedClient = await prisma.withTenant(TENANT_ID, (tx) =>
      tx.client.create({
        data: {
          tenantId: TENANT_ID,
          name: 'Reviewed Existing Client',
          createdByUserId: USER_ID,
        },
      }),
    );
    const confirmedLink = await service.convert(ctx, confirmed[0].id, {
      existingClientId: reviewedClient.id,
    });
    assert.equal(confirmedLink.created, false);
    const reviewedClientAfter = await prisma.client.findUniqueOrThrow({
      where: { id: reviewedClient.id },
      select: { canonicalEntityId: true },
    });
    assert.equal(reviewedClientAfter.canonicalEntityId, CANONICAL_CREATE_ID);

    // Explicit unresolved -> canonical link preserves the prospect id and
    // executes the same real advisory-lock overload.
    const unresolvedForIdentity = await service.create(ctx, {
      displayName: 'Manual Identity Candidate',
    });
    const resolved = await service.resolveIdentity(ctx, unresolvedForIdentity.id, {
      canonicalEntityId: CANONICAL_RESOLVE_ID,
    });
    assert.equal(resolved.outcome, 'resolved');
    if (resolved.outcome === 'resolved') {
      assert.equal(resolved.prospect.id, unresolvedForIdentity.id);
      assert.equal(resolved.prospect.canonicalEntityId, CANONICAL_RESOLVE_ID);
    }

    // Same-prospect conversion race: the row lock must cause exactly one
    // client creation, one conversion activity, and one durable link.
    const raceProspect = await service.create(ctx, { displayName: 'Conversion Race Co' });
    const sameProspectResults = await Promise.all([
      service.convert(ctx, raceProspect.id),
      service.convert(ctx, raceProspect.id),
    ]);
    assert.equal(sameProspectResults[0].client.id, sameProspectResults[1].client.id);
    assert.deepEqual(sameProspectResults.map((result) => result.created).sort(), [false, true]);
    assert.equal(createClientCalls, 1);
    assert.equal(
      await prisma.client.count({
        where: { tenantId: TENANT_ID, id: sameProspectResults[0].client.id },
      }),
      1,
    );
    assert.equal(
      await prisma.businessDevelopmentProspectActivity.count({
        where: { tenantId: TENANT_ID, prospectId: raceProspect.id, kind: 'convert' },
      }),
      1,
    );

    // Different prospects racing to claim the same existing client must
    // serialize on the client row. One succeeds; the loser receives the
    // structured review conflict instead of a raw unique-index error.
    const [claimA, claimB] = await Promise.all([
      service.create(ctx, { displayName: 'Claim A' }),
      service.create(ctx, { displayName: 'Claim B' }),
    ]);
    const sharedClient = await prisma.withTenant(TENANT_ID, (tx) =>
      tx.client.create({
        data: {
          tenantId: TENANT_ID,
          name: 'Shared Existing Client',
          createdByUserId: USER_ID,
        },
      }),
    );
    const claimResults = await Promise.allSettled([
      service.convert(ctx, claimA.id, { existingClientId: sharedClient.id }),
      service.convert(ctx, claimB.id, { existingClientId: sharedClient.id }),
    ]);
    assert.equal(claimResults.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = claimResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    assert.ok(rejected);
    assert.ok(rejected.reason instanceof ConflictException);
    const response = rejected.reason.getResponse() as { code?: string; prospectId?: string };
    assert.equal(response.code, 'BIZDEV_CLIENT_ALREADY_LINKED');
    assert.ok(response.prospectId === claimA.id || response.prospectId === claimB.id);
    assert.equal(
      await prisma.businessDevelopmentProspect.count({
        where: { tenantId: TENANT_ID, linkedClientId: sharedClient.id },
      }),
      1,
    );

    console.log('BUSINESS DEVELOPMENT PHASE 1 POSTGRES ACCEPTANCE PASSED');
    console.log(
      JSON.stringify(
        {
          confirmedProspectId: confirmed[0].id,
          preservedIdentityProspectId: unresolvedForIdentity.id,
          conversionClientId: sameProspectResults[0].client.id,
          createClientCalls,
          sharedClientId: sharedClient.id,
          structuredConflictCode: response.code,
        },
        null,
        2,
      ),
    );
  } finally {
    await cleanup(prisma);
    await prisma.$disconnect();
  }
}

async function cleanup(prisma: PrismaService): Promise<void> {
  await prisma.withSystem(async (tx) => {
    // The repository's audit table is deliberately append-only. This harness
    // has already refused every non-local/non-dedicated database above, so use
    // the same transaction-local purge switch as the supported tenant deletion
    // path to make repeated acceptance runs deterministic.
    await tx.$executeRaw`SELECT set_config('app.allow_audit_purge', 'on', true)`;
    await tx.auditLog.deleteMany({ where: { tenantId: TENANT_ID } });
    await tx.businessDevelopmentProspectActivity.deleteMany({ where: { tenantId: TENANT_ID } });
    await tx.businessDevelopmentProspect.deleteMany({ where: { tenantId: TENANT_ID } });
    await tx.businessDevelopmentPreference.deleteMany({ where: { tenantId: TENANT_ID } });
    await tx.client.deleteMany({ where: { tenantId: TENANT_ID } });
    await tx.tenantMembership.deleteMany({ where: { tenantId: TENANT_ID } });
    await tx.user.deleteMany({ where: { id: USER_ID } });
    await tx.canonicalEntity.deleteMany({
      where: { id: { in: [CANONICAL_CREATE_ID, CANONICAL_RESOLVE_ID] } },
    });
    await tx.tenant.deleteMany({ where: { id: TENANT_ID } });
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
