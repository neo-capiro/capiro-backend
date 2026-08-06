import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MemoryReviewInboxService } from './memory-review-inbox.service.js';

/**
 * Phase 3 plain-English work queue and proposer history.
 *
 * Broad list and notification routes are body-free. Proposal content is loaded
 * only from a protected detail route after current membership, participant,
 * tenant, grant, ethical-wall, and client-state authorization.
 */
@Controller('memory/review')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MemoryReviewInboxController {
  constructor(private readonly inbox: MemoryReviewInboxService) {}

  @Get('inbox')
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query('view') view?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.inbox.list(ctx, { view, cursor, limit });
  }

  @Get('inbox/summary')
  summary(@CurrentTenant() ctx: TenantContext) {
    return this.inbox.summary(ctx);
  }

  @Get('inbox/candidates/:id')
  detail(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inbox.detail(ctx, id);
  }

  @Get('inbox/requests/:id')
  detailByRequest(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inbox.detailByReviewRequest(ctx, id);
  }

  @Get('notifications')
  notifications(
    @CurrentTenant() ctx: TenantContext,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.inbox.listNotifications(ctx, { cursor, limit });
  }

  @Get('notifications/unread-count')
  unreadCount(@CurrentTenant() ctx: TenantContext) {
    return this.inbox.unreadNotificationCount(ctx);
  }

  @Post('notifications/read-all')
  async readAll(@CurrentTenant() ctx: TenantContext) {
    return { ok: true, updated: await this.inbox.markAllNotificationsRead(ctx) };
  }

  @Post('notifications/:id/read')
  async readOne(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.inbox.markNotificationRead(ctx, id);
    return { ok: true };
  }
}
