import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import { LegiWatchWave1Service } from './legiwatch-wave1.service.js';
import { LegiWatchLifecycleNotificationService } from './legiwatch-lifecycle-notification.service.js';

export class BillRecordNotificationDto {
  @IsUUID() tenantId!: string;
  @IsString() @MaxLength(200) userId!: string;
  @IsString() @MaxLength(200) billId!: string;
  @IsString() @MaxLength(500) eventKey!: string;
  @IsString() @MaxLength(500) title!: string;
  @IsString() @MaxLength(10000) body!: string;
}

/**
 * class-validator decorators are REQUIRED: the global ValidationPipe runs
 * `whitelist` + `forbidNonWhitelisted`, so an undecorated query key 400s before
 * the handler runs. `hearingId` is the canonical `committee_hearing.id`
 * (`cm-119-119533`-style, not a UUID) and is optional: an ad-hoc browser-captured
 * session has no canonical hearing, and still deserves the client's name.
 */
export class ClientBriefContextQueryDto {
  @IsUUID()
  tenantId!: string;

  @IsUUID()
  clientId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  hearingId?: string;
}

/**
 * Internal-only (InternalServiceGuard) client context for the post-hearing
 * brief. intel-api owns the brief but has no Client model and no relevance
 * tables; apps/api owns both. Mirrors InternalTrackerController: same guard,
 * same shared-secret channel intel-api already uses for the live-hearing BYOK
 * path and alert summaries.
 *
 * Returns the client's name plus the SAME `ClientRelevanceResult` the
 * user-facing `events/:id/client-relevance` route serves — so the brief and the
 * hearing detail page can never disagree about why a hearing matters to a
 * client. Tenant scoping comes from the caller's own authenticated tenantId;
 * the client must belong to it (404 otherwise, from the service).
 *
 * NOT reachable by an ordinary user JWT (InternalServiceGuard, not RolesGuard).
 */
@Controller('internal/legiwatch')
@UseGuards(InternalServiceGuard)
export class InternalLegiWatchController {
  constructor(private readonly wave1: LegiWatchWave1Service, private readonly notifications: LegiWatchLifecycleNotificationService) {}

  @Post('bill-record-notification')
  billRecord(@Body() input: BillRecordNotificationDto) {
    return this.notifications.emitBillRecord(input);
  }

  @Get('client-brief-context')
  clientBriefContext(@Query() query: ClientBriefContextQueryDto) {
    const hearingId = typeof query.hearingId === 'string' ? query.hearingId.trim() : '';
    return this.wave1.clientBriefContext(query.tenantId, query.clientId, hearingId || null);
  }
}
