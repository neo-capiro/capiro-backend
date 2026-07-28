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

/** §4.5 twins, copied verbatim from AlertMemoController (HP-03/Gate L phase a). */
class DistrictBriefRegulationDto {
  @IsOptional() @IsString() @MaxLength(500) ruleTitle?: string | null;
  @IsOptional() @IsString() @MaxLength(200) agency?: string | null;
  @IsOptional() @IsString() @MaxLength(64) ruleType?: string | null;
  @IsOptional() @IsString() @MaxLength(32) commentEndDate?: string | null;
  @IsOptional() @IsString() @MaxLength(32) effectiveDate?: string | null;
  @IsOptional() @IsString() @MaxLength(120) docketId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) url?: string | null;
}

class DistrictBriefDeadlineDto {
  @IsOptional() @IsString() @MaxLength(64) cutoffType?: string | null;
  @IsOptional() @IsString() @MaxLength(32) cutoffDate?: string | null;
  @IsOptional() @IsNumber() daysUntil?: number | null;
}

class DistrictBriefProgramElementDto {
  @IsString() @MaxLength(32) peCode!: string;
  @IsOptional() @IsString() @MaxLength(300) title?: string | null;
  @IsOptional() @IsNumber() fiscalYear?: number | null;
  @IsOptional() @IsString() @MaxLength(64) deltaType?: string | null;
  @IsOptional() @IsString() @MaxLength(120) deltaTypeLabel?: string | null;
  @IsOptional() @IsString() @MaxLength(200) fromRef?: string | null;
  @IsOptional() @IsString() @MaxLength(200) toRef?: string | null;
  @IsOptional() @IsNumber() amountFromMillions?: number | null;
  @IsOptional() @IsNumber() amountToMillions?: number | null;
  @IsOptional() @IsNumber() deltaMillions?: number | null;
  @IsOptional() @IsNumber() deltaPct?: number | null;
  @IsOptional() @IsString() @MaxLength(32) verification?: string | null;
  @IsOptional() @IsString() @MaxLength(200) linkedRef?: string | null;
  @IsOptional() @IsString() @MaxLength(500) href?: string | null;
}

class DistrictBriefAlertDto implements AlertMemoAlertInput {
  @IsString() alertId!: string;
  // HP-03 (Gate L phase a): widened for state_bill only — a district brief for a
  // program_element or regulation alert stays out of scope (feedItemToDistrictBriefAlert
  // still downgrades those). Still an allow-list: an unknown sourceType is rejected.
  @IsIn(['bill', 'hearing', 'combined', 'state_bill'])
  sourceType!: 'bill' | 'hearing' | 'combined' | 'state_bill';
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
  @IsOptional() @ValidateNested() @Type(() => DistrictBriefProgramElementDto)
  programElement?: DistrictBriefProgramElementDto;
  /** §4.5: 2-letter state code, or 'US' for federal. Drives the state-bill framing. */
  @IsOptional() @IsString() @MaxLength(32) jurisdiction?: string | null;
  /** Gate L (HP-03) followup: the state legislative session's display name
   *  (e.g. "2026 Regular Session"). Only ever set for sourceType='state_bill'. */
  @IsOptional() @IsString() @MaxLength(120) session?: string | null;
  @IsOptional() @ValidateNested() @Type(() => DistrictBriefDeadlineDto)
  deadline?: DistrictBriefDeadlineDto | null;
  @IsOptional() @ValidateNested() @Type(() => DistrictBriefRegulationDto)
  regulation?: DistrictBriefRegulationDto;
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
