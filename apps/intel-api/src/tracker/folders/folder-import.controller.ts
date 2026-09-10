import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { TenantGuard } from '../../auth/tenant.guard.js';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { FolderTrackerGuard } from './folder-tracker.controller.js';
import { FolderImportService } from './folder-import.service.js';
import { FolderReportService } from './folder-report.service.js';
import { PreviewFolderImportDto, ApplyFolderImportDto } from './folder-import.dto.js';

@Controller('legiwatch/folder-imports')
@UseGuards(TenantGuard, FolderTrackerGuard)
export class FolderImportController {
  constructor(
    private readonly svc: FolderImportService,
    private readonly reports: FolderReportService,
  ) {}
  @Get() runs(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.svc.runs(ctx);
  }
  @Post('preview') preview(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() input: PreviewFolderImportDto,
  ) {
    return this.svc.preview(ctx, input);
  }
  @Get(':id') reconcile(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Query('offset') offset = '0',
  ) {
    const value = Number(offset);
    if (!Number.isSafeInteger(value) || value < 0) throw new BadRequestException('INVALID_OFFSET');
    return this.svc.reconcile(ctx, id, value);
  }
  @Post(':id/apply') apply(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() input: ApplyFolderImportDto,
  ) {
    return this.svc.apply(ctx, id, input);
  }
  @Post(':id/pause') pause(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.svc.pause(ctx, id, true);
  }
  @Post(':id/resume') resume(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.svc.pause(ctx, id, false);
  }
  @Post(':id/compensate') compensate(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() input: ApplyFolderImportDto,
  ) {
    return this.svc.compensate(ctx, id, input);
  }
  @Get(':id/items/:itemId') details(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    return this.svc.details(ctx, id, itemId);
  }
  @Get(':id/report/:reportId') report(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('reportId') reportId: string,
    @Query('asOf') asOf: string,
  ) {
    return this.reports.preview(ctx, id, reportId, asOf);
  }
}
