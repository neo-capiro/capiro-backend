import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ClientCapabilitiesService } from './client-capabilities.service.js';

class CreateCapabilityDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  sector?: string;

  @IsOptional()
  @IsArray()
  tags?: unknown[];

  @IsOptional()
  @IsArray()
  issueCodes?: unknown[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(9)
  trl?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  mrl?: number;

  @IsOptional()
  @IsString()
  peNumber?: string;

  // Step 2.3 — multi-PE list + explicit match keywords (peNumber kept for backcompat).
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  peNumbers?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @IsString()
  appropriationAccount?: string;

  @IsOptional()
  @IsString()
  serviceBranch?: string;

  @IsOptional()
  @IsString()
  targetSubcommittee?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  fundingAsk?: number;

  @IsOptional()
  @IsString()
  fundingAskLabel?: string;

  @IsOptional()
  @IsString()
  justification?: string;

  @IsOptional()
  @IsString()
  districtNexus?: string;

  @IsOptional()
  @IsString()
  existingContracts?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

// PATCH is partial, so every field — including `name` — must be optional.
// We can't `extends CreateCapabilityDto` here: that DTO marks `name` required
// (@IsString without @IsOptional), and because the global ValidationPipe runs
// whitelist + forbidNonWhitelisted, a partial update that omits `name` (e.g.
// editing only the description or tags) would be rejected with 400
// ("name must be a string"). Declared standalone, mirroring UpdateHistoryDto.
class UpdateCapabilityDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  sector?: string;

  @IsOptional()
  @IsArray()
  tags?: unknown[];

  @IsOptional()
  @IsArray()
  issueCodes?: unknown[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(9)
  trl?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  mrl?: number;

  @IsOptional()
  @IsString()
  peNumber?: string;

  // Step 2.3 — multi-PE list + explicit match keywords (peNumber kept for backcompat).
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  peNumbers?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @IsString()
  appropriationAccount?: string;

  @IsOptional()
  @IsString()
  serviceBranch?: string;

  @IsOptional()
  @IsString()
  targetSubcommittee?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  fundingAsk?: number;

  @IsOptional()
  @IsString()
  fundingAskLabel?: string;

  @IsOptional()
  @IsString()
  justification?: string;

  @IsOptional()
  @IsString()
  districtNexus?: string;

  @IsOptional()
  @IsString()
  existingContracts?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

class CreateHistoryDto {
  @IsString()
  fiscalYear!: string;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  meta?: string;

  @IsOptional()
  @IsString()
  outcome?: string;

  @IsOptional()
  @IsString()
  outcomeType?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

class UpdateHistoryDto {
  @IsOptional()
  @IsString()
  fiscalYear?: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  meta?: string;

  @IsOptional()
  @IsString()
  outcome?: string;

  @IsOptional()
  @IsString()
  outcomeType?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

@Controller('clients/:clientId')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientCapabilitiesController {
  constructor(private readonly service: ClientCapabilitiesService) {}

  @Get('capabilities')
  listCapabilities(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
  ) {
    return this.service.listCapabilities(ctx, clientId);
  }

  @Post('capabilities')
  createCapability(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: CreateCapabilityDto,
  ) {
    return this.service.createCapability(ctx, clientId, body);
  }

  @Patch('capabilities/:id')
  updateCapability(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
    @Body() body: UpdateCapabilityDto,
  ) {
    return this.service.updateCapability(ctx, clientId, id, body);
  }

  @Delete('capabilities/:id')
  deleteCapability(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
  ) {
    return this.service.deleteCapability(ctx, clientId, id);
  }

  /**
   * Client-wide submission history in ONE read. The profile UI previously had
   * to fan out one `capabilities/:capId/history` request per capability (14+
   * parallel GETs on profile load), which drove the API to 503s. Same rows,
   * same tenancy checks, one query.
   */
  @Get('submission-history')
  listClientHistory(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.listClientHistory(ctx, clientId, 200);
  }

  @Get('capabilities/:capId/history')
  listHistory(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('capId') capId: string,
  ) {
    return this.service.listHistory(ctx, clientId, capId);
  }

  @Post('capabilities/:capId/history')
  createHistory(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('capId') capId: string,
    @Body() body: CreateHistoryDto,
  ) {
    return this.service.createHistory(ctx, clientId, capId, body);
  }

  @Patch('history/:id')
  updateHistory(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
    @Body() body: UpdateHistoryDto,
  ) {
    return this.service.updateHistory(ctx, clientId, id, body);
  }

  @Delete('history/:id')
  deleteHistory(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
  ) {
    return this.service.deleteHistory(ctx, clientId, id);
  }
}
