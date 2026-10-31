import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';

/** Shared personal-owner predicate. Caller joins clients as c and memory_items as mi. */
export function ownerMemoryAccessSql(ctx: TenantContext, visibleClientIds?: readonly string[]) {
  const previewRoster = visibleClientIds === undefined ? null : JSON.stringify(visibleClientIds);
  return Prisma.sql`mi.tenant_id = ${ctx.tenantId}::uuid
          AND mi.owner_user_id = ${ctx.userId}::uuid
          AND mi.memory_scope = 'user_private'
          AND mi.visibility = 'user'
          AND (${previewRoster}::jsonb IS NULL OR mi.client_id IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${previewRoster}::jsonb) AS preview_client(id)
            WHERE preview_client.id = mi.client_id::text
          ))
          AND (
            mi.client_id IS NULL OR (
              c.id IS NOT NULL AND c.status::text = 'active'
              AND (NOT c.memory_wall OR EXISTS (
                SELECT 1 FROM client_memory_access wall_grant
                WHERE wall_grant.tenant_id = c.tenant_id
                  AND wall_grant.client_id = c.id
                  AND wall_grant.user_id = ${ctx.userId}::uuid
              ))
            )
          )
          AND mi.legal_hold IS FALSE`;
}
