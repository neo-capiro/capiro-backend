import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ReviewsService } from './reviews.service.js';

class AssignReviewDto {
  @IsUUID() userId!: string;
}

/**
 * G4 review queue (blueprint §3.3). Listing is standard_user (you can see
 * your own requests/assignments; admins see everything — enforced in the
 * service). ASSIGNING the named reviewer is user_admin-only. Deciding
 * (approve/reject) is authorized in the service: user_admin OR the assigned
 * reviewer — deliberately never the requester alone.
 */
@Controller('reviews')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list(@CurrentTenant() ctx: TenantContext, @Query('status') status?: string) {
    return this.reviews.list(ctx, status);
  }

  @Post(':id/assign')
  @Roles('user_admin')
  assign(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignReviewDto,
  ) {
    return this.reviews.assign(ctx, id, dto.userId);
  }

  @Post(':id/approve')
  approve(@CurrentTenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.reviews.approve(ctx, id);
  }

  @Post(':id/reject')
  reject(@CurrentTenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.reviews.reject(ctx, id);
  }
}
