import {
  Injectable,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ResearchService } from './research.service.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { object, digest, json, escapeHtml } from '../delivery/delivery-domain.js';
@Injectable()
export class ResearchReportService {
  constructor(readonly research: ResearchService) {}
  async preview(ctx: WorkspaceTenantContext, input: unknown) {
    const b = object(input);
    if (typeof b.selectionId !== 'string')
      throw new BadRequestException('EXACT_RESEARCH_SELECTION_REQUIRED');
    const source = await this.research.researchSource(ctx, b.selectionId);
    if (source.stale) throw new ConflictException('RESEARCH_SOURCE_STALE_REVIEW_NEW_SELECTION');
    const scope = object(object(source.prefill.context).scope);
    if (!scope.folderId) throw new BadRequestException('RESEARCH_FOLDER_REQUIRED');
    const base = process.env.WORKSPACE_BASE_URL,
      secret = process.env.INTERNAL_SERVICE_SECRET;
    if (!base || !secret) throw new ServiceUnavailableException('WORKSPACE_NOT_CONFIGURED');
    const response = await fetch(
      `${base.replace(/\/+$/, '')}/workspace-api/internal/legiwatch/research/${encodeURIComponent(b.selectionId)}/output?${new URLSearchParams({ tenantId: ctx.tenantId, ownerId: ctx.clerkUserId })}`,
      {
        headers: { 'x-internal-service-secret': secret },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    );
    if (!response.ok) throw new ServiceUnavailableException('RESEARCH_OUTPUT_UNAVAILABLE');
    const output = object(await response.json());
    if (
      output.selectionId !== b.selectionId ||
      !/^[a-f0-9]{64}$/.test(String(output.outputHash)) ||
      typeof output.text !== 'string' ||
      output.text.length > 200_000 ||
      JSON.stringify(output).length > 1_200_000
    )
      throw new BadRequestException('RESEARCH_OUTPUT_UNQUALIFIED');
    const review = {
      selectionId: b.selectionId,
      ownerId: ctx.clerkUserId,
      sourceHash: source.prefill.context.contentHash,
      contextVersion: object(source.prefill.context).contextVersion,
      draftId: output.draftId,
      outputHash: output.outputHash,
      sourceVersions: source.prefill.sources,
      outputSnapshot: output.snapshot,
      text: output.text,
    };
    const rendered = {
      html: `<html><body><section><h2>Reviewed Capiro research</h2><pre style="white-space:pre-wrap">${escapeHtml(output.text)}</pre></section></body></html>`,
      text: 'REVIEWED CAPIRO RESEARCH\n\n' + output.text,
    };
    return {
      scope,
      review,
      rendered,
      approvalHash: digest({ review, rendered }),
      deliveryState: 'internal_review_only',
    };
  }
  async approve(ctx: WorkspaceTenantContext, input: unknown) {
    const b = object(input);
    await this.research.authorize(ctx);
    if (/^[a-f0-9]{64}$/.test(String(b.approvalHash))) {
      const prior = await this.research.keywords.reports.folders.withActor(ctx, (tx) =>
        tx.legiWatchReportRun.findUnique({
          where: {
            tenantId_generationKey: {
              tenantId: ctx.tenantId,
              generationKey: 'research-review:' + String(b.approvalHash),
            },
          },
        }),
      );
      if (prior) {
        const review = object(object(prior.snapshot).researchReview);
        if (review.selectionId !== b.selectionId)
          throw new ConflictException('RESEARCH_REVIEW_REQUEST_CHANGED');
        await this.research.keywords.reports.run(ctx, prior.id);
        return { runId: prior.id, replayed: true };
      }
    }
    const preview = await this.preview(ctx, input);
    if (b.approvalHash !== preview.approvalHash)
      throw new ConflictException('RESEARCH_OUTPUT_CHANGED_REVIEW_AGAIN');
    const reports = this.research.keywords.reports,
      generationKey = 'research-review:' + preview.approvalHash;
    return reports.folders.withActor(ctx, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + generationKey},0))`;
      const existing = await tx.legiWatchReportRun.findUnique({
        where: { tenantId_generationKey: { tenantId: ctx.tenantId, generationKey } },
      });
      if (existing) return { runId: existing.id, replayed: true };
      const folder = await reports.folders.folder(tx, ctx, String(preview.scope.folderId));
      if (folder.archived || folder.clientId !== (preview.scope.clientId ?? null))
        throw new ConflictException('RESEARCH_SCOPE_CHANGED_REVIEW_AGAIN');
      // The existing immutable run storage is shared with retained research and
      // client briefings. Its scope record is created only for this exact draft.
      const record = await tx.legiWatchReport.create({
        data: {
          tenantId: ctx.tenantId,
          ownerClerkId: ctx.clerkUserId,
          name: 'Reviewed research',
          folderIds: [folder.id],
          jurisdiction: String(preview.scope.jurisdiction),
          sessionKey: String(preview.scope.sessionKey),
          settings: json({}),
        },
      });
      const snapshot = {
        schema: 'legiwatch.research-draft.v1',
        mode: 'research_draft',
        audience: 'internal',
        rows: [],
        complete: true,
        researchReview: {
          ...preview.review,
          approvedAt: new Date().toISOString(),
          approvalHash: preview.approvalHash,
        },
      };
      const run = await tx.legiWatchReportRun.create({
        data: {
          tenantId: ctx.tenantId,
          reportId: record.id,
          definitionVersion: record.version,
          createdBy: ctx.clerkUserId,
          audience: 'internal',
          cutoff: new Date().toISOString().slice(0, 10),
          snapshot: json(snapshot),
          rendered: json(preview.rendered),
          contentHash: digest({ snapshot, rendered: preview.rendered }),
          complete: true,
          generationKey,
        },
      });
      return { runId: run.id, replayed: false, deliveryState: 'internal_review_only' };
    });
  }
}
