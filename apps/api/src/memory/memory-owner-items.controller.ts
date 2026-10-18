import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MemoryOwnerItemsService } from './memory-owner-items.service.js';

@Controller('memory/owner')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MemoryOwnerItemsController {
  constructor(private readonly items: MemoryOwnerItemsService) {}

  @Get('items')
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.items.list(ctx, { cursor, limit });
  }
}
