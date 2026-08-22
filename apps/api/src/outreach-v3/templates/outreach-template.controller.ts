import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsObject,
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
import type { OutreachTemplateSortKey } from './outreach-template.repository.js';
import { OutreachTemplateService } from './outreach-template.service.js';

const TEMPLATE_SORT_KEYS: OutreachTemplateSortKey[] = ['updated', 'name', 'usage', 'last_used'];

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

  @IsOptional()
  @IsString()
  @MaxLength(160)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  campaignType?: string;

  @IsOptional()
  @Transform(({ value }) => (value === true || value === 'true' ? true : value === false || value === 'false' ? false : value))
  @IsBoolean()
  mineOnly?: boolean;

  @IsOptional()
  @IsIn(TEMPLATE_SORT_KEYS)
  sort?: OutreachTemplateSortKey;
}

class GetTemplateQueryDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(60)
  campaignType?: string;

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

class CreateTemplateFromScratchDto {
  @IsString()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  campaignType?: string;

  // The reusable spec itself is validated by outreachTemplateSpecV1Schema
  // server-side (parseOutreachTemplateSpecV1) — this DTO only guards the
  // outer envelope shape before that parse runs.
  @IsObject()
  spec!: Record<string, unknown>;
}

class ReplaceDraftContentDto {
  @IsObject()
  spec!: Record<string, unknown>;
}

class CreateTemplateVersionDto {
  @IsUUID()
  sessionId!: string;
}

class DuplicateTemplateDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;
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

  @IsOptional()
  @IsObject()
  variableValues?: Record<string, string>;
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

  /**
   * Provenance lookup for the "From template · name · vN" marker and the
   * receipt panel on an already-open campaign (closeout runbook 7.6/7.7).
   * MUST be registered before the generic `:templateId` GET route below —
   * Nest/Express match routes in declaration order, and `ParseUUIDPipe` on
   * `:templateId` would otherwise 400 on the literal segment "provenance".
   */
  @Get('provenance/:sessionId')
  getProvenance(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.templates.getProvenance(ctx, sessionId);
  }

  @Get(':templateId')
  get(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Query() query: GetTemplateQueryDto,
  ) {
    return this.templates.get(ctx, templateId, query.clientId);
  }

  @Post('from-session')
  createFromSession(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: CreateTemplateFromSessionDto,
  ) {
    return this.templates.createFromSession(ctx, body);
  }

  @Post('from-scratch')
  createFromScratch(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: CreateTemplateFromScratchDto,
  ) {
    return this.templates.createFromScratch(ctx, body);
  }

  @Patch(':templateId')
  updateMetadata(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() body: TemplateMetadataDto,
  ) {
    return this.templates.updateMetadata(ctx, templateId, body);
  }

  @Patch(':templateId/draft')
  replaceDraftContent(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() body: ReplaceDraftContentDto,
  ) {
    return this.templates.replaceDraftContent(ctx, templateId, body.spec);
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

  @Post(':templateId/duplicate')
  duplicate(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() body: DuplicateTemplateDto,
  ) {
    return this.templates.duplicate(ctx, templateId, body);
  }

  @Post(':templateId/archive')
  archive(
    @CurrentTenant() ctx: TenantContext,
    @Param('templateId', ParseUUIDPipe) templateId: string,
  ) {
    return this.templates.archive(ctx, templateId);
  }
}
