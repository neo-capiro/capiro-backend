import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Injectable,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { CLIENT_STORAGE_QUOTA_BYTES } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { requireOwnerClient } from './client-ordered-owner.access.js';
import { lockFileAccessRows } from './client-file-access-authority.js';
import {
  commitFileAccess,
  getFileAccessReceipt,
  FILE_ACCESS_TRANSACTION_TIMEOUT_MS,
} from './client-file-access-command.js';
import { parseFileAccessCommand } from './client-file-access-input.js';

type StorageUsage = {
  clientId: string;
  source: 'engagement_attachments';
  usageBasis: 'registered_attachments';
  allowanceScope: 'client';
  asOf: string;
  allowanceBytes: number;
  enforcement: 'report_only';
} & (
  | { status: 'available'; usedBytes: number; remainingBytes: number; overAllowance: boolean }
  | {
      status: 'unavailable';
      reason: 'incomplete_size_metadata' | 'unsafe_total';
      usedBytes: null;
      remainingBytes: null;
      overAllowance: null;
    }
);

@Injectable()
export class ClientFilesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Registered client storage, independent of file-list visibility and paging. */
  async storageUsage(ctx: TenantContext, clientId: string): Promise<StorageUsage> {
    return this.prisma.withTenant<StorageUsage>(ctx.tenantId, async (tx) => {
      // Use the same current membership, archive and ethical-wall boundary as
      // the client team/owner reads. File access is not authority to read bytes
      // or metadata of other files; this response exposes only their aggregate.
      await requireOwnerClient(tx, ctx, clientId);
      const [usage] = await tx.$queryRaw<
        Array<{ usedBytes: string; incomplete: boolean; asOf: Date }>
      >`
        SELECT COALESCE(SUM(byte_size::bigint), 0)::text AS "usedBytes",
          COALESCE(BOOL_OR(byte_size IS NULL OR byte_size < 0), false) AS incomplete,
          statement_timestamp() AS "asOf"
        FROM engagement_attachments
        WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${clientId}::uuid
          AND prospect_id IS NULL`;
      if (!usage) throw new Error('Storage aggregate did not return a snapshot');
      // The tenant+s3_key unique index makes one row one registered object.
      // All lifecycle states and superseded versions count until deletion
      // removes the row. Do not apply viewer/owner/readiness/list predicates.
      const base = {
        clientId,
        source: 'engagement_attachments' as const,
        usageBasis: 'registered_attachments' as const,
        allowanceScope: 'client' as const,
        asOf: usage.asOf.toISOString(),
        allowanceBytes: CLIENT_STORAGE_QUOTA_BYTES,
        enforcement: 'report_only' as const,
      };
      const usedBytes = Number(usage.usedBytes);
      if (usage.incomplete || !Number.isSafeInteger(usedBytes) || usedBytes < 0) {
        return {
          ...base,
          status: 'unavailable',
          reason: usage.incomplete ? 'incomplete_size_metadata' : 'unsafe_total',
          usedBytes: null,
          remainingBytes: null,
          overAllowance: null,
        };
      }
      return {
        ...base,
        status: 'available',
        usedBytes,
        remainingBytes: Math.max(0, CLIENT_STORAGE_QUOTA_BYTES - usedBytes),
        overAllowance: usedBytes > CLIENT_STORAGE_QUOTA_BYTES,
      };
    });
  }

  /** Folder tree with counts, including the unfiled group. */
  async folders(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
      const rows = await tx.engagementAttachment.groupBy({
        by: ['folder'],
        where: {
          prospectId: null,
          tenantId: ctx.tenantId,
          clientId,
          // A restricted file the caller cannot view is not "in" the folder for them.
          OR: this.visibleWhere(ctx.userId),
        },
        _count: { _all: true },
      });
      return rows
        .map((row) => ({ folder: row.folder, count: row._count._all }))
        .sort((a, b) => (a.folder ?? '').localeCompare(b.folder ?? ''));
    });
  }

  /** Access reads return the revision the user actually reviewed. */
  async getAccess(ctx: TenantContext, clientId: string, attachmentId: string) {
    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        const [row] = await lockFileAccessRows(tx, ctx, clientId, [attachmentId]);
        return {
          id: row!.id,
          fileName: row!.fileName,
          folder: row!.folder,
          metadataRevision: row!.metadataRevision,
          viewerMode: row!.viewerMode,
          viewerUserIds: row!.viewerUserIds,
          uploadedByUserId: row!.uploadedByUserId,
        };
      },
      { timeoutMs: FILE_ACCESS_TRANSACTION_TIMEOUT_MS },
    );
  }

  setAccess(ctx: TenantContext, clientId: string, attachmentId: string, raw: unknown) {
    const command = parseFileAccessCommand(clientId, raw);
    if (command.operation !== 'file-access' || command.files[0]!.id !== attachmentId)
      throw new BadRequestException('The reviewed file does not match this route');
    return commitFileAccess(this.prisma, ctx, clientId, command);
  }

  setFolderAccess(ctx: TenantContext, clientId: string, raw: unknown) {
    const command = parseFileAccessCommand(clientId, raw);
    if (command.operation !== 'folder-access')
      throw new BadRequestException('A reviewed folder access change is required');
    return commitFileAccess(this.prisma, ctx, clientId, command);
  }

  accessReceipt(ctx: TenantContext, clientId: string, requestId: string) {
    return getFileAccessReceipt(this.prisma, ctx, clientId, requestId);
  }

  private visibleWhere(userId: string) {
    return [
      { viewerMode: 'all' },
      { viewerMode: 'restricted', viewerUserIds: { has: userId } },
      { uploadedByUserId: userId },
    ];
  }
}

@Controller('clients/:clientId/files')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientFilesController {
  constructor(private readonly service: ClientFilesService) {}

  @Get('storage-usage')
  @Header('Cache-Control', 'no-store')
  storageUsage(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
  ) {
    return this.service.storageUsage(ctx, clientId);
  }

  @Get('folders')
  @Header('Cache-Control', 'no-store')
  folders(@CurrentTenant() ctx: TenantContext, @Param('clientId', ParseUUIDPipe) clientId: string) {
    return this.service.folders(ctx, clientId);
  }

  @Get('access/commands/:requestId')
  @Header('Cache-Control', 'no-store')
  accessReceipt(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.service.accessReceipt(ctx, clientId, requestId);
  }

  @Patch('access/folder')
  @Header('Cache-Control', 'no-store')
  setFolderAccess(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() body: unknown,
  ) {
    return this.service.setFolderAccess(ctx, clientId, body);
  }

  @Get(':attachmentId/access')
  @Header('Cache-Control', 'no-store')
  getAccess(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    return this.service.getAccess(ctx, clientId, attachmentId);
  }

  @Patch(':attachmentId/access')
  @Header('Cache-Control', 'no-store')
  setAccess(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() body: unknown,
  ) {
    return this.service.setAccess(ctx, clientId, attachmentId, body);
  }
}
