import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import {
  CLIENT_PROFILE_FILL_SOURCES,
  type ClientProfileFillSource,
} from './client-profile-fill.helpers.js';
import { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';

class StartClientProfileFillDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CLIENT_PROFILE_FILL_SOURCES.length)
  @IsIn(CLIENT_PROFILE_FILL_SOURCES, { each: true })
  sources?: ClientProfileFillSource[];

  /** Legacy one-document input. New clients send attachmentIds so documents and
   * connected sources can run together in the same durable workflow. */
  @IsOptional()
  @IsUUID()
  attachmentId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  attachmentIds?: string[];

  /** Imported LDA identities are always retained. These are only additional
   * identities the setup screen explicitly offered and the user selected. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ldaClientIds?: number[];

  /** Optional website entered in the setup gate. It is persisted before the
   * public-web specialist starts so every task sees the same canonical site. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;
}

class ApplyClientProfileFillDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  findingIds!: string[];
}

class RejectClientProfileFillDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

class UpdateClientProfileFillScheduleDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(6)
  @Max(720)
  cadenceHours?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CLIENT_PROFILE_FILL_SOURCES.length)
  @IsIn(CLIENT_PROFILE_FILL_SOURCES, { each: true })
  sources?: ClientProfileFillSource[];
}

@Controller('clients/:clientId/fill-with-meri')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientProfileFillController {
  constructor(private readonly service: ClientProfileFillCompletionService) {}

  @Get('setup')
  setup(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getSetup(ctx, clientId);
  }

  @Post('runs')
  @HttpCode(HttpStatus.ACCEPTED)
  start(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: StartClientProfileFillDto,
  ) {
    const attachmentIds = [
      ...new Set([
        ...(body.attachmentIds ?? []),
        ...(body.attachmentId ? [body.attachmentId] : []),
      ]),
    ];
    return this.service.startRun(ctx, clientId, {
      sources: body.sources,
      attachmentIds,
      ldaClientIds: body.ldaClientIds,
      website: body.website,
    });
  }

  @Get('latest')
  latest(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.getLatest(ctx, clientId);
  }

  @Get('runs/:runId')
  getRun(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('runId') runId: string,
  ) {
    return this.service.getRun(ctx, clientId, runId);
  }

  @Post('runs/:runId/cancel')
  cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('runId') runId: string,
  ) {
    return this.service.cancelRun(ctx, clientId, runId);
  }

  @Post('runs/:runId/tasks/:taskId/retry')
  retryTask(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('runId') runId: string,
    @Param('taskId') taskId: string,
  ) {
    return this.service.retryTask(ctx, clientId, runId, taskId);
  }

  @Post('runs/:runId/apply')
  @Roles('user_admin')
  apply(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('runId') runId: string,
    @Body() body: ApplyClientProfileFillDto,
  ) {
    return this.service.applyFindings(ctx, clientId, runId, body.findingIds);
  }

  @Post('findings/:findingId/reject')
  @Roles('user_admin')
  reject(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('findingId') findingId: string,
    @Body() body: RejectClientProfileFillDto,
  ) {
    return this.service.rejectFinding(ctx, clientId, findingId, body.reason);
  }

  @Post('findings/:findingId/restore')
  @Roles('user_admin')
  restore(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('findingId') findingId: string,
  ) {
    return this.service.restoreFinding(ctx, clientId, findingId);
  }

  @Get('refresh-schedule')
  getRefreshSchedule(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
  ) {
    return this.service.getSchedule(ctx, clientId);
  }

  @Put('refresh-schedule')
  @Roles('user_admin')
  updateRefreshSchedule(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: UpdateClientProfileFillScheduleDto,
  ) {
    return this.service.updateSchedule(ctx, clientId, body);
  }

  @Post('refresh-now')
  @HttpCode(HttpStatus.ACCEPTED)
  refreshNow(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.refreshNow(ctx, clientId);
  }
}
