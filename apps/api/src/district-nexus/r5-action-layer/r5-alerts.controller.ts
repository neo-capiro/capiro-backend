/**
 * District Nexus R5 — Alerts API controller.
 *
 * Flag-guarded, tenant-scoped. Lists recent district alerts for a client.
 * Registered under the existing District Nexus controller prefix
 * `/intelligence/...` so it is served by capiro-dev-api.
 */

import { Controller, Get, NotFoundException, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../../auth/roles.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { DistrictNexusFlagGuard } from '../district-nexus-flag.guard.js';
import { R5DistrictAlertsService, type DistrictAlertPayload } from './r5-alerts.service.js';

@Controller('intelligence')
@UseGuards(RolesGuard, DistrictNexusFlagGuard)
@Roles('standard_user')
export class R5DistrictAlertsController {
  constructor(
    private readonly alerts: R5DistrictAlertsService,
  ) {}

  /**
   * GET /intelligence/district-nexus/r5/alerts?clientId=&state=&district=
   *
   * Flag-guarded (district_nexus_r5_alerts must be ON for the tenant).
   * Returns the client's recent district alerts.
   */
 ​@Get('district-nexus/r5/alerts')
  async listAlerts(
    @CurrentTenant() ct: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('state') state?: string,
    @Query('district') district?: string,
  ): Promise<DistrictAlertPayload[]> {
    if (!clientId?.trim()) {
      throw new NotFoundException('clientId is required');
    }

    // Check R5 alerts flag
    const enabled = await this.alerts.isEnabled(ct.tenantId);
    if (!enabled) throw new NotFoundException();

    // Verify client belongs to this tenant
    try {
      await this.alerts.verifyClientAccess(ct.tenantId, clientId.trim());
    } catch {
      throw new NotFoundException();
    }

    return this.alerts.listClientAlerts(
      ct.tenantId,
      clientId.trim(),
      state?.trim(),
      district?.trim(),
    );
  }
}