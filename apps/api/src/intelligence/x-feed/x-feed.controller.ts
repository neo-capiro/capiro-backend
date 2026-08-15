import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { AddXFeedSubscriptionDto } from './x-feed.dto.js';
import { XFeedService } from './x-feed.service.js';

/**
 * X Intelligence Feed — configurable X/Twitter dashboard feed.
 *
 * All endpoints require authentication + tenant context. The browser never
 * sees the X API bearer token — all X API calls are server-side.
 */
@Controller('intelligence/x-feed')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class XFeedController {
  constructor(private readonly xFeed: XFeedService) {}

  /** Combined feed of posts from all subscribed accounts. */
  @Get('dashboard')
  dashboard(
    @CurrentTenant() ctx: TenantContext,
    @Query('accountId') accountId?: string,
  ) {
    return this.xFeed.getDashboard(ctx, accountId);
  }

  /** List the user's subscriptions. */
  @Get('subscriptions')
  subscriptions(@CurrentTenant() ctx: TenantContext) {
    return this.xFeed.getSubscriptions(ctx);
  }

  /** Add an X account by handle. */
  @Post('subscriptions')
  addSubscription(
    @CurrentTenant() ctx: TenantContext,
    @Body() input: AddXFeedSubscriptionDto,
  ) {
    return this.xFeed.addSubscription(ctx, input.username);
  }

  /** Remove a subscription. */
  @Delete('subscriptions/:subscriptionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeSubscription(
    @CurrentTenant() ctx: TenantContext,
    @Param('subscriptionId', new ParseUUIDPipe({ version: '4' })) subscriptionId: string,
  ): Promise<void> {
    await this.xFeed.removeSubscription(ctx, subscriptionId);
  }

  /** Resolve/search an X handle to preview the account before subscribing. */
  @Get('resolve')
  resolve(
    @CurrentTenant() ctx: TenantContext,
    @Query('username') username: string,
  ) {
    return this.xFeed.resolveHandle(ctx, username);
  }

  /** Provider availability status. */
  @Get('status')
  status() {
    return this.xFeed.getStatus();
  }

  /** Refresh all cached timelines for this user's subscriptions. */
  @Post('refresh')
  refresh(@CurrentTenant() ctx: TenantContext) {
    return this.xFeed.refreshDashboard(ctx);
  }
}
