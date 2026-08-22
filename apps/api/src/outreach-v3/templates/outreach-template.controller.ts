import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { OutreachV3ExceptionFilter } from '../api/outreach-v3-exception.filter.js';
import { OutreachV3StateGuard } from '../api/outreach-v3-state.guard.js';
import type { OutreachTemplateScope } from './outreach-template.contract.js';
import { OutreachTemplateService } from './outreach-template.service.js';

class ListTemplatesQueryDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  includeArchived?: boolean;

  @IsOptional()
  @IsUUID()
  clientId?: string;
}

class TemplateMetadataDto {
  @IsString()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  description?: string;

  @IsIn(['private', 'firm', 'client'])
  scope!: OutreachTemplateScope;

  @IsOptional()
  @IsUUID()
  clientId?: string;
}

class CreateTemplateFromSessionDto extends TemplateMetadataDto {
  @IsUUID()
  sessionId!: string;
}

class CreateTemplateVersionDto {
  @IsUUID()
  sessionId!: string;
}

class UseTemplateDto {
  @IsUUID()
  requestKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  title?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;
}

@Controller('engagement/outreach-v3/templates')
@UseGuards(OutreachV3StateGuard, RolesGuard)
@UseFilters(OutreachV3ExceptionFilter)
@Roles('standard_user')
export class OutreachTemplateController {
  constructor(private readonly templates: OutreachTemplateService) {}

  @Get()
  list(@CurrentTenant() ctx: TenantContext, @Query() query: ListTemplatesQueryDto) {
    return this.templates.list(ctx, query);
  }

  @Get(':templateId')
  get(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Query('clientId') clientId?: string,
  ) {
    return this.templates.get(ctx, templateId, clientId);
  }

  @Post('from-session')
  createFromSession(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: CreateTemplateFromSessionDto,
  ) {
    return this.templates.createFromSession(ctx, body);
  }

  @Patch(':templateId')
  updateMetadata(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() body: TemplateMetadataDto,
  ) {
    return this.templates.updateMetadata(ctx, templateId, body);
  }

  @Post(':templateId/versions/from-session')
  createVersion(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() body: CreateTemplateVersionDto,
  ) {
    return this.templates.createVersionFromSession(ctx, templateId, body);
  }

  @Post(':templateId/publish')
  publish(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ) {
    return this.templates.publish(ctx, templateId);
  }

  @Post(':templateId/use')
  use(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() body: UseTemplateDto,
  ) {
    return this.templates.usePublished(ctx, templateId, body);
  }

  @Post(':templateId/archive')
  archive(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ) {
    return this.templates.archive(ctx, templateId);
  }
}
