import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseFilters, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { OUTREACH_GOVERNMENT_RECORD_CATEGORIES } from '../../capabilities/context/outreach-context.contract.js';
import { OutreachV3StateGuard } from '../api/outreach-v3-state.guard.js';
import { OutreachV3ExceptionFilter } from '../api/outreach-v3-exception.filter.js';
import { OutreachV3ContextGuard } from './outreach-v3-context.guard.js';
import { OutreachV3ContextService } from './outreach-v3-context.service.js';

const contextClasses = [
  'required_policy',
  'writing_guidance',
  'campaign_fact',
  'target_specific',
  'group_safe',
] as const;

class SearchMemoryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  query!: string;

  @IsOptional()
  @IsUUID()
  clientId?: string | null;

  @IsIn(contextClasses)
  intendedClass!: (typeof contextClasses)[number];

  @IsObject()
  scope!: Record<string, unknown>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

class ResearchGovernmentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  query!: string;

  @IsOptional()
  @IsArray()
  @IsIn(OUTREACH_GOVERNMENT_RECORD_CATEGORIES, { each: true })
  categories?: Array<(typeof OUTREACH_GOVERNMENT_RECORD_CATEGORIES)[number]>;

  @IsIn(['required_policy', 'campaign_fact', 'target_specific', 'group_safe'])
  intendedClass!: 'required_policy' | 'campaign_fact' | 'target_specific' | 'group_safe';

  @IsObject()
  scope!: Record<string, unknown>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

class GetDocumentDto {
  @IsUUID()
  documentId!: string;

  @IsOptional()
  @IsUUID()
  clientId?: string | null;

  @IsIn(contextClasses)
  intendedClass!: (typeof contextClasses)[number];

  @IsObject()
  scope!: Record<string, unknown>;
}

@Controller('engagement/outreach-v3/sessions/:sessionId/context')
@UseGuards(OutreachV3StateGuard, OutreachV3ContextGuard, RolesGuard)
@UseFilters(OutreachV3ExceptionFilter)
@Roles('standard_user')
export class OutreachV3ContextController {
  constructor(private readonly context: OutreachV3ContextService) {}

  @Post('memory/search')
  searchMemory(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: SearchMemoryDto,
  ) {
    return this.context.searchMemory(ctx, sessionId, {
      query: body.query,
      clientId: body.clientId ?? null,
      intendedClass: body.intendedClass,
      scope: body.scope as never,
      limit: body.limit ?? 20,
    });
  }

  @Post('government/search')
  researchGovernment(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: ResearchGovernmentDto,
  ) {
    return this.context.researchGovernment(ctx, sessionId, {
      query: body.query,
      categories: body.categories ?? [],
      intendedClass: body.intendedClass,
      scope: body.scope as never,
      limit: body.limit ?? 20,
    });
  }

  @Post('document')
  getDocument(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: GetDocumentDto,
  ) {
    return this.context.getDocument(ctx, sessionId, {
      documentId: body.documentId,
      clientId: body.clientId ?? null,
      intendedClass: body.intendedClass,
      scope: body.scope as never,
    });
  }

  @Get('review')
  review(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.context.review(ctx, sessionId);
  }

  @Get('strategy')
  strategy(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.context.recommendStrategy(ctx, sessionId);
  }
}
