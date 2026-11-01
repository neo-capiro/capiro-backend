import { objectiveIntentFromSnapshot, parseObjectiveGenerationIntent } from '@capiro/shared/strategy-intake';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { requireObjectiveDestinationRevision } from '../strategy/objective-destination.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import type { Prisma } from '../../generated/prisma-client/index.js';
import {
  digest,
  type ObjectiveDraftRequest,
  type ObjectiveIntent,
  type ObjectiveSource,
} from './objective-generation.types.js';

export async function admitObjective(
  tx: Prisma.TransactionClient,
  actor: Pick<AuthTenantContext, 'tenantId' | 'clerkUserId'>,
  request: ObjectiveDraftRequest,
): Promise<{ source: ObjectiveSource; intent: ObjectiveIntent; sourceDigest: string }> {
  const source = await requireObjectiveDestinationRevision(tx, actor as AuthTenantContext, {
    clientId: request.clientId,
    ...request.objective,
  });
  const rows = await tx.$queryRaw<Array<{ snapshot: any }>>`
    SELECT snapshot FROM client_objective_revisions
    WHERE id=${source.objectiveRevisionId}::uuid AND tenant_id=${actor.tenantId}::uuid
      AND client_id=${source.clientId}::uuid AND objective_id=${source.objectiveId}::uuid
      AND version=${source.objectiveVersion}`;
  const snapshot = rows[0]?.snapshot;
  if (
    !snapshot ||
    snapshot.id !== source.objectiveId ||
    snapshot.clientId !== source.clientId ||
    snapshot.version !== source.objectiveVersion
  )
    throw new NotFoundException('Objective generation not found');
  let intent: ObjectiveIntent;
  try {
    if (snapshot.status !== 'ready' || snapshot.deletedAt != null) throw new Error();
    intent = parseObjectiveGenerationIntent(objectiveIntentFromSnapshot(snapshot));
    if ('kind' in intent) {
      if (intent.strategyIntake.type !== request.type) throw new Error();
      const owners = await tx.$queryRaw<Array<{ userId: string }>>`
        SELECT u.id::text AS "userId" FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id
        WHERE tm.tenant_id=${actor.tenantId}::uuid AND tm.status::text='active'
          AND u.clerk_user_id=${intent.strategyIntake.ownerUserId}`;
      if (owners.length !== 1 || owners[0]!.userId !== snapshot.ownerUserId) throw new Error();
    }
  } catch { throw new BadRequestException('Objective must be ready and complete before generating'); }

  return { source, intent, sourceDigest: digest({ source, intent }) };
}
