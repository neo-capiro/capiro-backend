import { Body, Controller, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { PortfolioRelationshipsService } from './portfolio-relationships.service.js';

@Controller('clients/:clientId/targets')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class PortfolioRelationshipsController {
  constructor(private readonly service: PortfolioRelationshipsService) {}
  @Post('recommendations/proposals')
  propose(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() body: unknown,
  ) {
    return this.service.propose(ctx, clientId, body);
  }
  @Post('recommendations/refresh')
  refresh(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() body: unknown,
  ) {
    return this.service.refreshRecommendations(ctx, clientId, body);
  }
  @Post('recommendations/:id/review')
  review(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.service.review(ctx, clientId, id, body);
  }
  @Patch(':id/relationship')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.service.updateRelationship(ctx, clientId, id, body);
  }
  @Post(':id/supports')
  support(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.service.support(ctx, clientId, id, body);
  }
}
