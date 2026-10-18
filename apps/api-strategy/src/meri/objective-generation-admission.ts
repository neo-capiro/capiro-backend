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
  const limits: Record<string, number> = {
    outcome: 2000,
    governmentProblem: 4000,
    minimumWin: 2000,
    limits: 4000,
  };
  if (
    snapshot.status !== 'ready' ||
    snapshot.deletedAt != null ||
    Object.entries(limits).some(
      ([k, max]) =>
        typeof snapshot[k] !== 'string' ||
        snapshot[k].length > max ||
        (k !== 'limits' && !snapshot[k].trim()),
    ) ||
    !['funding', 'policy_authority', 'both', 'protect_funding', 'meri_propose'].includes(
      snapshot.askType,
    )
  )
    throw new BadRequestException('Objective must be ready and complete before generating');
  const intent: ObjectiveIntent = {
    outcome: snapshot.outcome,
    governmentProblem: snapshot.governmentProblem,
    askType: snapshot.askType,
    minimumWin: snapshot.minimumWin,
    limits: snapshot.limits,
  };
  return { source, intent, sourceDigest: digest({ source, intent }) };
}
