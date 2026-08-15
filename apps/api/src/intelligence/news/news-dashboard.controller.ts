import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import {
  NewsCatcherDashboardService,
  type NewsDashboardFilterInput,
} from './news-catcher-dashboard.service.js';

/**
 * Dashboard-specific boundary for NewsCatcher intelligence.
 *
 * Filters are optional and user-scoped by the web client. They change provider
 * retrieval + Capiro relevance inputs rather than merely hiding already-selected
 * cards in the browser. Missing filters preserve the original all-portfolio,
 * balanced 48-hour behavior.
 */
@Controller('intelligence/news')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class NewsDashboardController {
  constructor(private readonly news: NewsCatcherDashboardService) {}

  @Get('dashboard')
  dashboard(
    @CurrentTenant() ctx: TenantContext,
    @Query('clients') clients?: string,
    @Query('topics') topics?: string,
    @Query('signals') signals?: string,
    @Query('custom') custom?: string,
    @Query('lookback') lookback?: string,
  ) {
    const filters: NewsDashboardFilterInput = {
      clientIds: splitClientIds(clients),
      policyTopics: splitCsv(topics),
      signalKinds: splitCsv(signals),
      customTopics: splitCustomTopics(custom),
      lookback,
    };
    return this.news.getDashboard(ctx.tenantId, filters);
  }
}

function splitCsv(value?: string): string[] | undefined {
  if (!value) return undefined;
  const rows = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return rows.length ? rows : undefined;
}

function splitClientIds(value?: string): string[] | undefined {
  const rows = splitCsv(value);
  if (!rows) return undefined;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (rows.some((item) => !uuidPattern.test(item))) {
    throw new BadRequestException('Invalid client filter.');
  }
  return rows.slice(0, 100);
}

function splitCustomTopics(value?: string): string[] | undefined {
  const rows = splitCsv(value);
  if (!rows) return undefined;
  return rows.slice(0, 20).map((item) => item.slice(0, 120));
}
