import {
  Injectable,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ResearchService } from './research.service.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { object, digest, json, escapeHtml } from '../reports/report-domain.js';
@Injectable()
export class ResearchReportService {
  constructor(readonly research: ResearchService) {}
  async preview(ctx: WorkspaceTenantContext, input: unknown) {
    const b = object(input);
    if (typeof b.selectionId !== 'string' || typeof b.runId !== 'string')
      throw new BadRequestException('EXACT_RESEARCH_AND_REPORT_REQUIRED');
    const source = await this.research.researchSource(ctx, b.selectionId);
    if (source.stale) throw new ConflictException('RESEARCH_SOURCE_STALE_REVIEW_NEW_SELECTION');
    const scope = object(object(source.prefill.context).scope),
      reports = this.research.keywords.reports;
    const run = await reports.run(ctx, b.runId);
    if (run.audience !== 'internal')
      throw new BadRequestException('INTERNAL_REPORT_REVIEW_REQUIRED');
    const report = await reports.folders.withActor(ctx, (tx) => reports.get(tx, ctx, run.reportId));
    const folders = await reports.folders.withActor(ctx, async (tx) => {
      const result = [];
      for (const id of report.folderIds) result.push(await reports.folders.folder(tx, ctx, id));
      return result;
    });
    if (
      report.ownerClerkId !== ctx.clerkUserId ||
      !scope.folderId ||
      !report.folderIds.includes(String(scope.folderId)) ||
      folders.some((f) => f.clientId !== scope.clientId) ||
      report.jurisdiction !== scope.jurisdiction ||
      report.sessionKey !== scope.sessionKey
    )
      throw new BadRequestException('RESEARCH_REPORT_SCOPE_MISMATCH');
    if (object(run.snapshot).researchReview)
      throw new BadRequestException('SELECT_BASE_REPORT_VERSION');
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
      baseRunId: run.id,
      baseRunHash: run.contentHash,
    };
    const rendered = {
      html: run.rendered.html.replace(
        '</body>',
        `<section><h2>Reviewed Capiro research</h2><pre style="white-space:pre-wrap">${escapeHtml(output.text)}</pre></section></body>`,
      ),
      text: run.rendered.text + '\n\nREVIEWED CAPIRO RESEARCH\n\n' + output.text,
    };
    return {
      run,
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
        if (review.selectionId !== b.selectionId || review.baseRunId !== b.runId)
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
      const current = await reports.get(tx, ctx, preview.run.reportId);
      if (current.version !== preview.run.definitionVersion)
        throw new ConflictException('REPORT_CHANGED_REVIEW_AGAIN');
      const snapshot = {
        ...object(preview.run.snapshot),
        researchReview: {
          ...preview.review,
          approvedAt: new Date().toISOString(),
          approvalHash: preview.approvalHash,
        },
      };
      const run = await tx.legiWatchReportRun.create({
        data: {
          tenantId: ctx.tenantId,
          reportId: preview.run.reportId,
          definitionVersion: preview.run.definitionVersion,
          createdBy: ctx.clerkUserId,
          audience: 'internal',
          cutoff: preview.run.cutoff,
          snapshot: json(snapshot),
          rendered: json(preview.rendered),
          contentHash: digest({ snapshot, rendered: preview.rendered }),
          complete: preview.run.complete,
          generationKey,
        },
      });
      return { runId: run.id, replayed: false, deliveryState: 'internal_review_only' };
    });
  }
}
