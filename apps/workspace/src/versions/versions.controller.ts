import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { VersionsService } from './versions.service.js';
import { CreateVersionDto } from './dto/version.dto.js';

/** Version history nested under a draft (Phase 6b). All tenant-scoped. */
@Controller('drafts/:draftId/versions')
@UseGuards(TenantGuard)
export class VersionsController {
  constructor(private readonly versions: VersionsService) {}

  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.versions.list(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  /** Snapshot the current draft (called on a manual "Save draft"). */
  @Post()
  create(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: CreateVersionDto,
  ) {
    return this.versions.create(ctx.tenantId, draftId, ctx.clerkUserId, dto);
  }

  /** Restore a prior version's snapshot into the live draft. */
  @Post(':versionId/restore')
  restore(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.versions.restore(ctx.tenantId, draftId, versionId, ctx.clerkUserId);
  }
}
