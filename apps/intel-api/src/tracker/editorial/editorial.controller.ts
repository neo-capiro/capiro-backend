import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import { TenantGuard } from '../../auth/tenant.guard.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { FolderTrackerGuard } from '../folders/folder-tracker.controller.js';
import { WorkflowSourceGuard } from '../keywords/internal-workflow.controller.js';
import { Phase8EvidenceService } from './evidence.service.js';
import { EditorialService } from './editorial.service.js';
@Controller('legiwatch/evidence')
@UseGuards(TenantGuard, FolderTrackerGuard)
export class Phase8Controller {
  constructor(
    readonly evidence: Phase8EvidenceService,
    readonly editorial: EditorialService,
  ) {}
  @Get('news') news(@CurrentTenant() ctx: WorkspaceTenantContext, @Query() b: unknown) {
    return this.evidence.news(ctx, b);
  }
  @Get('news/monitors') monitors(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.evidence.monitors(ctx);
  }
  @Post('news/monitors/:id/configure') configureMonitor(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.evidence.configureMonitor(ctx, id, b);
  }
  @Post('news/monitors/:id/scan') scan(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.evidence.scan(ctx, id);
  }
  @Get('budget') budget(@CurrentTenant() ctx: WorkspaceTenantContext, @Query() b: unknown) {
    return this.evidence.budget(ctx, b);
  }
  @Post('budget/compare') compare(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() b: unknown,
  ) {
    return this.evidence.compare(ctx, b);
  }
  @Get('personnel') personnel(@CurrentTenant() ctx: WorkspaceTenantContext, @Query() b: unknown) {
    return this.evidence.personnel(ctx, b);
  }
  @Post('track') track(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() b: unknown) {
    return this.evidence.track(ctx, b);
  }
  @Get('source/:kind/:id') exact(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Query() b: unknown,
  ) {
    return this.evidence.run(ctx, b, kind === 'budget' ? 'budget' : 'news', (tx) =>
      this.evidence.exact(tx, kind, id),
    );
  }
  @Post('imports/preview') previewImport(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() b: unknown,
  ) {
    return this.evidence.importPreview(ctx, b);
  }
  @Post('imports/stage') stageImport(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() b: unknown,
  ) {
    return this.evidence.importPreview(ctx, b, true);
  }
  @Post('briefings/drafts') draft(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() b: unknown,
  ) {
    return this.editorial.save(ctx, b);
  }
  @Post('briefings/preview') preview(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() b: unknown,
  ) {
    return this.editorial.preview(ctx, b);
  }
  @Post('briefings/approve') approve(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() b: unknown,
  ) {
    return this.editorial.approve(ctx, b);
  }
  @Get('briefings/configurations') configurations(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.editorial.configurations(ctx);
  }
  @Post('briefings/configurations/:id') configure(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.editorial.configure(ctx, id, b);
  }
  @Post('briefings/configurations/:id/activation') activate(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.editorial.activation(ctx, id, b);
  }
}
@Controller('internal/legiwatch/editorial-source')
@UseGuards(WorkflowSourceGuard)
export class EditorialSourceController {
  constructor(readonly editorial: EditorialService) {}
  @Get(':id') source(
    @Param('id') id: string,
    @Query('tenantId') tenantId: string,
    @Query('ownerId') clerkUserId: string,
  ) {
    return this.editorial.source({ tenantId, clerkUserId, role: null }, id);
  }
  @Get(':id/access') async access(
    @Param('id') id: string,
    @Query('tenantId') tenantId: string,
    @Query('ownerId') clerkUserId: string,
  ) {
    await this.editorial.source({ tenantId, clerkUserId, role: null }, id);
    return { selectionId: id, allowed: true };
  }
}
