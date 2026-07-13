import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsISO8601, IsOptional } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { TrustMetricsService } from './trust-metrics.service.js';

class TrustMetricsQueryDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

/**
 * P3 — trust/eval metrics rollup (§12.6). Sits beside product-metrics under
 * the same controller prefix + guard. standard_user-readable (any real firm
 * user); RLS scopes to the caller's tenant. Route: GET /api/intelligence/metrics/trust
 */
@Controller('intelligence/metrics')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class TrustMetricsController {
  constructor(private readonly trustMetrics: TrustMetricsService) {}

  @Get('trust')
  getTrust(@CurrentTenant() ctx: TenantContext, @Query() query: TrustMetricsQueryDto) {
    return this.trustMetrics.getTrustMetrics(ctx, {
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    });
  }
}
