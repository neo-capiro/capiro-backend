import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerActor } from './client-ordered-owner.access.js';

type Group<T> =
  { status: 'available'; coverage: 'complete'; counts: T } | { status: 'unavailable' };
type ClientCounts = { activeClients: number };
type ObjectiveCounts = { objectives: number; awaitingReview: number; ready: number };
type ActivityCounts = {
  recordedActivities: number;
  overdueRequests: number;
  overdueCommitments: number;
};
type WatchCounts = {
  activeClients: number;
  clientsWithWatches: number;
  clientBillWatches: number;
  distinctBills: number;
};

/** One visibility predicate per statement, with no roster/page cap and no joins
 * that can multiply counted source rows. Each source has its own transaction:
 * a missing/unavailable owner cannot replace another owner's count with zero. */
export async function readPortfolioMetrics(
  prisma: PrismaService,
  ctx: TenantContext,
  clock: () => Date = () => new Date(),
) {
  const current = () =>
    prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      requireOwnerActor(tx, ctx, false, true),
    );
  await current();
  const now = clock(),
    start = new Date(now.getTime() - 30 * 86400000);
  const visible = Prisma.sql`SELECT c.id FROM clients c WHERE c.tenant_id=${ctx.tenantId}::uuid
    AND c.status='active' AND upper(trim(coalesce(c.profile_type,'CLIENT')))<>'PROSPECT'
    AND (NOT c.memory_wall OR EXISTS (SELECT 1 FROM client_memory_access a
      WHERE a.tenant_id=c.tenant_id AND a.client_id=c.id AND a.user_id=${ctx.userId}::uuid))`;
  const group = async <T>(sql: Prisma.Sql): Promise<Group<T>> => {
    try {
      return await prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        await requireOwnerActor(tx, ctx, false, true);
        const rows = await tx.$queryRaw<T[]>(sql);
        if (!rows[0]) throw Error('Missing aggregate');
        return { status: 'available', coverage: 'complete', counts: rows[0] };
      });
    } catch {
      return { status: 'unavailable' };
    }
  };
  const [clients, objectives, activity, billWatch] = await Promise.all([
    group<ClientCounts>(
      Prisma.sql`WITH visible AS (${visible}) SELECT count(*)::int AS "activeClients" FROM visible`,
    ),
    group<ObjectiveCounts>(Prisma.sql`WITH visible AS (${visible}) SELECT count(*)::int AS objectives,
      (count(*) FILTER (WHERE status='in_review'))::int AS "awaitingReview",
      (count(*) FILTER (WHERE status='ready'))::int AS ready
      FROM client_objectives WHERE tenant_id=${ctx.tenantId}::uuid AND client_id IN (SELECT id FROM visible)
        AND deleted_at IS NULL AND status IN ('draft','in_review','ready')`),
    group<ActivityCounts>(Prisma.sql`WITH visible AS (${visible}) SELECT
      (count(*) FILTER (WHERE occurred_at>=${start} AND occurred_at<=${now}))::int AS "recordedActivities",
      (count(*) FILTER (WHERE kind='request' AND settled_at IS NULL AND due_at<${now}))::int AS "overdueRequests",
      (count(*) FILTER (WHERE kind='commitment' AND settled_at IS NULL AND due_at<${now}))::int AS "overdueCommitments"
      FROM client_activity WHERE tenant_id=${ctx.tenantId}::uuid AND client_id IN (SELECT id FROM visible)`),
    group<WatchCounts>(Prisma.sql`WITH visible AS (${visible}) SELECT
      (SELECT count(*)::int FROM visible) AS "activeClients", count(DISTINCT client_id)::int AS "clientsWithWatches",
      count(DISTINCT (client_id,bill_id))::int AS "clientBillWatches", count(DISTINCT bill_id)::int AS "distinctBills"
      FROM tracked_bill WHERE tenant_id=${ctx.tenantId}::uuid AND client_id IN (SELECT id FROM visible)`),
  ]);
  // Do not release even aggregates after the original account loses authority.
  await current();
  return {
    definition: 'portfolio-recorded-baseline-v1' as const,
    tenantId: ctx.tenantId,
    observedAt: now.toISOString(),
    activityWindow: {
      start: start.toISOString(),
      end: now.toISOString(),
      timezone: 'UTC' as const,
    },
    clients,
    objectives,
    activity,
    billWatch,
  };
}
