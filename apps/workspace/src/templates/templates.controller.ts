import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { TemplatesService, type TemplateView } from './templates.service.js';

/** Template catalog endpoints (Phase 3, AC-3.2). */
@Controller('templates')
@UseGuards(TenantGuard)
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  /**
   * GET /workspace-api/templates?product=NDAA... → { primary, secondary, all }.
   */
  @Get()
  forProduct(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query('product') product: string,
  ): Promise<{
    primary: TemplateView | null;
    secondary: TemplateView | null;
    all: TemplateView[];
  }> {
    return this.templates.forProduct(ctx.tenantId, decodeURIComponent(product ?? ''));
  }

  /**
   * GET /workspace-api/templates/library → the full tenant-visible template
   * library (all products) for Setup's "Search all templates". Declared BEFORE
   * @Get(':id') so 'library' isn't captured as an :id.
   */
  @Get('library')
  library(@CurrentTenant() ctx: WorkspaceTenantContext): Promise<TemplateView[]> {
    return this.templates.list(ctx.tenantId);
  }

  /** GET /workspace-api/templates/:id → full template (preview sections). */
  @Get(':id')
  byId(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ): Promise<TemplateView> {
    return this.templates.byId(ctx.tenantId, id);
  }
}
