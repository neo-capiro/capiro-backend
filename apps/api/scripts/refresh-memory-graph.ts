/**
 * Refresh the institutional-memory knowledge graph for one or all tenants.
 *
 *   pnpm --filter @capiro/api refresh:memory-graph -- --tenant=<slug-or-uuid>   # one tenant
 *   pnpm --filter @capiro/api refresh:memory-graph -- --all-tenants            # every tenant
 *
 * This is Gap 3 (live/incremental freshness) implemented the same way the other
 * recurring jobs run: a standalone script wired to an ECS scheduled task. It
 * drives the PRODUCTION MemoryIngestService.backfillCurrentTenant() (same
 * projection + embedding logic as the in-app "Populate graph" button), so the
 * graph picks up new clients, memories, meetings, email threads, and Meri
 * sessions without anyone clicking Populate. Idempotent (stable slugs +
 * content-hash embedding skip), so frequent runs are cheap.
 *
 * Requires DATABASE_URL; embedding additionally needs Bedrock Titan access
 * (the embedding pass fails open — logged, never fatal).
 *
 * No-Nest-container pattern: services are instantiated manually around
 * PrismaService (mirrors backfill-client-kb.ts) so the script can never drift
 * from the live ingester. Tenant context is supplied via TenantContextStore.run.
 */
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TenantContextStore } from '../src/tenant/tenant-context.store.js';
import { MemoryStoreService } from '../src/memory/memory-store.service.js';
import { MemoryIngestService } from '../src/memory/memory-ingest.service.js';
import type { TenantContext } from '@capiro/shared';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const i = process.argv.indexOf(`--${name}`);
  const next = i >= 0 ? process.argv[i + 1] : undefined;
  return next && !next.startsWith('--') ? next : undefined;
}

const ALL_TENANTS = flag('all-tenants');
const TENANT_ARG = arg('tenant');
const SLEEP_MS = 250;

async function main(): Promise<void> {
  const prisma = new PrismaService();
  const tenantCtx = new TenantContextStore();
  const store = new MemoryStoreService(prisma, tenantCtx);
  const ingest = new MemoryIngestService(prisma, store, tenantCtx);

  const tenants = await prisma.withSystem(
    (tx) =>
      tx.$queryRaw<
        Array<{ id: string; slug: string }>
      >`SELECT id, slug FROM tenants ORDER BY created_at ASC`,
  );

  const targets = ALL_TENANTS
    ? tenants
    : tenants.filter((t) => t.id === TENANT_ARG || t.slug === TENANT_ARG);

  if (!targets.length) {
    console.error(
      ALL_TENANTS
        ? 'No tenants found.'
        : `No tenant matched "${TENANT_ARG}". Pass --tenant=<slug|uuid> or --all-tenants.`,
    );
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  // ── G2 ephemeral purge (runs FIRST, before re-projection, so an expired
  // clio_memory row can't be re-projected in the same sweep). Expired working
  // memory is erased outright — no tombstone: unlike forget_memory (a
  // governance action on durable history), expiry is the designed end of
  // task-scoped context, and the RLS expiry predicate already made these rows
  // unreadable to every non-bypass caller. Order: embeddings first (they
  // reference items by source_id), then the projections, then the source rows.
  try {
    const purged = await prisma.withSystem(async (tx) => {
      const embeddings = await tx.$executeRaw`
        DELETE FROM context_embeddings ce
        USING memory_items mi
        WHERE ce.source_type = 'memory_item'
          AND ce.source_id = mi.id::text
          AND mi.expires_at IS NOT NULL AND mi.expires_at <= now()
      `;
      const items = await tx.$executeRaw`
        DELETE FROM memory_items
        WHERE expires_at IS NOT NULL AND expires_at <= now()
      `;
      const clio = await tx.$executeRaw`
        DELETE FROM clio_memory
        WHERE expires_at IS NOT NULL AND expires_at <= now()
      `;
      return { embeddings, items, clio };
    });
    console.log(`[purge] expired ephemeral memory: ${JSON.stringify(purged)}`);
  } catch (err) {
    console.error(`[purge] FAILED (non-fatal): ${(err as Error).message}`);
  }

  for (const t of targets) {
    // System context for the tenant: a refresh job acts as the tenant with an
    // all-zero system user id (the email phase only uses userId as an owner
    // fallback, and firm/tenant items are owner-null anyway).
    const ctx: TenantContext = {
      tenantId: t.id,
      tenantSlug: t.slug,
      userId: '00000000-0000-0000-0000-000000000000',
      clerkUserId: 'system:refresh-memory-graph',
      role: 'capiro_admin',
    };
    try {
      // Phase 6: the nightly pass opens an auditable memory_ingest_run tagged 'cron'.
      const counts = await tenantCtx.run(ctx, () => ingest.backfillCurrentTenant('cron'));
      console.log(`[${t.slug}] ${JSON.stringify(counts)}`);
    } catch (err) {
      console.error(`[${t.slug}] FAILED: ${(err as Error).message}`);
    }
    await sleep(SLEEP_MS);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
