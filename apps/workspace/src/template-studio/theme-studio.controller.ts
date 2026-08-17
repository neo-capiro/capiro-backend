import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { ThemeStudioService } from './theme-studio.service.js';
import {
  CreateThemeDto,
  SaveThemeDraftDto,
  CreateThemeVersionDto,
} from './dto/theme.dto.js';

/**
 * Theme Studio REST surface. Document theme CRUD with versioned, immutable
 * published versions (GAPS §15). Tenant-scoped via TenantGuard.
 *
 * Mounted under /workspace-api/template-studio/themes by the global prefix.
 */
@Controller('template-studio/themes')
@UseGuards(TenantGuard)
export class ThemeStudioController {
  constructor(private readonly themeStudio: ThemeStudioService) {}

  /** GET /template-studio/themes — list all themes for this tenant. */
  @Get()
  listThemes(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.themeStudio.listThemes(ctx.tenantId);
  }

  /** POST /template-studio/themes — create a new theme. */
  @Post()
  createTheme(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() dto: CreateThemeDto,
  ) {
    return this.themeStudio.createTheme(ctx.tenantId, ctx.clerkUserId, dto);
  }

  /** GET /template-studio/themes/:themeId — one theme + versions. */
  @Get(':themeId')
  getTheme(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('themeId') themeId: string,
  ) {
    return this.themeStudio.getTheme(ctx.tenantId, themeId);
  }

  /** POST /template-studio/themes/:themeId/versions — new draft version. */
  @Post(':themeId/versions')
  createVersion(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('themeId') themeId: string,
    @Body() dto: CreateThemeVersionDto,
  ) {
    return this.themeStudio.createVersion(ctx.tenantId, themeId, ctx.clerkUserId, dto);
  }

  /** PATCH /template-studio/themes/:themeId/versions/:versionId — save draft settings. */
  @Patch(':themeId/versions/:versionId')
  saveDraft(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('themeId') themeId: string,
    @Param('versionId') versionId: string,
    @Body() dto: SaveThemeDraftDto,
  ) {
    return this.themeStudio.saveDraft(ctx.tenantId, themeId, versionId, dto);
  }

  /** POST /template-studio/themes/:themeId/versions/:versionId/publish — publish. */
  @Post(':themeId/versions/:versionId/publish')
  publishVersion(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('themeId') themeId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.themeStudio.publishVersion(
      ctx.tenantId,
      themeId,
      versionId,
      ctx.clerkUserId,
    );
  }

  /** POST /template-studio/themes/:themeId/versions/:versionId/retire — retire. */
  @Post(':themeId/versions/:versionId/retire')
  retireVersion(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('themeId') themeId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.themeStudio.retireVersion(
      ctx.tenantId,
      themeId,
      versionId,
      ctx.clerkUserId,
    );
  }
}
