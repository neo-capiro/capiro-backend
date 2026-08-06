import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import {
  prepareMemoryReviewRevision,
  type MemoryReviewRevisionInput,
} from './memory-review-revision.helpers.js';
import {
  MemoryReviewWorkflowService,
  type MemoryReviewWorkflowSnapshot,
} from './memory-review-workflow.service.js';

interface RevisionSourceRow {
  id: string;
  clientId: string | null;
  proposedBy: string;
  sourceKind: string;
  scope: string;
  payload: unknown;
  provenance: unknown;
}

interface RevisionFunctionRow {
  candidate_id: string;
  root_candidate_id: string;
  candidate_revision_number: number;
}

export interface MemoryReviewRevisionResult {
  predecessorCandidateId: string;
  candidateId: string;
  rootCandidateId: string;
  revisionNumber: number;
  activeMemoryUnchanged: true;
  workflow: MemoryReviewWorkflowSnapshot;
}

/**
 * Creates an immutable successor after an assigned reviewer requests changes.
 *
 * Browser input may replace only reviewable content. Scope, client, proposer,
 * source kind, canonical identity, versionProposal, governance classification,
 * and source evidence are cloned from the predecessor inside PostgreSQL. The
 * predecessor is superseded and the successor workflow is created atomically.
 */
@Injectable()
export class MemoryReviewRevisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MemoryAuthorizationService,
    private readonly workflow: MemoryReviewWorkflowService,
  ) {}

  async revise(
    ctx: TenantContext,
    predecessorCandidateId: string,
    input: MemoryReviewRevisionInput,
  ): Promise<MemoryReviewRevisionResult> {
    const successorCandidateId = randomUUID();

    try {
      return await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const source = await this.loadSourceInTx(tx, ctx.tenantId, predecessorCandidateId);
        if (!source) throw new NotFoundException('Memory proposal not found.');
        if (source.proposedBy !== ctx.userId) {
          throw new ForbiddenException('Only the original proposer may submit a revision.');
        }

        const subject = await this.authorization.loadCandidateInTx(
          tx,
          ctx.tenantId,
          predecessorCandidateId,
        );
        if (!subject) throw new NotFoundException('Memory proposal not found.');
        const propose = await this.authorization.evaluateInTx(tx, ctx, subject, 'propose');
        if (!propose.allowed) {
          throw new ForbiddenException(`Memory operation denied: ${propose.reason}`);
        }

        const prepared = prepareMemoryReviewRevision(source.sourceKind, source.payload, input);
        const sourceContentHash = revisionContentHash(prepared.payload);
        const provenance = revisionProvenance(
          source.provenance,
          predecessorCandidateId,
          ctx.userId,
          successorCandidateId,
          prepared.revisionSummary,
        );

        const rows = await tx.$queryRaw<RevisionFunctionRow[]>(Prisma.sql`
          SELECT candidate_id::text,
                 root_candidate_id::text,
                 candidate_revision_number
          FROM create_memory_candidate_revision(
            ${ctx.tenantId}::uuid,
            ${predecessorCandidateId}::uuid,
            ${ctx.userId}::uuid,
            ${successorCandidateId}::uuid,
            ${JSON.stringify(prepared.payload)}::jsonb,
            ${JSON.stringify(provenance)}::jsonb,
            ${sourceContentHash}
          )
        `);
        const created = rows[0];
        if (!created) throw new Error('Memory revision function returned no successor.');

        const successorSubject = await this.authorization.loadCandidateInTx(
          tx,
          ctx.tenantId,
          created.candidate_id,
        );
        if (!successorSubject) throw new Error('Created memory revision could not be loaded.');

        // Re-evaluate after creation so a wall/grant/client-status change between
        // the predecessor check and clone rolls back the entire revision transaction.
        const successorPropose = await this.authorization.evaluateInTx(
          tx,
          ctx,
          successorSubject,
          'propose',
        );
        if (!successorPropose.allowed) {
          throw new ForbiddenException(`Memory operation denied: ${successorPropose.reason}`);
        }

        const workflow = await this.workflow.ensureAndDescribeInTx(
          tx,
          ctx,
          {
            id: created.candidate_id,
            tenantId: ctx.tenantId,
            clientId: source.clientId,
            proposedByUserId: ctx.userId,
            sourceKind: source.sourceKind,
            scope: source.scope,
            candidateKind: candidateKindForSource(source.sourceKind),
            title: candidateTitle(prepared.payload),
          },
          successorSubject,
        );

        await tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            action: 'memory.review.revision_submitted',
            entityType: 'memory_candidate',
            entityId: created.candidate_id,
            before: {
              candidateId: predecessorCandidateId,
              status: 'changes_requested',
            },
            after: {
              candidateId: created.candidate_id,
              rootCandidateId: created.root_candidate_id,
              revisionNumber: created.candidate_revision_number,
              predecessorCandidateId,
              payloadHash: createHash('sha256')
                .update(JSON.stringify(prepared.payload))
                .digest('hex'),
              sourceContentHash,
              ...prepared.revisionSummary,
            },
          },
        });

        return {
          predecessorCandidateId,
          candidateId: created.candidate_id,
          rootCandidateId: created.root_candidate_id,
          revisionNumber: created.candidate_revision_number,
          activeMemoryUnchanged: true,
          workflow,
        };
      });
    } catch (error) {
      translateRevisionError(error);
    }
  }

  private async loadSourceInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    candidateId: string,
  ): Promise<RevisionSourceRow | null> {
    const rows = await tx.$queryRaw<RevisionSourceRow[]>(Prisma.sql`
      SELECT id::text AS id,
             client_id::text AS "clientId",
             proposed_by::text AS "proposedBy",
             source_kind AS "sourceKind",
             scope,
             payload_jsonb AS payload,
             provenance_jsonb AS provenance
      FROM memory_candidate
      WHERE tenant_id = ${tenantId}::uuid
        AND id = ${candidateId}::uuid
      LIMIT 1
    `);
    return rows[0] ?? null;
  }
}

function revisionProvenance(
  existing: unknown,
  predecessorCandidateId: string,
  revisedByUserId: string,
  successorCandidateId: string,
  summary: { valueChanged: boolean; sectionBodiesChanged: number },
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...base,
    reviewRevision: {
      predecessorCandidateId,
      successorCandidateId,
      revisedByUserId,
      revisedAt: new Date().toISOString(),
      ...summary,
    },
  };
}

function revisionContentHash(payload: Record<string, unknown>): string {
  const value = typeof payload.value === 'string' ? payload.value : JSON.stringify(payload);
  return createHash('sha256').update(value).digest('hex');
}

function candidateKindForSource(sourceKind: string): string {
  if (sourceKind === 'memory_correction') return 'correction';
  if (sourceKind === 'memory_restore') return 'restore';
  if (sourceKind === 'memory_contradiction') return 'contradiction';
  return 'standard';
}

function candidateTitle(payload: Record<string, unknown>): string {
  const canonical = payload.canonicalItem;
  if (canonical && typeof canonical === 'object' && !Array.isArray(canonical)) {
    const title = (canonical as Record<string, unknown>).title;
    if (typeof title === 'string' && title.trim()) return title.trim();
  }
  const key = payload.key;
  return typeof key === 'string' && key.trim() ? key.trim() : 'Memory proposal';
}

function translateRevisionError(error: unknown): never {
  if (
    error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof ForbiddenException ||
    error instanceof NotFoundException
  ) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('MEMORY_REVISION_SUCCESSOR_EXISTS')) {
    throw new ConflictException('A revised successor already exists for this proposal.');
  }
  if (message.includes('MEMORY_REVISION_CHANGES_NOT_REQUESTED')) {
    throw new ConflictException('This proposal is not awaiting a revision.');
  }
  if (
    message.includes('MEMORY_REVISION_PROPOSER_REQUIRED') ||
    message.includes('MEMORY_REVISION_WORKFLOW_PROPOSER_MISMATCH')
  ) {
    throw new ForbiddenException('Only the original proposer may submit a revision.');
  }
  if (message.includes('MEMORY_REVISION_PREDECESSOR_NOT_PENDING')) {
    throw new ConflictException('This proposal can no longer be revised.');
  }
  throw error;
}
