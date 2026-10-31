import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import { TenantGuard } from '../../auth/tenant.guard.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { RecipientsService } from './recipients.service.js';
import { DeliveryService } from './delivery.service.js';
import { RecordRuleService } from './record-rule.service.js';
import { DraftAccessService } from './draft-access.service.js';

/** Every service entry verifies the explicit capability and current membership.
 * Unknown bodies are narrowed by runtime validators, including nested controls.
 */
@Controller('legiwatch/deliveries')
@UseGuards(TenantGuard)
export class DeliveryController {
  constructor(
    readonly reports: DraftAccessService,
    readonly recipients: RecipientsService,
    readonly delivery: DeliveryService,
  ) {}
  @Get('record-bill-context') recordBillContext(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query('billId') billId: string,
    @Query('clientId') clientId?: string,
    @Query('folderId') folderId?: string,
  ) {
    if (!this.delivery.recordBriefs) return { events: [], briefs: [], complete: false };
    return this.delivery.recordBriefs.workflow.billContext(ctx, billId, clientId, folderId);
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
}

@Controller('legiwatch/monitoring')
@UseGuards(TenantGuard)
export class MonitoringRuleController {
  constructor(readonly rules: RecordRuleService) {}
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
}
