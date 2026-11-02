import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ProcurementMoneyFlowService } from './procurement-money-flow.service.js';

/** Shared public-source data, behind Core's existing authenticated tenant/role boundary. */
@Controller('defense-budget/procurement')
@UseGuards(RolesGuard)
@Roles('standard_user', 'user_admin', 'capiro_admin')
export class ProcurementMoneyFlowController {
  constructor(private readonly service: ProcurementMoneyFlowService) {}
  @Post('money-flow')
  moneyFlow(@CurrentTenant() context: TenantContext, @Body() scope: unknown) { return this.service.moneyFlow(context.tenantId, scope); }
}

/** Procurement summary is separate from Hub's existing opportunity-count metric. */
@Controller('hub/procurement')
@UseGuards(RolesGuard)
@Roles('standard_user', 'user_admin', 'capiro_admin')
export class ProcurementHubController {
  constructor(private readonly service: ProcurementMoneyFlowService) {}
  @Post('summary')
  summary(@CurrentTenant() context: TenantContext, @Body() scope: unknown) { return this.service.hubSummary(context.tenantId, scope); }
}
