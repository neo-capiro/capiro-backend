import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import type { PlannerAttachment, PlannerTaskData, PlannerRole } from '@capiro/strategy-verifier';
import type { Prisma, SpPlannerAttachment } from '../../generated/prisma-client/index.js';
import { plannerTaskAccess } from './planner.service.js';
import { fail, uuid, object, keys } from './planner.validation.js';
import {
  PLANNER_ATTACHMENT_LIMIT,
  plannerAttachmentName,
  type PlannerUpload,
} from './planner-files.js';
export { PLANNER_ATTACHMENT_LIMIT, plannerAttachmentName } from './planner-files.js';
export type { PlannerUpload } from './planner-files.js';
const rank: Record<PlannerRole, number> = { viewer: 0, commenter: 1, editor: 2, admin: 3 };
@Injectable()
export class PlannerAttachmentsService {
  private readonly s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
  constructor(private readonly prisma: PrismaService) {}
  private bucket() {
    const bucket = process.env.ASSETS_BUCKET?.trim();
    if (!bucket)
      throw new ServiceUnavailableException('Planner attachment storage is not configured');
    return bucket;
  }
  private async task(
    tx: Prisma.TransactionClient,
    ctx: AuthTenantContext,
    id: string,
    minimum: PlannerRole,
  ) {
    const row = await tx.spPlannerTask.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!row) throw new NotFoundException('Task unavailable');
    const projects = await tx.spPlannerProject.findMany({ where: { tenantId: ctx.tenantId } });
    const access = plannerTaskAccess(row, projects, ctx.clerkUserId);
    if (!access) throw new NotFoundException('Task unavailable');
    if (rank[access] < rank[minimum])
      throw new ForbiddenException('Planner attachment permission is required');
    return { row, access };
  }
  private view(row: SpPlannerAttachment): PlannerAttachment {
    return {
      id: row.id,
      taskId: row.taskId,
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
      uploadedBy: row.uploadedBy,
      archived: row.archived,
      createdAt: row.createdAt.toISOString(),
    };
  }
  async list(ctx: AuthTenantContext, taskId: string) {
    uuid(taskId);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.task(tx, ctx, taskId, 'viewer');
      return (
        await tx.spPlannerAttachment.findMany({
          where: { tenantId: ctx.tenantId, taskId },
          orderBy: { createdAt: 'desc' },
        })
      ).map((row) => this.view(row));
    });
  }
  async upload(ctx: AuthTenantContext, taskId: string, file: PlannerUpload | undefined) {
    uuid(taskId);
    if (
      !file ||
      file.size <= 0 ||
      file.size > PLANNER_ATTACHMENT_LIMIT ||
      file.size !== file.buffer.length
    )
      fail('Choose a file between 1 byte and 25 MB');
    const fileName = plannerAttachmentName(file.originalname);
    const bucket = this.bucket();
    await this.prisma.withTenant(ctx.tenantId, (tx) => this.task(tx, ctx, taskId, 'commenter'));
    const id = randomUUID(),
      objectKey = `tenants/${ctx.tenantId}/planner/tasks/${taskId}/${id}`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: file.buffer,
        ContentType: 'application/octet-stream',
      }),
    );
    try {
      return await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`planner:${ctx.tenantId}`},0))`;
        const { row: task } = await this.task(tx, ctx, taskId, 'commenter');
        if (task.archived) fail('Restore the task before adding files');
        const row = await tx.spPlannerAttachment.create({
          data: {
            id,
            tenantId: ctx.tenantId,
            taskId,
            uploadedBy: ctx.clerkUserId,
            fileName,
            sizeBytes: file.size,
            objectKey,
          },
        });
        const event = await tx.spPlannerEvent.create({
          data: {
            tenantId: ctx.tenantId,
            taskId,
            actorId: ctx.clerkUserId,
            kind: 'updated',
            text: `Attached ${fileName}`,
          },
        });
        const data = task.data as unknown as PlannerTaskData;
        const recipients = [task.ownerId, data.assigneeId, ...data.collaborators].filter(
          (p): p is string => !!p && p !== ctx.clerkUserId,
        );
        for (const userId of new Set(recipients))
          await tx.spPlannerInbox.create({
            data: { tenantId: ctx.tenantId, userId, eventId: event.id },
          });
        return this.view(row);
      });
    } catch (error) {
      await this.s3
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }))
        .catch(() => undefined);
      throw error;
    }
  }
  async download(ctx: AuthTenantContext, taskId: string, id: string) {
    uuid(taskId);
    uuid(id);
    const bucket = this.bucket();
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.task(tx, ctx, taskId, 'viewer');
      const file = await tx.spPlannerAttachment.findFirst({
        where: { id, tenantId: ctx.tenantId, taskId, archived: false },
      });
      if (!file) throw new NotFoundException('Attachment unavailable');
      return file;
    });
    return {
      row,
      response: await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: row.objectKey })),
    };
  }
  async archive(ctx: AuthTenantContext, taskId: string, id: string, raw: unknown) {
    uuid(taskId);
    uuid(id);
    const dto = object(raw);
    keys(dto, ['archived']);
    if (typeof dto.archived !== 'boolean') fail('Invalid attachment state');
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`planner:${ctx.tenantId}`},0))`;
      const { access } = await this.task(tx, ctx, taskId, 'commenter');
      const row = await tx.spPlannerAttachment.findFirst({
        where: { id, tenantId: ctx.tenantId, taskId },
      });
      if (!row) throw new NotFoundException('Attachment unavailable');
      if (rank[access] < rank.editor && row.uploadedBy !== ctx.clerkUserId)
        throw new ForbiddenException('You can archive only your own attachments');
      return this.view(
        await tx.spPlannerAttachment.update({
          where: { id, tenantId: ctx.tenantId },
          data: { archived: dto.archived as boolean },
        }),
      );
    });
  }
}
