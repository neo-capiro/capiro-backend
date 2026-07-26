import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { AlertMemoService } from './alert-memo.service.js';
import type { AlertMemoAlertInput } from './alert-memo.types.js';

// Global ValidationPipe runs whitelist + forbidNonWhitelisted, so every DTO field
// MUST carry a class-validator decorator (mirrors ArtifactController).

class AlertMemoQuoteDto {
  @IsString() @MaxLength(4000) text!: string;
  @IsOptional() @IsString() speaker?: string;
  @IsOptional() @IsNumber() atSec?: number;
}

/**
 * P0-08. Every field carries a decorator because the global ValidationPipe runs
 * forbidNonWhitelisted — an undecorated field would 400 the whole request.
 */
/** §4.5. Every field decorated — forbidNonWhitelisted would 400 the request otherwise. */
class AlertMemoRegulationDto {
  @IsOptional() @IsString() @MaxLength(500) ruleTitle?: string | null;
  @IsOptional() @IsString() @MaxLength(200) agency?: string | null;
  @IsOptional() @IsString() @MaxLength(64) ruleType?: string | null;
  @IsOptional() @IsString() @MaxLength(32) commentEndDate?: string | null;
  @IsOptional() @IsString() @MaxLength(32) effectiveDate?: string | null;
  @IsOptional() @IsString() @MaxLength(120) docketId?: string | null;
  @IsOptional() @IsString() @MaxLength(500) url?: string | null;
}

class AlertMemoDeadlineDto {
  @IsOptional() @IsString() @MaxLength(64) cutoffType?: string | null;
  @IsOptional() @IsString() @MaxLength(32) cutoffDate?: string | null;
  @IsOptional() @IsNumber() daysUntil?: number | null;
}

class AlertMemoProgramElementDto {
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

/** Exported so the PE widening (P0-08) can be validated directly in a unit test. */
export class AlertMemoAlertDto implements AlertMemoAlertInput {
  @IsString() alertId!: string;
  // P0-08 / §4.5: widened for program_element, state_bill, and regulation — each now has
  // its own section order, system prompt, claim builder, and scaffold. Still an
  // allow-list: an unknown sourceType is rejected, never coerced.
  @IsIn(['bill', 'hearing', 'combined', 'program_element', 'state_bill', 'regulation'])
  sourceType!: 'bill' | 'hearing' | 'combined' | 'program_element' | 'state_bill' | 'regulation';
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
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AlertMemoQuoteDto)
  quotes?: AlertMemoQuoteDto[];
  @IsOptional() @IsString() url?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) matchedTags?: string[];
  @IsOptional() @ValidateNested() @Type(() => AlertMemoProgramElementDto)
  programElement?: AlertMemoProgramElementDto;
  @IsOptional() @IsString() @MaxLength(32) jurisdiction?: string | null;
  @IsOptional() @ValidateNested() @Type(() => AlertMemoDeadlineDto)
  deadline?: AlertMemoDeadlineDto | null;
  @IsOptional() @ValidateNested() @Type(() => AlertMemoRegulationDto)
  regulation?: AlertMemoRegulationDto;
}

class GenerateAlertMemoDto {
  @IsString() @MaxLength(300) clientName!: string;
  @ValidateNested() @Type(() => AlertMemoAlertDto) alert!: AlertMemoAlertDto;
  /** When regenerating from the composer, the prior Document to replace. */
  @IsOptional() @IsString() replaceAttachmentId?: string;
}

export class SaveAlertMemoDto {
  @IsString() @MaxLength(300) title!: string;
  @IsString() @MinLength(1) markdown!: string;
  @IsString() @MaxLength(300) clientName!: string;
  /** REQUIRED (P0-01): the alert this memo came from — the review-hold guard keys on it. */
  @IsString() @MaxLength(128) alertId!: string;
  @IsOptional() @IsString() actionDate?: string;
  @IsOptional() @IsString() replaceAttachmentId?: string;
}

/**
 * Alert → client-memo generation API. Mounted under /intelligence (own module).
 * Tenant-scoped via RolesGuard + @Roles(standard_user); the service enforces RLS
 * through withTenant. The alert content is passed from intel-api's Feed (the
 * frontend already has it); apps/api enriches with the client's Memory files,
 * generates a grounded memo, and auto-files it in the client's Documents.
 */
@Controller('intelligence')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class AlertMemoController {
  constructor(private readonly memo: AlertMemoService) {}

  /** Generate a Memory-grounded client memo from an alert + auto-file to Documents. */
  @Post('clients/:clientId/alert-memo')
  generate(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: GenerateAlertMemoDto,
  ) {
    return this.memo.generate(ctx, clientId, body.alert, body.clientName, body.replaceAttachmentId);
  }

  /** Persist an edited memo: re-render the (edited) markdown to docx + re-file to Documents. */
  @Post('clients/:clientId/alert-memo/save')
  save(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: SaveAlertMemoDto,
  ) {
    return this.memo.saveEdited(ctx, clientId, body);
  }
}
