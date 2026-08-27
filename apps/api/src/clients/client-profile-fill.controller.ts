import {
  BadRequestException,
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
  ValidateNested,
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

/** Matches `NewMatterForRecordDto` on the advocacy-matter controller —
 *  same "create Matter" shape, reused here so a reviewer's "Create new
 *  Matter" choice on a pending finding goes through identical validation
 *  to the equivalent action elsewhere in the product. */
class NewMatterForFindingDto {
  @IsString()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsIn([
    'funding_request',
    'legislative',
    'regulatory',
    'program_element',
    'community_project',
    'procurement',
    'other',
  ])
  matterType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string;
}

/** §22/23 follow-up: "Attach to Matter X" / "Create new Matter" on a
 *  still-pending advocacy finding. Exactly one of `matterId`/`newMatter`
 *  is required — enforced in the service, not here, so the error message
 *  can name both fields together rather than two separate DTO-level
 *  "required" complaints depending on which one is missing. */
class AssignFindingMatterDto {
  @IsOptional()
  @IsUUID()
  matterId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NewMatterForFindingDto)
  newMatter?: NewMatterForFindingDto;
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

  /** §22/23 follow-up: "Attach to Matter X" / "Create new Matter" directly
   *  on a pending advocacy_record finding. Same `user_admin` gate as the
   *  generic apply endpoint above — this is a variant of applying a
   *  finding, not a lower-trust action. */
  @Post('runs/:runId/findings/:findingId/assign-matter')
  @Roles('user_admin')
  assignFindingMatter(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('runId') runId: string,
    @Param('findingId') findingId: string,
    @Body() body: AssignFindingMatterDto,
  ) {
    // Constructed explicitly (never `{ matterId: body.matterId! }` when
    // matterId is undefined) so the service's exactly-one-of check sees a
    // real absence of the key, not a present key with an undefined value.
    if (body.newMatter && body.matterId) {
      throw new BadRequestException('Provide exactly one of matterId or newMatter, not both');
    }
    const target = body.newMatter
      ? { newMatter: body.newMatter }
      : body.matterId
        ? { matterId: body.matterId }
        : null;
    if (!target) {
      throw new BadRequestException('Provide exactly one of matterId or newMatter');
    }
    return this.service.applyAdvocacyFindingToMatter(ctx, clientId, runId, findingId, target);
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
  getRefreshSchedule(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
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

  @Get('advocacy-history/health')
  getAdvocacyHistoryHealth(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
  ) {
    return this.service.getAdvocacyHistoryHealth(ctx, clientId);
  }
}
