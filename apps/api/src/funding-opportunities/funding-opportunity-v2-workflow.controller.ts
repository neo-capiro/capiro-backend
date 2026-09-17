import { Body, Controller, Delete, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { OPPORTUNITY_SOURCES_V2, type TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { FundingOpportunitiesFlagGuard } from './funding-opportunities-flag.guard.js';
import { FundingOpportunityClientAccessGuard } from './funding-opportunity-client-access.guard.js';
import { FundingOpportunityV2WorkflowService, NOT_FIT_REASONS, type NotFitReasonV2 } from './funding-opportunity-v2-workflow.service.js';

class CurrentSourceRecordParamDto {
  @IsIn(OPPORTUNITY_SOURCES_V2) source!: string;
  @IsString() @MaxLength(256) sourceRecordId!: string;
  @IsOptional() @IsUUID() clientId?: string;
}
class WorkspaceSaveV2Dto {
  @IsOptional() @IsIn(['saved']) status?: 'saved';
}
class NotFitV2Dto { @IsIn(Object.keys(NOT_FIT_REASONS)) reason!: NotFitReasonV2; @IsOptional() @IsString() @MaxLength(4000) note?: string | null; }

@Controller('intelligence')
@Roles('standard_user')
@UseGuards(RolesGuard, FundingOpportunitiesFlagGuard, FundingOpportunityClientAccessGuard)
export class FundingOpportunityV2WorkflowController {
  constructor(private readonly service: FundingOpportunityV2WorkflowService) {}


  @Delete('clients/:clientId/opportunities/:source/:sourceRecordId/save')
  clientUnsave(@CurrentTenant() ctx: TenantContext, @Param() params: CurrentSourceRecordParamDto) { return this.service.unsave(ctx, params.source, params.sourceRecordId, params.clientId!); }
  @Post('opportunities/:source/:sourceRecordId/save')
  workspaceSave(@CurrentTenant() ctx: TenantContext, @Param() params: CurrentSourceRecordParamDto, @Body() body: WorkspaceSaveV2Dto) { return this.service.save(ctx, params.source, params.sourceRecordId, null, body.status ?? 'saved'); }
  @Delete('opportunities/:source/:sourceRecordId/save')
  workspaceUnsave(@CurrentTenant() ctx: TenantContext, @Param() params: CurrentSourceRecordParamDto) { return this.service.unsave(ctx, params.source, params.sourceRecordId, null); }
  @Post('clients/:clientId/opportunities/:source/:sourceRecordId/not-fit')
  notFit(@CurrentTenant() ctx: TenantContext, @Param() params: CurrentSourceRecordParamDto, @Body() body: NotFitV2Dto) { return this.service.notFit(ctx, params.clientId!, params.source, params.sourceRecordId, body.reason, body.note ?? null); }

}