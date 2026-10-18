import {
  BadRequestException,
  Body,
  ConflictException,
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
import {
  normalizeCreatePlan,
  normalizeCreateWave,
  normalizeHistoryQuery,
  normalizeListQuery,
  normalizePatchPlan,
  normalizePatchWave,
  normalizeReorderWaves,
  normalizeReview,
  PlanInputError,
  PlanRuleError,
} from './engagement-plan.rules.js';
import { EngagementPlansService } from './engagement-plans.service.js';

@Controller('engagement/plans')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class EngagementPlansController {
  constructor(private readonly service: EngagementPlansService) {}

  @Get()
  list(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    return this.service.list(
      ctx,
      this.parse(() => normalizeListQuery(query)),
    );
  }

  @Get(':planId')
  get(@CurrentTenant() ctx: TenantContext, @Param('planId', ParseUUIDPipe) planId: string) {
    return this.service.get(ctx, planId.toLowerCase());
  }

  @Post()
  create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return this.service.create(
      ctx,
      this.parse(() => normalizeCreatePlan(body)),
    );
  }

  @Patch(':planId')
  patch(
    @CurrentTenant() ctx: TenantContext,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: unknown,
  ) {
    return this.service.patch(
      ctx,
      planId.toLowerCase(),
      this.parse(() => normalizePatchPlan(body)),
    );
  }

  @Post(':planId/waves')
  createWave(
    @CurrentTenant() ctx: TenantContext,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: unknown,
  ) {
    return this.service.createWave(
      ctx,
      planId.toLowerCase(),
      this.parse(() => normalizeCreateWave(body)),
    );
  }

  @Patch(':planId/waves/:waveId')
  patchWave(
    @CurrentTenant() ctx: TenantContext,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('waveId', ParseUUIDPipe) waveId: string,
    @Body() body: unknown,
  ) {
    return this.service.patchWave(
      ctx,
      planId.toLowerCase(),
      waveId.toLowerCase(),
      this.parse(() => normalizePatchWave(body)),
    );
  }

  @Post(':planId/waves/reorder')
  reorder(
    @CurrentTenant() ctx: TenantContext,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: unknown,
  ) {
    return this.service.reorder(
      ctx,
      planId.toLowerCase(),
      this.parse(() => normalizeReorderWaves(body)),
    );
  }

  @Post(':planId/reviews')
  review(
    @CurrentTenant() ctx: TenantContext,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: unknown,
  ) {
    return this.service.review(
      ctx,
      planId.toLowerCase(),
      this.parse(() => normalizeReview(body, new Date())),
    );
  }

  @Get(':planId/history')
  history(
    @CurrentTenant() ctx: TenantContext,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Query() query: unknown,
  ) {
    return this.service.history(
      ctx,
      planId.toLowerCase(),
      this.parse(() => normalizeHistoryQuery(query)),
    );
  }

  private parse<Input>(normalize: () => Input): Input {
    try {
      return normalize();
    } catch (error) {
      if (error instanceof PlanInputError)
        throw new BadRequestException({ code: error.code, message: error.message });
      if (error instanceof PlanRuleError)
        throw new ConflictException({ code: error.code, message: error.message });
      throw error;
    }
  }
}
