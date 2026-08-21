/**
 * LegiWatch Live Hearings — canonical read surface (master plan §12).
 *
 * Calendar and event data are global public records with a tenant/user
 * subscription overlay. Committee identity is sourced from CongressCommittee,
 * never inferred from whatever hearings happen to fall inside a date window.
 */
import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { CommitteeDirectoryService } from './committee-directory.service.js';
import { LiveHearingsService } from './live-hearings.service.js';

/**
 * The global ValidationPipe runs whitelist + forbidNonWhitelisted, so every
 * public query field must be declared here. These names are the canonical
 * frontend/backend contract.
 */
class CalendarQueryDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsIn(['house', 'senate', 'joint', 'House', 'Senate', 'Joint'])
  chamber?: string;

  /** congress_committee.system_code, or a display-name substring. */
  @IsOptional()
  @IsString()
  committee?: string;

  @IsOptional()
  @IsString()
  subcommittee?: string;

  @IsOptional()
  @IsString()
  eventType?: string;

  @IsOptional()
  @IsIn(['scheduled', 'postponed', 'canceled', 'in_progress', 'completed'])
  eventStatus?: string;

  @IsOptional()
  @IsIn(['unknown', 'none', 'live_only', 'archived', 'embedded_third_party'])
  streamState?: string;

  @IsOptional()
  @IsIn([
    'not_covered',
    'discovered',
    'stream_ready',
    'capturing',
    'captured',
    'no_public_stream',
    'blocked',
  ])
  captureState?: string;

  /** 'scheduled' = this user's subscriptions; 'unscheduled' = the complement. */
  @IsOptional()
  @IsIn(['scheduled', 'unscheduled'])
  followState?: 'scheduled' | 'unscheduled';

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

class UpdatesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

@Controller('legiwatch/live-hearings')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class LiveHearingsController {
  constructor(
    private readonly service: LiveHearingsService,
    private readonly committees: CommitteeDirectoryService,
  ) {}

  @Get('calendar')
  calendar(@CurrentTenant() ctx: TenantContext, @Query() query: CalendarQueryDto) {
    return this.service.calendar(ctx, query);
  }

  @Get('live')
  live(@CurrentTenant() ctx: TenantContext) {
    return this.service.live(ctx);
  }

  /** Complete current committee/subcommittee catalog, including zero-hearing bodies. */
  @Get('committees')
  committeeDirectory() {
    return this.committees.committees();
  }

  @Get('committees/:id')
  async committee(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    const committee = await this.committees.committee(id, ctx);
    if (!committee) throw new NotFoundException(`committee ${id} not found`);
    return committee;
  }

  @Get('committees/:id/members')
  async committeeMembers(@Param('id') id: string) {
    const committee = await this.committees.committeeExists(id);
    if (!committee) throw new NotFoundException(`committee ${id} not found`);
    return this.committees.members(id);
  }

  @Get('committees/:id/updates')
  async committeeUpdates(@Param('id') id: string, @Query() query: UpdatesQueryDto) {
    const committee = await this.committees.committeeExists(id);
    if (!committee) throw new NotFoundException(`committee ${id} not found`);
    return this.committees.updates(id, query.limit ?? 100);
  }

  @Get('events/:id')
  async event(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    const event = await this.service.event(ctx, id);
    if (!event) throw new NotFoundException(`hearing ${id} not found`);
    return event;
  }

  @Get('events/:id/updates')
  async updates(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query() query: UpdatesQueryDto,
  ) {
    const event = await this.service.event(ctx, id);
    if (!event) throw new NotFoundException(`hearing ${id} not found`);
    return { hearingId: id, updates: await this.service.updates(ctx, id, query.limit ?? 100) };
  }

  /** Global source-health/operator view; no tenant content is returned. */
  @Get('coverage')
  coverage() {
    return this.service.coverage();
  }
}
