import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { meriJobsEnabled } from '../common/tenant-flags.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriClientFilingService } from './meri-client-filing.service.js';
import { MeriDocgenService } from './meri-docgen.service.js';
import { deliverableFileName, researchReportWordSpec } from './meri-job-deliverables.js';
import { meriJobDeliverables, type MeriJobDeliverable } from './meri-job.js';
import { readResearchHandoff } from './meri-research-handoff.js';
import { MeriResearchService } from './meri-research.service.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Deliverable jobs (Stage 2 Release B). The Word document is rendered from the
 * job's report through `getReportMarkdown`, which applies the held-report rule
 * and the read-time source and producer-input re-check, so a deliverable is
 * never available after its report would be withheld. Filing into the
 * client's Files is one user confirmation and is idempotent per deliverable.
 */
@Injectable()
export class MeriJobDeliverablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly research: MeriResearchService,
    private readonly docgen: MeriDocgenService,
    private readonly filing: MeriClientFilingService,
  ) {}

  private async deliverable(ctx: TenantContext, jobId: string, index: number) {
    if (!Number.isSafeInteger(index) || index < 0)
      throw new NotFoundException('Deliverable not found');
    const session = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioResearchSession.findFirst({
        where: { id: jobId, tenantId: ctx.tenantId, userId: ctx.userId },
        select: { id: true, kind: true, clientId: true, deliverables: true, metadata: true },
      }),
    );
    if (!session) throw new NotFoundException('Job not found');
    if (session.kind !== 'deliverable')
      throw new BadRequestException('This job has no deliverables.');
    const deliverable = meriJobDeliverables(session.deliverables)[index];
    if (!deliverable || deliverable.format !== 'docx')
      throw new NotFoundException('Deliverable not found');
    return { session, deliverable };
  }

  /** The current Word document for a completed deliverable job. */
  async docx(
    ctx: TenantContext,
    jobId: string,
    index: number,
  ): Promise<{ fileName: string; contentType: string; buffer: Buffer; deliverable: MeriJobDeliverable }> {
    const { deliverable } = await this.deliverable(ctx, jobId, index);
    const report = await this.research.getReportMarkdown(ctx, jobId);
    const title = deliverable.title || report.title;
    const buffer = await this.docgen.buildDocx(researchReportWordSpec(title, report.markdown));
    return { fileName: deliverableFileName(title), contentType: DOCX_MIME, buffer, deliverable };
  }

  /** One confirmation files the deliverable into the job's client Files. */
  async file(ctx: TenantContext, jobId: string, index: number) {
    const tenant = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.tenant.findFirst({ where: { id: ctx.tenantId }, select: { settings: true } }),
    );
    if (!meriJobsEnabled(tenant?.settings)) throw new ForbiddenException('meri_jobs_disabled');
    const { session, deliverable } = await this.deliverable(ctx, jobId, index);
    if (!session.clientId)
      throw new BadRequestException('Only a client-scoped job can file into client Files.');
    const conversationId = readResearchHandoff(session.metadata)?.conversationId ?? undefined;

    // A filed deliverable stays filed: document bytes carry timestamps, so the
    // writer's content-bound key alone would not stop a second copy.
    if (deliverable.artifactId) {
      const existing = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.engagementAttachment.findFirst({
          where: { id: deliverable.artifactId!, tenantId: ctx.tenantId, clientId: session.clientId },
          select: { id: true, fileName: true },
        }),
      );
      if (existing)
        return {
          status: 'saved' as const,
          documentId: existing.id,
          fileName: existing.fileName,
          location: `/clients?clientId=${session.clientId}&tab=files&attachmentId=${encodeURIComponent(existing.id)}`,
          reused: true,
        };
    }

    const document = await this.docx(ctx, jobId, index);
    const receipt = await this.filing.saveJobDeliverable(ctx, {
      clientId: session.clientId,
      ...(conversationId ? { conversationId } : {}),
      jobId,
      index,
      fileName: document.fileName,
      contentType: document.contentType,
      buffer: document.buffer,
    });
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const current = await tx.clioResearchSession.findFirst({
        where: { id: jobId, tenantId: ctx.tenantId, userId: ctx.userId },
        select: { deliverables: true },
      });
      if (!current) return;
      const deliverables = meriJobDeliverables(current.deliverables);
      if (!deliverables[index]) return;
      deliverables[index] = { ...deliverables[index]!, artifactId: receipt.documentId };
      await tx.clioResearchSession.update({
        where: { id: jobId },
        data: { deliverables: deliverables as unknown as Prisma.InputJsonValue },
      });
    });
    return receipt;
  }
}
