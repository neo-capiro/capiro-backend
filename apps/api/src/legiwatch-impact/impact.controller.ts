import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ImpactService } from './impact.service.js';
import { ImpactContextDto, ImpactTrackerQuery } from './impact.dto.js';
import { ImpactRefreshService } from './impact-refresh.service.js';

@Controller('legiwatch')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ImpactController {
  constructor(
    private readonly service: ImpactService,
    private readonly refresh: ImpactRefreshService,
  ) {}
  @Get('tracker')
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentTenant() ctx: TenantContext, @Query() query: ImpactTrackerQuery) {
    return this.service.list(ctx, query);
  }

  @Get('clients/:clientId/bills/:billId/impact')
  @Header('Cache-Control', 'private, no-store')
  detail(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('billId') billId: string,
  ) {
    return this.service.detail(ctx, clientId, billId);
  }

  @Post('clients/:clientId/bills/:billId/impact/analyze')
  @HttpCode(202)
  @Header('Cache-Control', 'private, no-store')
  analyze(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('billId') billId: string,
  ) {
    return this.refresh.request(ctx, clientId, billId);
  }

  @Put('clients/:clientId/bills/:billId/context')
  @Header('Cache-Control', 'private, no-store')
  context(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('billId') billId: string,
    @Body() body: ImpactContextDto,
  ) {
    return this.service.updateContext(ctx, clientId, billId, body);
  }
}
