/**
 * Drain durable governed-memory projection work.
 *
 * This is an out-of-band, lease-based worker. EventBridge starts one short-lived
 * ECS task; concurrent invocations are safe because claims use FOR UPDATE SKIP
 * LOCKED and an opaque expiring lease. Projection and Bedrock embedding work occur
 * after the claim transaction commits.
 *
 * Usage:
 *   drain-memory-cleanup-outbox [batch-size] [lease-seconds]
 *
 * Exits non-zero when any job failed or reached dead-letter so EventBridge/ECS and
 * CloudWatch surface the run instead of treating a partial drain as healthy.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { ExactMemoryProjectionWorkerService } from '../src/memory/exact-memory-projection-worker.service.js';
import { MemoryStoreService } from '../src/memory/memory-store.service.js';
import { StrictMemoryProjectorService } from '../src/memory/strict-memory-projector.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { TenantContextStore } from '../src/tenant/tenant-context.store.js';

function positiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${label}`);
  return value;
}

async function main(): Promise<void> {
  const limit = positiveInteger(process.argv[2], 200, 'batch size');
  const leaseSeconds = positiveInteger(process.argv[3], 300, 'lease seconds');
  const prisma = new PrismaClient();

  // The worker deliberately spans tenants, so every DB unit runs in its own
  // transaction with the exact FORCE-RLS bypass GUC used by trusted ingestion.
  // Object.assign retains PrismaClient's real raw-query methods for embeddings.
  const prismaLike = Object.assign(prisma, {
    withSystem: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      }),
  }) as unknown as PrismaService;

  const tenantContext = new TenantContextStore();
  const store = new MemoryStoreService(prismaLike, tenantContext);
  const projector = new StrictMemoryProjectorService(prismaLike, store);
  const worker = new ExactMemoryProjectionWorkerService(prismaLike, projector);

  try {
    const summary = await worker.drainPending(limit, leaseSeconds);
    console.log(JSON.stringify({ event: 'memory_projection_worker.drain', ...summary }));
    if (summary.failed > 0 || summary.deadLettered > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : 'WorkerError';
  console.error(JSON.stringify({ event: 'memory_projection_worker.crashed', error_code: errorName }));
  process.exit(1);
});
