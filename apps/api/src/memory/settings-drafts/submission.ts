import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import {
  memoryDraftSubmissionBytes,
  parseMemoryDraftSubmit,
} from '@capiro/shared/settings-memory-drafts';
import { governedMemoryModeEnabledForTenant } from '@capiro/meriv2-core';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MemoryAuthorizationService } from '../memory-authorization.service.js';
import { MemoryCandidateService } from '../memory-candidate.service.js';
import { SettingsMemoryVersionCandidateService } from '../settings-memory-version-candidate.service.js';
import { MemorySettingsReviewReadinessService } from '../memory-settings-review-readiness.service.js';
import { MemoryReviewWorkflowService } from '../memory-review-workflow.service.js';
import { candidateKindFor } from '../memory-version.helpers.js';
import { editableSectionKeys, fileDefForType, mergeEditedSections } from '../memory-catalog.js';
import type { MemoryItemType } from '../memory.types.js';
import { withDraftTarget, readDraftBase } from './authority.js';
import { draftId, type DraftTarget } from './input.js';
import { assertDraftErasureAllowed, readDraft } from './store.js';

interface SubmissionReceipt {
  type: string;
  slug: string;
  requestId: string;
  requestHash: string;
  draftId: string;
  draftRevision: number;
  candidateId: string;
  submittedAt: Date;
}
async function receiptInTx(tx: Prisma.TransactionClient, ctx: TenantContext, requestId: string) {
  const rows = await tx.$queryRaw<
    SubmissionReceipt[]
  >`SELECT type,slug,request_id AS "requestId",request_hash AS "requestHash",
    draft_id AS "draftId",draft_revision AS "draftRevision",candidate_id AS "candidateId",submitted_at AS "submittedAt"
    FROM memory_settings_submissions WHERE tenant_id=${ctx.tenantId}::uuid AND author_user_id=${ctx.userId}::uuid
      AND request_id=${requestId}::uuid`;
  return rows[0] ?? null;
}
function result(receipt: SubmissionReceipt) {
  return {
    schema: 'memory-settings-submit-receipt/1' as const,
    requestId: receipt.requestId,
    requestHash: receipt.requestHash,
    draftId: receipt.draftId,
    draftRevision: receipt.draftRevision,
    candidateId: receipt.candidateId,
    submittedAt: receipt.submittedAt,
    status: 'pending_review' as const,
    activeItemUnchanged: true as const,
  };
}
@Injectable()
export class SettingsMemorySubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MemoryAuthorizationService,
    private readonly candidates: MemoryCandidateService,
    private readonly versions: SettingsMemoryVersionCandidateService,
    private readonly readiness: MemorySettingsReviewReadinessService,
    private readonly workflow: MemoryReviewWorkflowService,
  ) {}
  async submit(ctx: TenantContext, type: string, slug: string, id: string, raw: unknown) {
    draftId(id);
    let body: ReturnType<typeof parseMemoryDraftSubmit>;
    try {
      body = parseMemoryDraftSubmit(raw);
    } catch {
      throw new BadRequestException('Invalid draft submission.');
    }
    const { requestId, expectedRevision: revision } = body;
    return withDraftTarget(
      this.prisma,
      this.authorization,
      ctx,
      type,
      slug,
      async (tx, target, current) => {
        await this.requireSchema(tx);
        const hash = createHash('sha256')
          .update(memoryDraftSubmissionBytes(target, id, body))
          .digest('hex');
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':settings-drafts:' + ctx.userId},0))`;
        const previous = await receiptInTx(tx, current, requestId);
        if (previous) {
          if (previous.requestHash !== hash)
            throw new ConflictException('Request identity was used for a different submission.');
          return result(previous);
        }
        const candidateId = await this.proposeSavedDraft(tx, current, target, id, revision);
        if (target.scope !== 'user')
          await this.ensureSharedReview(tx, current, target, candidateId);
        await tx.$executeRaw`UPDATE memory_settings_drafts SET state='submitted',sections=NULL,revision=revision+1
        WHERE tenant_id=${ctx.tenantId}::uuid AND author_user_id=${ctx.userId}::uuid AND id=${id}::uuid`;
        await tx.$executeRaw`INSERT INTO memory_settings_submissions
        (tenant_id,author_user_id,request_id,request_hash,draft_id,draft_revision,candidate_id)
        VALUES(${ctx.tenantId}::uuid,${ctx.userId}::uuid,${requestId}::uuid,${hash},${id}::uuid,${revision},${candidateId}::uuid)`;
        return result((await receiptInTx(tx, current, requestId))!);
      },
      true,
    );
  }
  async receipt(ctx: TenantContext, type: string, slug: string, id: string, requestId: string) {
    draftId(id);
    draftId(requestId);
    return withDraftTarget(
      this.prisma,
      this.authorization,
      ctx,
      type,
      slug,
      async (tx, target, current) => {
        await this.requireSchema(tx);
        const receipt = await receiptInTx(tx, current, requestId);
        if (
          !receipt ||
          receipt.draftId !== id ||
          receipt.type !== target.type ||
          receipt.slug !== target.slug
        )
          throw new NotFoundException('Draft submission receipt unavailable.');
        return result(receipt);
      },
    );
  }
  private async prepareSubmission(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    target: DraftTarget,
    id: string,
    revision: number,
  ) {
    const type = target.type;
    // Lifecycle is required for both pending review and immutable publication.
    if (
      !governedMemoryModeEnabledForTenant(
        ctx.tenantId,
        process.env.MEMORY_GOVERNANCE_LIFECYCLE,
        process.env.MEMORY_GOVERNANCE_TENANTS,
      ) ||
      !governedMemoryModeEnabledForTenant(
        ctx.tenantId,
        process.env.MEMORY_GOVERNANCE_ENFORCE,
        process.env.MEMORY_GOVERNANCE_TENANTS,
      )
    )
      throw new ConflictException(
        'Memory review is unavailable. Your private draft was not submitted.',
      );
    const draft = await readDraft(tx, ctx, target, id);
    if (!draft) throw new NotFoundException('Draft unavailable or expired.');
    if (
      draft.state !== 'draft' ||
      draft.revision !== revision ||
      draft.legalHold ||
      !draft.sections
    )
      throw new ConflictException(
        'Draft changed, is held or was already submitted. Reload before continuing.',
      );
    const base = await readDraftBase(tx, ctx, target, this.authorization);
    await assertDraftErasureAllowed(tx, ctx.tenantId, draft.baseItemId);
    if (base.baseItemId !== draft.baseItemId || base.baseVersion !== draft.baseVersion)
      throw new ConflictException(
        'Active memory changed. Start a draft based on the current version.',
      );
    const sections = mergeEditedSections(
      type,
      base.baseItemId ? base.sections : null,
      draft.sections,
      editableSectionKeys(type),
    );
    const input = {
      type: type as MemoryItemType,
      slug: target.slug,
      title: fileDefForType(type)!.label,
      scope: target.scope === 'user' ? ('user_private' as const) : target.scope,
      clientId: target.clientId,
      sections,
    };
    if (input.scope !== 'user_private')
      await this.readiness.assertSubmissionReady(ctx, { ...input, scope: input.scope }, tx);
    return { base, input };
  }
  private async proposeSavedDraft(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    target: DraftTarget,
    id: string,
    revision: number,
  ) {
    const { base, input } = await this.prepareSubmission(tx, ctx, target, id, revision);
    const correction = base.baseItemId
      ? await this.versions.proposeExistingCorrection(
          ctx,
          {
            ...input,
            sourceVersion: base.baseVersion!,
            draftId: id,
          },
          tx,
        )
      : null;
    if (base.baseItemId && !correction)
      throw new ConflictException('Active memory changed before submission.');
    const candidateId =
      correction?.candidateId ??
      (
        await this.candidates.proposeSaveMemory(
          ctx.tenantId,
          ctx.userId,
          {
            scope: input.scope,
            ownerUserId: input.scope === 'user_private' ? ctx.userId : null,
            clientId: target.clientId,
            key: `settings-file:${target.type}:${target.slug}`,
            value: JSON.stringify(input.sections),
            source: 'settings_memory_editor',
            sourceType: 'settings_memory_editor',
            sourceId: id,
            canonicalItem: input,
          },
          ctx.role === 'user_admin' || ctx.role === 'capiro_admin',
          'settings_sections',
          undefined,
          tx,
        )
      ).candidateId;
    return candidateId;
  }
  private async requireSchema(tx: Prisma.TransactionClient) {
    const ready = await tx.$queryRaw<
      Array<{ ready: boolean }>
    >`SELECT to_regclass('public.memory_settings_submissions') IS NOT NULL AS ready`;
    if (!ready[0]?.ready)
      throw new ServiceUnavailableException('Memory draft submission is not available yet.');
  }
  private async ensureSharedReview(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    target: DraftTarget,
    candidateId: string,
  ) {
    const candidate = await tx.memoryCandidate.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: candidateId, status: 'pending' },
      select: {
        sourceKind: true,
        contradictsMemoryItemId: true,
        conflictStatus: true,
        scope: true,
      },
    });
    const subject = await this.authorization.loadCandidateInTx(tx, ctx.tenantId, candidateId);
    if (!subject)
      throw new ConflictException(
        'Review candidate unavailable. Your private draft was not submitted.',
      );
    const review = await this.workflow.ensureAndDescribeInTx(
      tx,
      ctx,
      {
        id: candidateId,
        tenantId: ctx.tenantId,
        clientId: target.clientId,
        proposedByUserId: ctx.userId,
        sourceKind: candidate.sourceKind,
        scope: candidate.scope,
        candidateKind: candidateKindFor(candidate),
        title: fileDefForType(target.type)!.label,
      },
      subject,
    );
    if (!review.assignedReviewer)
      throw new ConflictException('No eligible reviewer. Your private draft was not submitted.');
  }
}
