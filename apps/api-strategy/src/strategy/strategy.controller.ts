import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyPlannerGuard } from '../flags/strategy-planner.guard.js';
import { StrategyService } from './strategy.service.js';
import { NodeService } from './node.service.js';
import { VersionService } from './version.service.js';
import { CreateStrategyDto } from './dto/create-strategy.dto.js';
import { PatchStrategyDto } from './dto/patch-strategy.dto.js';
import { CreateNodeDto, UpdateNodeDto } from './dto/node.dto.js';
import { CreateArtifactDto } from './dto/artifact.dto.js';

/**
 * /strategy-api/strategies — library read + manual create (G2), node CRUD +
 * meta patch + version history/restore (G3). TenantGuard first (populates
 * req.tenantContext), then StrategyPlannerGuard (403s when the flag is off).
 */
@Controller('strategies')
@UseGuards(TenantGuard, StrategyPlannerGuard)
export class StrategyController {
  constructor(
    private readonly strategies: StrategyService,
    private readonly nodes: NodeService,
    private readonly versions: VersionService,
  ) {}

  @Get()
  list(@CurrentTenant() ctx: AuthTenantContext) {
    return this.strategies.list(ctx.tenantId);
  }

  @Post()
  create(@CurrentTenant() ctx: AuthTenantContext, @Body() dto: CreateStrategyDto) {
    return this.strategies.create(ctx.tenantId, ctx.clerkUserId, dto);
  }

  @Get(':id')
  byId(@CurrentTenant() ctx: AuthTenantContext, @Param('id') id: string) {
    return this.strategies.byId(ctx.tenantId, id);
  }

  @Patch(':id')
  patch(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: PatchStrategyDto,
  ) {
    return this.strategies.patchMeta(ctx.tenantId, ctx.clerkUserId, id, dto);
  }

  // ---- nodes ----
  @Post(':id/nodes')
  addNode(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: CreateNodeDto,
  ) {
    return this.nodes.add(ctx.tenantId, ctx.clerkUserId, id, dto);
  }

  @Patch(':id/nodes/:nodeId')
  updateNode(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
    @Body() dto: UpdateNodeDto,
  ) {
    return this.nodes.update(ctx.tenantId, ctx.clerkUserId, id, nodeId, dto);
  }

  @Delete(':id/nodes/:nodeId')
  deleteNode(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
  ) {
    return this.nodes.remove(ctx.tenantId, ctx.clerkUserId, id, nodeId);
  }

  /** RTE-3: record a node -> Capiro artifact back-link (Workspace draft / Outreach record). */
  @Post(':id/nodes/:nodeId/artifacts')
  addArtifact(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
    @Body() dto: CreateArtifactDto,
  ) {
    return this.nodes.linkArtifact(ctx.tenantId, ctx.clerkUserId, id, nodeId, dto);
  }

  // ---- version history ----
  @Get(':id/versions')
  listVersions(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Query('take') take?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.versions.list(ctx.tenantId, id, {
      take: take ? Number(take) : undefined,
      cursor: cursor || undefined,
    });
  }

  @Post(':id/versions/:versionId/restore')
  restoreVersion(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.versions.restore(ctx.tenantId, ctx.clerkUserId, id, versionId);
  }
}
