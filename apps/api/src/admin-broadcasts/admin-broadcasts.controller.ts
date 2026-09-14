import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import {
  ADMIN_BROADCAST_AUDIENCES,
  AdminBroadcastsService,
  type AdminBroadcastAudienceInput,
} from './admin-broadcasts.service.js';

class CreateBroadcastDto {
  @IsUUID()
  tenantId!: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsString()
  @Length(1, 5000)
  body!: string;

  @IsIn(ADMIN_BROADCAST_AUDIENCES)
  audience!: AdminBroadcastAudienceInput;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  userIds?: string[];
}

/** Capiro-staff console: send and track acknowledgement of tenant broadcasts. */
@Controller('capiro-admin/broadcasts')
@UseGuards(RolesGuard)
@Roles('capiro_admin')
export class AdminBroadcastsController {
  constructor(private readonly service: AdminBroadcastsService) {}

  @Get('tenant-members')
  listTenantMembers(@Query('tenantId', new ParseUUIDPipe()) tenantId: string) {
    return this.service.listTenantMembers(tenantId);
  }

  @Get()
  list(@Query('tenantId', new ParseUUIDPipe()) tenantId: string) {
    return this.service.listBroadcasts(tenantId);
  }

  @Post()
  create(@CurrentTenant() ctx: TenantContext, @Body() body: CreateBroadcastDto) {
    return this.service.createBroadcast(ctx, body);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.getBroadcast(id);
  }

  @Post(':id/archive')
  archive(@CurrentTenant() ctx: TenantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.archiveBroadcast(ctx, id);
  }
}
