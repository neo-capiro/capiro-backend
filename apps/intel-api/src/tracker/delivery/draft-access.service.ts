import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { FolderTrackerService } from '../folders/folder-tracker.service.js';
import {
  FeatureFlagService,
  FOLDER_TRACKER_FEATURE,
} from '../../feature-flags/feature-flag.service.js';
import { assertEditorialAccess } from '../editorial/editorial-access.js';
import { assertResearchReportAccess } from '../research/research-report-access.js';
import { storedRendering, object } from './delivery-domain.js';

/** Shared access to folder-scoped retained drafts; no report-library mutation surface. */
@Injectable()
export class DraftAccessService {
  constructor(
    readonly folders: FolderTrackerService,
    readonly flags: FeatureFlagService,
  ) {}
  async authorize(ctx: WorkspaceTenantContext, feature: string = FOLDER_TRACKER_FEATURE) {
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
  async run(ctx: WorkspaceTenantContext, id: string) {
    await this.authorize(ctx);
    return this.folders.withActor(ctx, async (tx) => {
      const r = await tx.legiWatchReportRun.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!r) throw new NotFoundException('RUN_NOT_FOUND');
      await this.get(tx, ctx, r.reportId);
      const snapshot = object(r.snapshot);
      if (snapshot.mode !== 'editorial_brief' && !snapshot.researchReview)
        throw new NotFoundException('RUN_NOT_FOUND');
      await assertResearchReportAccess(tx, ctx, snapshot, (id) => this.folders.folder(tx, ctx, id));
      await assertEditorialAccess(tx, ctx, snapshot, (id) => this.folders.folder(tx, ctx, id));
      for (const folderId of new Set(
        (Array.isArray(snapshot.rows) ? snapshot.rows : []).map((r) => String(object(r).folderId)),
      ))
        await this.folders.folder(tx, ctx, folderId);
      return { ...r, rendered: storedRendering(r.rendered) };
    });
  }
}
