import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request, Response } from 'express';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { PreviewNativeReadService } from '../auth/preview-native-read.service.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MemoryOwnerHistoryService } from './memory-owner-history.service.js';
import { MemoryOwnerEvidenceService } from './memory-owner-evidence.service.js';
import { MemoryOwnerItemsService } from './memory-owner-items.service.js';

@Controller('memory/owner')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MemoryOwnerItemsController {
  constructor(
    private readonly items: MemoryOwnerItemsService,
    private readonly history: MemoryOwnerHistoryService,
    private readonly evidence: MemoryOwnerEvidenceService,
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
        this.items.list(ctx, { cursor, limit, visibleClientIds }),
      );
    }
    return this.items.list(ctx, { cursor, limit });
  }
  @Get('items/:itemId/versions')
  historyRead(
    @CurrentTenant() ctx: TenantContext,
    @Param('itemId') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    if (Object.keys(query).some((key) => key !== 'limit' && key !== 'cursor'))
      throw new BadRequestException('Invalid memory query.');
    res.setHeader('Cache-Control', 'private, no-store');
    const run = (visibleClientIds?: readonly string[]) =>
      this.history.list(ctx, id, { ...query, visibleClientIds });
    return this.preview.mode(req, res) ? this.preview.run(req, res, ctx, run) : run();
  }

  @Get('items/:itemId/evidence')
  evidenceRead(
    @CurrentTenant() ctx: TenantContext,
    @Param('itemId') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    if (Object.keys(query).some((key) => key !== 'limit' && key !== 'cursor'))
      throw new BadRequestException('Invalid memory query.');
    res.setHeader('Cache-Control', 'private, no-store');
    const run = (visibleClientIds?: readonly string[]) =>
      this.evidence.list(ctx, id, { ...query, visibleClientIds }, req.headers.authorization);
    return this.preview.mode(req, res) ? this.preview.run(req, res, ctx, run) : run();
  }
}
