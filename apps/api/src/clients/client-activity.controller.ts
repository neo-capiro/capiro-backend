import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import {
  ACTIVITY_KINDS,
  RECORDABLE_KINDS,
  ClientActivityService,
  type ActivityKind,
} from './client-activity.service.js';

class CreateActivityDto {
  // Only recordable kinds are accepted: meetings, documents and outreach are
  // written by the features that own them.
  @IsIn(RECORDABLE_KINDS)
  kind!: ActivityKind;

  @IsString()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  body?: string;

  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  @IsOptional()
  @IsUUID()
  personId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  sourceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  sourceId?: string;

  @IsOptional()
  @IsISO8601()
  dueAt?: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

class UpdateActivityDto {
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsBoolean()
  settled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  body?: string;
}

@Controller('clients/:clientId/activity')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientActivityController {
  constructor(private readonly service: ClientActivityService) {}

  @Get()
  list(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Query('kinds') kinds?: string,
    @Query('limit') limit?: string,
  ) {
    const requested = (kinds ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value): value is ActivityKind => (ACTIVITY_KINDS as readonly string[]).includes(value));
    return this.service.list(ctx, clientId, {
      ...(requested.length ? { kinds: requested } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
    });
  }

  @Post()
  create(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: CreateActivityDto,
  ) {
    return this.service.create(ctx, clientId, body);
  }

  @Patch(':id')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
    @Body() body: UpdateActivityDto,
  ) {
    return this.service.update(ctx, clientId, id, body);
  }

  @Delete(':id')
  remove(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
  ) {
    return this.service.remove(ctx, clientId, id);
  }
}
