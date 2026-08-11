import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import {
  CLIENT_PROFILE_FILL_SOURCES,
  type ClientProfileFillSource,
} from './client-profile-fill.helpers.js';
import { ClientProfileFillService } from './client-profile-fill.service.js';

class StartClientProfileFillDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CLIENT_PROFILE_FILL_SOURCES.length)
  @IsIn(CLIENT_PROFILE_FILL_SOURCES, { each: true })
  sources?: ClientProfileFillSource[];
}

class ApplyClientProfileFillDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  findingIds!: string[];
}

class RejectClientProfileFillDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

@Controller('clients/:clientId/fill-with-meri')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientProfileFillController {
  constructor(private readonly service: ClientProfileFillService) {}

  @Post('runs')
  start(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: StartClientProfileFillDto,
  ) {
    return this.service.startRun(ctx, clientId, body.sources);
  }

  @Get('latest')
  latest(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getLatest(ctx, clientId);
  }

  @Get('runs/:runId')
  getRun(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('runId') runId: string,
  ) {
    return this.service.getRun(ctx, clientId, runId);
  }

  @Post('runs/:runId/apply')
  @Roles('user_admin')
  apply(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('runId') runId: string,
    @Body() body: ApplyClientProfileFillDto,
  ) {
    return this.service.applyFindings(ctx, clientId, runId, body.findingIds);
  }

  @Post('findings/:findingId/reject')
  @Roles('user_admin')
  reject(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('findingId') findingId: string,
    @Body() body: RejectClientProfileFillDto,
  ) {
    return this.service.rejectFinding(ctx, clientId, findingId, body.reason);
  }

  @Post('findings/:findingId/restore')
  @Roles('user_admin')
  restore(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('findingId') findingId: string,
  ) {
    return this.service.restoreFinding(ctx, clientId, findingId);
  }
}
