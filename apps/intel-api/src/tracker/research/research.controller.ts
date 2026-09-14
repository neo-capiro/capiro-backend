import { ResearchImportService } from './research-import.service.js';
import { ResearchReportService } from './research-report.service.js';
import { ResearchDeadlineService } from './research-deadline.service.js';
import { StatuteMonitorService } from './statute-monitor.service.js';

import { Body, Controller, Get, Post, Query, UseGuards, Param } from '@nestjs/common';

import { CurrentTenant } from '../../auth/current-tenant.decorator.js';

import { TenantGuard } from '../../auth/tenant.guard.js';

import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';

import { FolderTrackerGuard } from '../folders/folder-tracker.controller.js';

import { ResearchService } from './research.service.js';

import { WorkflowSourceGuard } from '../keywords/internal-workflow.controller.js';

@Controller('legiwatch/research')
@UseGuards(TenantGuard, FolderTrackerGuard)
export class ResearchController {
  constructor(
    readonly research: ResearchService,
    readonly importsService: ResearchImportService,
    readonly researchReports: ResearchReportService,
    readonly researchDeadlines: ResearchDeadlineService,
    readonly monitors: StatuteMonitorService,
  ) {}
  @Get('monitors') monitorList(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.monitors.list(ctx);
  }
  @Post('monitors/:id/configure') monitorConfigure(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.monitors.configure(ctx, id, body);
  }
  @Post('monitors/:id/preview') monitorPreview(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.monitors.preview(ctx, id);
  }
  @Post('monitors/:id/activation') monitorActivation(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.monitors.activation(ctx, id, body);
  }
  @Post('monitors/:id/scan') monitorScan(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.monitors.scan(ctx, id);
  }
  @Get('monitors/:id/events') monitorEvents(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.monitors.events(ctx, id);
  }
  @Post('deadlines/drafts') deadlineDraft(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() body: unknown,
  ) {
    return this.researchDeadlines.save(ctx, body);
  }
  @Post('reports/preview') reportPreview(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() body: unknown,
  ) {
    return this.researchReports.preview(ctx, body);
  }
  @Post('reports/approve') reportApprove(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() body: unknown,
  ) {
    return this.researchReports.approve(ctx, body);
  }

  @Post('search') search(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() body: unknown) {
    return this.research.search(ctx, body);
  }

  @Post('compare') compare(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() body: unknown) {
    return this.research.compare(ctx, body);
  }

  @Get('versions') versions(@CurrentTenant() ctx: WorkspaceTenantContext, @Query() query: unknown) {
    return this.research.versions(ctx, query);
  }

  @Get('references') references(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query() query: unknown,
  ) {
    return this.research.references(ctx, query);
  }

  @Get('rules') rules(@CurrentTenant() ctx: WorkspaceTenantContext, @Query() query: unknown) {
    return this.research.rules(ctx, query);
  }

  @Get('deadlines') deadlines(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query() query: unknown,
  ) {
    return this.research.deadlines(ctx, query);
  }

  @Get('coverage') coverage(@CurrentTenant() ctx: WorkspaceTenantContext, @Query() query: unknown) {
    return this.research.coverage(ctx, query);
  }

  @Get('memberships') memberships(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query() query: unknown,
  ) {
    return this.research.memberships(ctx, query);
  }

  @Post('memberships') saveMembership(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() body: unknown,
  ) {
    return this.research.saveMembership(ctx, body);
  }

  @Get('imports') imports(@CurrentTenant() ctx: WorkspaceTenantContext, @Query() query: unknown) {
    return this.research.staged(ctx, query);
  }

  @Post('imports/promote') promote(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() body: unknown,
  ) {
    return this.research.promote(ctx, body);
  }

  @Post('imports/decide') decide(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() body: unknown,
  ) {
    return this.importsService.decide(ctx, body);
  }

  @Post('imports/preview') preview(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() body: unknown,
  ) {
    return this.importsService.preview(ctx, body);
  }

  @Post('drafts') draft(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() body: unknown) {
    return this.research.saveResearch(ctx, body);
  }
}

@Controller('internal/legiwatch/research-source')
@UseGuards(WorkflowSourceGuard)
export class ResearchSourceController {
  constructor(readonly research: ResearchService) {}
  @Get(':id/access') access(
    @Param('id') id: string,
    @Query('tenantId') tenantId: string,
    @Query('ownerId') ownerId: string,
  ) {
    return this.research.researchAccess({ tenantId, clerkUserId: ownerId, role: null }, id);
  }
  @Get(':id') source(
    @Param('id') id: string,
    @Query('tenantId') tenantId: string,
    @Query('ownerId') ownerId: string,
  ) {
    return this.research.researchSource({ tenantId, clerkUserId: ownerId, role: null }, id);
  }
}
