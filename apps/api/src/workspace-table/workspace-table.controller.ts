import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { WorkspaceTableService } from './workspace-table.service.js';
import { PlatformTableQueryDto } from './workspace-table.dto.js';

/**
 * Insert → Table → "Pull from platform" data source. Returns a flat
 * { title, headers, rows } the editor inserts as a prefilled (editable) table.
 * Tenant-guarded; any standard_user may pull tables for their own drafts.
 */
@Controller('workspace')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class WorkspaceTableController {
  constructor(private readonly tables: WorkspaceTableService) {}

  @Get('platform-table')
  platformTable(@CurrentTenant() ctx: TenantContext, @Query() query: PlatformTableQueryDto) {
    return this.tables.build(ctx, query.source, {
      peCode: query.peCode,
      clientId: query.clientId,
    });
  }
}
