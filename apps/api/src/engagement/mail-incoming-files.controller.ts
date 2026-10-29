import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { EngagementRuntimeAction } from './runtime/engagement-runtime-action.decorator.js';
import { MailIncomingFilesService } from './mail-incoming-files.service.js';
import { incomingObject } from './mail-incoming-files.js';

@Controller('engagement/mail/threads/:threadId/messages/:messageId/files')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MailIncomingFilesController {
  constructor(private readonly files: MailIncomingFilesService) {}

  @Get()
  @EngagementRuntimeAction('attachment_external_read')
  manifest(@CurrentTenant() ctx: TenantContext, @Param('threadId') threadId: string,
    @Param('messageId') messageId: string, @Query() query: Record<string, unknown>) {
    if (Object.keys(query).some(key => !['updatedAt', 'clientId'].includes(key))) throw new BadRequestException('Invalid file manifest query');
    return this.files.read(ctx, { ...query, threadId, messageId });
  }

  @Post('import')
  @EngagementRuntimeAction('attachment_external_write')
  importFile(@CurrentTenant() ctx: TenantContext, @Param('threadId') threadId: string,
    @Param('messageId') messageId: string, @Body() body: unknown) {
    const row = incomingObject(body);
    if (Object.keys(row).some(key => !['updatedAt', 'clientId', 'fileKey', 'manifestSha256'].includes(key)))
      throw new BadRequestException('Invalid file import request');
    const { fileKey, manifestSha256, ...original } = row;
    return this.files.read(ctx, { ...original, threadId, messageId }, { fileKey, manifestSha256 });
  }
}
