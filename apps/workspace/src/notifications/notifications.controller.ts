import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { NotificationsService } from './notifications.service.js';

/** In-app notifications for the current user (E-19). Tenant + recipient scoped. */
@Controller('notifications')
@UseGuards(TenantGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.notifications.list(ctx.tenantId, ctx.clerkUserId);
  }

  @Post('read-all')
  readAll(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.notifications.markAllRead(ctx.tenantId, ctx.clerkUserId);
  }

  @Post(':id/read')
  read(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.notifications.markRead(ctx.tenantId, ctx.clerkUserId, id);
  }
}
