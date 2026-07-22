import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ClientTargetsService } from './client-targets.service.js';

class AddTargetDto {
  // Widened to 128: OpenStates state-legislator ids ("ocd-person/<uuid>") are
  // longer than congressional bioguide ids.
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  memberId!: string;

  // "manual" (added from search results) | "meri" (added from the Meri sidebar).
  @IsOptional()
  @IsIn(['manual', 'meri'])
  source?: string;

  // Which directory the member came from. Defaults to congress server-side.
  @IsOptional()
  @IsIn(['congress', 'state'])
  sourceDirectory?: string;
}

@Controller('clients/:clientId/targets')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientTargetsController {
  constructor(private readonly service: ClientTargetsService) {}

  @Get()
  listTargets(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.listTargets(ctx, clientId);
  }

  @Post()
  addTarget(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: AddTargetDto,
  ) {
    return this.service.addTarget(ctx, clientId, body);
  }

  // Remove by member id (not row id) — the UI only knows the member it added.
  // memberId comes as a QUERY param, not a path segment: OpenStates ids contain a
  // slash ("ocd-person/…") that path routing / proxies mangle.
  @Delete()
  removeTarget(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Query('memberId') memberId?: string,
  ) {
    if (!memberId || !memberId.trim()) throw new BadRequestException('memberId is required');
    return this.service.removeTarget(ctx, clientId, memberId.trim());
  }
}
