/**
 * LegiWatch V2 Wave 1 — HTTP surface.
 *
 * Mounted on the SAME `legiwatch/live-hearings` controller prefix the shipped
 * Phase 7/8 surfaces use, so the module speaks one base path. Wave 1 routes are
 * ADDITIVE: no existing route's shape changes, and the Phase 7 follow/schedule
 * routes stay in place as the immediate rollback contract.
 *
 * Follow and Attend are separate route families, mirroring the fact that they
 * are separate products:
 *
 *   .../events/:id/follow-config   → notification interest (never capture)
 *   .../events/:id/attendance      → capture demand, policy-gated
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { TenantContext } from '@capiro/shared';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { LegiWatchWave1Service } from './legiwatch-wave1.service.js';
import {
  ArchiveSearchQueryDto,
  AskMeriDto,
  AttendanceRequestDto,
  BriefPrefillDto,
  ClientRelevanceQueryDto,
  CommitteeFollowDto,
  CommitteeIntelligenceQueryDto,
  DetailV2QueryDto,
  FollowConfigDto,
  NotificationInboxQueryDto,
  OutreachPrefillDto,
  SaveItemDto,
  SavedItemsQueryDto,
} from './legiwatch-wave1.dto.js';

@Controller('legiwatch/live-hearings')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class LegiWatchWave1Controller {
  constructor(
    private readonly wave1: LegiWatchWave1Service,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // ── W1-1 · configurable hearing following ────────────────────────────────

  @Get('events/:id/follow-config')
  followState(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.wave1.followState(ctx, id);
  }

  /** Upsert. The same call creates a follow and edits an existing one. */
  @Put('events/:id/follow-config')
  upsertFollow(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: FollowConfigDto,
  ) {
    return this.wave1.upsertFollow(ctx, id, body);
  }

  @Delete('events/:id/follow-config')
  unfollow(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.wave1.unfollow(ctx, id);
  }

  // ── W1-2 · configurable attendance / capture request ─────────────────────

  @Get('events/:id/attendance')
  attendanceState(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.wave1.attendanceState(ctx, id);
  }

  /**
   * Request attendance. The server re-derives eligibility and 409s a request
   * the policy does not permit, so bypassing the frontend controls changes
   * nothing.
   */
  @Put('events/:id/attendance')
  requestAttendance(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: AttendanceRequestDto,
  ) {
    return this.wave1.requestAttendance(ctx, id, body);
  }

  @Delete('events/:id/attendance')
  cancelAttendance(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.wave1.cancelAttendance(ctx, id);
  }

  // ── W1-3 · archive + global hearing research ─────────────────────────────

  @Get('events/:id/sessions')
  savedSessions(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.wave1.savedSessions(ctx, id);
  }

  /** Server-side search/facet/page over the durable historical corpus. */
  @Get('archive/search')
  searchArchive(@CurrentTenant() ctx: TenantContext, @Query() query: ArchiveSearchQueryDto) {
    return this.wave1.searchArchive(ctx, query);
  }

  // ── W1-4 · committee following + intelligence history ────────────────────

  @Get('committees/:systemCode/follow')
  committeeFollowState(
    @CurrentTenant() ctx: TenantContext,
    @Param('systemCode') systemCode: string,
  ) {
    return this.wave1.committeeFollowState(ctx, systemCode);
  }

  @Put('committees/:systemCode/follow')
  upsertCommitteeFollow(
    @CurrentTenant() ctx: TenantContext,
    @Param('systemCode') systemCode: string,
    @Body() body: CommitteeFollowDto,
  ) {
    return this.wave1.upsertCommitteeFollow(ctx, systemCode, body);
  }

  @Delete('committees/:systemCode/follow')
  unfollowCommittee(
    @CurrentTenant() ctx: TenantContext,
    @Param('systemCode') systemCode: string,
  ) {
    return this.wave1.unfollowCommittee(ctx, systemCode);
  }

  @Get('committees/:systemCode/intelligence-history')
  committeeIntelligenceHistory(
    @CurrentTenant() ctx: TenantContext,
    @Param('systemCode') systemCode: string,
    @Query() query: CommitteeIntelligenceQueryDto,
  ) {
    return this.wave1.committeeIntelligenceHistory(ctx, systemCode, query);
  }

  // ── W1-6 · client relevance V2 ───────────────────────────────────────────

  /** With `clientId`: one client. Without: the All-Clients ranked view. */
  @Get('events/:id/client-relevance')
  clientRelevance(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query() query: ClientRelevanceQueryDto,
  ) {
    return query.clientId
      ? this.wave1.clientRelevance(ctx, id, query.clientId)
      : this.wave1.allClientsRelevance(ctx, id);
  }

  // ── W1-7 · actions ───────────────────────────────────────────────────────

  @Post('events/:id/actions/ask-meri')
  askMeri(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: AskMeriDto,
  ) {
    return this.wave1.buildMeriContextPacket(ctx, id, body);
  }

  /**
   * Grounded prefill for the brief. Workspace still owns creation; the web
   * posts this to `POST /workspace-api/drafts` so there is one document path.
   */
  @Post('events/:id/actions/brief-prefill')
  briefPrefill(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: BriefPrefillDto,
  ) {
    return this.wave1.buildBriefPrefill(ctx, id, body);
  }

  /** Grounded prefill for outreach. Nothing is sent and nothing auto-created. */
  @Post('events/:id/actions/outreach-prefill')
  outreachPrefill(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: OutreachPrefillDto,
  ) {
    return this.wave1.buildOutreachPrefill(ctx, id, body);
  }

  @Post('events/:id/saved-items')
  saveItem(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: SaveItemDto,
  ) {
    return this.wave1.saveItem(ctx, id, body);
  }

  @Get('saved-items')
  listSavedItems(@CurrentTenant() ctx: TenantContext, @Query() query: SavedItemsQueryDto) {
    return this.wave1.listSavedItems(ctx, query);
  }

  @Delete('saved-items/:savedItemId')
  deleteSavedItem(
    @CurrentTenant() ctx: TenantContext,
    @Param('savedItemId') savedItemId: string,
  ) {
    return this.wave1.deleteSavedItem(ctx, savedItemId);
  }

  // ── W1-5 · notification inbox ────────────────────────────────────────────

  @Get('notifications')
  notifications(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: NotificationInboxQueryDto,
  ) {
    return this.wave1.notificationInbox(ctx, query);
  }

  @Post('notifications/:notificationId/read')
  markNotificationRead(
    @CurrentTenant() ctx: TenantContext,
    @Param('notificationId') notificationId: string,
  ) {
    return this.wave1.markNotificationRead(ctx, notificationId);
  }

  // ── W1-8 · calendar export ───────────────────────────────────────────────

  /**
   * The `.ics` payload plus the Google/Outlook URLs for the same event.
   *
   * Returned as JSON rather than a file download so one request serves all
   * three export routes and the web can offer the `.ics` as a Blob download
   * without a second round trip.
   */
  @Get('events/:id/calendar-export')
  calendarExport(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.wave1.calendarExport(ctx, id, this.appOrigin());
  }

  /**
   * Header-level "Export calendar" action (§2/§5.1) — either an explicit
   * `hearingIds` selection or a `from`/`to` window (the current filtered
   * Schedule view). Returns the same JSON shape as the single-hearing
   * `calendar-export` GET so the web client can reuse `downloadIcs()`.
   */
  @Post('calendar-export/bulk')
  @Header('Cache-Control', 'no-store')
  calendarExportBulk(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: { hearingIds?: string[]; from?: string; to?: string },
  ) {
    return this.wave1.calendarExportBulk(ctx, body, this.appOrigin());
  }

  /**
   * The same export as a real `text/calendar` download, for clients that
   * subscribe to a URL rather than saving a Blob.
   */
  @Get('events/:id/calendar.ics')
  @Header('Cache-Control', 'no-store')
  async calendarIcs(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.wave1.calendarExport(ctx, id, this.appOrigin());
    res
      .status(200)
      .type('text/calendar; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.ics);
  }

  // ── Hearing Detail V2 ────────────────────────────────────────────────────

  /**
   * One request that fills the canonical Hearing Detail route. Composes the
   * existing contracts; deliberately excludes the transcript body, which stays
   * on its own paginated endpoint.
   */
  @Get('events/:id/detail-v2')
  detailV2(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query() query: DetailV2QueryDto,
  ) {
    return this.wave1.detailV2(ctx, id, query);
  }

  /**
   * The absolute origin the canonical Hearing Detail link is built from.
   *
   * Exported calendar entries outlive the session, so the link has to be
   * absolute and cannot come from the request host (which may be an internal
   * ALB name). `APP_PUBLIC_ORIGIN` is the configured public origin.
   */
  private appOrigin(): string {
    return this.config.get('LEGIWATCH_APP_BASE_URL', { infer: true });
  }
}
