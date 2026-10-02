import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const NAMESPACE = 'meri-foundation-20260928';
const TENANTS = Object.freeze({
  'f2d6cf8f-057c-479a-8110-62fe5086d43f': `${NAMESPACE}-t1`,
  '52e91176-08f0-4d89-9633-bc212f5bdbbf': `${NAMESPACE}-t2`,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function assertConfiguration() {
  if (process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== NAMESPACE)
    throw new Error('CASE01_SETUP_NAMESPACE_REQUIRED');
  for (const key of [
    'MEMORY_GOVERNANCE_LIFECYCLE',
    'MEMORY_GOVERNANCE_CENTER',
    'MEMORY_GOVERNANCE_ENFORCE',
    'MEMORY_CLIENT_REVIEW',
  ])
    if (process.env[key] !== 'enforce') throw new Error('CASE01_SETUP_GOVERNANCE_REQUIRED');
  const cohort = (process.env.MEMORY_GOVERNANCE_TENANTS ?? '').split(',');
  if (
    cohort.some((id) => !UUID.test(id)) ||
    new Set(cohort).size !== cohort.length ||
    Object.keys(TENANTS).some((id) => !cohort.includes(id))
  )
    throw new Error('CASE01_SETUP_EXPLICIT_COHORT_REQUIRED');
  let database;
  try {
    database = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error('CASE01_SETUP_DATABASE_CONFIGURATION_REQUIRED');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol))
    throw new Error('CASE01_SETUP_DATABASE_CONFIGURATION_REQUIRED');
}

/**
 * Operator-only composition. Imports compiled image modules at fixed paths and
 * starts just the current canonical memory service graph. No AppModule,
 * controllers, queue drains, cron/bulk workers, chat or model calls are started.
 * Ordinary scoped owner operations retain their real projection fast paths and
 * durable outbox; this factory never substitutes an "indexed" receipt.
 */
export async function createCase01SetupDependencies() {
  if (arguments.length !== 0) throw new Error('CASE01_SETUP_FACTORY_ARGUMENTS_FORBIDDEN');
  assertConfiguration();
  require('reflect-metadata');
  const { Module } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { ConfigService } = require('@nestjs/config');
  const source = (path) => require(`../dist/${path}.js`);
  const { PrismaService } = source('prisma/prisma.service');
  const { TenantContextStore } = source('tenant/tenant-context.store');
  const { MemoryAuthorizationService } = source('memory/memory-authorization.service');
  const { MemoryTransitionAuditService } = source('memory/memory-transition-audit.service');
  const { MemoryStoreService } = source('memory/memory-store.service');
  const { LineageAwareMemoryStoreService } = source('memory/lineage-aware-memory-store.service');
  const { MemoryIngestService } = source('memory/memory-ingest.service');
  const { GovernedMemoryIngestService } = source('memory/governed-memory-ingest.service');
  const { MemoryCleanupOutboxService } = source('memory/memory-cleanup-outbox.service');
  const { ExactMemoryCleanupOutboxService } = source('memory/exact-memory-cleanup-outbox.service');
  const { StrictMemoryProjectorService } = source('memory/strict-memory-projector.service');
  const { ImmutableMemoryVersionService } = source('memory/immutable-memory-version.service');
  const { GovernedMemoryCandidateService } = source('memory/governed-memory-candidate.service');
  const { SettingsAwareMemoryCandidateService } = source(
    'memory/settings-aware-memory-candidate.service',
  );
  const { SettingsMemoryVersionCandidateService } = source(
    'memory/settings-memory-version-candidate.service',
  );
  const { MemorySettingsReviewReadinessService } = source(
    'memory/memory-settings-review-readiness.service',
  );
  const { MeetingNotesCryptoService } = source('engagement/meeting-notes-crypto.service');
  const { MeriService } = source('meri/meri.service');
  const { clientMemoryAllowed } = source('memory/memory-wall.helpers');
  const { runWithMemoryGovernanceTenant } = source('memory/memory-governance-tenant-scope');
  const { assertSyntheticCandidateWithdrawalInTx } = source(
    'memory/synthetic-candidate-withdrawal.helpers',
  );
  const { assertSyntheticApprovedMemoryInTx, readSyntheticMemoryRetirementInTx } = source(
    'memory/synthetic-approved-memory.helpers',
  );
  const { readSyntheticCorrectionInTx, readSyntheticCorrectionRetirementInTx } = source(
    'memory/synthetic-memory-version.helpers',
  );

  // The explicit aliases are the corresponding MemoryModule bindings. Nest's
  // existing forwardRef edges resolve Store <-> Outbox <-> Ingest without any
  // stub, duplicate store or best-effort projector. This module imports nothing.
  class Case01SetupModule {}
  Module({
    providers: [
      PrismaService,
      TenantContextStore,
      { provide: ConfigService, useValue: new ConfigService() },
      MemoryAuthorizationService,
      MemoryTransitionAuditService,
      ImmutableMemoryVersionService,
      LineageAwareMemoryStoreService,
      { provide: MemoryStoreService, useExisting: LineageAwareMemoryStoreService },
      StrictMemoryProjectorService,
      GovernedMemoryIngestService,
      { provide: MemoryIngestService, useExisting: GovernedMemoryIngestService },
      ExactMemoryCleanupOutboxService,
      { provide: MemoryCleanupOutboxService, useExisting: ExactMemoryCleanupOutboxService },
      SettingsMemoryVersionCandidateService,
      MemorySettingsReviewReadinessService,
      SettingsAwareMemoryCandidateService,
      { provide: GovernedMemoryCandidateService, useExisting: SettingsAwareMemoryCandidateService },
      MeetingNotesCryptoService,
    ],
  })(Case01SetupModule);

  const app = await NestFactory.createApplicationContext(Case01SetupModule, {
    logger: false,
    abortOnError: false,
  });
  let closePromise;
  let closed = false;
  const close = () => {
    closed = true;
    closePromise ??= app.close();
    return closePromise;
  };
  try {
    const prisma = app.get(PrismaService);
    const tenantContext = app.get(TenantContextStore);
    const deps = Object.freeze({
      prisma,
      tenantContext,
      memoryCandidates: app.get(GovernedMemoryCandidateService),
      memoryStore: app.get(MemoryStoreService),
      memoryVersions: app.get(ImmutableMemoryVersionService),
      memoryAuthorization: app.get(MemoryAuthorizationService),
      clientMemoryAllowed,
      runWithMemoryGovernanceTenant,
      assertSyntheticCandidateWithdrawalInTx,
      assertSyntheticApprovedMemoryInTx,
      readSyntheticMemoryRetirementInTx,
      readSyntheticCorrectionInTx,
      readSyntheticCorrectionRetirementInTx,
    });

    function assertContext(ctx) {
      if (
        !ctx ||
        ctx.tenantId !== 'f2d6cf8f-057c-479a-8110-62fe5086d43f' ||
        TENANTS[ctx.tenantId] !== ctx.tenantSlug ||
        ctx.role !== 'standard_user' ||
        !UUID.test(ctx.userId ?? '') ||
        typeof ctx.clerkUserId !== 'string' ||
        !ctx.clerkUserId.startsWith('user_')
      )
        throw new Error('CASE01_SETUP_CONVERSATION_SCOPE_INVALID');
    }

    async function assertActorInTx(tx, ctx) {
      const actors = await tx.$queryRaw`
        SELECT u.id FROM users u
        JOIN tenant_memberships tm ON tm.user_id=u.id
        JOIN tenants t ON t.id=tm.tenant_id
        WHERE u.id=${ctx.userId}::uuid AND u.clerk_user_id=${ctx.clerkUserId}
          AND tm.tenant_id=${ctx.tenantId}::uuid AND t.slug=${ctx.tenantSlug}
          AND tm.status='active' AND tm.role='standard_user'
        FOR UPDATE OF u, tm, t
      `;
      if (actors.length !== 1) throw new Error('CASE01_SETUP_CURRENT_ACTOR_REQUIRED');
    }

    async function runWithTenant(context, work) {
      if (closed) throw new Error('CASE01_SETUP_CLOSED');
      assertConfiguration();
      const ctx = structuredClone(context);
      assertContext(ctx);
      if (typeof work !== 'function') throw new Error('CASE01_SETUP_WORK_REQUIRED');
      // Operator entry resolves the ordinary actor from the database. Canonical
      // commands still recheck their current memberships/walls in each write.
      await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => assertActorInTx(tx, ctx));
      return runWithMemoryGovernanceTenant(ctx.tenantId, () => tenantContext.run(ctx, work));
    }

    async function createConversation(context, input) {
      if (closed) throw new Error('CASE01_SETUP_CLOSED');
      assertConfiguration();
      const ctx = structuredClone(context);
      const args = structuredClone(input);
      assertContext(ctx);
      if (
        !args ||
        Object.keys(args).sort().join(',') !== 'clientId,title' ||
        !UUID.test(args.clientId ?? '') ||
        typeof args.title !== 'string' ||
        !args.title.startsWith(`${NAMESPACE} case01 `) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          args.title.slice(`${NAMESPACE} case01 `.length),
        )
      )
        throw new Error('CASE01_SETUP_CONVERSATION_SCOPE_INVALID');

      return tenantContext.run(ctx, () =>
        prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
          await assertActorInTx(tx, ctx);
          const clients = await tx.$queryRaw`
          SELECT id FROM clients WHERE id=${args.clientId}::uuid
            AND tenant_id=${ctx.tenantId}::uuid AND status <> 'archived' FOR UPDATE
        `;
          if (
            clients.length !== 1 ||
            !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, args.clientId))
          )
            throw new Error('CASE01_SETUP_CURRENT_CLIENT_REQUIRED');

          // The real product creation method, including its visibility/profile
          // reads, runs on this same locked transaction. The receiver intentionally
          // has no chat/provider collaborators and cannot accept extra scope keys.
          const receiver = Object.create(MeriService.prototype);
          receiver.prisma = Object.freeze({
            withTenant: (tenantId, work) => {
              if (tenantId !== ctx.tenantId) throw new Error('CASE01_SETUP_TENANT_CHANGED');
              return work(tx);
            },
          });
          const row = await MeriService.prototype.createConversation.call(receiver, ctx, args);
          return {
            id: row.id,
            tenantId: row.tenantId,
            userId: row.userId,
            clientId: row.clientId,
            title: row.title,
          };
        }),
      );
    }
    return Object.freeze({ deps, runWithTenant, createConversation, close });
  } catch (error) {
    await close();
    throw error;
  }
}
