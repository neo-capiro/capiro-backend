import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { DistrictNexusFlagGuard } from './district-nexus-flag.guard.js';
import {
  DISTRICT_NEXUS_AWARD_RELATIONSHIP_TYPES,
  DISTRICT_NEXUS_RELATIONSHIP_STATUSES,
  DistrictNexusRelationshipsService,
  type DistrictNexusAwardRelationshipType,
  type DistrictNexusRelationshipStatus,
} from './district-nexus-relationships.service.js';

class AssistanceAwardSearchQueryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  q!: string;
}

class CreateDistrictNexusRelationshipDto {
  @IsUUID()
  assistanceAwardId!: string;

  @IsIn([...DISTRICT_NEXUS_AWARD_RELATIONSHIP_TYPES])
  relationshipType!: DistrictNexusAwardRelationshipType;

  @IsOptional()
  @IsUUID()
  facilityId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  relationshipDescription?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  attributableAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  beneficiaryCount?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  evidenceSourceRef?: string | null;

  @IsOptional()
  @IsIn([...DISTRICT_NEXUS_RELATIONSHIP_STATUSES])
  verificationStatus?: DistrictNexusRelationshipStatus;

  @IsOptional()
  @IsBoolean()
  externalUseApproved?: boolean;

  @IsOptional()
  @IsDateString({ strict: true })
  effectiveStart?: string | null;

  @IsOptional()
  @IsDateString({ strict: true })
  effectiveEnd?: string | null;
}

class UpdateDistrictNexusRelationshipDto {
  @IsOptional()
  @IsUUID()
  assistanceAwardId?: string;

  @IsOptional()
  @IsIn([...DISTRICT_NEXUS_AWARD_RELATIONSHIP_TYPES])
  relationshipType?: DistrictNexusAwardRelationshipType;

  @IsOptional()
  @IsUUID()
  facilityId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  relationshipDescription?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  attributableAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  beneficiaryCount?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  evidenceSourceRef?: string | null;

  @IsOptional()
  @IsIn([...DISTRICT_NEXUS_RELATIONSHIP_STATUSES])
  verificationStatus?: DistrictNexusRelationshipStatus;

  @IsOptional()
  @IsBoolean()
  externalUseApproved?: boolean;

  @IsOptional()
  @IsDateString({ strict: true })
  effectiveStart?: string | null;

  @IsOptional()
  @IsDateString({ strict: true })
  effectiveEnd?: string | null;
}

/**
 * Human-review surface for the seven awarded-grant relationship types already
 * consumed by DistrictNexusService. Reads are available to normal tenant users;
 * mutations require user_admin and are audit-logged in the same transaction.
 */
@Controller('intelligence')
@UseGuards(RolesGuard, DistrictNexusFlagGuard)
@Roles('standard_user')
export class DistrictNexusRelationshipsController {
  constructor(private readonly relationships: DistrictNexusRelationshipsService) {}

  @Get('clients/:clientId/district-nexus-relationships')
  list(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
  ) {
    return this.relationships.list(ctx.tenantId, clientId);
  }

  @Get('district-nexus/assistance-awards/search')
  searchAwards(@Query() query: AssistanceAwardSearchQueryDto) {
    return this.relationships.searchAwards(query.q);
  }

  @Post('clients/:clientId/district-nexus-relationships')
  @Roles('user_admin')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: CreateDistrictNexusRelationshipDto,
  ) {
    return this.relationships.create(
      ctx.tenantId,
      clientId,
      { userId: ctx.userId, role: ctx.role },
      body,
    );
  }

  @Patch('clients/:clientId/district-nexus-relationships/:relationshipId')
  @Roles('user_admin')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('relationshipId') relationshipId: string,
    @Body() body: UpdateDistrictNexusRelationshipDto,
  ) {
    return this.relationships.update(
      ctx.tenantId,
      clientId,
      relationshipId,
      { userId: ctx.userId, role: ctx.role },
      body,
    );
  }

  @Delete('clients/:clientId/district-nexus-relationships/:relationshipId')
  @Roles('user_admin')
  reject(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('relationshipId') relationshipId: string,
  ) {
    return this.relationships.reject(
      ctx.tenantId,
      clientId,
      relationshipId,
      { userId: ctx.userId, role: ctx.role },
    );
  }
}
