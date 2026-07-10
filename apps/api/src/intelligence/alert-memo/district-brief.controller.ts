import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { DistrictBriefService } from './district-brief.service.js';
import type { AlertMemoAlertInput } from './alert-memo.types.js';

// Global ValidationPipe runs whitelist + forbidNonWhitelisted, so every DTO field
// MUST carry a class-validator decorator (mirrors AlertMemoController).

class DistrictBriefQuoteDto {
  @IsString() @MaxLength(4000) text!: string;
  @IsOptional() @IsString() speaker?: string;
  @IsOptional() @IsNumber() atSec?: number;
}

class DistrictBriefAlertDto implements AlertMemoAlertInput {
  @IsString() alertId!: string;
  @IsIn(['bill', 'hearing', 'combined']) sourceType!: 'bill' | 'hearing' | 'combined';
  @IsString() @MaxLength(500) title!: string;
  @IsOptional() @IsString() whyItMatters?: string | null;
  @IsOptional() @IsString() severity?: string | null;
  @IsOptional() @IsString() band?: string | null;
  @IsOptional() @IsString() sourceRef?: string | null;
  @IsOptional() @IsString() billDisplayNum?: string | null;
  @IsOptional() @IsString() billTitle?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) actionText?: string | null;
  @IsOptional() @IsString() actionDate?: string | null;
  @IsOptional() @IsString() committee?: string | null;
  @IsOptional() @IsString() hearingTitle?: string | null;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DistrictBriefQuoteDto)
  quotes?: DistrictBriefQuoteDto[];
  @IsOptional() @IsString() url?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) matchedTags?: string[];
}

class GenerateDistrictBriefDto {
  @ValidateNested() @Type(() => DistrictBriefAlertDto) alert!: DistrictBriefAlertDto;
  /** When regenerating from the composer, the prior Document to replace. */
  @IsOptional() @IsString() replaceAttachmentId?: string;
}

/**
 * District-impact one-pager API (Phase 1 M1.5, PD6). Mounted under
 * /intelligence alongside alert-memo — same alert shape the Feed already
 * passes for /alert-memo, plus which of the client's facilities the brief
 * should ground on.
 */
@Controller('intelligence')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class DistrictBriefController {
  constructor(private readonly brief: DistrictBriefService) {}

  @Post('clients/:clientId/facilities/:facilityId/district-brief')
  generate(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('facilityId') facilityId: string,
    @Body() body: GenerateDistrictBriefDto,
  ) {
    return this.brief.generate(ctx, clientId, facilityId, body.alert, body.replaceAttachmentId);
  }
}
