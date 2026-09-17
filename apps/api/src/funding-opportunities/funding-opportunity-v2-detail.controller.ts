import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { TenantContext, OpportunitySearchMode, OpportunitySourceV2 } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { FundingOpportunityClientAccessGuard } from './funding-opportunity-client-access.guard.js';
import { FundingOpportunitiesFlagGuard } from './funding-opportunities-flag.guard.js';
import { OPPORTUNITY_SOURCES_V2 } from '@capiro/shared';
import { FundingOpportunityV2DetailService } from './funding-opportunity-v2-detail.service.js';

class DetailQueryDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsIn(['matched', 'all'])
  mode?: OpportunitySearchMode;
}

class SourceClickDto {
  @IsIn(OPPORTUNITY_SOURCES_V2)
  source!: OpportunitySourceV2;

  @IsString()
  @MaxLength(200)
  sourceRecordId!: string;

  @IsOptional()
  @IsUUID()
  clientId?: string | null;

  @IsString()
  @MaxLength(160)
  destinationKind!: string;
}

@Controller('intelligence/opportunities/v2')
@Roles('standard_user')
@UseGuards(RolesGuard, FundingOpportunitiesFlagGuard, FundingOpportunityClientAccessGuard)
export class FundingOpportunityV2DetailController {
  constructor(private readonly detailService: FundingOpportunityV2DetailService) {}

  @Get('detail/:source/:sourceRecordId')
  detail(
    @CurrentTenant() context: TenantContext,
    @Param('source') source: string,
    @Param('sourceRecordId') sourceRecordId: string,
    @Query() query: DetailQueryDto,
  ) {
    return this.detailService.readDetail(
      { tenantId: context.tenantId, userId: context.userId, role: context.role },
      source,
      sourceRecordId,
      query.clientId ?? null,
      query.mode ?? 'all',
    );
  }

  @Post('source-clicks')
  sourceClick(@CurrentTenant() context: TenantContext, @Body() input: SourceClickDto) {
    return this.detailService.auditSourceClick(
      { tenantId: context.tenantId, userId: context.userId, role: context.role },
      { ...input, clientId: input.clientId ?? null },
    );
  }
}
