/**
 * Drain the identity outbox — retry Clerk de-provisioning calls that did not
 * land at removal time.
 *
 * Run out-of-band:
 *   aws ecs run-task --cluster capiro-dev \
 *     --task-definition capiro-dev-api-sync-congress \
 *     --overrides '{"containerOverrides":[{"name":"api-migrate","command":["drain-identity-outbox"]}]}'
 *
 * Scheduled every 15 minutes by the EventBridge rule
 * `capiro-dev-drain-identity-outbox`.
 *
 * apps/api has no in-process scheduler (@nestjs/schedule is not a dependency
 * and there are no @Cron usages), and running one in a multi-task service would
 * have every task racing the same rows. This mirrors the existing verb pattern
 * in scripts/entrypoint.sh.
 *
 * NO NEST. Two earlier attempts booted a Nest context and both died before
 * doing any work:
 *   - createApplicationContext(AppModule) instantiates EVERY provider in the
 *     service, and they assume the SERVE task's environment; it crashed in
 *     InsightGeneratorService.
 *   - A minimal module still failed, with ConfigService arriving `undefined` in
 *     the ClerkService constructor — Nest DI does not resolve reliably in this
 *     tsx script context.
 * The dominant pattern in this directory is a direct PrismaClient (127 scripts
 * vs 13 using the app graph). This follows it: construct the two collaborators
 * by hand and reuse the REAL IdentityOutboxService so the retry/backoff/
 * idempotency logic lives in exactly one place.
 *
 * Idempotent and safe to run concurrently: each job is claimed with an atomic
 * conditional UPDATE, so a row can only be processed once.
 *
 * Exits 0 when every due job succeeded, 1 when any remain failed — so a
 * scheduled invocation surfaces as a task failure rather than silent success.
 */
import { createClerkClient } from '@clerk/backend';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { ClerkService } from '../src/auth/clerk.service.js';
import { IdentityOutboxService } from '../src/auth/identity-outbox.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

async function main(): Promise<void> {
  const limitArg = process.argv[2];
  const limit = limitArg ? Number.parseInt(limitArg, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`Invalid limit: ${String(limitArg)}`);
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is required');

  const prisma = new PrismaClient();

  /**
   * Minimal stand-in for PrismaService.withSystem.
   *
   * IdentityOutboxService only ever uses withSystem, and only with raw queries,
   * which bypass the tenant-scope client extension anyway — so a plain
   * transaction that sets the bypass GUC is equivalent here.
   *
   * The GUC is `app.bypass_rls` (NOT `app.rls_bypass`). identity_outbox has
   * FORCE ROW LEVEL SECURITY, and the drain deliberately reaches across
   * tenants, so without this every query would match zero rows — silently.
   */
  const prismaLike = {
    withSystem: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      }),
  } as unknown as PrismaService;

  // IdentityOutboxService only touches `.backend`.
  const clerkLike = { backend: createClerkClient({ secretKey }) } as unknown as ClerkService;

  const outbox = new IdentityOutboxService(prismaLike, clerkLike);

  try {
    const { processed, succeeded } = await outbox.drainPending(limit);
    const failed = processed - succeeded;
    console.log(
      JSON.stringify({
        event: 'identity_outbox.drain',
        processed,
        succeeded,
        failed,
      }),
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('drain-identity-outbox failed:', err);
  process.exit(1);
});
