import { Body, Controller, Get, Param, Post, Query, UseGuards, Headers, Res } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength, Matches } from 'class-validator';
import type { Response } from 'express';
import { DOCX_MIME } from './alert-memo-docx.js';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { HearingRecapService } from './hearing-recap.service.js';

export class SaveHearingRecapDto {
  @IsString() @MaxLength(128) sessionId!: string;
  @IsString() @MaxLength(300) title!: string;
  @IsString() @MinLength(1) markdown!: string;
  @IsOptional() @IsString() replaceAttachmentId?: string;
}
export class ApprovedHearingRecapDto {
  @IsString() @MinLength(1) @MaxLength(128) sessionId!: string;
  @IsString() @MinLength(1) @MaxLength(128) publicationId!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) contentHash!: string;
}
export class ApprovedRecordBriefDto {
  @IsString() @MinLength(1) @MaxLength(128) eventId!: string;
  @IsString() @MinLength(1) @MaxLength(128) briefId!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) contentHash!: string;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

@Controller('intelligence')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class HearingRecapController {
  constructor(private readonly recaps: HearingRecapService) {}
  @Post('clients/:clientId/record-briefs/approved')
  saveRecordBrief(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() input: ApprovedRecordBriefDto,
    @Headers('authorization') authorization?: string,
    @Headers('x-capiro-impersonate-tenant') impersonation?: string,
  ) {
    return this.recaps.recordBriefDocument(
      ctx,
      clientId,
      input,
      true,
      authorization,
      impersonation,
    );
  }
  @Post('clients/:clientId/record-briefs/approved/export')
  async exportRecordBrief(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() input: ApprovedRecordBriefDto,
    @Res() response: Response,
    @Headers('authorization') authorization?: string,
    @Headers('x-capiro-impersonate-tenant') impersonation?: string,
  ) {
    const file = await this.recaps.recordBriefDocument(
      ctx,
      clientId,
      input,
      false,
      authorization,
      impersonation,
    );
    if (!('buffer' in file) || typeof file.fileName !== 'string')
      throw new Error('RECORD_BRIEF_EXPORT_CONTRACT');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Type', DOCX_MIME);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    response.send(file.buffer);
  }
  @Post('clients/:clientId/hearing-recaps/approved')
  saveApproved(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() input: ApprovedHearingRecapDto,
    @Headers('authorization') authorization?: string,
    @Headers('x-capiro-impersonate-tenant') impersonation?: string,
  ) {
    return this.recaps.saveApproved(ctx, clientId, input, authorization, impersonation);
  }
  @Post('clients/:clientId/hearing-recaps/approved/export')
  async exportApproved(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() input: ApprovedHearingRecapDto,
    @Res() response: Response,
    @Headers('authorization') authorization?: string,
    @Headers('x-capiro-impersonate-tenant') impersonation?: string,
  ) {
    const file = await this.recaps.exportApproved(
      ctx,
      clientId,
      input,
      authorization,
      impersonation,
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Type', DOCX_MIME);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    response.send(file.buffer);
  }

  @Get('clients/:clientId/hearing-recaps')
  list(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('sessionId') sessionId?: string,
  ) {
    return this.recaps.list(ctx, clientId, {
      cursor: cursor || undefined,
      limit: positiveInt(limit, 25),
      sessionId: sessionId || undefined,
    });
  }

  @Post('clients/:clientId/hearing-recaps')
  save(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: SaveHearingRecapDto,
  ) {
    return this.recaps.save(ctx, clientId, body);
  }
}
