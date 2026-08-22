import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { DistrictNexusFlagGuard } from './district-nexus-flag.guard.js';
import {
  DistrictNexusEconomicFlagGuard,
  RequireDistrictNexusEconomicFeature,
} from './district-nexus-economic-flag.guard.js';
import { DistrictNexusEconomicService } from './district-nexus-economic.service.js';
import {
  DISTRICT_NEXUS_EXTERNAL_CONTEXT_FEATURE,
  DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE,
  DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE,
  type ClientEconomicFootprintResponse,
  type DistrictEconomicContextResponse,
  type FootprintEvidenceDecisionRequest,
  type FootprintEvidenceRecord,
  type FootprintImportPreviewRequest,
  type FootprintImportPreviewResponse,
  type FootprintImportSummary,
} from './district-nexus-economic.types.js';

/**
 * Release 3 — Economic Footprint.
 *
 * The controller is nested behind BOTH the existing District Nexus flag and a
 * rail-specific Release 3 flag. Every disabled state is a 404, matching the
 * base feature's fail-closed posture. Public district context and client-owned
 * evidence have separate routes and separate flags so one can never silently
 * imply the other.
 */
@Controller('intelligence')
@UseGuards(RolesGuard, DistrictNexusFlagGuard, DistrictNexusEconomicFlagGuard)
@Roles('standard_user')
export class DistrictNexusEconomicController {
  constructor(private readonly service: DistrictNexusEconomicService) {}

  @Get('clients/:clientId/district-nexus-v2/economic-footprint')
  @RequireDistrictNexusEconomicFeature(DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE)
  getClientFootprint(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
  ): Promise<ClientEconomicFootprintResponse> {
    return this.service.getClientFootprint(ctx.tenantId, clientId);
  }

  @Post('clients/:clientId/district-nexus-v2/footprint-imports/preview')
  @RequireDistrictNexusEconomicFeature(DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE)
  previewImport(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: FootprintImportPreviewRequest,
  ): Promise<FootprintImportPreviewResponse> {
    return this.service.previewImport(ctx.tenantId, ctx.userId ?? null, clientId, body);
  }

  @Post('clients/:clientId/district-nexus-v2/footprint-imports/:importId/commit')
  @RequireDistrictNexusEconomicFeature(DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE)
  commitImport(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('importId') importId: string,
  ): Promise<FootprintImportSummary> {
    return this.service.commitImport(ctx.tenantId, ctx.userId ?? null, clientId, importId);
  }

  @Post('clients/:clientId/district-nexus-v2/footprint-evidence/:evidenceId/approve')
  @Roles('user_admin')
  @RequireDistrictNexusEconomicFeature(DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE)
  approveEvidence(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('evidenceId') evidenceId: string,
    @Body() body: FootprintEvidenceDecisionRequest,
  ): Promise<FootprintEvidenceRecord> {
    return this.service.decideEvidence(
      ctx.tenantId,
      ctx.userId ?? null,
      clientId,
      evidenceId,
      'approve',
      body ?? {},
    );
  }

  @Post('clients/:clientId/district-nexus-v2/footprint-evidence/:evidenceId/reject')
  @Roles('user_admin')
  @RequireDistrictNexusEconomicFeature(DISTRICT_NEXUS_FOOTPRINT_IMPORT_FEATURE)
  rejectEvidence(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('evidenceId') evidenceId: string,
  ): Promise<FootprintEvidenceRecord> {
    return this.service.decideEvidence(
      ctx.tenantId,
      ctx.userId ?? null,
      clientId,
      evidenceId,
      'reject',
      {},
    );
  }

  @Get('district-nexus/districts/:state/:district/economic-context')
  @RequireDistrictNexusEconomicFeature(DISTRICT_NEXUS_EXTERNAL_CONTEXT_FEATURE)
  getDistrictContext(
    @Param('state') state: string,
    @Param('district') district: string,
  ): Promise<DistrictEconomicContextResponse> {
    return this.service.getDistrictContext(state, district);
  }

  /** Federal Market remains the supplier/subaward source of truth. */
  @Get('clients/:clientId/district-nexus-v2/supplier-footprint/status')
  @RequireDistrictNexusEconomicFeature(DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE)
  supplierFootprintStatus(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
  ) {
    return this.service.getSupplierFootprintStatus(ctx.tenantId, clientId);
  }
}
