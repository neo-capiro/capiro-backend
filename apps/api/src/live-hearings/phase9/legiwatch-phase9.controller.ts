import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { LegiWatchPhase9CutoverService } from './legiwatch-phase9-cutover.service.js';
import { LegiWatchPhase9ReadinessService } from './legiwatch-phase9-readiness.service.js';
import {
  LegiWatchPhase9RuntimeService,
  type LegiWatchRuntimeRegistration,
} from './legiwatch-phase9-runtime.service.js';
import {
  LEGIWATCH_PHASE9_EVIDENCE_SOURCES,
  LEGIWATCH_PHASE9_MODES,
  type LegiWatchPhase9AuditOptions,
  type LegiWatchPhase9CutoverPhase,
} from './legiwatch-phase9.types.js';

const CUTOVER_PHASES = ['SHADOW', 'CANARY', 'READY', 'CUTOVER', 'ROLLBACK'] as const;
const EVIDENCE_STATUSES = ['PASS', 'FAIL', 'BLOCKED'] as const;
const OBSERVATION_DISPOSITIONS = ['CONFLICT', 'IGNORED_INVALID'] as const;

class ReadinessQueryDto {
  @IsOptional()
  @IsIn(LEGIWATCH_PHASE9_EVIDENCE_SOURCES)
  evidenceSource?: (typeof LEGIWATCH_PHASE9_EVIDENCE_SOURCES)[number];

  @IsOptional()
  @IsIn(LEGIWATCH_PHASE9_MODES)
  mode?: (typeof LEGIWATCH_PHASE9_MODES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  lookbackDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  lookaheadDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  captureGraceMinutes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  intelligenceLagMinutes?: number;
}

class RunReadinessDto extends ReadinessQueryDto {}

class ObservationDispositionDto {
  @IsIn(OBSERVATION_DISPOSITIONS)
  disposition!: (typeof OBSERVATION_DISPOSITIONS)[number];

  @IsString()
  reasonCode!: string;
}

class RuntimeRegistrationDto implements LegiWatchRuntimeRegistration {
  @IsString()
  jobKey!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsBoolean()
  scheduleEnabled!: boolean;

  @IsOptional()
  @IsString()
  ruleName?: string | null;

  @IsOptional()
  @IsString()
  taskFamily?: string | null;
}

class RegisterRuntimeDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RuntimeRegistrationDto)
  registrations!: RuntimeRegistrationDto[];

  @IsString()
  confirmation!: string;
}

class TransitionDto {
  @IsIn(CUTOVER_PHASES)
  target!: LegiWatchPhase9CutoverPhase;

  @IsString()
  confirmation!: string;
}

class CaptureAllDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  confirmation!: string;
}

class EvidenceDto {
  @IsString()
  evidenceType!: string;

  @IsIn(LEGIWATCH_PHASE9_EVIDENCE_SOURCES.filter((value) => value !== 'NONE'))
  evidenceSource!: string;

  @IsIn(EVIDENCE_STATUSES)
  status!: (typeof EVIDENCE_STATUSES)[number];

  @IsOptional()
  @IsString()
  hearingId?: string;

  @IsOptional()
  @IsString()
  captureId?: string;

  @IsOptional()
  @IsUUID()
  runId?: string;

  @IsOptional()
  @IsISO8601()
  observedAt?: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  artifactUri?: string;

  @IsOptional()
  @IsObject()
  details?: Record<string, unknown>;
}

class EvidenceQueryDto {
  @IsOptional()
  @IsString()
  evidenceType?: string;

  @IsOptional()
  @IsIn(EVIDENCE_STATUSES)
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

class LimitQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

@Controller('legiwatch/live-hearings/phase9')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class LegiWatchPhase9RolloutController {
  constructor(private readonly cutover: LegiWatchPhase9CutoverService) {}

  /**
   * Safe runtime rollout decision consumed by the web shell. It exposes no
   * evidence details, actor identity, queue payload, tenant context, or secret.
   */
  @Get('rollout')
  rollout() {
    return this.cutover.rolloutDecision();
  }
}

@Controller('admin/legiwatch/phase9')
@UseGuards(RolesGuard)
@Roles('capiro_admin')
export class LegiWatchPhase9AdminController {
  constructor(
    private readonly readiness: LegiWatchPhase9ReadinessService,
    private readonly runtime: LegiWatchPhase9RuntimeService,
    private readonly cutover: LegiWatchPhase9CutoverService,
  ) {}

  @Get('readiness')
  readinessPreview(@Query() query: ReadinessQueryDto) {
    return this.readiness.evaluate(readinessOptions(query));
  }

  @Post('readiness/run')
  runReadiness(@CurrentTenant() ctx: TenantContext, @Body() body: RunReadinessDto) {
    return this.readiness.evaluateAndPersist(actor(ctx), readinessOptions(body));
  }

  @Get('runs')
  runs(@Query() query: LimitQueryDto) {
    return this.readiness.listRecentRuns(query.limit);
  }

  @Get('runs/:id')
  run(@Param('id') id: string) {
    return this.readiness.getRun(id);
  }

  @Post('observations/:id/disposition')
  dispositionObservation(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: ObservationDispositionDto,
  ) {
    return this.readiness.dispositionObservation({
      observationId: id,
      disposition: body.disposition,
      reasonCode: body.reasonCode,
      actor: actor(ctx),
    });
  }

  @Get('runtime')
  runtimeJobs() {
    return this.runtime.list();
  }

  @Post('runtime/register')
  registerRuntime(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: RegisterRuntimeDto,
  ) {
    return this.runtime.registerSchedules({
      registrations: body.registrations,
      actor: actor(ctx),
      confirmation: body.confirmation,
    });
  }

  @Get('state')
  state() {
    return this.cutover.state();
  }

  @Post('transition')
  transition(@CurrentTenant() ctx: TenantContext, @Body() body: TransitionDto) {
    return this.cutover.transition({
      target: body.target,
      actor: actor(ctx),
      confirmation: body.confirmation,
    });
  }

  @Post('capture-all')
  captureAll(@CurrentTenant() ctx: TenantContext, @Body() body: CaptureAllDto) {
    return this.cutover.setCaptureAll({
      enabled: body.enabled,
      actor: actor(ctx),
      confirmation: body.confirmation,
    });
  }

  @Post('evidence')
  recordEvidence(@CurrentTenant() ctx: TenantContext, @Body() body: EvidenceDto) {
    return this.cutover.recordEvidence({
      evidenceType: body.evidenceType,
      evidenceSource: body.evidenceSource,
      status: body.status,
      hearingId: body.hearingId,
      captureId: body.captureId,
      runId: body.runId,
      observedAt: body.observedAt ? new Date(body.observedAt) : undefined,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      artifactUri: body.artifactUri,
      details: body.details,
      actor: actor(ctx),
    });
  }

  @Get('evidence')
  evidence(@Query() query: EvidenceQueryDto) {
    return this.cutover.listEvidence(query);
  }
}

function readinessOptions(input: ReadinessQueryDto): LegiWatchPhase9AuditOptions {
  return {
    evidenceSource: input.evidenceSource ?? 'NONE',
    mode: input.mode ?? 'READINESS',
    lookbackDays: input.lookbackDays,
    lookaheadDays: input.lookaheadDays,
    captureGraceMinutes: input.captureGraceMinutes,
    intelligenceLagMinutes: input.intelligenceLagMinutes,
  };
}

function actor(ctx: TenantContext): string {
  return ctx.userId || ctx.clerkUserId || 'unknown-capiro-admin';
}
