import { Body, Controller, Post, Req, UseGuards, Inject, Optional } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import {
  decodeAndVerifyMeriCapturePolicyTransport,
  MERI_CAPTURE_POLICY_HEADER,
  MERI_GOVERNED_ARTIFACT_HEADER,
  decodeMeriGovernedArtifactTransport,
} from '@capiro/meriv2-core';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriV3InternalServiceGuard } from './meri-v3-internal-service.guard.js';
import { captureProviderBudgetOwner } from './meri-capture-provider-budget-owner.js';
import { syntheticReadBudgetOwner } from './meri-synthetic-read-budget-owner.js';
import type { ResearchProviderReservationBinding } from './meri-research-tool-budget.js';
import type { CaptureProviderSettlement } from './meri-capture-provider-budget.js';
import { CASE46_AUTHORITY_DEPENDENCIES } from './meri-case46-action-authority.js';
import type { Case46AuthorityDependencies } from './meri-case46-authority.js';
import {
  case46ProviderBudgetOwner,
  type Case46BudgetOperation,
} from './meri-case46-provider-budget-owner.js';

@Controller('clio/capture-provider-budget')
@UseGuards(RolesGuard, MeriV3InternalServiceGuard)
@Roles('standard_user')
export class MeriCaptureProviderBudgetController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(CASE46_AUTHORITY_DEPENDENCIES)
    private readonly case46?: Case46AuthorityDependencies,
  ) {}

  private operation(
    ctx: TenantContext,
    req: Request,
    operation: Extract<Case46BudgetOperation, { kind: 'reserve' | 'settle' }>,
  ) {
    const value = req.headers[MERI_GOVERNED_ARTIFACT_HEADER];
    if (value !== undefined) {
      if (
        typeof value !== 'string' ||
        req.headers[MERI_CAPTURE_POLICY_HEADER] !== undefined ||
        !this.case46
      )
        throw new Error('meri_case46_provider_transport_invalid');
      const policy = decodeMeriGovernedArtifactTransport(
        value,
        { purpose: 'provider_budget', tenantId: ctx.tenantId, actorUserId: ctx.userId },
        process.env.INTERNAL_SERVICE_SECRET,
      );
      if (!policy.turnId) throw new Error('meri_case46_provider_turn_unbound');
      return case46ProviderBudgetOwner(this.case46, { ctx, policy, operation });
    }
    const policy = this.policy(ctx, req);
    if (policy.syntheticReadBudget && !policy.turnId)
      throw new Error('meri_synthetic_read_budget_turn_unbound');
    return (policy.syntheticReadBudget ? syntheticReadBudgetOwner : captureProviderBudgetOwner)({
      prisma: this.prisma,
      ctx,
      policy,
      operation,
    });
  }

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
    const result = await this.operation(ctx, req, { kind: 'reserve', binding });
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
    await this.operation(ctx, req, { kind: 'settle', input });
    return { settled: true };
  }
}
