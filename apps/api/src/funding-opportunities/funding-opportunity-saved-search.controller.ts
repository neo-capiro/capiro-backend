import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsDefined,
  IsObject,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { FundingOpportunitiesFlagGuard } from './funding-opportunities-flag.guard.js';
import { FundingOpportunitySavedSearchService } from './funding-opportunity-saved-search.service.js';

export class CreateSavedSearchDto {
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string | null;
  @IsIn(['private', 'tenant']) visibility!: 'private' | 'tenant';
  @IsOptional() @IsUUID() clientId?: string | null;
  @IsDefined() @IsObject() criteria!: Record<string, unknown>;
}

export class PatchSavedSearchDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string | null;
  @IsOptional() @IsIn(['private', 'tenant']) visibility?: 'private' | 'tenant';
  @IsOptional() @IsUUID() clientId?: string | null;
  @IsOptional() @IsObject() criteria?: Record<string, unknown>;
  @IsOptional() @IsBoolean() archived?: boolean;
}

export class DuplicateSavedSearchDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
}

export class SavedSearchListQueryDto {
  @IsOptional() @IsUUID() clientId?: string;
}

@Controller('intelligence/opportunities/v2/searches')
@Roles('standard_user')
@UseGuards(RolesGuard, FundingOpportunitiesFlagGuard)
export class FundingOpportunitySavedSearchController {
  constructor(private readonly service: FundingOpportunitySavedSearchService) {}

  @Get()
  list(@CurrentTenant() ctx: TenantContext, @Query() query: SavedSearchListQueryDto) {
    return this.service.list(ctx, query.clientId);
  }

  @Post()
  create(@CurrentTenant() ctx: TenantContext, @Body() body: CreateSavedSearchDto) {
    return this.service.create(ctx, body);
  }

  @Get(':id')
  get(@CurrentTenant() ctx: TenantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.get(ctx, id);
  }

  @Patch(':id')
  update(@CurrentTenant() ctx: TenantContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: PatchSavedSearchDto) {
    return this.service.update(ctx, id, body);
  }

  @Delete(':id')
  remove(@CurrentTenant() ctx: TenantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.remove(ctx, id);
  }

  @Post(':id/apply')
  apply(@CurrentTenant() ctx: TenantContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.apply(ctx, id);
  }

  @Post(':id/duplicate')
  duplicate(@CurrentTenant() ctx: TenantContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: DuplicateSavedSearchDto) {
    return this.service.duplicate(ctx, id, body?.name);
  }
}
