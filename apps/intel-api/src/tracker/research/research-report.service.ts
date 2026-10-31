import {
  Injectable,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import { ResearchService } from './research.service.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { object, digest, json, escapeHtml, storedRendering } from '../delivery/delivery-domain.js';
import { assertEditorialAccess } from '../editorial/editorial-access.js';
import { assertResearchReportAccess } from './research-report-access.js';
@Injectable()
export class ResearchReportService {
  constructor(readonly research: ResearchService) {}
  /** Temporary metadata-only picker for cached research review clients. */
  async history(ctx: WorkspaceTenantContext, input: unknown) {
    const b = object(input),
      reports = this.research.keywords.reports;
    await this.research.authorize(ctx);
    await reports.authorize(ctx);
    if (
      b.reportId !== undefined &&
      (typeof b.reportId !== 'string' || !b.reportId || b.reportId.length > 180)
    )
      throw new BadRequestException('INVALID_REPORT_FILTER');
    const before = b.before === undefined ? null : new Date(String(b.before));
    if (before && !Number.isFinite(before.getTime()))
      throw new BadRequestException('INVALID_HISTORY_CURSOR');
    return reports.folders.withActor(ctx, async (tx) => {
      const rows = await tx.legiWatchReportRun.findMany({
        where: {
          tenantId: ctx.tenantId,
          audience: 'internal',
          ...(b.reportId ? { reportId: String(b.reportId) } : {}),
          ...(before ? { generatedAt: { lt: before } } : {}),
        },
        select: { id: true },
        orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      const allowed = [];
      for (const row of rows) {
        try {
          const { run } = await this.legacyBase(tx, ctx, row.id);
          const {
            id,
            reportId,
            definitionVersion,
            audience,
            cutoff,
            contentHash,
            complete,
            generatedAt,
          } = run;
          allowed.push({
            id,
            reportId,
            definitionVersion,
            audience,
            cutoff,
            contentHash,
            complete,
            generatedAt,
          });
        } catch (error) {
          if (!(
            error instanceof ForbiddenException ||
            error instanceof NotFoundException ||
            error instanceof BadRequestException
          ))
            throw error;
        }
      }
      return allowed;
    });
  }
  /** Existing frozen bases are readable only inside retained research review. */
  private async legacyBase(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    id: unknown,
    scope?: Record<string, unknown>,
    lock = false,
  ) {
    if (typeof id !== 'string' || !id || id.length > 180)
      throw new BadRequestException('EXACT_RESEARCH_AND_REPORT_REQUIRED');
    if (lock)
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_report_run WHERE tenant_id=${ctx.tenantId} AND id=${id} FOR SHARE`;
    const run = await tx.legiWatchReportRun.findFirst({ where: { tenantId: ctx.tenantId, id } });
    if (!run) throw new NotFoundException('RUN_NOT_FOUND');
    const snapshot = object(run.snapshot),
      reports = this.research.keywords.reports;
    if (run.audience !== 'internal')
      throw new BadRequestException('INTERNAL_REPORT_REVIEW_REQUIRED');
    if (
      snapshot.researchReview ||
      !['bill_report', 'editorial_brief'].includes(String(snapshot.mode))
    )
      throw new BadRequestException('SELECT_BASE_REPORT_VERSION');
    if (lock)
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_report WHERE tenant_id=${ctx.tenantId} AND id=${run.reportId} FOR SHARE`;
    const report = await reports.get(tx, ctx, run.reportId, true);
    if (report.archived || !report.folderIds.length)
      throw new BadRequestException('RESEARCH_REPORT_SCOPE_MISMATCH');
    const folderIds = new Set([
      ...report.folderIds,
      ...(Array.isArray(snapshot.rows) ? snapshot.rows : []).map((row) =>
        String(object(row).folderId),
      ),
    ]);
    for (const folderId of folderIds) {
      const folder = await reports.folders.folder(tx, ctx, folderId);
      if (folder.archived || (scope && folder.clientId !== (scope.clientId ?? null)))
        throw new BadRequestException('RESEARCH_REPORT_SCOPE_MISMATCH');
      await this.research.context(tx, ctx, {
        jurisdiction: report.jurisdiction,
        sessionKey: report.sessionKey,
        folderId,
        clientId: folder.clientId,
      });
    }
    if (
      scope &&
      (!scope.folderId ||
        !report.folderIds.includes(String(scope.folderId)) ||
        report.jurisdiction !== scope.jurisdiction ||
        report.sessionKey !== scope.sessionKey)
    )
      throw new BadRequestException('RESEARCH_REPORT_SCOPE_MISMATCH');
    await assertEditorialAccess(tx, ctx, snapshot, (folderId) =>
      reports.folders.folder(tx, ctx, folderId),
    );
    return { run: { ...run, rendered: storedRendering(run.rendered) }, report };
  }
  async preview(ctx: WorkspaceTenantContext, input: unknown) {
    const b = object(input);
    if (typeof b.selectionId !== 'string')
      throw new BadRequestException('EXACT_RESEARCH_SELECTION_REQUIRED');
    const source = await this.research.researchSource(ctx, b.selectionId);
    if (source.stale) throw new ConflictException('RESEARCH_SOURCE_STALE_REVIEW_NEW_SELECTION');
    const scope = object(object(source.prefill.context).scope);
    if (!scope.folderId) throw new BadRequestException('RESEARCH_FOLDER_REQUIRED');
    const baseRun =
      'runId' in b
        ? await this.research.keywords.reports.folders.withActor(ctx, (tx) =>
            this.legacyBase(tx, ctx, b.runId, scope),
          )
        : null;
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
      ...(baseRun ? { baseRunId: baseRun.run.id, baseRunHash: baseRun.run.contentHash } : {}),
    };
    const rendered = baseRun
      ? {
          html: baseRun.run.rendered.html.replace(
            '</body>',
            `<section><h2>Reviewed Capiro research</h2><pre style="white-space:pre-wrap">${escapeHtml(output.text)}</pre></section></body>`,
          ),
          text: baseRun.run.rendered.text + '\n\nREVIEWED CAPIRO RESEARCH\n\n' + output.text,
        }
      : {
          html: `<html><body><section><h2>Reviewed Capiro research</h2><pre style="white-space:pre-wrap">${escapeHtml(output.text)}</pre></section></body></html>`,
          text: 'REVIEWED CAPIRO RESEARCH\n\n' + output.text,
        };
    return {
      ...(baseRun ? { run: baseRun.run } : {}),
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
        if (review.selectionId !== b.selectionId || review.baseRunId !== b.runId)
          throw new ConflictException('RESEARCH_REVIEW_REQUEST_CHANGED');
        await this.research.keywords.reports.run(ctx, prior.id);
        if (review.baseRunId) {
          // Historical frozen research stays replayable after source revisions,
          // while present access and the exact chosen base still bind the read.
          const source = await this.research.researchSource(ctx, String(b.selectionId));
          await this.research.keywords.reports.folders.withActor(ctx, async (tx) => {
            const { run } = await this.legacyBase(
              tx,
              ctx,
              b.runId,
              object(object(source.prefill.context).scope),
            );
            if (run.contentHash !== review.baseRunHash)
              throw new ConflictException('RESEARCH_BASE_CHANGED');
          });
        }
        return { runId: prior.id, replayed: true };
      }
    }
    const preview = await this.preview(ctx, input);
    if (b.approvalHash !== preview.approvalHash)
      throw new ConflictException('RESEARCH_OUTPUT_CHANGED_REVIEW_AGAIN');
    // Recheck membership/capability after the Workspace request, including General scope.
    if (preview.run) await this.research.authorize(ctx);
    const reports = this.research.keywords.reports,
      generationKey = 'research-review:' + preview.approvalHash;
    return reports.folders.withActor(ctx, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + generationKey},0))`;
      const existing = await tx.legiWatchReportRun.findUnique({
        where: { tenantId_generationKey: { tenantId: ctx.tenantId, generationKey } },
      });
      const baseRun = preview.run
        ? await this.legacyBase(tx, ctx, preview.run.id, preview.scope, true)
        : null;
      if (baseRun) {
        if (baseRun.run.contentHash !== preview.review.baseRunHash)
          throw new ConflictException('RESEARCH_BASE_CHANGED');
        await assertResearchReportAccess(tx, ctx, { researchReview: preview.review }, (id) =>
          reports.folders.folder(tx, ctx, id),
        );
      }
      if (existing) return { runId: existing.id, replayed: true };
      if (baseRun && baseRun.report.version !== baseRun.run.definitionVersion)
        throw new ConflictException('REPORT_CHANGED_REVIEW_AGAIN');
      const folder = await reports.folders.folder(tx, ctx, String(preview.scope.folderId));
      if (folder.archived || folder.clientId !== (preview.scope.clientId ?? null))
        throw new ConflictException('RESEARCH_SCOPE_CHANGED_REVIEW_AGAIN');
      // The existing immutable run storage is shared with retained research and
      // client briefings. Its scope record is created only for this exact draft.
      const record =
        baseRun?.report ??
        (await tx.legiWatchReport.create({
          data: {
            tenantId: ctx.tenantId,
            ownerClerkId: ctx.clerkUserId,
            name: 'Reviewed research',
            folderIds: [folder.id],
            jurisdiction: String(preview.scope.jurisdiction),
            sessionKey: String(preview.scope.sessionKey),
            settings: json({}),
          },
        }));
      const snapshot = {
        ...(baseRun
          ? object(baseRun.run.snapshot)
          : {
              schema: 'legiwatch.research-draft.v1',
              mode: 'research_draft',
              audience: 'internal',
              rows: [],
              complete: true,
            }),
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
          cutoff: baseRun?.run.cutoff ?? new Date().toISOString().slice(0, 10),
          snapshot: json(snapshot),
          rendered: json(preview.rendered),
          contentHash: digest({ snapshot, rendered: preview.rendered }),
          complete: baseRun?.run.complete ?? true,
          generationKey,
        },
      });
      return { runId: run.id, replayed: false, deliveryState: 'internal_review_only' };
    });
  }
}
