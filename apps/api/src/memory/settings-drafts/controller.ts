import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../../auth/roles.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { SettingsMemoryDraftService } from './service.js';
import { SettingsMemorySubmissionService } from './submission.js';

@Controller('memory/settings/:type/:slug/drafts')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class SettingsMemoryDraftController {
  constructor(
    private readonly drafts: SettingsMemoryDraftService,
    private readonly submissions: SettingsMemorySubmissionService,
  ) {}
  @Post(':id/submit')
  submit(
    @CurrentTenant() ctx: TenantContext,
    @Param('type') type: string,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.submissions.submit(ctx, type, slug, id, body);
  }
  @Get(':id/submissions/:requestId')
  submissionReceipt(
    @CurrentTenant() ctx: TenantContext,
    @Param('type') type: string,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
  ) {
    return this.submissions.receipt(ctx, type, slug, id, requestId);
  }
  @Get()
  file(
    @CurrentTenant() ctx: TenantContext,
    @Param('type') type: string,
    @Param('slug') slug: string,
  ) {
    return this.drafts.readFile(ctx, type, slug);
  }
  @Get(':id')
  read(
    @CurrentTenant() ctx: TenantContext,
    @Param('type') type: string,
    @Param('slug') slug: string,
    @Param('id') id: string,
  ) {
    return this.drafts.read(ctx, type, slug, id);
  }
  @Put(':id')
  save(
    @CurrentTenant() ctx: TenantContext,
    @Param('type') type: string,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.drafts.save(ctx, type, slug, id, body);
  }
  @Get(':id/receipts/:requestId')
  receipt(
    @CurrentTenant() ctx: TenantContext,
    @Param('type') type: string,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
  ) {
    return this.drafts.receipt(ctx, type, slug, id, requestId);
  }
}
