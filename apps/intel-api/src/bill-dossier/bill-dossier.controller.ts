import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import {
  DEFENSE_FUNDING_INTEL_FEATURE,
  FeatureFlagService,
} from '../feature-flags/feature-flag.service.js';
import { Bill360FeatureGuard } from './bill-360.guard.js';
import { BillDossierService } from './bill-dossier.service.js';

/**
 * Bill 360 dossier read model (plan §1.2). Registered at the app root so it can
 * own two distinct base paths (global + client). Both routes require auth
 * (TenantGuard) and the `bill_360` flag (Bill360FeatureGuard → 404 when off, so
 * the surface stays dark for non-enabled tenants during R1 QA):
 *
 *   GET /intel-api/bills/:billId/dossier                    — public/official data only
 *   GET /intel-api/clients/:clientId/bills/:billId/dossier  — adds that tenant/client's context
 *
 * The client route additionally returns tracked state, matched topics, stance/
 * priority, analyst note/outlook, this client's alerts for the bill, hearing
 * mentions, and recommended actions. Every client read is tenant- AND client-scoped
 * in the service.
 *
 * R3 §3.6: the controller — not the service — resolves the tenant's
 * `defense_funding_intel` flag and passes it down, so the service stays a pure
 * composer and NO funding query is issued for a tenant without the flag. Both routes
 * resolve it identically: funding data is public, so it is not client-contextual.
 */
@Controller()
@UseGuards(TenantGuard, Bill360FeatureGuard)
export class BillDossierController {
  constructor(
    private readonly svc: BillDossierService,
    private readonly flags: FeatureFlagService,
  ) {}

  @Get('bills/:billId/dossier')
  async getGlobalDossier(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('billId') billId: string,
  ) {
    return this.svc.getGlobalDossier(billId, { funding: await this.fundingEnabled(ctx.tenantId) });
  }

  @Get('clients/:clientId/bills/:billId/dossier')
  async getClientDossier(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Param('billId') billId: string,
  ) {
    return this.svc.getClientDossier(ctx.tenantId, clientId, billId, {
      funding: await this.fundingEnabled(ctx.tenantId),
    });
  }

  /** Fails CLOSED: any flag-resolution problem leaves funding off. */
  private async fundingEnabled(tenantId: string): Promise<boolean> {
    try {
      return await this.flags.isEnabled(DEFENSE_FUNDING_INTEL_FEATURE, tenantId);
    } catch {
      return false;
    }
  }
}
