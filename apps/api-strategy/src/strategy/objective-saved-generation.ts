import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { UUID } from '../meri/objective-generation.types.js';
import {
  normalizeObjectiveDestination,
  type ObjectiveDestinationQueryDto,
} from './objective-destination.js';
import { readObjectiveSavedReview } from './objective-saved-review.js';

/** Discover a current-revision, actor-owned canonical result, never a reserved
 * output or mutable Strategy head. Candidate metadata is only a routing hint:
 * the existing exact reader must reconstruct custody and check current access
 * before any selector leaves this owner. No cross-actor discovery is implied.
 * Two matching jobs are uncertainty; ordering never chooses a winner. */
export async function readObjectiveSavedGeneration(
  tx: Prisma.TransactionClient,
  ctx: AuthTenantContext,
  input: ObjectiveDestinationQueryDto,
) {
  const binding = normalizeObjectiveDestination(input);
  const candidates = await tx.$queryRaw<
    Array<{
      generationJobId: string;
      strategyId: string;
      strategyVersionId: string;
    }>
  >`SELECT id::text AS "generationJobId",
      input#>>'{objectiveGeneration,receipt,result,strategyId}' AS "strategyId",
      input#>>'{objectiveGeneration,receipt,result,strategyVersionId}' AS "strategyVersionId"
    FROM sp_draft_job
    WHERE tenant_id=${ctx.tenantId}::uuid AND owner_user_id=${ctx.clerkUserId}
      AND client_id=${binding.clientId}::uuid AND status='completed'
      AND input ? 'canonicalGeneration'
      AND input#>>'{objectiveGeneration,receipt,source,clientId}'=${binding.clientId}
      AND input#>>'{objectiveGeneration,receipt,source,objectiveId}'=${binding.objectiveId}
      AND input#>>'{objectiveGeneration,receipt,source,objectiveVersion}'=${String(binding.objectiveVersion)}
    ORDER BY id LIMIT 2`;
  if (candidates.length > 1)
    throw new ServiceUnavailableException(
      'The saved generation could not be selected. Retry this read.',
    );
  const candidate = candidates[0];
  if (
    !candidate ||
    ![candidate.generationJobId, candidate.strategyId, candidate.strategyVersionId].every(
      (value) => typeof value === 'string' && UUID.test(value),
    )
  )
    throw new NotFoundException('Saved Strategy unavailable');
  const saved = await readObjectiveSavedReview(tx, ctx, candidate.strategyId, {
    ...binding,
    generationJobId: candidate.generationJobId,
    strategyVersionId: candidate.strategyVersionId,
  });
  return {
    selection: {
      query: binding,
      ids: {
        strategyId: saved.source.strategyId,
        strategyVersionId: saved.source.strategyVersionId,
        generatedJobId: saved.source.generationJobId,
      },
    },
    objectiveRevisionId: saved.source.objectiveRevisionId,
    savedAt: saved.savedAt,
  };
}
