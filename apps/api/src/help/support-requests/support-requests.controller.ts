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
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { CreateSupportRequestDto, ListSupportRequestsDto } from './support-requests.dto.js';
import { SupportRequestsService } from './support-requests.service.js';

@Controller('me/support-requests')
@UseGuards(RolesGuard)
@Roles('client_portal_user')
export class MySupportRequestsController {
  constructor(private readonly service: SupportRequestsService) {}

  @Post()
  create(@CurrentTenant() ctx: TenantContext, @Body() body: CreateSupportRequestDto) {
    return this.service.create(ctx, body);
  }

  @Get(':id')
  receipt(@CurrentTenant() ctx: TenantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.ownReceipt(ctx, id);
  }
}

@Controller('capiro-admin/support-requests')
@UseGuards(RolesGuard)
@Roles('capiro_admin')
export class AdminSupportRequestsController {
  constructor(private readonly service: SupportRequestsService) {}

  @Get()
  list(@CurrentTenant() ctx: TenantContext, @Query() query: ListSupportRequestsDto) {
    return this.service.listForStaff(ctx, query);
  }

  @Get(':id')
  detail(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('tenantId', new ParseUUIDPipe()) tenantId: string,
  ) {
    return this.service.detailForStaff(ctx, tenantId, id);
  }
}
