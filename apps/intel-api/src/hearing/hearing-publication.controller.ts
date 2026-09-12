import { Body, Controller, Get, Param, Post, Query, UseGuards, Header } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { HearingPublicationService } from './hearing-publication.service.js';

@Controller('hearings/:sessionId/publications')
@UseGuards(TenantGuard)
export class HearingPublicationController {
  constructor(private readonly publications: HearingPublicationService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('sessionId') sessionId: string,
    @Query('kind') kind = 'live_update',
  ) {
    return this.publications.list(ctx, sessionId, kind);
  }
  @Post()
  create(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
  ) {
    return this.publications.create(ctx, sessionId, body);
  }
  @Get('candidates')
  @Header('Cache-Control', 'private, no-store')
  candidates(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('sessionId') sessionId: string,
    @Query('kind') kind = 'live_update',
  ) {
    return this.publications.candidates(ctx, sessionId, kind);
  }
  @Get(':id/deliveries')
  @Header('Cache-Control', 'private, no-store')
  history(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ) {
    return this.publications.deliveryHistory(ctx, sessionId, id);
  }
  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  version(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ) {
    return this.publications.version(ctx, sessionId, id);
  }
  @Post('generate')
  generate(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
  ) {
    return this.publications.generate(ctx, sessionId, body);
  }
  @Post(':id/approve')
  approve(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.publications.approve(ctx, sessionId, id, body);
  }
  @Get(':id/approved-document')
  @Header('Cache-Control', 'private, no-store')
  approvedDocument(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Query('contentHash') contentHash: string,
  ) {
    return this.publications.approvedDocument(ctx, sessionId, id, contentHash);
  }
  @Post(':id/delivery-preview')
  preview(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.publications.previewDelivery(ctx, sessionId, id, body);
  }
  @Post(':id/deliveries')
  enqueue(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.publications.enqueue(ctx, sessionId, id, body);
  }
}
