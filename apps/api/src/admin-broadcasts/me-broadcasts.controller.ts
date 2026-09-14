import { Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { AdminBroadcastsService } from './admin-broadcasts.service.js';

/** The signed-in user's own pending broadcasts and acknowledgement. Every role. */
@Controller('me/broadcasts')
@UseGuards(RolesGuard)
@Roles('client_portal_user')
export class MeBroadcastsController {
  constructor(private readonly service: AdminBroadcastsService) {}

  @Get('pending')
  pending(@CurrentTenant() ctx: TenantContext) {
    return this.service.listPendingForUser(ctx);
  }

  @Post(':id/acknowledge')
  acknowledge(@CurrentTenant() ctx: TenantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.acknowledge(ctx, id);
  }
}
