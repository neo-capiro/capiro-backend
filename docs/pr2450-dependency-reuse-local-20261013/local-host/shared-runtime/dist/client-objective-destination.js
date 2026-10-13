"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClientObjectiveDestinationError = void 0;
exports.normalizeClientObjectiveDestination = normalizeClientObjectiveDestination;
exports.requireClientObjectiveDestinationRevision = requireClientObjectiveDestinationRevision;
class ClientObjectiveDestinationError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
exports.ClientObjectiveDestinationError = ClientObjectiveDestinationError;
function normalizeClientObjectiveDestination(input) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!input ||
        typeof input.clientId !== 'string' ||
        typeof input.objectiveId !== 'string' ||
        !uuid.test(input.clientId) ||
        !uuid.test(input.objectiveId) ||
        !Number.isInteger(input.objectiveVersion) ||
        input.objectiveVersion < 1 ||
        input.objectiveVersion > 2147483647) {
        throw new ClientObjectiveDestinationError('OBJECTIVE_DESTINATION_INVALID');
    }
    return {
        clientId: input.clientId.toLowerCase(),
        objectiveId: input.objectiveId.toLowerCase(),
        objectiveVersion: input.objectiveVersion,
    };
}
async function requireClientObjectiveDestinationRevision(tx, actor, input) {
    const binding = normalizeClientObjectiveDestination(input);
    // This is the existing Objective owner's authority policy. Resolve the Clerk
    // actor to the current member's Core UUID inside the same locked tenant query.
    const scope = await tx.$queryRaw `
    SELECT m.user_id::text AS "userId", c.memory_wall AS "memoryWall"
    FROM tenants t
    JOIN tenant_memberships m ON m.tenant_id=t.id
    JOIN users u ON u.id=m.user_id
    JOIN clients c ON c.tenant_id=t.id
    WHERE t.id=${actor.tenantId}::uuid AND t.status::text='active'
      AND m.user_id=COALESCE(${actor.userId ?? null}::uuid,u.id) AND m.status::text='active'
      AND m.role::text IN ('standard_user','user_admin','capiro_admin')
      AND u.clerk_user_id=${actor.clerkUserId}
      AND c.id=${binding.clientId}::uuid AND c.status::text<>'archived'
    FOR SHARE OF t,m,u,c
  `;
    const member = scope[0];
    if (!member)
        throw new ClientObjectiveDestinationError('OBJECTIVE_DESTINATION_NOT_FOUND');
    if (member.memoryWall) {
        const grants = await tx.$queryRaw `
      SELECT id FROM client_memory_access
      WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${binding.clientId}::uuid
        AND user_id=${actor.userId ?? member.userId}::uuid FOR SHARE
    `;
        if (!grants[0])
            throw new ClientObjectiveDestinationError('OBJECTIVE_DESTINATION_NOT_FOUND');
    }
    const objectives = await tx.$queryRaw `
    SELECT version FROM client_objectives
    WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${binding.clientId}::uuid
      AND id=${binding.objectiveId}::uuid AND deleted_at IS NULL FOR SHARE
  `;
    if (!objectives[0])
        throw new ClientObjectiveDestinationError('OBJECTIVE_DESTINATION_NOT_FOUND');
    if (objectives[0].version !== binding.objectiveVersion)
        throw new ClientObjectiveDestinationError('OBJECTIVE_VERSION_CONFLICT');
    const revisions = await tx.$queryRaw `
    SELECT id FROM client_objective_revisions
    WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${binding.clientId}::uuid
      AND objective_id=${binding.objectiveId}::uuid AND version=${binding.objectiveVersion}
  `;
    if (!revisions[0])
        throw new ClientObjectiveDestinationError('OBJECTIVE_DESTINATION_NOT_FOUND');
    return { ...binding, objectiveRevisionId: revisions[0].id };
}
//# sourceMappingURL=client-objective-destination.js.map