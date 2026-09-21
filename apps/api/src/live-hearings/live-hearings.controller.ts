import { CanonicalHearingIdPipe } from './canonical-hearing-id.pipe.js';
/**
 * LegiWatch Live Hearings — canonical read surface (master plan §12).
 *
 * Calendar and event data are global public records with a tenant/user
 * subscription overlay. Committee identity is sourced from CongressCommittee,
 * never inferred from whatever hearings happen to fall inside a date window.
 */
import {
  Body,
  Controller,
  Get,
  Post,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { CommitteeDirectoryService } from './committee-directory.service.js';
import { LiveHearingsService } from './live-hearings.service.js';

const CAPTURE_STATES = [
  'not_covered',
  'discovered',
  'stream_ready',
  'capturing',
  'captured',
  'no_public_stream',
  'blocked',
] as const;

/**
 * The global ValidationPipe runs whitelist + forbidNonWhitelisted, so every
 * public query field must be declared here. Canonical fields are listed first;
 * the legacy aliases remain accepted during the V2 cutover and are normalized
 * before the service sees them.
 */
export class CalendarQueryDto {
  @IsOptional() @IsIn(['US', 'FL', 'ALL']) jurisdiction?: 'US' | 'FL' | 'ALL';
  @IsOptional() @IsString() session?: string;
  @IsOptional() @IsString() stateCommitteeId?: string;
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',') : value))
  @IsArray()
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  billIds?: string[];
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',') : value))
  @IsArray()
  @ArrayMaxSize(5000)
  @IsString({ each: true })
  hearingIds?: string[];
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  following?: boolean;
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsIn(['house', 'senate', 'joint', 'House', 'Senate', 'Joint'])
  chamber?: string;

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
  @IsIn([...CAPTURE_STATES])
  captureState?: string;

  @IsOptional()
  @IsIn(['scheduled', 'unscheduled'])
  followState?: 'scheduled' | 'unscheduled';

  /**
   * Whitelisted sort direction on the canonical date/startsAt key. Default
   * `asc` (chronological) is the calendar's long-standing contract and drives
   * export semantics; `desc` exists for explicit "latest first" lookups (the
   * Florida empty-week "view latest" action) and is bounded by the same
   * pageSize cap — it never widens the selection.
   */
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sort?: 'asc' | 'desc';

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

  // Compatibility aliases used by the first Phase 7 client. They are accepted
  // deliberately rather than leaking through whitelist validation as 400s.
  @IsOptional()
  @IsString()
  committeeId?: string;

  @IsOptional()
  @IsString()
  subcommitteeId?: string;

  @IsOptional()
  @IsString()
  captureStatus?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  scheduled?: 'true' | 'false';

  @IsOptional()
  @IsIn(['true', 'false'])
  followed?: 'true' | 'false';

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
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

  @Get('state-committees')
  stateBodies(@CurrentTenant() ctx: TenantContext, @Query('session') session?: string) {
    return this.service.stateBodies(ctx, session);
  }
  @Get('state-directory/florida')
  floridaDirectoryResources(@CurrentTenant() ctx: TenantContext) {
    return this.service.floridaDirectoryResources(ctx);
  }
  @Get('calendar/coverage')
  calendarCoverage(@CurrentTenant() ctx: TenantContext, @Query() query: CalendarQueryDto) {
    return this.service.calendarCoverage(ctx, query);
  }
  @Get('state-committees/:id')
  stateBody(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.stateBody(ctx, id);
  }

  @Get('calendar')
  async calendar(@CurrentTenant() ctx: TenantContext, @Query() query: CalendarQueryDto) {
    const result = await this.service.calendar(ctx, normalizeCalendarQuery(query));
    // `rows` is canonical; `items` is a bounded compatibility alias for the
    // already-shipped Phase 7 normalizer. Both point to the same objects.
    return { ...result, items: result.rows };
  }

  @Get('live')
  async live(@CurrentTenant() ctx: TenantContext) {
    const result = await this.service.live(ctx);
    return { ...result, items: result.rows };
  }

  /** POST accommodates a large explicitly resolved folder selection without
   * URL truncation. Same filtering, counting and paging contract as GET. */
  @Post('calendar/query')
  async calendarSelection(@CurrentTenant() ctx: TenantContext, @Body() query: CalendarQueryDto) {
    const result = await this.service.calendar(ctx, normalizeCalendarQuery(query));
    return { ...result, items: result.rows };
  }

  /** Complete current committee/subcommittee catalog, including zero-hearing bodies. */
  @Get('committees')
  committeeDirectory(@CurrentTenant() ctx: TenantContext) {
    return this.committees.committees(ctx);
  }

  @Get('committees/:id')
  async committee(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    const committee = await this.committees.committee(id, ctx);
    if (!committee) throw new NotFoundException(`committee ${id} not found`);
    return committee;
  }

  @Get('committees/:id/members')
  async committeeMembers(@Param('id') id: string) {
    await this.assertCommittee(id);
    return this.committees.members(id);
  }

  @Get('committees/:id/updates')
  async committeeUpdates(@Param('id') id: string, @Query() query: UpdatesQueryDto) {
    await this.assertCommittee(id);
    return this.committees.updates(id, query.limit ?? 100);
  }

  @Get('events/:id')
  async event(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', CanonicalHearingIdPipe) id: string,
  ) {
    const event = await this.service.event(ctx, id);
    if (!event) throw new NotFoundException(`hearing ${id} not found`);
    return event;
  }

  @Get('events/:id/updates')
  async updates(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', CanonicalHearingIdPipe) id: string,
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

  private async assertCommittee(id: string): Promise<void> {
    const directory = await this.committees.committees();
    const normalized = id.trim().toLowerCase();
    if (!directory.rows.some((row) => row.systemCode.toLowerCase() === normalized)) {
      throw new NotFoundException(`committee ${id} not found`);
    }
  }
}

function normalizeCalendarQuery(query: CalendarQueryDto) {
  const cursorPage = query.cursor ? Number.parseInt(query.cursor, 10) : undefined;
  const legacyCaptureState = CAPTURE_STATES.includes(
    query.captureStatus?.toLowerCase() as (typeof CAPTURE_STATES)[number],
  )
    ? query.captureStatus?.toLowerCase()
    : undefined;
  const legacyFollowState =
    query.scheduled === 'true' || query.followed === 'true'
      ? 'scheduled'
      : query.scheduled === 'false' || query.followed === 'false'
        ? 'unscheduled'
        : undefined;

  return {
    jurisdiction: query.jurisdiction,
    session: query.session,
    stateCommitteeId: query.stateCommitteeId,
    billIds: query.billIds,
    hearingIds: query.hearingIds,
    following: query.following,
    from: query.from,
    to: query.to,
    chamber: query.chamber,
    committee: query.committee ?? query.committeeId,
    subcommittee: query.subcommittee ?? query.subcommitteeId,
    eventType: query.eventType,
    eventStatus: query.eventStatus,
    streamState: query.streamState,
    captureState: query.captureState ?? legacyCaptureState,
    followState: query.followState ?? legacyFollowState,
    sort: query.sort,
    q: query.q ?? query.search,
    page: query.page ?? (Number.isFinite(cursorPage) && cursorPage! > 0 ? cursorPage : undefined),
    pageSize: query.pageSize ?? query.limit,
  };
}
