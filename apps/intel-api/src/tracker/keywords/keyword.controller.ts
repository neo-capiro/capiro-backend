import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import { TenantGuard } from '../../auth/tenant.guard.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { FolderTrackerGuard } from '../folders/folder-tracker.controller.js';
import { KeywordRuleService } from './keyword-rule.service.js';
import { KeywordDiscoveryService } from './keyword-discovery.service.js';
import { KeywordDeliveryService } from './keyword-delivery.service.js';
@Controller('legiwatch/keyword-rules')
@UseGuards(TenantGuard, FolderTrackerGuard)
export class KeywordController {
  constructor(
    readonly rules: KeywordRuleService,
    readonly discovery: KeywordDiscoveryService,
    readonly delivery: KeywordDeliveryService,
  ) {}
  @Get() list(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.rules.list(ctx);
  }
  @Post(':id/mappings') mappings(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.rules.reviewMappings(ctx, id, body);
  }
  @Get(':id/delivery-preview') deliveryPreview(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.delivery.readiness(ctx, id);
  }
  @Get(':id/deliveries') deliveryHistory(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.delivery.history(ctx, id);
  }
  @Post(':id/delivery') deliveryActivation(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.delivery.activation(ctx, id, body);
  }
  @Get('staged') staged(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query('sourceAccount') sourceAccount: string,
  ) {
    return this.rules.staged(ctx, sourceAccount);
  }
  @Post('preview') preview(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() body: unknown) {
    return this.rules.preview(ctx, body);
  }
  @Post() create(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() body: unknown) {
    return this.rules.save(ctx, body);
  }
  @Put(':id') save(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.rules.save(ctx, body, id);
  }
  @Post(':id/activation') activation(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.discovery.activation(ctx, id, body);
  }
  @Post('promote/:id') promote(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.rules.promote(ctx, id, body);
  }
  @Post(':id/scans') start(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.discovery.start(ctx, id, body);
  }
  @Get(':id/history') history(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.discovery.history(ctx, id);
  }
  @Get('scans/:id') run(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.discovery.read(ctx, id);
  }
  @Post('scans/:id/continue') advance(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.discovery.advance(ctx, id);
  }
  @Get('suggestions/:folderId') suggestions(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('folderId') folderId: string,
    @Query() query: unknown,
  ) {
    return this.discovery.suggestions(ctx, folderId, query);
  }
  @Post('suggestions/:id/decision') decide(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.discovery.decide(ctx, id, body);
  }
  @Post('suggestions/batch') batch(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() body: unknown,
  ) {
    return this.discovery.batch(ctx, body);
  }
}
