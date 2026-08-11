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
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';

/**
 * Client file folders (Figma `907:2810` and the Move to Folder modal
 * `907:3355`).
 *
 * Deliberately narrow: upload, delete, presign and confirm all stay with the
 * engagement attachment API that already owns them. This adds only the folder
 * metadata the CRM needs, so there is one attachment pipeline and one stored
 * object per file.
 */

@Injectable()
export class ClientFilesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Folder tree with counts, including the unfiled group. */
  async folders(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.engagementAttachment.groupBy({
        by: ['folder'],
        where: { tenantId: ctx.tenantId, clientId },
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
        where: { id: attachmentId, tenantId: ctx.tenantId, clientId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('File not found for this client');

      return tx.engagementAttachment.update({
        where: { id: attachmentId },
        data: { folder: normalized },
        select: { id: true, fileName: true, folder: true },
      });
    });
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

@Controller('clients/:clientId/files')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientFilesController {
  constructor(private readonly service: ClientFilesService) {}

  @Get('folders')
  folders(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.folders(ctx, clientId);
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
}
