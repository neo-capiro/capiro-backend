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
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request, Response } from 'express';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { runMeriStreamWithSetupGuard } from '../meri/meri-stream-preflight.helpers.js';
import { projectRun } from '../meri/hermes/meri-hermes.controller.js';
import type { MeriSseFrame } from '../meri/hermes/hermes-runtime.contracts.js';
import { MeriHermesRuntimeAdapter } from '../meri/hermes/meri-hermes-runtime.adapter.js';
import {
  MERI_HERMES_RUN_REPOSITORY,
  type MeriHermesRunRecord,
  type MeriHermesRunRepository,
} from '../meri/hermes/meri-hermes-run-store.js';
import { MeriMobileService } from './meri-mobile.service.js';

class StartRunDto {
  @IsString() @Length(0, 24_000) body!: string;
  @IsOptional() @IsIn(['new', 'regenerate', 'resend']) mode?: 'new' | 'regenerate' | 'resend';
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsUUID(undefined, { each: true }) attachmentIds?: string[];
}

class ApprovalDto {
  @IsString() @Length(1, 200) requestId!: string;
  @IsIn(['approve_once', 'deny']) decision!: 'approve_once' | 'deny';
}

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
  constructor(
    private readonly mobile: MeriMobileService,
    private readonly adapter: MeriHermesRuntimeAdapter,
    @Inject(MERI_HERMES_RUN_REPOSITORY) private readonly runs: MeriHermesRunRepository,
  ) {}

  private async ownedRun(ctx: TenantContext, runId: string): Promise<MeriHermesRunRecord> {
    const run = await this.runs.requireOwned(runId, ctx.tenantId, ctx.userId);
    if (!run) throw new NotFoundException('Run not found');
    return run;
  }

  @Get('bootstrap')
  bootstrap(@CurrentTenant() ctx: TenantContext) {
    return this.mobile.bootstrap(ctx);
  }

  @Post('meri/conversations/:conversationId/runs')
  async startRun(
    @CurrentTenant() ctx: TenantContext,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: StartRunDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.mobile.assertCapability(ctx, 'runs');
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) {
      throw new BadRequestException({ code: 'invalid_idempotency_key', message: 'Idempotency-Key is required (1-200 characters).' });
    }
    const abort = new AbortController();
    const onAbort = () => abort.abort(new DOMException('Client disconnected', 'AbortError'));
    req.once('aborted', onAbort);
    res.once('close', onAbort);
    res.once('error', onAbort);
    try {
      await runMeriStreamWithSetupGuard({
        res,
        stream: (sse) =>
          this.adapter.streamMessage(
            ctx,
            conversationId,
            body.body,
            sse,
            abort.signal,
            body.mode ?? 'new',
            body.attachmentIds ?? [],
            undefined,
            undefined,
            key,
          ),
      });
    } finally {
      req.off('aborted', onAbort);
      res.off('close', onAbort);
      res.off('error', onAbort);
    }
  }

  @Get('meri/runs/:runId')
  async run(@CurrentTenant() ctx: TenantContext, @Param('runId', ParseUUIDPipe) runId: string) {
    return projectRun(await this.ownedRun(ctx, runId));
  }

  @Get('meri/runs/:runId/events')
  async events(
    @CurrentTenant() ctx: TenantContext,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Query('after') after: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const run = await this.ownedRun(ctx, runId);
    const afterSeq = Math.max(0, Number.parseInt(after ?? '0', 10) || 0);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const abort = new AbortController();
    const onClose = () => abort.abort();
    req.once('aborted', onClose);
    res.once('close', onClose);
    const write = (frame: MeriSseFrame) => {
      if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    try {
      await this.adapter.attach(run, write, abort.signal, afterSeq);
    } finally {
      req.off('aborted', onClose);
      res.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
  }

  @Post('meri/runs/:runId/stop')
  async stop(@CurrentTenant() ctx: TenantContext, @Param('runId', ParseUUIDPipe) runId: string) {
    return projectRun(await this.adapter.requestStop(await this.ownedRun(ctx, runId)));
  }

  @Post('meri/runs/:runId/approval')
  async approval(
    @CurrentTenant() ctx: TenantContext,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() body: ApprovalDto,
  ) {
    await this.mobile.assertCapability(ctx, 'runs');
    const run = await this.ownedRun(ctx, runId);
    await this.adapter.resolveApproval(run, body.requestId, body.decision, ctx.userId);
    return projectRun((await this.runs.get(run.runId)) ?? run);
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
