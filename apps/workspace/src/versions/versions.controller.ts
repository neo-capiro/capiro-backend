import { Body, Controller, Get, Param, Post, UseGuards, ParseUUIDPipe, Query, Header } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { VersionsService } from './versions.service.js';
import { CreateVersionDto } from './dto/version.dto.js';
import { WorkspaceObjectiveDestinationQueryDto } from './dto/objective-destination.dto.js';

/** Version history nested under a draft (Phase 6b). All tenant-scoped. */
@Controller('drafts/:draftId/versions')
@UseGuards(TenantGuard)
export class VersionsController {
  constructor(private readonly versions: VersionsService) {}

  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.versions.list(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  @Get(':versionId/outreach-revision')
  outreachRevision(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    return this.versions.outreachRevision(ctx.tenantId, draftId, versionId, ctx.clerkUserId);
  }

  @Header('Cache-Control', 'private, no-store')
  @Get(':versionId/objective-destination')
  objectiveDestination(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Query() query: WorkspaceObjectiveDestinationQueryDto,
  ) {
    return this.versions.objectiveDestination(ctx.tenantId, draftId, versionId, ctx.clerkUserId, query);
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
