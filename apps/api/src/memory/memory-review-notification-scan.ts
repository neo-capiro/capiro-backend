import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';

interface UnreadNotificationIdentity {
  id: string;
  candidateId: string;
}

/** Bounded pages, not a bounded population. Both aggregate callers authorize
 * every candidate through the existing policy within their transaction. The
 * durable UUID cursor avoids rounding database timestamps to JS milliseconds. */
export async function* unreadMemoryNotificationPages(
  tx: Prisma.TransactionClient,
  ctx: Pick<TenantContext, 'tenantId' | 'userId'>,
): AsyncGenerator<UnreadNotificationIdentity[]> {
  const pageSize = 200;
  let after: string | null = null;
  while (true) {
    const rows: UnreadNotificationIdentity[] = await tx.$queryRaw(Prisma.sql`
      SELECT notification.id::text AS id, notification.candidate_id::text AS "candidateId"
      FROM memory_review_in_app_notification notification
      WHERE notification.tenant_id = ${ctx.tenantId}::uuid
        AND notification.recipient_user_id = ${ctx.userId}::uuid
        AND notification.read_at IS NULL
        ${after ? Prisma.sql`AND notification.id > ${after}::uuid` : Prisma.empty}
      ORDER BY notification.id ASC
      LIMIT ${pageSize}
    `);
    if (rows.length === 0) return;
    yield rows;
    after = rows[rows.length - 1]!.id;
    if (rows.length < pageSize) return;
  }
}
