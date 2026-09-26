import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsObject, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import type { ActionStatus } from '../../intelligence/actions/action-recommendation.types.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { DistrictNexusFlagGuard } from '../district-nexus-flag.guard.js';
import { R5FlagGuard, RequireR5Feature, DISTRCT_NEXUS_R5_ACTIONS } from './r5-flag.guard.js';
import { R5DistrictActionsService, type ActionText } from './r5-district-actions.service.js';

class ActionScopeDto {
  @IsUUID() clientId!: string;
  @Matches(/^[A-Za-z]{2}$/) state!: string;
  @Matches(/^\d{2}$/) district!: string;
}
class StageDto extends ActionScopeDto {
  @IsString() key!: string;
  @IsOptional() @IsObject() edits?: Partial<ActionText>;
}
class EditDto extends ActionScopeDto {
  @IsObject() edits!: Partial<ActionText>;
}
class StatusDto extends ActionScopeDto {
  @IsIn(['new', 'triaged', 'assigned', 'drafting', 'ready_for_review', 'sent_to_client', 'outreach_completed', 'monitoring', 'dismissed', 'archived']) status!: ActionStatus;
  @IsOptional() @IsString() dismissalReason?: string;
}
function scope(clientId?: string, state?: string, district?: string) {
  if (!clientId?.trim() || !state || !district) throw new BadRequestException('clientId, state and district are required');
  if (!/^[a-f0-9-]{36}$/i.test(clientId) || !/^[a-z]{2}$/i.test(state) || !/^\d{2}$/.test(district)) throw new BadRequestException('Invalid scope');
  return { clientId: clientId.trim(), state: state.toUpperCase(), district };
}
@Controller('intelligence/district-nexus/r5/actions')
@UseGuards(RolesGuard, DistrictNexusFlagGuard, R5FlagGuard)
@RequireR5Feature(DISTRCT_NEXUS_R5_ACTIONS)
@Roles('standard_user')
export class R5DistrictActionsController {
  constructor(private readonly actions: R5DistrictActionsService) {}
  @Get()
  list(@CurrentTenant() ctx: TenantContext, @Query('clientId') clientId?: string, @Query('state') state?: string, @Query('district') district?: string) {
    const s = scope(clientId, state, district);
    return this.actions.list(ctx, s.clientId, s.state, s.district);
  }
  @Post('stage')
  stage(@CurrentTenant() ctx: TenantContext, @Body() body: StageDto) {
    const s = scope(body?.clientId, body?.state, body?.district);
    if (!body.key) throw new BadRequestException('key is required');
    return this.actions.stage(ctx, s.clientId, s.state, s.district, body.key, body.edits);
  }
  @Patch(':id')
  edit(@CurrentTenant() ctx: TenantContext, @Param('id') id: string, @Body() body: EditDto) {
    const s = scope(body?.clientId, body?.state, body?.district);
    return this.actions.edit(ctx, id, s.clientId, s.state, s.district, body.edits);
  }
  @Patch(':id/status')
  status(@CurrentTenant() ctx: TenantContext, @Param('id') id: string, @Body() body: StatusDto) {
    const s = scope(body?.clientId, body?.state, body?.district);
    return this.actions.status(ctx, id, s.clientId, s.state, s.district, body.status, body.dismissalReason);
  }
}
