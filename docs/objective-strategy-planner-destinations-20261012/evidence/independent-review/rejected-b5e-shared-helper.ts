/** Canonical Core Objective revision authority, reused inside each owner's transaction. */
export interface ClientObjectiveDestinationInput {
  clientId: string;
  objectiveId: string;
  objectiveVersion: number;
}

export interface ClientObjectiveRevisionBinding extends ClientObjectiveDestinationInput {
  objectiveRevisionId: string;
}

export interface ClientObjectiveDestinationActor {
  tenantId: string;
  clerkUserId: string;
  /** Core callers additionally pin their already-resolved UUID; Clerk subjects are never cast. */
  userId?: string;
}

export interface ClientObjectiveDestinationTx {
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export class ClientObjectiveDestinationError extends Error {
  constructor(
    readonly code:
      | 'OBJECTIVE_DESTINATION_INVALID'
      | 'OBJECTIVE_DESTINATION_NOT_FOUND'
      | 'OBJECTIVE_VERSION_CONFLICT',
  ) {
    super(code);
  }
}

export function normalizeClientObjectiveDestination(
  input: ClientObjectiveDestinationInput,
): ClientObjectiveDestinationInput {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !input ||
    !uuid.test(input.clientId) ||
    !uuid.test(input.objectiveId) ||
    !Number.isInteger(input.objectiveVersion) ||
    input.objectiveVersion < 1 ||
    input.objectiveVersion > 2147483647
  ) {
    throw new ClientObjectiveDestinationError('OBJECTIVE_DESTINATION_INVALID');
  }
  return {
    clientId: input.clientId.toLowerCase(),
    objectiveId: input.objectiveId.toLowerCase(),
    objectiveVersion: input.objectiveVersion,
  };
}

export async function requireClientObjectiveDestinationRevision(
  tx: ClientObjectiveDestinationTx,
  actor: ClientObjectiveDestinationActor,
  input: ClientObjectiveDestinationInput,
): Promise<ClientObjectiveRevisionBinding> {
  const binding = normalizeClientObjectiveDestination(input);
  // This is the existing Objective owner's authority policy. Resolve the Clerk
  // actor to the current member's Core UUID inside the same locked tenant query.
  const scope = await tx.$queryRaw<Array<{ userId: string; memoryWall: boolean }>>`
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
  if (!member) throw new ClientObjectiveDestinationError('OBJECTIVE_DESTINATION_NOT_FOUND');
  if (member.memoryWall) {
    const grants = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM client_memory_access
      WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${binding.clientId}::uuid
        AND user_id=${actor.userId ?? member.userId}::uuid FOR SHARE
    `;
    if (!grants[0]) throw new ClientObjectiveDestinationError('OBJECTIVE_DESTINATION_NOT_FOUND');
  }
  const objectives = await tx.$queryRaw<Array<{ version: number }>>`
    SELECT version FROM client_objectives
    WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${binding.clientId}::uuid
      AND id=${binding.objectiveId}::uuid AND deleted_at IS NULL FOR SHARE
  `;
  if (!objectives[0]) throw new ClientObjectiveDestinationError('OBJECTIVE_DESTINATION_NOT_FOUND');
  if (objectives[0].version !== binding.objectiveVersion)
    throw new ClientObjectiveDestinationError('OBJECTIVE_VERSION_CONFLICT');
  const revisions = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM client_objective_revisions
    WHERE tenant_id=${actor.tenantId}::uuid AND client_id=${binding.clientId}::uuid
      AND objective_id=${binding.objectiveId}::uuid AND version=${binding.objectiveVersion}
  `;
  if (!revisions[0]) throw new ClientObjectiveDestinationError('OBJECTIVE_DESTINATION_NOT_FOUND');
  return { ...binding, objectiveRevisionId: revisions[0].id };
}
