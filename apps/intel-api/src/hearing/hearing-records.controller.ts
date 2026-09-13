import { Body, Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { HearingRecordWorkflowService } from './hearing-record-workflow.service.js';
import { HearingRecordDeliveryService } from './hearing-record-delivery.service.js';
@Controller('hearing-events/:eventId/published-records')
@UseGuards(TenantGuard)
export class HearingRecordsController {
  constructor(
    readonly records: HearingRecordWorkflowService,
    readonly delivery: HearingRecordDeliveryService,
  ) {}
  @Post('correction-source')
  correctionSource(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    return this.records.correctionSource(ctx, eventId, body);
  }
  @Post('refresh')
  refresh(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('eventId') eventId: string) {
    return this.records.refreshRecords(ctx, eventId);
  }
  @Get('history')
  @Header('Cache-Control', 'private, no-store')
  history(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Query('offset') offset = '0',
  ) {
    return this.records.history(ctx, eventId, Number(offset));
  }
  @Get('evidence/:recordId')
  @Header('Cache-Control', 'private, no-store')
  evidence(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Param('recordId') id: string,
    @Query('locator') locator?: string,
  ) {
    return this.records.evidence(ctx, eventId, id, locator);
  }
  @Post('briefs/:id/versions')
  edit(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.records.editBrief(ctx, eventId, id, body);
  }
  @Post('briefs/:id/delivery-preview')
  previewDelivery(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.delivery.preview(ctx, eventId, id, body);
  }
  @Post('briefs/:id/deliveries')
  enqueue(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.delivery.enqueue(ctx, eventId, id, body);
  }
  @Get('briefs/:id/prior-audience')
  @Header('Cache-Control', 'private, no-store')
  priorAudience(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
  ) {
    return this.delivery.priorAudience(ctx, eventId, id);
  }
  @Get('briefs/:id/deliveries')
  @Header('Cache-Control', 'private, no-store')
  deliveries(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Query('offset') offset = '0',
  ) {
    return this.delivery.history(ctx, eventId, id, Number(offset));
  }
  @Post('reconciliations/:id/briefs')
  generateBrief(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.records.generateBrief(ctx, eventId, id, body);
  }
  @Get('briefs/:id')
  @Header('Cache-Control', 'private, no-store')
  brief(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
  ) {
    return this.records.brief(ctx, eventId, id);
  }
  @Post('briefs/:id/approve')
  approveBrief(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.records.approveBrief(ctx, eventId, id, body);
  }
  @Get('briefs/:id/approved-document')
  @Header('Cache-Control', 'private, no-store')
  document(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Query('contentHash') hash: string,
  ) {
    return this.records.approvedDocument(ctx, eventId, id, hash);
  }
  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Query('offset') offset = '0',
  ) {
    return this.records.listRecords(ctx, eventId, Number(offset));
  }
  @Post('reconciliations')
  reconcile(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    return this.records.reconcile(ctx, eventId, body);
  }
  @Get('reconciliations/:id')
  @Header('Cache-Control', 'private, no-store')
  run(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Query('offset') offset = '0',
  ) {
    return this.records.runPage(ctx, eventId, id, Number(offset));
  }
  @Post('reconciliations/:id/assessments/:assessmentId/reviews')
  review(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Param('assessmentId') assessmentId: string,
    @Body() body: unknown,
  ) {
    return this.records.review(ctx, eventId, id, assessmentId, body);
  }
}
