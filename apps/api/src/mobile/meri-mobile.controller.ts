import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Response } from 'express';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MeriMobileService } from './meri-mobile.service.js';

class MeetingListQueryDto {
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsString() @Length(1, 2048) cursor?: string;
}

class UpdateMeetingDto {
  @IsOptional() @IsUUID() clientId?: string | null;
  @IsOptional() @IsString() @Length(1, 240) subject?: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() location?: string | null;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
  @IsOptional() @IsString() @Length(1, 80) status?: string;
}

class UpdateEncryptedArtifactDto {
  @IsString() @MinLength(1) body!: string;
  @IsOptional() @IsBoolean() confidential?: boolean;
  @IsOptional() @IsString() accessLevel?: string;
}

class UpdatePrepDto {
  @IsOptional() @IsString() summary?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(80) @IsString({ each: true }) agenda?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(80) @IsString({ each: true }) talkingPoints?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(80) @IsString({ each: true }) risks?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(80) @IsString({ each: true }) followUps?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(80) @IsString({ each: true }) emailEvidence?: string[];
}

class AttachmentUploadDto {
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() meetingId?: string;
  @IsOptional() @IsUUID() mailMessageId?: string;
  @IsString() @Length(1, 255) fileName!: string;
  @IsString() @Length(1, 255) contentType!: string;
  @Type(() => Number) @IsInt() @Min(1) contentLength!: number;
}

class ConfirmAttachmentDto {
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() meetingId?: string;
  @IsOptional() @IsUUID() mailMessageId?: string;
  @IsString() @Length(1, 255) fileName!: string;
  @IsString() @Length(1, 255) contentType!: string;
  @IsString() @Length(1, 2048) s3Key!: string;
  @IsOptional() @IsString() @Length(64, 64) checksumSha256?: string;
}

class FileParentQueryDto {
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() meetingId?: string;
  @IsOptional() @IsUUID() mailMessageId?: string;
  @IsOptional() @IsIn(['true', 'false', '1', '0']) unlinked?: string;
}

class RegisterDeviceDto {
  @IsString() @Length(1, 128) deviceId!: string;
  @IsIn(['sandbox', 'production']) environment!: 'sandbox' | 'production';
  @IsString() @Length(64, 512) token!: string;
  @IsOptional() @IsString() @Length(1, 64) appVersion?: string;
}

class RevokeDeviceDto {
  @IsString() @Length(1, 128) deviceId!: string;
  @IsIn(['sandbox', 'production']) environment!: 'sandbox' | 'production';
}

function requireIfMatch(value: string | undefined): string {
  if (!value) {
    throw new HttpException(
      { statusCode: 428, code: 'precondition_required', message: 'If-Match is required.' },
      428,
    );
  }
  const revision = value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!revision || !Number.isFinite(Date.parse(revision))) {
    throw new BadRequestException({ code: 'invalid_revision', message: 'If-Match must contain an ISO revision.' });
  }
  return revision;
}

function setRevisionEtag(res: Response, value: unknown): void {
  const revision = (value as { revision?: string | null })?.revision;
  if (revision) res.setHeader('ETag', `"${revision}"`);
}

@Controller('mobile/v1')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MeriMobileController {
  constructor(private readonly mobile: MeriMobileService) {}

  @Get('bootstrap')
  bootstrap(@CurrentTenant() ctx: TenantContext) {
    return this.mobile.bootstrap(ctx);
  }

  @Get('meetings')
  listMeetings(@CurrentTenant() ctx: TenantContext, @Query() query: MeetingListQueryDto) {
    return this.mobile.listMeetings(ctx, query);
  }

  @Get('meetings/:meetingId')
  async meeting(
    @CurrentTenant() ctx: TenantContext,
    @Param('meetingId', ParseUUIDPipe) meetingId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const value = await this.mobile.getMeeting(ctx, meetingId);
    setRevisionEtag(res, value);
    return value;
  }

  @Patch('meetings/:meetingId')
  async updateMeeting(
    @CurrentTenant() ctx: TenantContext,
    @Param('meetingId', ParseUUIDPipe) meetingId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateMeetingDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const value = await this.mobile.updateMeeting(ctx, meetingId, requireIfMatch(ifMatch), body);
    setRevisionEtag(res, value);
    return value;
  }

  @Patch('meetings/:meetingId/notes/:noteId')
  async updateNote(
    @CurrentTenant() ctx: TenantContext,
    @Param('meetingId', ParseUUIDPipe) meetingId: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateEncryptedArtifactDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const value = await this.mobile.updateNote(ctx, meetingId, noteId, requireIfMatch(ifMatch), body);
    setRevisionEtag(res, value);
    return value;
  }

  @Patch('meetings/:meetingId/debriefs/:debriefId')
  async updateDebrief(
    @CurrentTenant() ctx: TenantContext,
    @Param('meetingId', ParseUUIDPipe) meetingId: string,
    @Param('debriefId', ParseUUIDPipe) debriefId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateEncryptedArtifactDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const value = await this.mobile.updateDebrief(ctx, meetingId, debriefId, requireIfMatch(ifMatch), body);
    setRevisionEtag(res, value);
    return value;
  }

  @Patch('meeting-preps/:prepId')
  async updatePrep(
    @CurrentTenant() ctx: TenantContext,
    @Param('prepId', ParseUUIDPipe) prepId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdatePrepDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const value = await this.mobile.updatePrep(ctx, prepId, requireIfMatch(ifMatch), body);
    setRevisionEtag(res, value);
    return value;
  }

  @Post('files/upload-url')
  createUploadUrl(@CurrentTenant() ctx: TenantContext, @Body() body: AttachmentUploadDto) {
    return this.mobile.createUploadUrl(ctx, body);
  }

  @Post('files/confirm')
  confirmUpload(@CurrentTenant() ctx: TenantContext, @Body() body: ConfirmAttachmentDto) {
    return this.mobile.confirmUpload(ctx, body);
  }

  @Get('files')
  listFiles(@CurrentTenant() ctx: TenantContext, @Query() query: FileParentQueryDto) {
    return this.mobile.listFiles(ctx, { ...query, unlinked: query.unlinked === 'true' || query.unlinked === '1' });
  }

  @Get('files/:fileId/status')
  fileStatus(
    @CurrentTenant() ctx: TenantContext,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Query() query: FileParentQueryDto,
  ) {
    return this.mobile.fileStatus(ctx, fileId, {
      ...query,
      unlinked: query.unlinked === 'true' || query.unlinked === '1',
    });
  }

  @Post('devices')
  registerDevice(@CurrentTenant() ctx: TenantContext, @Body() body: RegisterDeviceDto) {
    return this.mobile.registerDevice(ctx, body);
  }

  @Delete('devices')
  revokeDevice(@CurrentTenant() ctx: TenantContext, @Body() body: RevokeDeviceDto) {
    return this.mobile.revokeDevice(ctx, body);
  }
}
