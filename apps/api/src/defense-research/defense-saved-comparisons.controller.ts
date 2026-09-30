import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type {
  TenantContext,
  SaveDefenseComparisonDto,
  ChangeDefenseSavedComparisonLifecycleDto,
  AddDefenseSavedComparisonSelectionDto,
} from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { DefenseSavedComparisonsService } from './defense-saved-comparisons.service.js';

@Controller('defense-budget/saved-comparisons')
@UseGuards(RolesGuard)
@Roles('standard_user', 'user_admin', 'capiro_admin')
export class DefenseSavedComparisonsController {
  constructor(private readonly service: DefenseSavedComparisonsService) {}
  @Get()
  list(@CurrentTenant() ctx: TenantContext, @Query('includeArchived') includeArchived?: string) {
    return this.service.list(ctx, includeArchived === 'true');
  }
  @Get(':id')
  get(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.get(ctx, id);
  }
  @Get(':id/versions/:versionId')
  version(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.service.get(ctx, id, versionId);
  }
  @Post()
  create(@CurrentTenant() ctx: TenantContext, @Body() input: SaveDefenseComparisonDto) {
    return this.service.save(ctx, input);
  }
  @Post(':id/versions')
  revise(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() input: SaveDefenseComparisonDto,
  ) {
    return this.service.save(ctx, input, id);
  }

  @Post(':id/archive')
  archive(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() input: ChangeDefenseSavedComparisonLifecycleDto,
  ) {
    return this.service.changeLifecycle(ctx, id, input, true);
  }
  @Post(':id/restore')
  restore(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() input: ChangeDefenseSavedComparisonLifecycleDto,
  ) {
    return this.service.changeLifecycle(ctx, id, input, false);
  }
  @Post(':id/versions/:versionId/add-selection-to-portfolio')
  addSelection(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() input: AddDefenseSavedComparisonSelectionDto,
  ) {
    return this.service.addSelectionToPortfolio(ctx, id, versionId, input);
  }
}
