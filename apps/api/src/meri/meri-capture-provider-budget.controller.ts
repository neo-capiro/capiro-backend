import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import {
  decodeAndVerifyMeriCapturePolicyTransport,
  MERI_CAPTURE_POLICY_HEADER,
} from '@capiro/meriv2-core';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriV3InternalServiceGuard } from './meri-v3-internal-service.guard.js';
import { captureProviderBudgetOwner } from './meri-capture-provider-budget-owner.js';
import type { ResearchProviderReservationBinding } from './meri-research-tool-budget.js';
import type { CaptureProviderSettlement } from './meri-capture-provider-budget.js';

@Controller('clio/capture-provider-budget')
@UseGuards(RolesGuard, MeriV3InternalServiceGuard)
@Roles('standard_user')
export class MeriCaptureProviderBudgetController {
  constructor(private readonly prisma: PrismaService) {}

  private policy(ctx: TenantContext, req: Request) {
    const value = req.headers[MERI_CAPTURE_POLICY_HEADER];
    return decodeAndVerifyMeriCapturePolicyTransport(
      typeof value === 'string' ? value : undefined,
      { purpose: 'provider_budget', tenantId: ctx.tenantId, actorUserId: ctx.userId },
      process.env.INTERNAL_SERVICE_SECRET,
    );
  }
  @Post('reservations')
  async reserve(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: Request,
    @Body() binding: ResearchProviderReservationBinding,
  ) {
    const result = await captureProviderBudgetOwner({
      prisma: this.prisma,
      ctx,
      policy: this.policy(ctx, req),
      operation: { kind: 'reserve', binding },
    });
    if (!('reservationId' in result) || !('dispatchAllowed' in result) || !('deadlineAt' in result))
      throw new Error('meri_capture_provider_budget_reservation_missing');
    return {
      reservationId: result.reservationId,
      dispatchAllowed: result.dispatchAllowed,
      deadlineAt: result.deadlineAt,
    };
  }
  @Post('settlements')
  async settle(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: Request,
    @Body() input: CaptureProviderSettlement,
  ) {
    await captureProviderBudgetOwner({
      prisma: this.prisma,
      ctx,
      policy: this.policy(ctx, req),
      operation: { kind: 'settle', input },
    });
    return { settled: true };
  }
}
