import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerClient } from './client-ordered-owner.access.js';

type ActivityCounts = {
  recordedActivities: number;
  openRequests: number;
  overdueRequests: number;
  openCommitments: number;
  overdueCommitments: number;
};

/** Aggregate the canonical saved CRM rows, never a capped/derived timeline page.
 * All five counts share one statement snapshot and the same current client wall.
 * No join can multiply a row. Meetings, mail, attachments and Planner are separate
 * owners and deliberately do not become engagement touches or deadlines here. */
export function readClientActivityMetrics(
  prisma: PrismaService,
  ctx: TenantContext,
  clientId: string,
  clock: () => Date = () => new Date(),
) {
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
    const observedAt = clock();
    const start = new Date(observedAt.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [counts] = await tx.$queryRaw<ActivityCounts[]>`
      SELECT
        (COUNT(*) FILTER (WHERE occurred_at >= ${start} AND occurred_at <= ${observedAt}))::int AS "recordedActivities",
        (COUNT(*) FILTER (WHERE kind='request' AND settled_at IS NULL))::int AS "openRequests",
        (COUNT(*) FILTER (WHERE kind='request' AND settled_at IS NULL AND due_at < ${observedAt}))::int AS "overdueRequests",
        (COUNT(*) FILTER (WHERE kind='commitment' AND settled_at IS NULL))::int AS "openCommitments",
        (COUNT(*) FILTER (WHERE kind='commitment' AND settled_at IS NULL AND due_at < ${observedAt}))::int AS "overdueCommitments"
      FROM client_activity WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${clientId}::uuid`;
    if (!counts) throw new Error('Activity aggregate unavailable');
    return {
      definition: 'client-recorded-activity-v1' as const,
      tenantId: ctx.tenantId,
      clientId,
      observedAt: observedAt.toISOString(),
      window: {
        start: start.toISOString(),
        end: observedAt.toISOString(),
        timezone: 'UTC' as const,
      },
      coverage: 'complete' as const,
      counts,
    };
  });
}
