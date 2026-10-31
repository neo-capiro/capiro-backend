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
  @Get('source/:kind/:id') exact(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Query() b: unknown,
  ) {
    if (kind === 'research')
      return this.evidence.research.run(ctx, b, (tx) => this.evidence.exact(tx, kind, id));
    return this.evidence.run(ctx, b, 'editorial', (tx) => this.evidence.exact(tx, kind, id));
  }
  @Post('briefings/drafts') draft(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() b: unknown,
  ) {
    return this.editorial.save(ctx, b);
  }
  @Get('briefings/drafts') drafts(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query() b: unknown,
  ) {
    return this.editorial.history(ctx, b);
  }
  @Get('briefings/configurations/:id/occurrences') occurrences(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Query() b: unknown,
  ) {
    return this.editorial.history(ctx, b, id);
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
