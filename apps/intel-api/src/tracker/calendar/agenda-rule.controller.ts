import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import { TenantGuard } from '../../auth/tenant.guard.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { AgendaRuleService } from './agenda-rule.service.js';
@Controller('legiwatch/agenda-rules')
@UseGuards(TenantGuard)
export class AgendaRuleController {
  constructor(readonly rules: AgendaRuleService) {}
  @Get() list(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.rules.list(ctx);
  }
  @Get('staged') staged(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.rules.staged(ctx);
  }
  @Post('promote/:id') promote(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.rules.promote(ctx, id, body);
  }
  @Put(':id') save(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.rules.save(ctx, id, body);
  }
  @Get(':id/readiness') readiness(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.rules.readiness(ctx, id);
  }
  @Post(':id/activation') activation(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.rules.activation(ctx, id, body);
  }
}
