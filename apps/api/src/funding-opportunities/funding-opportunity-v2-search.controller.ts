import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { FundingOpportunitiesFlagGuard } from './funding-opportunities-flag.guard.js';
import {
  FundingOpportunityV2SearchService,
  normalizeOpportunitySearchQuery,
} from './funding-opportunity-v2-search.service.js';

@Controller('intelligence/opportunities/v2')
@Roles('standard_user')
@UseGuards(RolesGuard, FundingOpportunitiesFlagGuard)
export class FundingOpportunityV2SearchController {
  constructor(private readonly searchService: FundingOpportunityV2SearchService) {}

  @Get('search')
  search(@CurrentTenant() context: TenantContext, @Query() query: Record<string, unknown>) {
    try {
      const criteria = normalizeOpportunitySearchQuery(query);
      return this.searchService.search(
        { tenantId: context.tenantId, userId: context.userId },
        criteria,
      );
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Invalid opportunity search criteria.');
    }
  }

  @Get('sources')
  sources(@CurrentTenant() context: TenantContext) {
    return this.searchService.readSourceHealth({ tenantId: context.tenantId, userId: context.userId });
  }
}
