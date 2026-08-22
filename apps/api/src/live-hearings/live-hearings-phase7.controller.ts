import { Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { LiveHearingsPhase7PublicGuard } from './live-hearings-phase7-public.guard.js';
import { LiveHearingsPhase7ScheduleGuard } from './live-hearings-phase7-schedule.guard.js';
import { LiveHearingsPhase7Service } from './live-hearings-phase7.service.js';
import { LiveHearingsPhase8Service } from './live-hearings-phase8.service.js';

class TranscriptQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsString()
  q?: string;
}

class IntelligenceQueryDto extends TranscriptQueryDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  onlyRelevant?: boolean;
}

/**
 * Canonical Hearing Room request surface. Phase 7 owns room/capture interactions;
 * Phase 8 now owns the established intelligence route without changing its URL.
 */
@Controller('legiwatch/live-hearings')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class LiveHearingsPhase7Controller {
  constructor(
    private readonly phase7: LiveHearingsPhase7Service,
    private readonly scheduleGuard: LiveHearingsPhase7ScheduleGuard,
    private readonly publicGuard: LiveHearingsPhase7PublicGuard,
    private readonly phase8: LiveHearingsPhase8Service,
  ) {}

  @Get('events/:id/room')
  room(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.phase7.room(ctx, id);
  }

  @Get('events/:id/transcript')
  async transcript(@Param('id') id: string, @Query() query: TranscriptQueryDto) {
    await this.publicGuard.assertPublic(id);
    return this.phase7.transcript(id, query);
  }

  @Get('events/:id/participation')
  participation(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.phase7.participation(ctx, id);
  }

  @Post('events/:id/schedule')
  async schedule(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    await this.scheduleGuard.assertSchedulable(id);
    return this.phase7.schedule(ctx, id);
  }

  @Delete('events/:id/schedule')
  cancelSchedule(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.phase7.cancelSchedule(ctx, id);
  }

  @Post('events/:id/follow')
  follow(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.phase7.follow(ctx, id);
  }

  @Delete('events/:id/follow')
  unfollow(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.phase7.unfollow(ctx, id);
  }

  /**
   * Returns a safe browser-capture handoff or tells the UI to attach to the
   * already-running canonical transcript. Never returns a raw media URL.
   */
  @Post('events/:id/join-browser')
  joinBrowser(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.phase7.browserJoin(ctx, id);
  }

  @Get('recordings')
  recordings(@CurrentTenant() ctx: TenantContext, @Query() query: PageQueryDto) {
    return this.phase7.recordings(ctx, query);
  }

  @Get('archive')
  archive(@CurrentTenant() ctx: TenantContext, @Query() query: PageQueryDto) {
    return this.phase7.archive(ctx, query);
  }

  @Get('events/:id/intelligence')
  intelligence(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query() query: IntelligenceQueryDto,
  ) {
    return this.phase8.intelligence(ctx, id, query);
  }
}
