import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { CanonicalRequestOwner } from './objective-canonical-request.js';
import { CanonicalApplicationError } from '../planner/objective-canonical-application.js';

/** The same active tenant-member owner policy as MeriService.resolveOwnerNames.
 * Called only inside an already authorized publication transaction. Rows are
 * locked for the short final publication, never during context/network work.
 * No caller-supplied ID, display name or implicit default directory is used. */
@Injectable()
export class ObjectiveCanonicalOwnerDirectory {
  async read(tx: Prisma.TransactionClient, tenantId: string): Promise<CanonicalRequestOwner[]> {
    const rows = await tx.$queryRaw<Array<{ clerkUserId: string }>>`
      SELECT u.clerk_user_id AS "clerkUserId"
      FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id
      WHERE tm.tenant_id=${tenantId}::uuid AND tm.status::text='active'
        AND u.clerk_user_id IS NOT NULL
      ORDER BY u.clerk_user_id,u.id FOR SHARE OF tm,u`;
    const seen = new Set<string>();
    return rows.map(row => {
      if (typeof row.clerkUserId !== 'string' || !row.clerkUserId || row.clerkUserId.length > 128 || seen.has(row.clerkUserId))
        throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
      seen.add(row.clerkUserId);
      return { ownerRef: row.clerkUserId, clerkUserId: row.clerkUserId };
    });
  }
}
