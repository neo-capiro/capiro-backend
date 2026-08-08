import { Controller, Get, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { NewsCatcherDashboardService } from './news-catcher-dashboard.service.js';

/**
 * Small dashboard-specific boundary for the NewsCatcher MVP.
 *
 * The provider is optional: an environment without NEWSCATCHER_API_KEY returns
 * an explicit `available:false` payload rather than failing application boot or
 * turning a missing vendor credential into a dashboard 500.
 */
@Controller('intelligence/news')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class NewsDashboardController {
  constructor(private readonly news: NewsCatcherDashboardService) {}

  @Get('dashboard')
  dashboard(@CurrentTenant() ctx: TenantContext) {
    return this.news.getDashboard(ctx.tenantId);
  }
}
