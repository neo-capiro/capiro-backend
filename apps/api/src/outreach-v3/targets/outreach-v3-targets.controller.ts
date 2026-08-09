import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseFilters, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { TARGET_SEARCH_SOURCES } from '../../capabilities/targets/search-targets.capability.js';
import { OutreachV3StateGuard } from '../api/outreach-v3-state.guard.js';
import { OutreachV3ExceptionFilter } from '../api/outreach-v3-exception.filter.js';
import { OutreachV3TargetsGuard } from './outreach-v3-targets.guard.js';
import { OutreachV3TargetsService } from './outreach-v3-targets.service.js';

class SearchOutreachTargetsDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  query?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TARGET_SEARCH_SOURCES.length)
  @IsIn(TARGET_SEARCH_SOURCES, { each: true })
  sources?: Array<(typeof TARGET_SEARCH_SOURCES)[number]>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

class TargetProfileDto {
  @IsObject()
  targetRef!: Record<string, unknown>;
}

class TargetRelationshipDto extends TargetProfileDto {
  @IsUUID()
  clientId!: string;
}

@Controller('engagement/outreach-v3/sessions/:sessionId/targets')
@UseGuards(OutreachV3StateGuard, OutreachV3TargetsGuard, RolesGuard)
@UseFilters(OutreachV3ExceptionFilter)
@Roles('standard_user')
export class OutreachV3TargetsController {
  constructor(private readonly targets: OutreachV3TargetsService) {}

  @Post('search')
  search(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: SearchOutreachTargetsDto,
  ) {
    return this.targets.search(ctx, sessionId, {
      query: body.query ?? null,
      clientId: body.clientId ?? null,
      sources: body.sources ?? [],
      limit: body.limit ?? 20,
    });
  }

  @Post('profile')
  profile(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: TargetProfileDto,
  ) {
    return this.targets.getProfile(ctx, sessionId, { targetRef: body.targetRef as never });
  }

  @Post('relationships')
  relationships(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: TargetRelationshipDto,
  ) {
    return this.targets.analyzeRelationships(ctx, sessionId, {
      targetRef: body.targetRef as never,
      clientId: body.clientId,
    });
  }

  @Get('coverage')
  coverage(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.targets.getCoverage(ctx, sessionId);
  }
}
