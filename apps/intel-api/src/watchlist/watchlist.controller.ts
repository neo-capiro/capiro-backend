import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { HearingWatchFeatureGuard } from '../feature-flags/hearing-watch-feature.guard.js';
import { WatchlistService } from './watchlist.service.js';
import { AddTermDto, CreateWatchlistDto, SetActiveDto } from './dto/watchlist.dto.js';

/**
 * Client watchlist management (H2). Tenant-scoped; gated to Hearing-Watch tenants.
 */
@Controller('watchlists')
@UseGuards(TenantGuard, HearingWatchFeatureGuard)
export class WatchlistController {
  constructor(private readonly watchlists: WatchlistService) {}

  @Post()
  create(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() dto: CreateWatchlistDto) {
    return this.watchlists.create(ctx.tenantId, ctx.clerkUserId, dto);
  }

  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext, @Query('clientId') clientId?: string) {
    return this.watchlists.list(ctx.tenantId, clientId);
  }

  @Get(':id')
  get(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.watchlists.get(ctx.tenantId, id);
  }

  @Post(':id/terms')
  addTerm(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string, @Body() dto: AddTermDto) {
    return this.watchlists.addTerm(ctx.tenantId, id, dto);
  }

  @Delete('terms/:termId')
  removeTerm(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('termId') termId: string) {
    return this.watchlists.removeTerm(ctx.tenantId, termId);
  }

  @Put(':id/active')
  setActive(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string, @Body() dto: SetActiveDto) {
    return this.watchlists.setActive(ctx.tenantId, id, dto.active);
  }
}
