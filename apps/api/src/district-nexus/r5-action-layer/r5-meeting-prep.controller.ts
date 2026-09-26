import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../../auth/roles.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { DistrictNexusFlagGuard } from '../district-nexus-flag.guard.js';
import { R5FlagGuard, RequireR5Feature, DISTRCT_NEXUS_R5_MEETING_PREP } from './r5-flag.guard.js';
import { R5MeetingPrepService, type DistrictPrepInput, type DistrictPrepEdit } from './r5-meeting-prep.service.js';

@Controller('intelligence/district-nexus/r5/meeting-prep')
@UseGuards(RolesGuard, DistrictNexusFlagGuard, R5FlagGuard)
@RequireR5Feature(DISTRCT_NEXUS_R5_MEETING_PREP)
@Roles('standard_user')
export class R5MeetingPrepController {
  constructor(private readonly service: R5MeetingPrepService) {}

  @Get('meetings')
  list(@CurrentTenant() ctx: TenantContext, @Query('clientId') clientId?: string,
    @Query('from') from?: string, @Query('to') to?: string) {
    if (!clientId?.trim()) throw new BadRequestException('clientId is required');
    return this.service.listMeetings(ctx, clientId.trim(), from, to);
  }

  @Post()
  generate(@CurrentTenant() ctx: TenantContext, @Body() input: DistrictPrepInput) {
    if (!input || typeof input !== 'object') throw new BadRequestException('Invalid prep input');
    return this.service.generate(ctx, input);
  }

  @Get(':prepId')
  get(@CurrentTenant() ctx: TenantContext, @Param('prepId') id: string) {
    return this.service.get(ctx, id);
  }

  @Patch(':prepId')
  edit(@CurrentTenant() ctx: TenantContext, @Param('prepId') id: string, @Body() input: DistrictPrepEdit) {
    if (!input || typeof input !== 'object') throw new BadRequestException('Invalid prep edit');
    return this.service.edit(ctx, id, input);
  }
}
