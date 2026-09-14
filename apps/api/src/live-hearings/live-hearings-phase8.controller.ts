import { CanonicalHearingIdPipe } from './canonical-hearing-id.pipe.js';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { LiveHearingsPhase8Service } from './live-hearings-phase8.service.js';

class Phase8IntelligenceQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  onlyRelevant?: boolean;
}

/**
 * Canonical Phase 8 read surface. The established intelligence route also
 * uses this service and preserves legacy evidence fields for rollback clients.
 */
@Controller('legiwatch/live-hearings')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class LiveHearingsPhase8Controller {
  constructor(private readonly phase8: LiveHearingsPhase8Service) {}

  @Get('events/:id/intelligence-v2')
  intelligence(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', CanonicalHearingIdPipe) id: string,
    @Query() query: Phase8IntelligenceQueryDto,
  ) {
    return this.phase8.intelligence(ctx, id, query);
  }
}
