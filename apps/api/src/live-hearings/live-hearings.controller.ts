/**
 * LegiWatch Live Hearings — Master Calendar HTTP surface (Phase 3, plan §12).
 *
 *   GET /legiwatch/live-hearings/calendar
 *   GET /legiwatch/live-hearings/live
 *   GET /legiwatch/live-hearings/events/:id
 *   GET /legiwatch/live-hearings/events/:id/updates
 *
 * Lives in `apps/api` rather than `apps/intel-api` because that is where the
 * models live: `committee_hearing`, `hearing_subscription`, the Phase 2 capture
 * tables and the change feed are all in this service's Prisma schema, and
 * `apps/api` already owns the existing hearing read surface
 * (`GET /explorer/hearings`). intel-api's `hearings` controller is a different
 * thing — the per-tenant BROWSER capture session CRUD — and stays untouched.
 *
 * No mock data: every field is read from the canonical corpus, and a tenant only
 * ever sees its own subscription overlay.
 */
import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { LiveHearingsService } from './live-hearings.service.js';

/**
 * The global ValidationPipe runs whitelist + forbidNonWhitelisted, so EVERY
 * field needs a class-validator decorator or the whole request 400s with
 * "property X should not exist". Query values arrive as strings, so @Type
 * coerces the numeric ones (transformOptions has enableImplicitConversion off).
 */
class CalendarQueryDto {
  /** Inclusive lower bound on the Eastern calendar day, `YYYY-MM-DD`. */
  @IsOptional()
  @IsString()
  from?: string;

  /** Inclusive upper bound on the Eastern calendar day, `YYYY-MM-DD`. */
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

  /** 'scheduled' = only what this user follows; 'unscheduled' = only what they do not. */
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
  constructor(private readonly service: LiveHearingsService) {}

  @Get('calendar')
  calendar(@CurrentTenant() ctx: TenantContext, @Query() query: CalendarQueryDto) {
    return this.service.calendar(ctx, query);
  }

  @Get('live')
  live(@CurrentTenant() ctx: TenantContext) {
    return this.service.live(ctx);
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
    // 404 on an unknown hearing rather than an empty list, so a bad id is
    // distinguishable from an event that genuinely has no published changes.
    const event = await this.service.event(ctx, id);
    if (!event) throw new NotFoundException(`hearing ${id} not found`);
    return { hearingId: id, updates: await this.service.updates(ctx, id, query.limit ?? 100) };
  }
}
