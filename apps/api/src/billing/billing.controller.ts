/**
 * Read-only billing endpoints (/api/billing) — onboarding v1 split:
 *   GET /api/billing/state    — minimal posture, ANY authenticated role
 *                               (BillingGate, trial banner, slot counters).
 *   GET /api/billing/summary  — full detail, billing admins + capiro_admin
 *                               only (Gherkin: billing entirely hidden from
 *                               everyone else).
 * All billing MUTATIONS (checkout/portal/comp) live on apps/onboard-api at
 * /onboard-api/billing/* — the web app calls them same-origin via the ALB
 * path rule.
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { BillingAdminGuard } from './billing-admin.guard.js';
import { BillingService } from './billing.service.js';

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Minimal billing posture — safe for every role (paywall + banner). */
  @Get('state')
  state(@CurrentTenant() ctx: TenantContext) {
    return this.billing.getState(ctx);
  }

  /** Full plan / slots / LLM usage — billing admins only. */
  @Get('summary')
  @UseGuards(RolesGuard, BillingAdminGuard)
  @Roles('user_admin')
  summary(@CurrentTenant() ctx: TenantContext) {
    return this.billing.getSummary(ctx);
  }
}
