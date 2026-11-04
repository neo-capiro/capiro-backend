import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { PortfolioCapabilitiesReviewService } from './portfolio-capabilities-review.service.js';
import { PortfolioDiscoveryService } from './portfolio-discovery.service.js';
import { PortfolioTrackingService } from './portfolio-tracking.service.js';

@Controller('clients/:clientId/capabilities')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class PortfolioCapabilitiesController {
  constructor(
    private readonly review: PortfolioCapabilitiesReviewService,
    private readonly discovery: PortfolioDiscoveryService,
    private readonly tracking: PortfolioTrackingService,
  ) {}

  @Post('discovery/proposals')
  propose(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() body: unknown,
  ) {
    return this.review.propose(ctx, clientId, body);
  }
  @Get('discovery/results')
  @Roles('standard_user')
  discoveryResults(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Query() query: unknown,
  ) {
    return this.discovery.results(ctx, clientId, query);
  }
  @Post('discovery/run')
  discover(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() body: unknown,
  ) {
    return this.discovery.discover(ctx, clientId, body);
  }
  @Patch('discovery/proposals/:id')
  edit(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.review.edit(ctx, clientId, id, body);
  }
  @Post('discovery/proposals/:id/review')
  reviewCapability(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.review.review(ctx, clientId, id, body);
  }
  @Post('discovery/merge')
  merge(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() body: unknown,
  ) {
    return this.review.merge(ctx, clientId, body);
  }
  @Post('discovery/proposals/:id/split')
  split(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.review.split(ctx, clientId, id, body);
  }
  @Post(':id/alignment/proposals')
  proposeAlignment(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.review.propose(ctx, clientId, body, id);
  }
  @Post(':id/alignment/bulk-approve')
  bulkApprove(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.review.bulkApprove(ctx, clientId, id, body);
  }
  @Post(':id/alignment/:proposalId/review')
  reviewAlignment(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: unknown,
  ) {
    return this.review.review(ctx, clientId, proposalId, body, id);
  }
  @Get(':id/tracking')
  @Roles('standard_user')
  feed(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tracking.feed(ctx, clientId, id);
  }
  @Post(':id/tracking/refresh')
  refresh(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tracking.feed(ctx, clientId, id, true);
  }
  @Post(':id/tracking')
  updateTracking(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.tracking.update(ctx, clientId, id, body);
  }
}
