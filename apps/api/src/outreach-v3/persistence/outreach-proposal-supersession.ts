import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';

interface SupersededProposalIdRow {
  id: string;
}

/**
 * Terminalize every pending proposal that targets a version older than the new
 * current state and return the exact proposal IDs changed by this statement.
 *
 * The caller already holds the owner session row lock. UPDATE ... RETURNING is
 * intentionally used instead of a pre-read + UPDATE so the audit layer receives
 * exactly the rows whose status changed, with no race window or pagination cap.
 */
export async function supersedeStaleOutreachProposals(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  sessionId: string,
  currentStateVersion: number,
  excludeProposalId: string | null = null,
): Promise<string[]> {
  const rows = excludeProposalId
    ? await tx.$queryRaw<SupersededProposalIdRow[]>`
        UPDATE outreach_command_proposals
        SET status = 'superseded',
            decided_at = NOW(),
            rejection_code = 'state_advanced'
        WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND session_id = CAST(${sessionId} AS uuid)
          AND created_by_user_id = CAST(${ctx.userId} AS uuid)
          AND status = 'pending'
          AND expected_state_version < ${currentStateVersion}
          AND id <> CAST(${excludeProposalId} AS uuid)
        RETURNING id::text AS id
      `
    : await tx.$queryRaw<SupersededProposalIdRow[]>`
        UPDATE outreach_command_proposals
        SET status = 'superseded',
            decided_at = NOW(),
            rejection_code = 'state_advanced'
        WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND session_id = CAST(${sessionId} AS uuid)
          AND created_by_user_id = CAST(${ctx.userId} AS uuid)
          AND status = 'pending'
          AND expected_state_version < ${currentStateVersion}
        RETURNING id::text AS id
      `;

  return rows.map((row) => row.id);
}
