import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { PlannerContextGuard } from './planner-context.guard.js';
import {
  PlannerAttachmentsService,
  PLANNER_ATTACHMENT_LIMIT,
  type PlannerUpload,
} from './planner-attachments.service.js';
@Controller('planner/tasks/:taskId/attachments')
@UseGuards(TenantGuard, PlannerContextGuard)
export class PlannerAttachmentsController {
  constructor(private readonly attachments: PlannerAttachmentsService) {}
  @Get() list(@CurrentTenant() ctx: AuthTenantContext, @Param('taskId') taskId: string) {
    return this.attachments.list(ctx, taskId);
  }
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: PLANNER_ATTACHMENT_LIMIT, files: 1, fields: 0 },
    }),
  )
  upload(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('taskId') taskId: string,
    @UploadedFile() file: PlannerUpload | undefined,
  ) {
    return this.attachments.upload(ctx, taskId, file);
  }
  @Patch(':id') archive(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('taskId') taskId: string,
    @Param('id') id: string,
    @Body() dto: unknown,
  ) {
    return this.attachments.archive(ctx, taskId, id, dto);
  }
  @Get(':id/download') async download(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('taskId') taskId: string,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { row, response } = await this.attachments.download(ctx, taskId, id);
    if (!response.Body) throw new NotFoundException('Attachment unavailable');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(row.sizeBytes));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(row.fileName).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('Cache-Control', 'private, no-store');
    await pipeline(response.Body as Readable, res);
  }
}
