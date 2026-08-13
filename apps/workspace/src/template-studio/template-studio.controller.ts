import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { TemplateStudioService } from './template-studio.service.js';
import type {
  CloneBlueprintDto,
  CompareVersionsResult,
  CreateBlueprintDto,
  CreateVersionDto,
  TestVersionDto,
  UpdateVersionDto,
} from './dto/template-studio.dto.js';

/**
 * Template Studio REST surface. Every route is tenant-scoped via TenantGuard
 * and @CurrentTenant(). Reads are open to any tenant collaborator; create /
 * publish / retire are firm-admin-only (enforced in the service).
 *
 * Mounted under /workspace-api/template-studio by the global prefix.
 */
@Controller('template-studio')
@UseGuards(TenantGuard)
export class TemplateStudioController {
  constructor(private readonly studio: TemplateStudioService) {}

  /** GET /template-studio/blueprints — capiro-global + firm blueprints. */
  @Get('blueprints')
  listBlueprints(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.studio.listBlueprints(ctx.tenantId);
  }

  /** POST /template-studio/blueprints — create a blueprint (firm admin). */
  @Post('blueprints')
  createBlueprint(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() dto: CreateBlueprintDto,
  ) {
    return this.studio.createBlueprint(ctx.tenantId, ctx.clerkUserId, dto);
  }

  /** GET /template-studio/blueprints/:blueprintId — one blueprint + versions. */
  @Get('blueprints/:blueprintId')
  getBlueprint(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('blueprintId') blueprintId: string,
  ) {
    return this.studio.getBlueprint(ctx.tenantId, blueprintId);
  }

  /** POST /template-studio/blueprints/:blueprintId/clone — clone to a new draft. */
  @Post('blueprints/:blueprintId/clone')
  cloneBlueprint(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('blueprintId') blueprintId: string,
    @Body() dto: CloneBlueprintDto,
  ) {
    return this.studio.cloneBlueprint(ctx.tenantId, blueprintId, ctx.clerkUserId, dto);
  }

  /** POST /template-studio/blueprints/:blueprintId/versions — new draft version. */
  @Post('blueprints/:blueprintId/versions')
  createVersion(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('blueprintId') blueprintId: string,
    @Body() dto: CreateVersionDto,
  ) {
    return this.studio.createVersion(ctx.tenantId, blueprintId, ctx.clerkUserId, dto);
  }

  /** GET /template-studio/blueprints/:blueprintId/versions/:versionId. */
  @Get('blueprints/:blueprintId/versions/:versionId')
  getVersion(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('blueprintId') blueprintId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.studio.getVersion(ctx.tenantId, blueprintId, versionId);
  }

  /** PATCH /template-studio/blueprints/:blueprintId/versions/:versionId —
   *  update a draft. Published → 409. */
  @Patch('blueprints/:blueprintId/versions/:versionId')
  updateVersion(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('blueprintId') blueprintId: string,
    @Param('versionId') versionId: string,
    @Body() dto: UpdateVersionDto,
  ) {
    return this.studio.updateVersion(
      ctx.tenantId,
      blueprintId,
      versionId,
      ctx.clerkUserId,
      dto,
    );
  }

  /** POST /template-studio/blueprints/:blueprintId/versions/:versionId/test —
   *  deterministic simulated intake + outline, no permanent doc. */
  @Post('blueprints/:blueprintId/versions/:versionId/test')
  testVersion(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('blueprintId') blueprintId: string,
    @Param('versionId') versionId: string,
    @Body() dto: TestVersionDto,
  ) {
    return this.studio.testVersion(ctx.tenantId, blueprintId, versionId, dto);
  }

  /** POST /template-studio/blueprints/:blueprintId/versions/:versionId/publish —
   *  publish (immutable after). */
  @Post('blueprints/:blueprintId/versions/:versionId/publish')
  publishVersion(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('blueprintId') blueprintId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.studio.publishVersion(
      ctx.tenantId,
      blueprintId,
      versionId,
      ctx.clerkUserId,
    );
  }

  /** POST /template-studio/blueprints/:blueprintId/versions/:versionId/retire. */
  @Post('blueprints/:blueprintId/versions/:versionId/retire')
  retireVersion(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('blueprintId') blueprintId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.studio.retireVersion(
      ctx.tenantId,
      blueprintId,
      versionId,
      ctx.clerkUserId,
    );
  }

  /** GET /template-studio/blueprints/:blueprintId/compare — compare versions. */
  @Get('blueprints/:blueprintId/compare')
  compareVersions(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('blueprintId') blueprintId: string,
  ): Promise<CompareVersionsResult> {
    return this.studio.compareVersions(ctx.tenantId, blueprintId);
  }
}
