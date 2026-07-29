/**
 * Drain the governed-memory cleanup outbox — remove the SECONDARY projections
 * (context_embeddings rows, clio_memory KV sources) of memory whose recall was
 * already suppressed synchronously by its governed status.
 *
 * Run out-of-band:
 *   aws ecs run-task --cluster capiro-dev \
 *     --task-definition capiro-dev-api-sync-congress \
 *     --overrides '{"containerOverrides":[{"name":"api-migrate","command":["drain-memory-cleanup-outbox"]}]}'
 *
 * Intended to be scheduled the same way as `drain-identity-outbox` (an EventBridge
 * rule). NOTE: no EventBridge rule is created by this branch — this script is
 * runnable but NOT yet scheduled, and it is also inert until
 * 20260729010000_memory_governance_context_v2 is applied (memory_cleanup_outbox
 * does not exist before it).
 *
 * apps/api has no in-process scheduler (@nestjs/schedule is not a dependency and
 * there are zero @Cron usages), and running one in a multi-task service would have
 * every task racing the same rows. This mirrors the existing verb pattern in
 * scripts/entrypoint.sh, and deliberately copies the shape of
 * scripts/drain-identity-outbox.ts rather than importing from
 * apps/api/src/auth (a guardrailed tree).
 *
 * NO NEST — same reasoning drain-identity-outbox documents: booting a Nest context
 * instantiates every provider in the service and they assume the SERVE task's
 * environment. A plain PrismaClient plus a hand-built withSystem stand-in is the
 * dominant pattern in this directory.
 *
 * Idempotent and safe to run concurrently: each job is claimed with an atomic
 * conditional UPDATE, so a row is processed at most once per pass, and the
 * (tenant_id, idempotency_key) unique index makes re-enqueueing a no-op.
 *
 * Exits 0 when nothing failed, 1 when any job failed — so a scheduled invocation
 * surfaces as a task failure rather than silent success.
 */
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { MemoryCleanupOutboxService } from '../src/memory/memory-cleanup-outbox.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

async function main(): Promise<void> {
  const limitArg = process.argv[2];
  const limit = limitArg ? Number.parseInt(limitArg, 10) : 200;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`Invalid limit: ${String(limitArg)}`);
  }

  const prisma = new PrismaClient();

  /**
   * Minimal stand-in for PrismaService.withSystem.
   *
   * MemoryCleanupOutboxService only ever uses withSystem, and only with raw
   * queries, which bypass the tenant-scope client extension anyway.
   *
   * The GUC is `app.bypass_rls` (NOT `app.rls_bypass`). All three governance
   * tables are FORCE ROW LEVEL SECURITY and the drain deliberately reaches across
   * tenants, so without this every query would match zero rows — silently.
   */
  const prismaLike = {
    withSystem: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      }),
  } as unknown as PrismaService;

  const outbox = new MemoryCleanupOutboxService(prismaLike);

  try {
    const summary = await outbox.drainPending(limit);
    console.log(
      JSON.stringify({
        event: 'memory_cleanup_outbox.drain',
        ...summary,
      }),
    );
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('drain-memory-cleanup-outbox failed:', err);
  process.exit(1);
});
