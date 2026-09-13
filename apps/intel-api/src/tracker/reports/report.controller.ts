import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import { TenantGuard } from '../../auth/tenant.guard.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { ReportService } from './report.service.js';
import { ReportRecipientsService } from './recipients.service.js';
import { ReportDeliveryService } from './report-delivery.service.js';
import { ReportSubscriptionService } from './report-subscription.service.js';
import { RecordRuleService } from './record-rule.service.js';
import { object, text } from './report-domain.js';

/** Every service entry verifies the explicit capability and current membership.
 * Unknown bodies are narrowed by runtime validators, including nested controls.
 */
@Controller('legiwatch/reports')
@UseGuards(TenantGuard)
export class ReportController {
  constructor(
    readonly reports: ReportService,
    readonly recipients: ReportRecipientsService,
    readonly delivery: ReportDeliveryService,
    readonly subscriptions: ReportSubscriptionService,
    readonly rules: RecordRuleService,
  ) {}
  @Get() list(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.reports.list(ctx);
  }
  @Post() create(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() body: unknown) {
    return this.reports.save(ctx, body);
  }
  @Get('staged') staged(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.reports.staged(ctx);
  }
  @Get('record-brief-options') recordBriefOptions(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query('reportId') reportId: string,
    @Query('offset') offset = '0',
  ) {
    if (!this.delivery.recordBriefs) return { options: [], next: null };
    return this.delivery.recordBriefs.reportOptions(ctx, reportId, Number(offset));
  }
  @Get('record-bill-context') recordBillContext(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query('billId') billId: string,
    @Query('clientId') clientId?: string,
    @Query('folderId') folderId?: string,
  ) {
    if (!this.delivery.recordBriefs) return { events: [], briefs: [], complete: false };
    return this.delivery.recordBriefs.workflow.billContext(ctx, billId, clientId, folderId);
  }
  @Post('promote/:id') promote(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.reports.promote(ctx, id);
  }
  @Get('history') history(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query('reportId') reportId?: string,
    @Query('before') before?: string,
  ) {
    return this.reports.history(ctx, reportId, before);
  }
  @Get('runs/:id') run(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.reports.run(ctx, id);
  }
  @Get('runs/:id/export') export(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.reports.run(ctx, id);
  }
  @Post('runs/:id/compose') compose(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.delivery.preview(ctx, id, body);
  }
  @Post('runs/:id/send') send(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.delivery.approve(ctx, id, body);
  }
  @Get('runs/:id/deliveries') deliveries(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.delivery.history(ctx, id);
  }
  @Post('deliveries/:id/retry') retryDelivery(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.delivery.retryHeld(ctx, id, body);
  }
  @Post('deliveries/:id/reconcile') reconcile(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.delivery.reconcile(ctx, id, body);
  }
  @Get('recipients') directory(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.recipients.directory(ctx);
  }
  @Post('recipients/promote') promoteContacts(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() body: unknown,
  ) {
    return this.recipients.promote(ctx, text(object(body).sourceAccount));
  }
  @Post('contacts') contact(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() body: unknown) {
    return this.recipients.saveContact(ctx, body);
  }
  @Put('contacts/:id') editContact(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.recipients.saveContact(ctx, body, id);
  }
  @Post('lists') listCreate(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() body: unknown) {
    return this.recipients.saveList(ctx, body);
  }
  @Put('lists/:id') listEdit(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.recipients.saveList(ctx, body, id);
  }
  @Get('subscriptions') schedules(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.subscriptions.list(ctx);
  }
  @Post('subscriptions') scheduleCreate(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() body: unknown,
  ) {
    return this.subscriptions.save(ctx, body);
  }
  @Put('subscriptions/:id') scheduleEdit(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.subscriptions.save(ctx, body, id);
  }
  @Post('subscriptions/:id/activation') scheduleActivation(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.subscriptions.activation(ctx, id, body);
  }
  @Post('subscriptions/:id/run-now') scheduleRunNow(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.subscriptions.runNow(ctx, id, body);
  }
  @Get('subscriptions/:id/history') scheduleHistory(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.subscriptions.history(ctx, id);
  }
  @Post('occurrences/:id/retry') retryOccurrence(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.subscriptions.retry(ctx, id);
  }
  @Get('rules') ruleList(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.rules.list(ctx);
  }
  @Post('rules/promote/:id') rulePromote(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.rules.promote(ctx, id, body);
  }
  @Put('rules/:id') ruleSave(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.rules.save(ctx, id, body);
  }
  @Get('rules/:id/readiness') rulePreview(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.rules.readiness(ctx, id);
  }
  @Post('rules/:id/activation') ruleActivation(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.rules.activation(ctx, id, body);
  }
  @Put(':id') update(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.reports.save(ctx, body, id);
  }
  @Post(':id/duplicate') duplicate(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.reports.duplicate(ctx, id);
  }
  @Post(':id/generate') generate(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.reports.generate(ctx, id, body);
  }
}
