import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, LegiWatchReport } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { FolderTrackerService, isFolderAdmin } from '../folders/folder-tracker.service.js';
import {
  FeatureFlagService,
  REPORTS_UPDATES_FEATURE,
} from '../../feature-flags/feature-flag.service.js';
import {
  capturedReport,
  dateOnly,
  digest,
  ids,
  json,
  makeDocument,
  object,
  renderReport,
  storedRendering,
  selectionHash,
  settings,
  text,
  version,
  type ReportAssignment,
  type ReportDocument,
} from './report-domain.js';

@Injectable()
export class ReportService {
  constructor(
    readonly folders: FolderTrackerService,
    readonly flags: FeatureFlagService,
  ) {}
  async authorize(ctx: WorkspaceTenantContext, feature: string = REPORTS_UPDATES_FEATURE) {
    if (!(await this.flags.isEnabled(feature, ctx.tenantId))) throw new NotFoundException();
    if (!(await this.folders.source.activeMember(ctx.tenantId, ctx.clerkUserId)))
      throw new ForbiddenException('ACTIVE_MEMBERSHIP_REQUIRED');
  }
  async get(tx: Prisma.TransactionClient, ctx: WorkspaceTenantContext, id: string, write = false) {
    const r = await tx.legiWatchReport.findFirst({ where: { tenantId: ctx.tenantId, id } });
    if (!r) throw new NotFoundException('REPORT_NOT_FOUND');
    if (write && r.ownerClerkId !== ctx.clerkUserId)
      throw new ForbiddenException('REPORT_OWNER_REQUIRED');
    for (const folderId of r.folderIds) await this.folders.folder(tx, ctx, folderId);
    return r;
  }
  async list(ctx: WorkspaceTenantContext) {
    await this.authorize(ctx);
    return this.folders.withActor(ctx, async (tx) => {
      const reports = await tx.legiWatchReport.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      const promotions = await tx.legiWatchPromotion.findMany({
        where: { tenantId: ctx.tenantId, kind: 'report' },
        select: { targetId: true, sourceId: true },
      });
      const runs = await tx.legiWatchReportRun.findMany({
        where: { tenantId: ctx.tenantId },
        distinct: ['reportId'],
        orderBy: { generatedAt: 'desc' },
        select: { reportId: true, generatedAt: true },
      });
      return reports.map((r) => ({
        ...r,
        canEdit: r.ownerClerkId === ctx.clerkUserId,
        sourceId: promotions.find((p) => p.targetId === r.id)?.sourceId ?? null,
        lastGeneratedAt: runs.find((run) => run.reportId === r.id)?.generatedAt ?? null,
      }));
    });
  }
  async save(ctx: WorkspaceTenantContext, input: unknown, id?: string) {
    await this.authorize(ctx);
    const body = object(input),
      folderIds = ids(body.folderIds);
    if (!folderIds.length) throw new BadRequestException('SELECT_AT_LEAST_ONE_FOLDER');
    const data = {
      name: text(body.name),
      folderIds,
      jurisdiction: text(body.jurisdiction, 2).toUpperCase(),
      sessionKey: text(body.sessionKey, 60),
      settings: json(settings(body.settings)),
    };
    if (
      !(await this.folders.source.sessions(data.jurisdiction)).some(
        (s) => s.key === data.sessionKey,
      )
    )
      throw new BadRequestException('CANONICAL_SESSION_REQUIRED');
    return this.folders.withActor(ctx, async (tx) => {
      for (const folderId of folderIds)
        await this.folders.folder(tx, ctx, folderId, true, settings(body.settings).includeArchived);
      if (!id)
        return tx.legiWatchReport.create({
          data: { ...data, tenantId: ctx.tenantId, ownerClerkId: ctx.clerkUserId },
        });
      await this.get(tx, ctx, id, true);
      const updated = await tx.legiWatchReport.updateMany({
        where: { tenantId: ctx.tenantId, id, version: version(body.expectedVersion) },
        data: { ...data, version: { increment: 1 } },
      });
      if (!updated.count) throw new ConflictException('REPORT_CHANGED_RELOAD');
      // Existing subscriptions are version-bound and hold until reviewed again.
      return tx.legiWatchReport.findFirstOrThrow({ where: { tenantId: ctx.tenantId, id } });
    });
  }
  async duplicate(ctx: WorkspaceTenantContext, id: string) {
    await this.authorize(ctx);
    const original = await this.folders.withActor(ctx, (tx) => this.get(tx, ctx, id));
    return this.save(ctx, { ...original, name: `${original.name} (copy)` });
  }
  async assignments(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    report: LegiWatchReport,
  ): Promise<ReportAssignment[]> {
    const folders = await Promise.all(
      report.folderIds.map((id) => this.folders.folder(tx, ctx, id)),
    );
    const selected = await tx.legiWatchFolderBill.findMany({
      where: {
        tenantId: ctx.tenantId,
        folderId: { in: report.folderIds },
        jurisdiction: report.jurisdiction,
        sessionKey: report.sessionKey,
      },
      orderBy: { id: 'asc' },
      take: 10001,
    });
    if (selected.length > 10000)
      throw new BadRequestException('REPORT_LIMIT_10000_ASSIGNMENTS_REFINE_SCOPE');
    return selected.map((a) => {
      const f = folders.find((f) => f.id === a.folderId)!;
      return { ...a, folderName: f.name, folderVersion: f.version, archived: f.archived };
    });
  }
  async generate(
    ctx: WorkspaceTenantContext,
    id: string,
    input: unknown,
    now = new Date(),
    generationKey?: string,
    window?: { start: Date; end: Date },
  ) {
    await this.authorize(ctx);
    const body = object(input);
    if (generationKey) {
      const existing = await this.folders.withActor(ctx, (tx) =>
        tx.legiWatchReportRun.findUnique({
          where: { tenantId_generationKey: { tenantId: ctx.tenantId, generationKey } },
        }),
      );
      if (existing) return this.run(ctx, existing.id);
    }
    const cutoff = dateOnly(text(body.cutoff, 10));
    if (cutoff > now.toISOString().slice(0, 10))
      throw new BadRequestException('FUTURE_CUTOFF_UNSUPPORTED');
    const audience = body.audience === 'internal' ? 'internal' : 'external';
    const { report, assignments } = await this.folders.withActor(ctx, async (tx) => {
      const report = await this.get(tx, ctx, id);
      if (report.archived) throw new BadRequestException('REPORT_ARCHIVED');
      if (body.expectedVersion !== undefined && report.version !== version(body.expectedVersion))
        throw new ConflictException('REPORT_CHANGED_RELOAD');
      return { report, assignments: await this.assignments(tx, ctx, report) };
    });
    const billIds = [...new Set(assignments.map((a) => a.billId))];
    const bills = [];
    for (let i = 0; i < billIds.length; i += 250)
      bills.push(...(await this.folders.source.reportBills(billIds.slice(i, i + 250))));
    const snapshot = makeDocument({ report, assignments, bills, cutoff, now, audience });
    if (window)
      snapshot.updates = {
        windowStart: window.start.toISOString(),
        windowEnd: window.end.toISOString(),
        records: bills
          .filter((b) => snapshot.rows.some((r) => r.id === b.id))
          .flatMap((b) =>
            b.events
              .filter(
                (e) =>
                  e.observedAt > window.start.toISOString() &&
                  e.observedAt <= window.end.toISOString(),
              )
              .map((e) => ({ ...e, billId: b.id, number: b.number })),
          ),
      };
    return this.folders.withActor(ctx, async (tx) => {
      const current = await this.get(tx, ctx, id);
      if (current.version !== report.version)
        throw new ConflictException('REPORT_CHANGED_DURING_GENERATION');
      if (selectionHash(await this.assignments(tx, ctx, current)) !== snapshot.selectionHash)
        throw new ConflictException('FOLDER_CHANGED_DURING_GENERATION');
      // Workers serialize this generation identity; retry always reuses the first frozen document.
      if (generationKey) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + generationKey}, 0))`;
        const existing = await tx.legiWatchReportRun.findUnique({
          where: { tenantId_generationKey: { tenantId: ctx.tenantId, generationKey } },
        });
        if (existing)
          return {
            ...existing,
            rendered: storedRendering(existing.rendered),
          };
      }
      const rendered = renderReport(snapshot);
      const run = await tx.legiWatchReportRun.create({
        data: {
          tenantId: ctx.tenantId,
          reportId: id,
          definitionVersion: report.version,
          createdBy: ctx.clerkUserId,
          audience,
          cutoff,
          snapshot: json(snapshot),
          rendered: json(rendered),
          contentHash: digest({ snapshot, rendered }),
          complete: snapshot.complete,
          generatedAt: now,
          generationKey,
        },
      });
      return { ...run, rendered };
    });
  }
  async run(ctx: WorkspaceTenantContext, id: string) {
    await this.authorize(ctx);
    return this.folders.withActor(ctx, async (tx) => {
      const r = await tx.legiWatchReportRun.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!r) throw new NotFoundException('RUN_NOT_FOUND');
      await this.get(tx, ctx, r.reportId);
      const snapshot = r.snapshot as unknown as ReportDocument;
      for (const folderId of new Set(snapshot.rows.map((r) => r.folderId)))
        await this.folders.folder(tx, ctx, folderId);
      return { ...r, rendered: storedRendering(r.rendered) };
    });
  }
  async history(ctx: WorkspaceTenantContext, reportId?: string, before?: string) {
    await this.authorize(ctx);
    return this.folders.withActor(ctx, async (tx) => {
      if (reportId) await this.get(tx, ctx, reportId);
      return tx.legiWatchReportRun.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(reportId ? { reportId } : {}),
          ...(before ? { generatedAt: { lt: new Date(before) } } : {}),
        },
        select: {
          id: true,
          reportId: true,
          definitionVersion: true,
          audience: true,
          cutoff: true,
          contentHash: true,
          complete: true,
          generatedAt: true,
        },
        orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
    });
  }
  async promote(ctx: WorkspaceTenantContext, stagedId: string) {
    await this.authorize(ctx);
    if (!isFolderAdmin(ctx)) throw new ForbiddenException('PROMOTION_REQUIRES_ADMIN');
    return this.folders.withActor(ctx, async (tx) => {
      // Serialize replay and preserve subsequent edits, even after recapture.
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_staged_configuration WHERE tenant_id=${ctx.tenantId} AND id=${stagedId} FOR UPDATE`;
      const staged = await tx.legiWatchStagedConfiguration.findFirst({
        where: { tenantId: ctx.tenantId, id: stagedId, kind: 'report', state: { not: 'excluded' } },
      });
      if (!staged) throw new NotFoundException('STAGED_REPORT_NOT_FOUND');
      const prior = await tx.legiWatchPromotion.findFirst({
        where: { tenantId: ctx.tenantId, stagedId },
      });
      if (prior)
        return {
          targetId: prior.targetId,
          state: 'already_promoted',
          sourceChanged: prior.sourceHash !== digest(staged.payload),
        };
      const raw = object(staged.payload),
        normalized = capturedReport(raw),
        sourceFolders = ids(raw.folder_ids);
      const mapped = await tx.legiWatchSourceMapping.findMany({
        where: {
          tenantId: ctx.tenantId,
          sourceAccount: staged.sourceAccount,
          kind: 'folder',
          sourceId: { in: sourceFolders },
        },
      });
      if (!sourceFolders.length || mapped.length !== sourceFolders.length)
        return { state: 'needs_review', reason: 'FOLDER_MAPPING_REQUIRED' };
      const folderIds = sourceFolders.map((id) => mapped.find((m) => m.sourceId === id)!.targetId);
      for (const id of folderIds) await this.folders.folder(tx, ctx, id, true);
      const assignmentItems = await tx.legiWatchImportItem.findMany({
        where: {
          tenantId: ctx.tenantId,
          kind: 'assignment',
          run: { sourceAccount: staged.sourceAccount },
        },
        take: 10001,
      });
      if (assignmentItems.length > 10000)
        throw new BadRequestException('PROMOTION_IMPORT_LIMIT_REQUIRES_REVIEW');
      const sessions = assignmentItems
        .map((i) => object(i.payload))
        .filter((p) => String(object(p.raw).session) === String(raw.session))
        .map((p) => object(p.resolved))
        .filter((r) => typeof r.sessionKey === 'string' && typeof r.jurisdiction === 'string');
      const scopes = [...new Set(sessions.map((r) => `${r.jurisdiction}:${r.sessionKey}`))];
      if (scopes.length !== 1)
        return { state: 'needs_review', reason: 'CANONICAL_SESSION_MAPPING_REQUIRED' };
      const [jurisdiction, sessionKey] = scopes[0]!.split(':');
      const report = await tx.legiWatchReport.create({
        data: {
          tenantId: ctx.tenantId,
          ownerClerkId: ctx.clerkUserId,
          name: text(raw.name),
          folderIds,
          jurisdiction: jurisdiction!,
          sessionKey: sessionKey!,
          settings: json(normalized),
        },
      });
      await tx.legiWatchPromotion.create({
        data: {
          tenantId: ctx.tenantId,
          stagedId,
          sourceAccount: staged.sourceAccount,
          sourceId: staged.sourceId,
          sourceVersion: staged.version,
          sourceHash: digest(staged.payload),
          kind: 'report',
          targetId: report.id,
          reviewedBy: ctx.clerkUserId,
        },
      });
      return { targetId: report.id, state: 'draft', deliveryEnabled: false };
    });
  }
  async staged(ctx: WorkspaceTenantContext) {
    await this.authorize(ctx);
    if (!isFolderAdmin(ctx)) return [];
    return this.folders.withActor(ctx, (tx) =>
      tx.legiWatchStagedConfiguration.findMany({
        where: {
          tenantId: ctx.tenantId,
          kind: { in: ['report', 'alert', 'contact', 'mailing_list'] },
          state: { not: 'excluded' },
        },
        select: { id: true, sourceId: true, kind: true, state: true, version: true },
        orderBy: [{ kind: 'asc' }, { sourceId: 'asc' }],
      }),
    );
  }
}
