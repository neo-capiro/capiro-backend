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

class AlertMemoAlertDto implements AlertMemoAlertInput {
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
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AlertMemoQuoteDto)
  quotes?: AlertMemoQuoteDto[];
  @IsOptional() @IsString() url?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) matchedTags?: string[];
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
