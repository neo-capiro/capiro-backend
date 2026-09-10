import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import { TenantGuard } from '../../auth/tenant.guard.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import {
  FeatureFlagService,
  FOLDER_TRACKER_FEATURE,
} from '../../feature-flags/feature-flag.service.js';
import { FolderTrackerService, isFolderAdmin } from './folder-tracker.service.js';
import {
  BulkFolderBillsDto,
  FolderBoardQueryDto,
  FolderContextDto,
  FolderExportDto,
  FolderFieldsDto,
  ResolveBillsDto,
  UpdateFolderDto,
} from './folder-tracker.dto.js';

@Injectable()
export class FolderTrackerGuard implements CanActivate {
  constructor(private readonly flags: FeatureFlagService) {}
  async canActivate(context: ExecutionContext) {
    const ctx = context
      .switchToHttp()
      .getRequest<{ tenantContext?: WorkspaceTenantContext }>().tenantContext;
    if (!ctx || !(await this.flags.isEnabled(FOLDER_TRACKER_FEATURE, ctx.tenantId)))
      throw new NotFoundException();
    return true;
  }
}
@Controller('legiwatch/folders')
@UseGuards(TenantGuard, FolderTrackerGuard)
export class FolderTrackerController {
  constructor(private readonly svc: FolderTrackerService) {}
  @Get() list(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.svc.list(ctx);
  }
  @Get('members') async members(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return {
      members: await this.svc.source.members(ctx.tenantId),
      currentActor: ctx.clerkUserId,
      canAssignOwner: isFolderAdmin(ctx),
    };
  }
  @Post() create(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() body: FolderFieldsDto) {
    return this.svc.create(ctx, body);
  }
  @Get('board') board(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query() query: FolderBoardQueryDto,
  ) {
    return this.svc.board(ctx, query);
  }
  @Get('search') search(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query() query: FolderBoardQueryDto,
  ) {
    return this.svc.board(ctx, query, true);
  }
  @Get('sessions/:jurisdiction') sessions(@Param('jurisdiction') jurisdiction: string) {
    if (!/^[A-Z]{2}$/.test(jurisdiction)) throw new NotFoundException();
    return this.svc.source.sessions(jurisdiction);
  }
  @Post('resolve') resolve(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() body: ResolveBillsDto,
  ) {
    return this.svc.resolveSelection(ctx, body);
  }
  @Post('export') export(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() body: FolderExportDto,
  ) {
    return this.svc.export(ctx, body);
  }
  @Put(':folderId') update(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('folderId') id: string,
    @Body() body: UpdateFolderDto,
  ) {
    return this.svc.update(ctx, id, body);
  }
  @Post(':folderId/bills') bulk(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('folderId') id: string,
    @Body() body: BulkFolderBillsDto,
  ) {
    return this.svc.bulk(ctx, id, body);
  }
  @Get(':folderId/bills/:billId/context') context(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('folderId') id: string,
    @Param('billId') billId: string,
  ) {
    return this.svc.context(ctx, id, billId);
  }
  @Put(':folderId/bills/:billId/context') updateContext(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('folderId') id: string,
    @Param('billId') billId: string,
    @Body() body: FolderContextDto,
  ) {
    return this.svc.updateContext(ctx, id, billId, body);
  }
}
