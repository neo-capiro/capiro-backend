import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';

/**
 * Client file folders + per-file view access (Figma `907:2810` / Move to Folder
 * modal `907:3355` / Files "who can view").
 *
 * Deliberately narrow: upload, delete, presign and confirm all stay with the
 * engagement attachment API that already owns them. This adds only the folder
 * metadata and the view-access ACL the CRM needs, so there is one attachment
 * pipeline and one stored object per file.
 *
 * View access:
 *  - `viewerMode: 'all'` (default) — every tenant member can see the file.
 *  - `viewerMode: 'restricted'` — only `viewerUserIds` (plus the uploader, who
 *    always retains access) can see it in the Files list / download it.
 * Folder-level "who can view" is applied by rewriting every attachment that
 * currently carries that folder label — folders are labels, not a table.
 */

export type ViewerMode = 'all' | 'restricted';

@Injectable()
export class ClientFilesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Folder tree with counts, including the unfiled group. */
  async folders(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.engagementAttachment.groupBy({
        by: ['folder'],
        where: { prospectId: null,
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

  /**
   * Move a file between folders. Rewrites metadata only — the S3 object is
   * untouched, so a file referenced from a capability or strategy keeps one
   * canonical copy.
   */
  async move(ctx: TenantContext, clientId: string, attachmentId: string, folder: string | null) {
    const normalized = folder?.trim() || null;
    if (normalized && normalized.length > 120) {
      throw new BadRequestException('Folder name is too long');
    }

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.engagementAttachment.findFirst({
        where: { prospectId: null, id: attachmentId, tenantId: ctx.tenantId, clientId },
        select: { id: true, viewerMode: true, viewerUserIds: true, uploadedByUserId: true },
      });
      if (!existing) throw new NotFoundException('File not found for this client');
      if (!this.canView(ctx.userId, existing)) {
        throw new NotFoundException('File not found for this client');
      }

      return tx.engagementAttachment.update({
        where: { id: attachmentId },
        data: { folder: normalized },
        select: {
          id: true,
          fileName: true,
          folder: true,
          viewerMode: true,
          viewerUserIds: true,
        },
      });
    });
  }

  /** Read the view-access ACL for one file. */
  async getAccess(ctx: TenantContext, clientId: string, attachmentId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.engagementAttachment.findFirst({
        where: { prospectId: null, id: attachmentId, tenantId: ctx.tenantId, clientId },
        select: {
          id: true,
          fileName: true,
          folder: true,
          viewerMode: true,
          viewerUserIds: true,
          uploadedByUserId: true,
        },
      });
      if (!row) throw new NotFoundException('File not found for this client');
      if (!this.canView(ctx.userId, row)) {
        throw new NotFoundException('File not found for this client');
      }
      return {
        id: row.id,
        fileName: row.fileName,
        folder: row.folder,
        viewerMode: row.viewerMode as ViewerMode,
        viewerUserIds: row.viewerUserIds,
        uploadedByUserId: row.uploadedByUserId,
      };
    });
  }

  /**
   * Set who on the team can view a single file. `viewerMode: 'all'` clears the
   * restricted list (it is meaningless under that mode). Restricted lists are
   * de-duplicated and must only contain active tenant members.
   */
  async setAccess(
    ctx: TenantContext,
    clientId: string,
    attachmentId: string,
    viewerMode: ViewerMode,
    viewerUserIds: string[],
  ) {
    const normalizedIds =
      viewerMode === 'all' ? [] : [...new Set(viewerUserIds.map((id) => id.trim()).filter(Boolean))];

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.engagementAttachment.findFirst({
        where: { prospectId: null, id: attachmentId, tenantId: ctx.tenantId, clientId },
        select: { id: true, viewerMode: true, viewerUserIds: true, uploadedByUserId: true },
      });
      if (!existing) throw new NotFoundException('File not found for this client');
      if (!this.canView(ctx.userId, existing)) {
        throw new NotFoundException('File not found for this client');
      }

      if (normalizedIds.length) {
        await this.assertTenantMembers(tx, ctx.tenantId, normalizedIds);
      }

      return tx.engagementAttachment.update({
        where: { id: attachmentId },
        data: { viewerMode, viewerUserIds: normalizedIds },
        select: {
          id: true,
          fileName: true,
          folder: true,
          viewerMode: true,
          viewerUserIds: true,
          uploadedByUserId: true,
        },
      });
    });
  }

  /**
   * Apply the same ACL to every file currently carrying `folder` (or the
   * unfiled group when `folder` is null). Folders are labels on attachments —
   * there is no folder table — so "folder access" is bulk file access.
   */
  async setFolderAccess(
    ctx: TenantContext,
    clientId: string,
    folder: string | null,
    viewerMode: ViewerMode,
    viewerUserIds: string[],
  ) {
    const normalizedFolder = folder?.trim() || null;
    const normalizedIds =
      viewerMode === 'all' ? [] : [...new Set(viewerUserIds.map((id) => id.trim()).filter(Boolean))];

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      if (normalizedIds.length) {
        await this.assertTenantMembers(tx, ctx.tenantId, normalizedIds);
      }

      const result = await tx.engagementAttachment.updateMany({
        where: { prospectId: null,
          tenantId: ctx.tenantId,
          clientId,
          folder: normalizedFolder,
          // Only rewrite files the caller can already see — never a vehicle for
          // changing ACLs on restricted files the caller is not on.
          OR: this.visibleWhere(ctx.userId),
        },
        data: { viewerMode, viewerUserIds: normalizedIds },
      });
      return {
        folder: normalizedFolder,
        viewerMode,
        viewerUserIds: normalizedIds,
        updated: result.count,
      };
    });
  }

  /** Prisma `OR` clause: all-mode files, or restricted files listing the user / uploaded by them. */
  private visibleWhere(userId: string) {
    return [
      { viewerMode: 'all' },
      { viewerMode: 'restricted', viewerUserIds: { has: userId } },
      { uploadedByUserId: userId },
    ];
  }

  private canView(
    userId: string,
    row: { viewerMode: string; viewerUserIds: string[]; uploadedByUserId: string | null },
  ): boolean {
    if (row.viewerMode !== 'restricted') return true;
    if (row.uploadedByUserId && row.uploadedByUserId === userId) return true;
    return row.viewerUserIds.includes(userId);
  }

  private async assertTenantMembers(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
    tenantId: string,
    userIds: string[],
  ) {
    // Same rule account-team assignment enforces: only ACTIVE members of this
    // tenant. Membership lives on tenant_memberships, not users.
    const members = await tx.tenantMembership.findMany({
      where: { tenantId, userId: { in: userIds }, status: 'active' },
      select: { userId: true },
    });
    const found = new Set(members.map((m: { userId: string }) => m.userId));
    const missing = userIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw new BadRequestException(
        'File viewers must be active members of this tenant',
      );
    }
  }
}

class MoveFileDto {
  // `null` is meaningful: it returns the file to the unfiled group.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(120)
  folder?: string | null;
}

class SetAccessDto {
  @IsIn(['all', 'restricted'])
  viewerMode!: ViewerMode;

  /** Required when restricted; ignored (and cleared) when mode is 'all'. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  viewerUserIds?: string[];
}

class SetFolderAccessDto extends SetAccessDto {
  // `null` = the unfiled group.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(120)
  folder?: string | null;
}

@Controller('clients/:clientId/files')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientFilesController {
  constructor(private readonly service: ClientFilesService) {}

  @Get('folders')
  folders(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.folders(ctx, clientId);
  }

  // Folder-level access MUST be registered before `:attachmentId/*` so Nest does
  // not treat the literal "access" as an attachment id.
  @Patch('access/folder')
  setFolderAccess(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: SetFolderAccessDto,
  ) {
    return this.service.setFolderAccess(
      ctx,
      clientId,
      body.folder ?? null,
      body.viewerMode,
      body.viewerUserIds ?? [],
    );
  }

  @Patch(':attachmentId/folder')
  move(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() body: MoveFileDto,
  ) {
    return this.service.move(ctx, clientId, attachmentId, body.folder ?? null);
  }

  @Get(':attachmentId/access')
  getAccess(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.service.getAccess(ctx, clientId, attachmentId);
  }

  @Patch(':attachmentId/access')
  setAccess(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('attachmentId') attachmentId: string,
    @Body() body: SetAccessDto,
  ) {
    return this.service.setAccess(
      ctx,
      clientId,
      attachmentId,
      body.viewerMode,
      body.viewerUserIds ?? [],
    );
  }
}
