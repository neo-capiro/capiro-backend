import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MemoryReviewCompatibilityGuardService } from './memory-review-compatibility-guard.service.js';
import { ReviewsService } from './reviews.service.js';

class AssignReviewDto {
  @IsUUID() userId!: string;
}

/**
 * G4 review queue for held deliverables other than governed memory.
 *
 * Memory review rows are filtered and rejected here so the generic release
 * service can never become a compatibility bypass around memory assignment,
 * ethical-wall, grant, lineage, or segregation-of-duties controls.
 */
@Controller('reviews')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ReviewsController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly memoryGuard: MemoryReviewCompatibilityGuardService,
  ) {}

  @Get()
  async list(@CurrentTenant() ctx: TenantContext, @Query('status') status?: string) {
    const rows = await this.reviews.list(ctx, status);
    return this.memoryGuard.filterNonMemoryReviews(rows);
  }

  @Get(':id')
  async detail(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.memoryGuard.assertNotMemoryReview(ctx, id);
    return this.reviews.detail(ctx, id);
  }

  @Post(':id/assign')
  @Roles('user_admin')
  async assign(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignReviewDto,
  ) {
    await this.memoryGuard.assertNotMemoryReview(ctx, id);
    return this.reviews.assign(ctx, id, dto.userId);
  }

  @Post(':id/approve')
  async approve(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.memoryGuard.assertNotMemoryReview(ctx, id);
    return this.reviews.approve(ctx, id);
  }

  @Post(':id/reject')
  async reject(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.memoryGuard.assertNotMemoryReview(ctx, id);
    return this.reviews.reject(ctx, id);
  }
}
