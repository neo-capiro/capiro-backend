import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { PortfolioCaseService } from './portfolio-case.service.js';
import { parsePortfolio } from './portfolio.contracts.js';
const filterSchema = z
  .object({
    capabilityId: z.string().uuid().optional(),
    memberId: z.string().min(1).max(180).optional(),
    sourceDirectory: z.enum(['congress', 'state']).optional(),
    officeTerm: z.string().min(1).max(180).optional(),
  })
  .strict();

@Controller('clients/:clientId/portfolio')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class PortfolioCaseController {
  constructor(private readonly service: PortfolioCaseService) {}
  @Get('depth')
  @Roles('standard_user')
  depth(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Query() query: unknown,
  ) {
    return this.service.depth(ctx, clientId, parsePortfolio(filterSchema, query));
  }
  @Post('case/proposals')
  proposeCase(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() body: unknown,
  ) {
    return this.service.propose(ctx, clientId, body, 'case_field');
  }
  @Post('case/:id/review')
  reviewCase(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.service.review(ctx, clientId, id, body, 'case_field');
  }
  @Post('sectors/proposals')
  proposeSector(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() body: unknown,
  ) {
    return this.service.propose(ctx, clientId, body, 'sector_anchor');
  }
  @Post('sectors/:id/review')
  reviewSector(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.service.review(ctx, clientId, id, body, 'sector_anchor');
  }
}
