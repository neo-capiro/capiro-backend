import { clientMemoryAllowed, type ResourceScopeTransaction } from './client-memory-wall.js';
import { tenantFeatureEnabled } from './tenant-feature.js';

export type ProspectResourceActor = { userId: string } | { clerkUserId: string };
export interface ProspectResourceScope {
  tenantId: string;
  prospectId: string;
  userId: string;
  clerkUserId: string;
  linkedClientId: string | null;
}

/** Additional resource restriction, never a substitute for a file/draft ACL.
 * The caller MUST supply a tenant-scoped transaction. SHARE locks keep current
 * identity, entitlement, conversion and grant decisions valid through a write.
 * Read-only callers also use short transactions; never hold them over providers.
 * Dismissed/archived history can be read, but cannot acquire new content/edits.
 */
export async function prospectResourceScope(
  tx: ResourceScopeTransaction,
  tenantId: string,
  actor: ProspectResourceActor,
  prospectId: string,
  mode: 'read' | 'write' = 'read',
): Promise<ProspectResourceScope | null> {
  const [prospect] = await tx.$queryRawUnsafe<
    Array<{
      linkedClientId: string | null;
      status: string;
      dismissedAt: Date | null;
    }>
  >(
    `SELECT linked_client_id::text AS "linkedClientId",status,dismissed_at AS "dismissedAt"
     FROM business_development_prospects WHERE tenant_id=$1::uuid AND id=$2::uuid FOR SHARE`,
    tenantId,
    prospectId,
  );
  if (!prospect || (mode === 'write' && (prospect.status !== 'active' || prospect.dismissedAt)))
    return null;
  const [tenant] = await tx.$queryRawUnsafe<Array<{ settings: unknown }>>(
    `SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid AND status::text='active' FOR SHARE`,
    tenantId,
  );
  if (!tenant || !tenantFeatureEnabled(tenant.settings, 'businessDevelopment.enabled', false))
    return null;
  const [member] = await tx.$queryRawUnsafe<Array<{ userId: string; clerkUserId: string }>>(
    `SELECT u.id::text AS "userId", u.clerk_user_id AS "clerkUserId"
     FROM tenant_memberships m JOIN users u ON u.id=m.user_id
     WHERE m.tenant_id=$1::uuid AND m.status::text='active'
       AND m.role::text IN ('standard_user','user_admin','capiro_admin')
       AND (($2::uuid IS NOT NULL AND u.id=$2::uuid) OR ($3::text IS NOT NULL AND u.clerk_user_id=$3))
     FOR SHARE OF m,u`,
    tenantId,
    'userId' in actor ? actor.userId : null,
    'clerkUserId' in actor ? actor.clerkUserId : null,
  );
  if (!member) return null;
  await tx.$queryRawUnsafe(`SELECT set_config('app.current_user',$1,true)`, member.userId);
  if (prospect.linkedClientId) {
    const [client] = await tx.$queryRawUnsafe<Array<{ status: string; memoryWall: boolean }>>(
      `SELECT status,memory_wall AS "memoryWall" FROM clients
       WHERE tenant_id=$1::uuid AND id=$2::uuid FOR SHARE`,
      tenantId,
      prospect.linkedClientId,
    );
    if (!client || (mode === 'write' && client.status === 'archived')) return null;
    if (client.memoryWall) {
      // Lock the actual live grant before evaluating the canonical wall reader.
      // Revocation DELETE and wall updates must wait for the resource transaction.
      const grants = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM client_memory_access WHERE tenant_id=$1::uuid
         AND client_id=$2::uuid AND user_id=$3::uuid FOR SHARE`,
        tenantId,
        prospect.linkedClientId,
        member.userId,
      );
      if (!grants.length) return null;
    }
    if (!(await clientMemoryAllowed(tx, tenantId, member.userId, prospect.linkedClientId)))
      return null;
  }
  return { tenantId, prospectId, ...member, linkedClientId: prospect.linkedClientId };
}
