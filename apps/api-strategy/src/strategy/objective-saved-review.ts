import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import type { StrategySnapshot } from './versioning.js';
import { UUID, digest } from '../meri/objective-generation.types.js';
import { readCanonicalSavedGeneration } from '../meri/objective-canonical-saved-generation.js';
import { requireCanonicalGenerationReadWithinTx } from '../meri/objective-canonical-generation-fence.js';
import { CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import {
  ObjectiveDestinationQueryDto,
  normalizeObjectiveDestination,
} from './objective-destination.js';
import { readObjectiveSavedSource } from './objective-saved-source.js';

export class ObjectiveSavedReviewQueryDto extends ObjectiveDestinationQueryDto {
  @IsUUID()
  generationJobId!: string;
  @IsUUID()
  strategyVersionId!: string;
}

const unavailable = (): never => {
  throw new NotFoundException('Saved Strategy unavailable');
};
const stale = (): never => {
  throw new ConflictException({
    code: 'OBJECTIVE_VERSION_CONFLICT',
    message: 'Objective changed. Reload it before reviewing this saved Strategy.',
  });
};

/** Public operative content only: never spread raw snapshots, context packs,
 * provenance, target records, credentials or private completion witnesses. */
export function projectSavedStrategy(raw: unknown) {
  const snapshot = raw as StrategySnapshot;
  const text = (value: unknown): string => (typeof value === 'string' ? value : unavailable());
  const nullable = (value: unknown): string | null => (value === null ? null : text(value));
  const id = (value: unknown): string => (UUID.test(text(value)) ? text(value) : unavailable());
  const date = (value: unknown): string => {
    const day = text(value);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) &&
      Number.isFinite(Date.parse(day)) &&
      new Date(day).toISOString().slice(0, 10) === day
      ? day
      : unavailable();
  };
  if (!snapshot?.meta || !Array.isArray(snapshot.nodes)) return unavailable();
  const m = snapshot.meta;
  const meta = {
    id: id(m.id),
    clientId: id(m.clientId),
    title: text(m.title),
    type: text(m.type),
    goal: nullable(m.goal),
    targetDate: m.targetDate === null ? null : date(m.targetDate),
    ownerUserId: text(m.ownerUserId),
  };
  const nodes = snapshot.nodes.map((n) => {
    if (!n || !Array.isArray(n.dependsOnIds) || typeof n.openEnded !== 'boolean')
      return unavailable();
    return {
      id: id(n.id),
      kind: text(n.kind),
      subject: text(n.subject),
      title: text(n.title),
      note: nullable(n.note),
      ownerUserId: nullable(n.ownerUserId),
      status: text(n.status),
      startsOn: date(n.startsOn),
      endsOn: n.endsOn === null ? null : date(n.endsOn),
      openEnded: n.openEnded,
      dependsOnIds: n.dependsOnIds.map(id),
    };
  });
  if (new Set(nodes.map((n) => n.id)).size !== nodes.length) return unavailable();
  return { meta, nodes };
}

/** Read only. The shared source reader enforces current Core authority; native
 * generations additionally reconstruct their retained original custody. Neither
 * historical evidence nor a successful review grants Planner consent. */
export async function readObjectiveSavedReviewState(
  tx: Prisma.TransactionClient,
  ctx: AuthTenantContext,
  strategyId: string,
  input: ObjectiveSavedReviewQueryDto,
) {
  let evidence: ReadonlyArray<{ ref: string; reviewState: string; asOfMs: number }> = [];
  const binding = normalizeObjectiveDestination({
    clientId: input.clientId,
    objectiveId: input.objectiveId,
    objectiveVersion: input.objectiveVersion,
  });
  if (
    ![strategyId, input.generationJobId, input.strategyVersionId].every(
      (v) => typeof v === 'string' && UUID.test(v),
    )
  )
    throw new BadRequestException('Invalid saved Strategy selection');
  const saved = await readObjectiveSavedSource(
    tx,
    ctx,
    {
      generationJobId: input.generationJobId.toLowerCase(),
      expected: {
        strategyId: strategyId.toLowerCase(),
        strategyVersionId: input.strategyVersionId.toLowerCase(),
      },
    },
    { unavailable, stale },
  );
  const s = saved.source;
  if (
    s.clientId !== binding.clientId ||
    s.objectiveId !== binding.objectiveId ||
    s.objectiveVersion !== binding.objectiveVersion
  )
    return unavailable();
  if (saved.canonical) {
    try {
      const canonical = await readCanonicalSavedGeneration(tx, {
        ...ctx,
        generationJobId: s.generationJobId,
      });
      evidence = canonical.publication.request.context.evidence;
      await requireCanonicalGenerationReadWithinTx(tx, canonical.admission, ctx.clerkUserId);
      if (
        canonical.receipt.snapshotDigest !== s.snapshotDigest ||
        digest(canonical.receipt.objectiveReceipt) !== saved.objectiveReceiptSha256
      )
        return unavailable();
    } catch (error) {
      if (!(error instanceof CanonicalApplicationError)) throw error;
      if (error.code === 'AUTHORITY_UNAVAILABLE' || error.code === 'NOT_AVAILABLE')
        return unavailable();
      throw new ServiceUnavailableException(
        'The saved generation could not be confirmed. Retry this read.',
      );
    }
  }
  const snapshot = projectSavedStrategy(saved.snapshot);
  // Report current archive state separately; never replace a saved node with a
  // current node. Planner remains the sole owner of eligibility/graph validation.
  const current = await tx.spNode.findMany({
    where: { tenantId: ctx.tenantId, strategyId: s.strategyId },
    select: { id: true, archivedAt: true },
  });
  const rows = new Map(current.map((n) => [n.id, n]));
  const review = {
    destination: {
      kind: 'strategy_saved_review' as const,
      resourceId: s.strategyId,
      ...binding,
      objectiveRevisionId: s.objectiveRevisionId,
    },
    source: s,
    savedAt: saved.receipt.result!.savedAt,
    context: {
      state: 'complete' as const,
      compiledAt: saved.receipt.context.compiledAt!,
      reobservedAt: saved.receipt.context.reobservedAt!,
    },
    snapshot,
    currentNodes: snapshot.nodes.map((n) => ({
      sourceNodeId: n.id,
      availability: !rows.has(n.id)
        ? ('unavailable' as const)
        : rows.get(n.id)!.archivedAt
          ? ('archived' as const)
          : ('available' as const),
    })),
  };
  return { review, evidence, generationType: snapshot.meta.type,
    nodes: (saved.snapshot as unknown as StrategySnapshot).nodes.map(node => ({ id: node.id, provenance: node.provenance })) };
}

export async function readObjectiveSavedReview(tx: Prisma.TransactionClient, ctx: AuthTenantContext,
  strategyId: string, input: ObjectiveSavedReviewQueryDto) {
  return (await readObjectiveSavedReviewState(tx, ctx, strategyId, input)).review;
}
