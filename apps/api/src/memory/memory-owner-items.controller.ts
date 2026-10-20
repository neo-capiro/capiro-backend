import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request, Response } from 'express';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { PreviewNativeReadService } from '../auth/preview-native-read.service.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MemoryOwnerItemsService } from './memory-owner-items.service.js';

@Controller('memory/owner')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MemoryOwnerItemsController {
  constructor(
    private readonly items: MemoryOwnerItemsService,
    private readonly preview: PreviewNativeReadService,
  ) {}

  @Get('items')
  list(
    @CurrentTenant() ctx: TenantContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    if (this.preview.mode(req, res)) {
      return this.preview.run(req, res, ctx, (visibleClientIds) =>
        this.items.list(ctx, { cursor, limit, visibleClientIds }));
    }
    return this.items.list(ctx, { cursor, limit });
  }
}
