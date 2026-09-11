import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { DistrictNexusFlagGuard } from './district-nexus-flag.guard.js';
import { DistrictNexusStrategicFlagGuard } from './district-nexus-strategic-flag.guard.js';
import { DistrictNexusService } from './district-nexus.service.js';
import { DistrictNexusStrategicService } from './district-nexus-strategic.service.js';
import { UnsupportedViewError } from './district-nexus.view.js';
import type {
  ClientDistrictNexusResponse,
  DistrictNexusDistrictDetailResponse,
  DistrictNexusMapResponse,
  FacilityCoverageDiagnostic,
} from './district-nexus.types.js';
import type {
  ClientDistrictStrategicGapsResponse,
  ClientDistrictStrategicMapResponse,
  DistrictStrategicRelevanceResponse,
} from './district-nexus-strategic.types.js';

/**
 * District Nexus v2 (Rev 2 plan, Workstream E).
 *
 * Guard order matters: RolesGuard establishes that the caller is an
 * authenticated member of the tenant, and only then does DistrictNexusFlagGuard
 * decide whether this tenant can see the feature at all. Reversing them would
 * let an unauthenticated caller probe which tenants have the flag on.
 *
 * The flag guard 404s when the feature is off, so with the flag dark this
 * controller is indistinguishable from routes that do not exist. The legacy
 * `clients/:clientId/district-nexus-spend` route on IntelligenceController
 * stays fully functional and unguarded by the flag — it is the fallback the
 * widget renders while v2 is dark, and the plan keeps it through first release.
 */
@Controller('intelligence')
@UseGuards(RolesGuard, DistrictNexusFlagGuard)
@Roles('standard_user')
export class DistrictNexusController {
  constructor(
    private readonly service: DistrictNexusService,
    private readonly strategic: DistrictNexusStrategicService,
  ) {}

  /** WS-E Step E3. */
  @Get('clients/:clientId/district-nexus-v2')
  getClientDistrictNexus(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
  ): Promise<ClientDistrictNexusResponse> {
    return this.service.getClientDistrictNexus(clientId, ctx.tenantId);
  }

  /**
   * WS-E Step E1 — firm-wide map aggregate.
   *
   * `view` accepts only `current`. A `future` request is a 400, not a silently
   * substituted current map: the future boundary rail does not exist and award
   * geography is reported against current districts, so any "future" answer
   * would be invention that looks entirely plausible.
   */
  @Get('district-nexus/map')
  async getDistrictNexusMap(
    @CurrentTenant() ctx: TenantContext,
    @Query('view') view?: string,
    @Query('clientId') clientId?: string,
    @Query('state') state?: string,
    @Query('includeAllDistricts') includeAllDistricts?: string,
  ): Promise<DistrictNexusMapResponse> {
    try {
      return await this.service.getFirmDistrictNexusMap(ctx.tenantId, {
        view,
        clientId,
        state,
        includeAllDistricts: includeAllDistricts === '1' || includeAllDistricts === 'true',
      });
    } catch (error) {
      if (error instanceof UnsupportedViewError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /**
   * WS-E Step E2 — one district's detail, for the drawer.
   *
   * 404s for a district code that is not a district (the '90'/'98'/'ZZ'
   * sentinels). A real district with no client activity is a 200 with an empty
   * shape, because "nothing here" is a legitimate answer and "this district does
   * not exist" is not.
   */
  @Get('district-nexus/districts/:state/:district')
  async getDistrictDetail(
    @CurrentTenant() ctx: TenantContext,
    @Param('state') state: string,
    @Param('district') district: string,
    @Query('view') view?: string,
    @Query('clientId') clientId?: string,
  ): Promise<DistrictNexusDistrictDetailResponse> {
    try {
      const detail = await this.service.getDistrictDetail(ctx.tenantId, state, district, {
        view,
        clientId,
      });
      if (!detail) {
        throw new NotFoundException(
          `"${district}" is not a congressional district code. Statewide ("90"), delegate ("98") and undefined ("ZZ") award geographies cannot be resolved to a single district.`,
        );
      }
      return detail;
    } catch (error) {
      if (error instanceof UnsupportedViewError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /**
   * Read-only facility geocode/Congress-provenance coverage diagnostic
   * (Release 1, §14) — not a dashboard, just the counts an operator needs to
   * judge coverage before deciding whether to run the backfill.
   */
  @Get('district-nexus/facility-coverage')
  getFacilityCoverageDiagnostic(
    @CurrentTenant() ctx: TenantContext,
  ): Promise<FacilityCoverageDiagnostic> {
    return this.service.getFacilityCoverageDiagnostic(ctx.tenantId);
  }

  // ── Release 2 — Strategic Relevance (nested flag, fail-closed) ────────────

  /**
   * Client-wide strategic relevance map rows. Separate from Nexus Strength.
   * Requires district_nexus_v2 AND district_nexus_strategic_relevance (or internal).
   */
  @Get('clients/:clientId/district-nexus-v2/strategic')
  @UseGuards(DistrictNexusStrategicFlagGuard)
  getClientStrategicMap(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
  ): Promise<ClientDistrictStrategicMapResponse> {
    return this.strategic.getClientStrategicMap(ctx.tenantId, clientId);
  }

  /**
   * Deterministic gap analysis for a client (named gap types, not one quadrant).
   */
  @Get('clients/:clientId/district-nexus-v2/gaps')
  @UseGuards(DistrictNexusStrategicFlagGuard)
  getClientStrategicGaps(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
  ): Promise<ClientDistrictStrategicGapsResponse> {
    return this.strategic.getClientStrategicGaps(ctx.tenantId, clientId);
  }

  /**
   * One district's explainable Strategic Relevance for a client.
   * clientId is required — strategic relevance is always client-scoped.
   */
  @Get('district-nexus/districts/:state/:district/strategic')
  @UseGuards(DistrictNexusStrategicFlagGuard)
  getDistrictStrategic(
    @CurrentTenant() ctx: TenantContext,
    @Param('state') state: string,
    @Param('district') district: string,
    @Query('clientId') clientId?: string,
  ): Promise<DistrictStrategicRelevanceResponse> {
    if (!clientId?.trim()) {
      throw new BadRequestException('clientId is required for strategic relevance');
    }
    return this.strategic.getDistrictStrategic(ctx.tenantId, state, district, clientId.trim());
  }
}
