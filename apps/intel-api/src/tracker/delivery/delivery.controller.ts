import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
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
  @Get('runs/:id') run(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
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
  // Operational recovery for the retained briefing, hearing and keyword queue.
  // These endpoints currently have no frontend caller: held work requires a
  // fresh authorization check, and uncertain sends require an explicit outcome
  // so the worker cannot automatically send the same message twice.
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
