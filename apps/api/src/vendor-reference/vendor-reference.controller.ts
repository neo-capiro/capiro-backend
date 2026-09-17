import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { VendorReferencePullDto } from './vendor-reference.dto.js';
import { renderVendorReferenceMarkdown } from './vendor-reference-markdown.js';
import { VendorReferenceService } from './vendor-reference.service.js';

/**
 * Vendor Reference Pull — read-only. Auth required (standard_user+). The
 * underlying rails are global public-record tables plus live SAM.gov; the only
 * tenant-scoped read is the optional `clientId` relationship check, which runs
 * inside the caller's tenant.
 */
@Controller('vendor-reference')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class VendorReferenceController {
  constructor(private readonly service: VendorReferenceService) {}

  /** The dossier as JSON (grouped rows + identity block + warnings). */
  @Get('pull')
  pull(@CurrentTenant() ctx: TenantContext, @Query() query: VendorReferencePullDto) {
    return this.service.pull(ctx.tenantId, query);
  }

  /** The same dossier rendered into the 15_vendor_reference_pull.md shape. */
  @Get('markdown')
  async markdown(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: VendorReferencePullDto,
  ): Promise<{ markdown: string }> {
    const dossier = await this.service.pull(ctx.tenantId, query);
    return { markdown: renderVendorReferenceMarkdown(dossier) };
  }
}
