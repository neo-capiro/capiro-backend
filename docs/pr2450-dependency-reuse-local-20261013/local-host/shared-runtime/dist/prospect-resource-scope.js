"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prospectResourceScope = prospectResourceScope;
const client_memory_wall_js_1 = require("./client-memory-wall.js");
const tenant_feature_js_1 = require("./tenant-feature.js");
/** Additional resource restriction, never a substitute for a file/draft ACL.
 * The caller MUST supply a tenant-scoped transaction. SHARE locks keep current
 * identity, entitlement, conversion and grant decisions valid through a write.
 * Read-only callers also use short transactions; never hold them over providers.
 * Dismissed/archived history can be read, but cannot acquire new content/edits.
 */
async function prospectResourceScope(tx, tenantId, actor, prospectId, mode = 'read') {
    const [prospect] = await tx.$queryRawUnsafe(`SELECT linked_client_id::text AS "linkedClientId",status,dismissed_at AS "dismissedAt"
     FROM business_development_prospects WHERE tenant_id=$1::uuid AND id=$2::uuid FOR SHARE`, tenantId, prospectId);
    if (!prospect || (mode === 'write' && (prospect.status !== 'active' || prospect.dismissedAt)))
        return null;
    const [tenant] = await tx.$queryRawUnsafe(`SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid AND status::text='active' FOR SHARE`, tenantId);
    if (!tenant || !(0, tenant_feature_js_1.tenantFeatureEnabled)(tenant.settings, 'businessDevelopment.enabled', false))
        return null;
    const [member] = await tx.$queryRawUnsafe(`SELECT u.id::text AS "userId", u.clerk_user_id AS "clerkUserId"
     FROM tenant_memberships m JOIN users u ON u.id=m.user_id
     WHERE m.tenant_id=$1::uuid AND m.status::text='active'
       AND m.role::text IN ('standard_user','user_admin','capiro_admin')
       AND (($2::uuid IS NOT NULL AND u.id=$2::uuid) OR ($3::text IS NOT NULL AND u.clerk_user_id=$3))
     FOR SHARE OF m,u`, tenantId, 'userId' in actor ? actor.userId : null, 'clerkUserId' in actor ? actor.clerkUserId : null);
    if (!member)
        return null;
    await tx.$queryRawUnsafe(`SELECT set_config('app.current_user',$1,true)`, member.userId);
    if (prospect.linkedClientId) {
        const [client] = await tx.$queryRawUnsafe(`SELECT status,memory_wall AS "memoryWall" FROM clients
       WHERE tenant_id=$1::uuid AND id=$2::uuid FOR SHARE`, tenantId, prospect.linkedClientId);
        if (!client || (mode === 'write' && client.status === 'archived'))
            return null;
        if (client.memoryWall) {
            // Lock the actual live grant before evaluating the canonical wall reader.
            // Revocation DELETE and wall updates must wait for the resource transaction.
            const grants = await tx.$queryRawUnsafe(`SELECT id FROM client_memory_access WHERE tenant_id=$1::uuid
         AND client_id=$2::uuid AND user_id=$3::uuid FOR SHARE`, tenantId, prospect.linkedClientId, member.userId);
            if (!grants.length)
                return null;
        }
        if (!(await (0, client_memory_wall_js_1.clientMemoryAllowed)(tx, tenantId, member.userId, prospect.linkedClientId)))
            return null;
    }
    return { tenantId, prospectId, ...member, linkedClientId: prospect.linkedClientId };
}
//# sourceMappingURL=prospect-resource-scope.js.map