import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import type { MaterializationSource } from '../planner/strategy-materialization.js';
import {
  digest,
  requestKey,
  validObjectiveOutcome,
  type ObjectiveJobEnvelope,
} from '../meri/objective-generation.types.js';
import { requireObjectiveDestinationRevision } from './objective-destination.js';

/** Shared saved-source admission for review and Planner. Caller owns the tx and
 * transport errors. Locks remain job -> Strategy -> exact version -> Core source.
 * This does not grant consent or establish canonical completion custody. */
export async function readObjectiveSavedSource(
  tx: Prisma.TransactionClient,
  ctx: AuthTenantContext,
  selection: {
    generationJobId: string;
    expected: { strategyId: string; strategyVersionId: string; objectiveRevisionId?: string };
  },
  { unavailable, stale }: { unavailable(): never; stale(): never },
) {
  const jobLocks = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM sp_draft_job WHERE tenant_id=${ctx.tenantId}::uuid AND id=${selection.generationJobId}::uuid AND owner_user_id=${ctx.clerkUserId} FOR SHARE`;
  if (!jobLocks[0]) return unavailable();
  const job = await tx.spDraftJob.findFirst({
    where: { tenantId: ctx.tenantId, id: selection.generationJobId, ownerUserId: ctx.clerkUserId },
  });
  const envelope = (job?.input as { objectiveGeneration?: ObjectiveJobEnvelope } | null)
    ?.objectiveGeneration;
  const receipt = envelope?.receipt;
  if (
    !job ||
    !envelope ||
    !envelope.request?.objective ||
    !receipt ||
    !validObjectiveOutcome(receipt, job.status, job.strategyId, job.errorMessage) ||
    job.status !== 'completed' ||
    !receipt.result ||
    envelope.request.requestId !== receipt.requestId ||
    envelope.request.clientId !== receipt.source.clientId ||
    envelope.request.objective.objectiveId !== receipt.source.objectiveId ||
    envelope.request.objective.objectiveVersion !== receipt.source.objectiveVersion ||
    job.clientId !== receipt.source.clientId ||
    job.requestKey !== requestKey(ctx.tenantId, ctx.clerkUserId, receipt.requestId)
  )
    return unavailable();
  const result = receipt.result;
  if (
    result.strategyId !== selection.expected.strategyId ||
    result.strategyVersionId !== selection.expected.strategyVersionId ||
    (selection.expected.objectiveRevisionId !== undefined &&
      receipt.source.objectiveRevisionId !== selection.expected.objectiveRevisionId)
  )
    return unavailable();
  const strategies = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM sp_strategy WHERE tenant_id=${ctx.tenantId}::uuid AND id=${result.strategyId}::uuid AND client_id=${job.clientId}::uuid AND archived_at IS NULL FOR SHARE`;
  if (!strategies[0]) return unavailable();
  const versions = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM sp_version WHERE tenant_id=${ctx.tenantId}::uuid AND strategy_id=${result.strategyId}::uuid AND id=${result.strategyVersionId}::uuid FOR SHARE`;
  if (!versions[0]) return unavailable();
  const version = await tx.spVersion.findFirst({
    where: {
      tenantId: ctx.tenantId,
      strategyId: result.strategyId,
      id: result.strategyVersionId,
      coalescible: false,
      authorKind: 'meri',
    },
  });
  if (!version) return unavailable();
  let authority;
  try {
    authority = await requireObjectiveDestinationRevision(tx, ctx, receipt.source);
  } catch (error) {
    if (error instanceof ConflictException) stale();
    if (error instanceof NotFoundException) return unavailable();
    throw error;
  }
  if (authority.objectiveRevisionId !== receipt.source.objectiveRevisionId) stale();
  const snapshot = version.snapshot as unknown as { meta?: { id?: string; clientId?: string } };
  if (snapshot?.meta?.id !== result.strategyId || snapshot.meta.clientId !== job.clientId)
    return unavailable();
  const source: MaterializationSource = {
    generationJobId: job.id,
    generationRequestId: receipt.requestId,
    clientId: receipt.source.clientId,
    objectiveId: receipt.source.objectiveId,
    objectiveVersion: receipt.source.objectiveVersion,
    objectiveRevisionId: receipt.source.objectiveRevisionId,
    strategyId: result.strategyId,
    strategyVersionId: result.strategyVersionId,
    snapshotDigest: digest(version.snapshot),
  };
  return {
    source,
    snapshot: version.snapshot,
    objectiveReceiptSha256: digest(receipt),
    receipt,
    canonical: [
      'canonicalGeneration',
      'canonicalCompletion',
      'canonicalTerminal',
      'objectiveCanonicalReservation',
    ].some((key) => Object.prototype.hasOwnProperty.call(job.input, key)),
  };
}
